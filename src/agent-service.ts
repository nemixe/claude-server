import { getSessionMessages, query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AppConfig } from "./config.js";
import { buildSafeAgentEnv, buildSandboxSettings } from "./sandbox.js";
import type { ClaudeMode, NormalizedAgentEvent, SessionMetadata, StreamMessageRequest } from "./types.js";

export type AgentPrompt = string | AsyncIterable<SDKUserMessage>;

export type AgentQuery = AsyncIterable<unknown> & {
  interrupt?: () => Promise<void>;
  close?: () => void;
};

export type AgentSdkAdapter = {
  query: (input: { prompt: AgentPrompt; options: Record<string, unknown> }) => AgentQuery;
  getSessionMessages: (sessionId: string, options?: { dir?: string; limit?: number; offset?: number }) => Promise<unknown[]>;
};

export type AgentRunInput = {
  session: SessionMetadata;
  request: StreamMessageRequest;
};

type ActiveRun = {
  query: AgentQuery;
  abortController: AbortController;
  observers: Set<EventQueue<NormalizedAgentEvent>>;
};

export const defaultAgentSdkAdapter: AgentSdkAdapter = {
  query: (input) => query(input as never) as AgentQuery,
  getSessionMessages: (sessionId, options) => getSessionMessages(sessionId, options) as Promise<unknown[]>
};

export class ConcurrencyLimitError extends Error {
  constructor() {
    super("Too many active Claude runs");
    this.name = "ConcurrencyLimitError";
  }
}

export class AgentService {
  private readonly activeRuns = new Map<string, ActiveRun>();

  constructor(
    private readonly config: AppConfig,
    private readonly adapter: AgentSdkAdapter = defaultAgentSdkAdapter
  ) {}

  async *stream(input: AgentRunInput): AsyncGenerator<NormalizedAgentEvent> {
    if (this.activeRuns.has(input.session.id) || this.activeRuns.size >= this.config.maxConcurrentRuns) {
      throw new ConcurrencyLimitError();
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.config.runTimeoutMs);
    const options = buildAgentOptions(this.config, input.session, input.request, abortController);
    const agentQuery = this.adapter.query({ prompt: buildAgentPrompt(input.request), options });
    const activeRun: ActiveRun = { query: agentQuery, abortController, observers: new Set() };
    this.activeRuns.set(input.session.id, activeRun);

    try {
      for await (const message of agentQuery) {
        const event = normalizeAgentMessage(message);
        broadcastEvent(activeRun, event);
        yield event;
      }
    } catch (error) {
      broadcastEvent(activeRun, { type: "error", data: { error: { code: "agent_error", message: errorMessage(error) } } });
      throw error;
    } finally {
      clearTimeout(timeout);
      agentQuery.close?.();
      this.activeRuns.delete(input.session.id);
      closeObservers(activeRun);
    }
  }

  observe(sessionId: string): { running: boolean; events: AsyncIterable<NormalizedAgentEvent> } {
    const active = this.activeRuns.get(sessionId);
    if (!active) {
      return {
        running: false,
        events: emptyEvents()
      };
    }

    const queue = new EventQueue<NormalizedAgentEvent>();
    active.observers.add(queue);

    return {
      running: true,
      events: queue.iterate(() => active.observers.delete(queue))
    };
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const active = this.activeRuns.get(sessionId);
    if (!active) return false;

    active.abortController.abort();
    await active.query.interrupt?.();
    return true;
  }

  async getMessages(session: SessionMetadata, limit?: number, offset?: number): Promise<unknown[]> {
    return this.adapter.getSessionMessages(session.id, {
      dir: session.workspacePath,
      limit,
      offset
    });
  }
}

class EventQueue<T> {
  private readonly queue: T[] = [];
  private closed = false;
  private waiting: ((result: IteratorResult<T>) => void) | undefined;

  enqueue(value: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ done: false, value });
      return;
    }
    this.queue.push(value);
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ done: true, value: undefined });
    }
  }

  async *iterate(onClose: () => void): AsyncGenerator<T> {
    try {
      while (true) {
        const next = await this.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      onClose();
      this.close();
    }
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.queue.length > 0) {
      return Promise.resolve({ done: false, value: this.queue.shift() as T });
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

function broadcastEvent(activeRun: ActiveRun, event: NormalizedAgentEvent): void {
  for (const observer of activeRun.observers) {
    observer.enqueue(event);
  }
}

function closeObservers(activeRun: ActiveRun): void {
  for (const observer of activeRun.observers) {
    observer.close();
  }
  activeRun.observers.clear();
}

async function* emptyEvents(): AsyncGenerator<NormalizedAgentEvent> {
  return;
}

export function buildAgentOptions(
  config: AppConfig,
  session: SessionMetadata,
  request: StreamMessageRequest,
  abortController: AbortController
): Record<string, unknown> {
  const mode = request.mode ?? session.mode;

  return {
    abortController,
    cwd: session.workspacePath,
    ...(session.hasRun ? { resume: session.id } : { sessionId: session.id }),
    persistSession: true,
    settingSources: ["project"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    tools: { type: "preset", preset: "claude_code" },
    permissionMode: permissionModeFor(mode),
    allowDangerouslySkipPermissions: mode === "bypass",
    enableFileCheckpointing: mode !== "plan",
    maxTurns: Math.min(request.maxTurns ?? config.maxTurns, config.maxTurns),
    maxBudgetUsd: config.maxBudgetUsd,
    model: request.model,
    env: buildSafeAgentEnv(),
    sandbox: buildSandboxSettings(config, session.workspacePath),
    disallowedTools: mode === "plan" ? ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"] : []
  };
}

export function buildAgentPrompt(request: StreamMessageRequest): AgentPrompt {
  if (!request.images || request.images.length === 0) {
    return request.prompt;
  }

  const message: SDKUserMessage = {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: request.prompt },
        ...request.images.map((image) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: image.mediaType,
            data: image.dataBase64
          }
        }))
      ]
    },
    parent_tool_use_id: null
  };

  return singleMessagePrompt(message);
}

async function* singleMessagePrompt(message: SDKUserMessage): AsyncGenerator<SDKUserMessage> {
  yield message;
}

function permissionModeFor(mode: ClaudeMode): string {
  if (mode === "plan") return "plan";
  if (mode === "bypass") return "bypassPermissions";
  return "acceptEdits";
}

export function normalizeAgentMessage(message: unknown): NormalizedAgentEvent {
  if (message && typeof message === "object") {
    const record = message as Record<string, unknown>;
    if (typeof record.type === "string") {
      if (record.type === "result") return { type: "result", data: message };
      if (record.type === "assistant") return { type: "message", data: message };
      if (record.type === "user") return { type: "message", data: message };
      if (record.type === "system") return { type: "system", data: message };
      if (record.type === "tool_use") return { type: "tool_use", data: message };
      if (record.type === "tool_result") return { type: "tool_result", data: message };
      return { type: record.type, data: message };
    }

    if ("result" in record) {
      return { type: "result", data: message };
    }
  }

  return { type: "message", data: message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

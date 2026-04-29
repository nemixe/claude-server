import { getSessionMessages, query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AppConfig } from "./config.js";
import { buildSafeAgentEnv, buildSandboxSettings } from "./sandbox.js";
import { MissingClaudeSessionIdError, SessionPool, type SessionFactory, type SessionLike, type SessionOptions } from "./session-adapter.js";
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
  onClaudeSessionId?: (claudeSessionId: string) => void | Promise<void>;
};

type ActiveRunHandle = {
  close: () => void;
  interrupt?: () => Promise<void>;
};

type ActiveRun = {
  handle: ActiveRunHandle;
  abortController: AbortController;
  observers: Set<EventQueue<NormalizedAgentEvent>>;
  closeOnFinish: boolean;
  closeOnError: boolean;
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
  private readonly pool?: SessionPool;
  private readonly cleanupTimer?: ReturnType<typeof setInterval>;
  private maxConcurrentRuns: number;
  private maxTurns: number;

  constructor(
    private readonly config: AppConfig,
    private readonly adapter: AgentSdkAdapter = defaultAgentSdkAdapter,
    sessionFactory?: SessionFactory
  ) {
    this.maxConcurrentRuns = config.maxConcurrentRuns;
    this.maxTurns = config.maxTurns;
    if (sessionFactory) {
      this.pool = new SessionPool(sessionFactory, { idleTtlMs: config.sessionIdleTtlMs });
      const timer = setInterval(() => this.pool?.cleanupIdle(), Math.min(config.sessionIdleTtlMs, 60_000));
      if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
        timer.unref();
      }
      this.cleanupTimer = timer;
    }
  }

  getMaxConcurrentRuns(): number {
    return this.maxConcurrentRuns;
  }

  setMaxConcurrentRuns(value: number): void {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error("maxConcurrentRuns must be a positive integer");
    }
    this.maxConcurrentRuns = value;
  }

  getMaxTurns(): number {
    return this.maxTurns;
  }

  setMaxTurns(value: number): void {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error("maxTurns must be a positive integer");
    }
    this.maxTurns = value;
  }

  async *stream(input: AgentRunInput): AsyncGenerator<NormalizedAgentEvent> {
    if (this.activeRuns.has(input.session.id) || this.activeRuns.size >= this.maxConcurrentRuns) {
      throw new ConcurrencyLimitError();
    }

    const abortController = new AbortController();
    let activeRun: ActiveRun | undefined;
    const timeout = setTimeout(() => {
      abortController.abort();
      activeRun?.handle.close();
    }, this.config.runTimeoutMs);

    try {
      const register = (handle: ActiveRunHandle, options: { closeOnFinish: boolean; closeOnError: boolean }): ActiveRun => {
        activeRun = {
          handle,
          abortController,
          observers: new Set(),
          closeOnFinish: options.closeOnFinish,
          closeOnError: options.closeOnError
        };
        this.activeRuns.set(input.session.id, activeRun);
        return activeRun;
      };

      if (this.pool) {
        yield* this.streamWithSession(input, register);
      } else {
        yield* this.streamWithQuery(input, abortController, register);
      }
    } catch (error) {
      if (activeRun) {
        if (activeRun.closeOnError) activeRun.handle.close();
        broadcastEvent(activeRun, { type: "error", data: { error: { code: "agent_error", message: errorMessage(error) } } });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (activeRun?.closeOnFinish) activeRun.handle.close();
      this.pool?.markRunning(input.session.id, false);
      this.activeRuns.delete(input.session.id);
      if (activeRun) closeObservers(activeRun);
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
    await active.handle.interrupt?.();
    return true;
  }

  closeSession(sessionId: string): boolean {
    const active = this.activeRuns.get(sessionId);
    if (active) {
      active.abortController.abort();
      active.handle.close();
      return true;
    }

    return this.pool?.close(sessionId) ?? false;
  }

  cleanupIdleSessions(): void {
    this.pool?.cleanupIdle();
  }

  dispose(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const [sessionId, active] of this.activeRuns) {
      active.abortController.abort();
      active.handle.close();
      closeObservers(active);
      this.activeRuns.delete(sessionId);
    }
    this.pool?.closeAll();
  }

  async getMessages(session: SessionMetadata, limit?: number, offset?: number): Promise<unknown[]> {
    if (this.pool && session.hasRun && !session.claudeSessionId) {
      throw new MissingClaudeSessionIdError(session.id);
    }

    const sessionId = this.pool && session.claudeSessionId ? session.claudeSessionId : session.id;
    return this.adapter.getSessionMessages(sessionId, {
      dir: this.config.projectRoot,
      limit,
      offset
    });
  }

  private async *streamWithQuery(
    input: AgentRunInput,
    abortController: AbortController,
    register: (handle: ActiveRunHandle, options: { closeOnFinish: boolean; closeOnError: boolean }) => ActiveRun
  ): AsyncGenerator<NormalizedAgentEvent> {
    const options = buildAgentOptions(this.config, input.session, input.request, abortController, this.maxTurns);
    const agentQuery = this.adapter.query({ prompt: buildAgentPrompt(input.request), options });
    const activeRun = register(
      {
        close: () => agentQuery.close?.(),
        interrupt: async () => {
          await agentQuery.interrupt?.();
        }
      },
      { closeOnFinish: true, closeOnError: false }
    );

    for await (const message of agentQuery) {
      const event = normalizeAgentMessage(message);
      yield this.emitEvent(activeRun, event);
      const pendingEvent = this.questionPendingEvent(message, activeRun);
      if (pendingEvent) {
        abortController.abort();
        agentQuery.close?.();
        yield pendingEvent;
        break;
      }
    }
  }

  private async *streamWithSession(
    input: AgentRunInput,
    register: (handle: ActiveRunHandle, options: { closeOnFinish: boolean; closeOnError: boolean }) => ActiveRun
  ): AsyncGenerator<NormalizedAgentEvent> {
    if (!this.pool) return;

    const options = buildSessionOptions(this.config, input.session, input.request);
    const sdkSession = this.pool.getOrCreate(input.session, options);
    this.pool.markRunning(input.session.id, true);
    const activeRun = register(
      {
        close: () => {
          this.pool?.close(input.session.id);
        },
        interrupt: async () => {
          this.pool?.close(input.session.id);
        }
      },
      { closeOnFinish: false, closeOnError: true }
    );

    await sendPrompt(sdkSession, buildAgentPrompt(input.request));

    for await (const message of sdkSession.stream()) {
      const claudeSessionId = getSessionIdFromEvent(message);
      if (claudeSessionId) {
        await input.onClaudeSessionId?.(claudeSessionId);
      }

      const event = normalizeAgentMessage(message);
      yield this.emitEvent(activeRun, event);
      const pendingEvent = this.questionPendingEvent(message, activeRun);
      if (pendingEvent) {
        activeRun.handle.close();
        yield pendingEvent;
        break;
      }
    }

    this.pool.touch(input.session.id);
  }

  private emitEvent(activeRun: ActiveRun, event: NormalizedAgentEvent): NormalizedAgentEvent {
    broadcastEvent(activeRun, event);
    return event;
  }

  private questionPendingEvent(message: unknown, activeRun: ActiveRun): NormalizedAgentEvent | undefined {
    const questionTool = getAskUserQuestionToolFromEvent(message);
    if (!questionTool) return undefined;

    const pendingEvent = {
      type: "question_pending",
      data: {
        waitingForUserQuestion: true,
        toolUseId: questionTool.id,
        input: questionTool.input
      }
    };
    broadcastEvent(activeRun, pendingEvent);
    return pendingEvent;
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
  abortController: AbortController,
  runtimeMaxTurns: number
): Record<string, unknown> {
  const mode = request.mode ?? session.mode;

  return {
    abortController,
    cwd: config.projectRoot,
    ...(session.hasRun ? { resume: session.id } : { sessionId: session.id }),
    persistSession: true,
    settingSources: ["project"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    tools: { type: "preset", preset: "claude_code" },
    permissionMode: permissionModeFor(mode),
    allowDangerouslySkipPermissions: mode === "bypass",
    enableFileCheckpointing: mode !== "plan",
    maxTurns: Math.min(request.maxTurns ?? runtimeMaxTurns, runtimeMaxTurns),
    maxBudgetUsd: config.maxBudgetUsd,
    model: request.model,
    env: buildSafeAgentEnv(),
    sandbox: buildSandboxSettings(config),
    disallowedTools: disallowedToolsFor(mode)
  };
}

export function buildSessionOptions(config: AppConfig, session: SessionMetadata, request: StreamMessageRequest): SessionOptions {
  const mode = request.mode ?? session.mode;
  const model = request.model ?? config.defaultModel;
  if (!model) {
    throw new Error("CLAUDE_MODEL must be set when ENABLE_SESSION_API=true or the stream request must include model");
  }

  return {
    model,
    cwd: config.projectRoot,
    settingSources: ["project"],
    permissionMode: permissionModeFor(mode),
    allowDangerouslySkipPermissions: mode === "bypass",
    env: buildSafeAgentEnv(),
    disallowedTools: disallowedToolsFor(mode)
  };
}

export function buildAgentPrompt(request: StreamMessageRequest): AgentPrompt {
  if (request.toolResult) {
    return buildQuestionAnswerPrompt(request, request.toolResult);
  }

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

function buildQuestionAnswerPrompt(request: StreamMessageRequest, toolResult: NonNullable<StreamMessageRequest["toolResult"]>): AgentPrompt {
  const text = [
    "The user answered the AskUserQuestion form. Use these selections and continue the task.",
    "Do not ask the same questions again unless a required detail is still missing.",
    "",
    formatQuestionAnswers(toolResult.content) ?? `Answer payload:\n${toolResult.content}`,
    "",
    "User answer summary:",
    request.prompt
  ]
    .join("\n")
    .trim();

  if (!request.images || request.images.length === 0) {
    return text;
  }

  const message: SDKUserMessage = {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text },
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

function formatQuestionAnswers(content: string): string | undefined {
  const parsed = parseJsonRecord(content);
  if (!parsed || !isRecord(parsed.answers)) return undefined;

  const answers = Object.entries(parsed.answers);
  if (answers.length === 0) return undefined;

  return ["Selected answers:", ...answers.map(([question, answer]) => `- ${question}: ${formatAnswerValue(answer)}`)].join("\n");
}

function formatAnswerValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatAnswerValue).join(", ");
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function* singleMessagePrompt(message: SDKUserMessage): AsyncGenerator<SDKUserMessage> {
  yield message;
}

async function sendPrompt(session: SessionLike, prompt: AgentPrompt): Promise<void> {
  if (typeof prompt === "string") {
    await session.send(prompt);
    return;
  }

  for await (const message of prompt) {
    await session.send(message);
  }
}

function permissionModeFor(mode: ClaudeMode): "plan" | "bypassPermissions" | "acceptEdits" {
  if (mode === "plan") return "plan";
  if (mode === "bypass") return "bypassPermissions";
  return "acceptEdits";
}

function disallowedToolsFor(mode: ClaudeMode): string[] {
  // Claude Code plan mode still needs Write available for the generated plan file.
  // The built-in plan permission mode owns the read-only guard for implementation files.
  return mode === "plan" ? ["Bash"] : [];
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

export function getAskUserQuestionTool(message: unknown): Record<string, unknown> | null {
  if (!message || typeof message !== "object") return null;
  const record = message as Record<string, unknown>;
  if (record.stop_reason !== "tool_use" && record.stop_reason !== null && record.stop_reason !== undefined) return null;
  const content = Array.isArray(record.content) ? record.content : [];
  const tool = content.find((block) => {
    if (!block || typeof block !== "object") return false;
    const blockRecord = block as Record<string, unknown>;
    return blockRecord.type === "tool_use" && blockRecord.name === "AskUserQuestion";
  });
  return tool && typeof tool === "object" ? (tool as Record<string, unknown>) : null;
}

function getAskUserQuestionToolFromEvent(event: unknown): Record<string, unknown> | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;
  if (record.type !== "assistant") return null;
  return getAskUserQuestionTool(record.message);
}

function getSessionIdFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  return typeof record.session_id === "string" ? record.session_id : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

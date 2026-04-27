import { getSessionMessages, query } from "@anthropic-ai/claude-agent-sdk";
import type { AppConfig } from "./config.js";
import { buildSafeAgentEnv, buildSandboxSettings } from "./sandbox.js";
import type { ClaudeMode, NormalizedAgentEvent, SessionMetadata, StreamMessageRequest } from "./types.js";

export type AgentQuery = AsyncIterable<unknown> & {
  interrupt?: () => Promise<void>;
  close?: () => void;
};

export type AgentSdkAdapter = {
  query: (input: { prompt: string; options: Record<string, unknown> }) => AgentQuery;
  getSessionMessages: (sessionId: string, options?: { dir?: string; limit?: number; offset?: number }) => Promise<unknown[]>;
};

export type AgentRunInput = {
  session: SessionMetadata;
  request: StreamMessageRequest;
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
  private readonly activeRuns = new Map<string, { query: AgentQuery; abortController: AbortController }>();

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
    const agentQuery = this.adapter.query({ prompt: input.request.prompt, options });
    this.activeRuns.set(input.session.id, { query: agentQuery, abortController });

    try {
      for await (const message of agentQuery) {
        yield normalizeAgentMessage(message);
      }
    } finally {
      clearTimeout(timeout);
      agentQuery.close?.();
      this.activeRuns.delete(input.session.id);
    }
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
    sessionId: session.id,
    ...(session.hasRun ? { resume: session.id } : {}),
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

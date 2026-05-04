import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKSession,
  type SDKSessionOptions
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionMetadata } from "./types.js";

type SessionSystemPrompt =
  | string
  | string[]
  | {
      type: "preset";
      preset: "claude_code";
      append?: string;
      excludeDynamicSections?: boolean;
    };

export type SessionOptions = SDKSessionOptions & {
  systemPrompt?: SessionSystemPrompt;
};
export type SessionLike = SDKSession;

export type SessionFactory = {
  createSession(options: SessionOptions): SessionLike;
  resumeSession(sessionId: string, options: SessionOptions): SessionLike;
};

export type SessionPoolOptions = {
  idleTtlMs?: number;
};

type PooledSession = {
  session: SessionLike;
  lastActiveAt: number;
  optionSignature: string;
  running: boolean;
};

export class MissingClaudeSessionIdError extends Error {
  readonly code = "missing_claude_session_id";

  constructor(sessionId: string) {
    super(`Session ${sessionId} has run before but has no persisted Claude session ID`);
    this.name = "MissingClaudeSessionIdError";
  }
}

export class SessionPool {
  private readonly sessions = new Map<string, PooledSession>();
  private readonly idleTtlMs: number;

  constructor(
    private readonly factory: SessionFactory,
    options: SessionPoolOptions = {}
  ) {
    this.idleTtlMs = options.idleTtlMs ?? 5 * 60 * 1000;
  }

  getOrCreate(metadata: SessionMetadata, options: SessionOptions): SessionLike {
    const optionSignature = createOptionSignature(options);
    const existing = this.sessions.get(metadata.id);

    if (existing) {
      if (existing.optionSignature === optionSignature) {
        existing.lastActiveAt = Date.now();
        return existing.session;
      }
      existing.session.close();
      this.sessions.delete(metadata.id);
    }

    const session = metadata.hasRun
      ? this.resume(metadata, options)
      : this.factory.createSession(options);

    this.sessions.set(metadata.id, {
      session,
      optionSignature,
      lastActiveAt: Date.now(),
      running: false
    });

    return session;
  }

  markRunning(sessionId: string, running: boolean): void {
    const existing = this.sessions.get(sessionId);
    if (!existing) return;
    existing.running = running;
    existing.lastActiveAt = Date.now();
  }

  touch(sessionId: string): void {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastActiveAt = Date.now();
    }
  }

  close(sessionId: string): boolean {
    const existing = this.sessions.get(sessionId);
    if (!existing) return false;
    existing.session.close();
    this.sessions.delete(sessionId);
    return true;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  cleanupIdle(): void {
    const now = Date.now();
    for (const [sessionId, pooled] of this.sessions) {
      if (!pooled.running && now - pooled.lastActiveAt > this.idleTtlMs) {
        pooled.session.close();
        this.sessions.delete(sessionId);
      }
    }
  }

  closeAll(): void {
    for (const pooled of this.sessions.values()) {
      pooled.session.close();
    }
    this.sessions.clear();
  }

  private resume(metadata: SessionMetadata, options: SessionOptions): SessionLike {
    const sessionId = metadata.agentSessionId ?? metadata.claudeSessionId;
    if (!sessionId) {
      throw new MissingClaudeSessionIdError(metadata.id);
    }
    return this.factory.resumeSession(sessionId, options);
  }
}

export function createSessionFactory(): SessionFactory {
  return {
    createSession: (options) => unstable_v2_createSession(options),
    resumeSession: (sessionId, options) => unstable_v2_resumeSession(sessionId, options)
  };
}

function createOptionSignature(options: SessionOptions): string {
  return JSON.stringify({
    model: options.model,
    cwd: options.cwd,
    settingSources: options.settingSources ?? [],
    permissionMode: options.permissionMode,
    allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions ?? false,
    systemPrompt: options.systemPrompt,
    env: options.env ?? {},
    disallowedTools: options.disallowedTools ?? []
  });
}

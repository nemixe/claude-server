import { describe, expect, it, vi } from "vitest";
import { MissingAgentSessionIdError, SessionPool, type SessionLike, type SessionOptions } from "../src/session-adapter.js";
import type { SessionMetadata } from "../src/types.js";

describe("SessionPool", () => {
  it("creates for sessions that have not run", () => {
    const mockSession = createMockSession("claude-1");
    const factory = {
      createSession: vi.fn(() => mockSession),
      resumeSession: vi.fn(() => createMockSession("unused"))
    };
    const pool = new SessionPool(factory);

    const result = pool.getOrCreate(metadata({ hasRun: false }), defaultOptions());

    expect(result).toBe(mockSession);
    expect(factory.createSession).toHaveBeenCalledTimes(1);
    expect(factory.resumeSession).not.toHaveBeenCalled();
  });

  it("reuses warm sessions without resuming", () => {
    const mockSession = createMockSession("claude-1");
    const factory = {
      createSession: vi.fn(() => mockSession),
      resumeSession: vi.fn(() => createMockSession("resume-1"))
    };
    const pool = new SessionPool(factory);
    const appSession = metadata({ hasRun: false });

    pool.getOrCreate(appSession, defaultOptions());
    const second = pool.getOrCreate({ ...appSession, hasRun: true, agentSessionId: "claude-1" }, defaultOptions());

    expect(second).toBe(mockSession);
    expect(factory.createSession).toHaveBeenCalledTimes(1);
    expect(factory.resumeSession).not.toHaveBeenCalled();
  });

  it("cold-resumes with persisted agent session ID", () => {
    const resumed = createMockSession("claude-2");
    const factory = {
      createSession: vi.fn(() => createMockSession("unused")),
      resumeSession: vi.fn(() => resumed)
    };
    const pool = new SessionPool(factory);

    const result = pool.getOrCreate(metadata({ hasRun: true, agentSessionId: "claude-2" }), defaultOptions());

    expect(result).toBe(resumed);
    expect(factory.resumeSession).toHaveBeenCalledWith("claude-2", expect.any(Object));
  });

  it("throws when an already-run session has no persisted agent session ID", () => {
    const pool = new SessionPool({
      createSession: vi.fn(() => createMockSession("unused")),
      resumeSession: vi.fn(() => createMockSession("unused"))
    });

    expect(() => pool.getOrCreate(metadata({ hasRun: true }), defaultOptions())).toThrow(MissingAgentSessionIdError);
  });

  it("closes and cold-resumes when fixed options change", () => {
    const first = createMockSession("claude-1");
    const second = createMockSession("claude-1");
    const factory = {
      createSession: vi.fn(() => first),
      resumeSession: vi.fn(() => second)
    };
    const pool = new SessionPool(factory);
    const appSession = metadata({ hasRun: false });

    pool.getOrCreate(appSession, defaultOptions({ model: "claude-sonnet-4-6" }));
    const result = pool.getOrCreate(
      { ...appSession, hasRun: true, agentSessionId: "claude-1" },
      defaultOptions({ model: "claude-opus-4-7" })
    );

    expect(result).toBe(second);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(factory.resumeSession).toHaveBeenCalledWith("claude-1", expect.any(Object));
  });

  it("evicts only idle sessions", () => {
    vi.useFakeTimers();
    const idle = createMockSession("idle");
    const active = createMockSession("active");
    const factory = {
      createSession: vi.fn().mockReturnValueOnce(idle).mockReturnValueOnce(active),
      resumeSession: vi.fn(() => createMockSession("unused"))
    };
    const pool = new SessionPool(factory, { idleTtlMs: 5_000 });

    pool.getOrCreate(metadata({ id: "idle", hasRun: false }), defaultOptions());
    pool.getOrCreate(metadata({ id: "active", hasRun: false }), defaultOptions());
    pool.markRunning("active", true);

    vi.advanceTimersByTime(5_001);
    pool.cleanupIdle();

    expect(idle.close).toHaveBeenCalledTimes(1);
    expect(active.close).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("closes all sessions on dispose", () => {
    const first = createMockSession("one");
    const second = createMockSession("two");
    const factory = {
      createSession: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
      resumeSession: vi.fn(() => createMockSession("unused"))
    };
    const pool = new SessionPool(factory);

    pool.getOrCreate(metadata({ id: "one", hasRun: false }), defaultOptions());
    pool.getOrCreate(metadata({ id: "two", hasRun: false }), defaultOptions());
    pool.closeAll();

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
  });
});

function createMockSession(id: string): SessionLike {
  return {
    get sessionId() {
      return id;
    },
    send: vi.fn(),
    stream: vi.fn().mockImplementation(async function* () {}),
    close: vi.fn(),
    [Symbol.asyncDispose]: vi.fn()
  };
}

function metadata(overrides: Partial<SessionMetadata>): SessionMetadata {
  return {
    id: "app-1",
    mode: "bypass",
    workspacePath: "/tmp/workspace",
    createdAt: "now",
    updatedAt: "now",
    hasRun: false,
    ...overrides
  };
}

function defaultOptions(overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    model: "claude-sonnet-4-6",
    cwd: "/tmp/workspace",
    settingSources: ["project"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    env: { CLAUDE_AGENT_SDK_CLIENT_APP: "test" },
    disallowedTools: [],
    ...overrides
  };
}

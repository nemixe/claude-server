import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentService, buildSessionOptions, type AgentSdkAdapter } from "../src/agent-service.js";
import { MissingClaudeSessionIdError, type SessionFactory, type SessionLike } from "../src/session-adapter.js";
import type { SessionMetadata } from "../src/types.js";
import { createTempConfig } from "./helpers.js";

describe("buildSessionOptions", () => {
  it("uses request model and excludes query-only options", async () => {
    const config = await createTempConfig();
    const session = metadata(config.workspaceDir, { mode: "plan" });

    const options = buildSessionOptions(config, session, { prompt: "hello", model: "claude-sonnet-4-6" });

    expect(options).toMatchObject({
      model: "claude-sonnet-4-6",
      cwd: config.projectRoot,
      settingSources: ["project"],
      permissionMode: "plan",
      allowDangerouslySkipPermissions: false
    });
    expect(options.disallowedTools).toContain("Bash");
    expect(options.disallowedTools).not.toContain("Write");
    expect(options.disallowedTools).not.toContain("Edit");
    expect(options.disallowedTools).not.toContain("MultiEdit");
    expect(options).not.toHaveProperty("canUseTool");
    expect(options).not.toHaveProperty("systemPrompt");
    expect(options).not.toHaveProperty("tools");
    expect(options).not.toHaveProperty("sandbox");
    expect(options).not.toHaveProperty("maxTurns");
    expect(options).not.toHaveProperty("maxBudgetUsd");
    expect(options).not.toHaveProperty("abortController");
    expect(options).not.toHaveProperty("enableFileCheckpointing");
    expect(options).not.toHaveProperty("persistSession");
  });

  it("falls back to CLAUDE_MODEL and errors clearly when missing", async () => {
    const config = await createTempConfig({ CLAUDE_MODEL: "claude-opus-4-7" });
    const session = metadata(config.workspaceDir);

    expect(buildSessionOptions(config, session, { prompt: "hello" }).model).toBe("claude-opus-4-7");

    const missingModelConfig = await createTempConfig({ CLAUDE_MODEL: "" });
    expect(() => buildSessionOptions(missingModelConfig, session, { prompt: "hello" })).toThrow(/CLAUDE_MODEL/);
  });

  it("reads persisted messages from the configured project root", async () => {
    const config = await createTempConfig();
    let seenOptions: { dir?: string; limit?: number; offset?: number } | undefined;
    const adapter: AgentSdkAdapter = {
      query: () => (async function* () {})(),
      getSessionMessages: async (_sessionId, options) => {
        seenOptions = options;
        return [];
      }
    };

    await new AgentService(config, adapter).getMessages(metadata(config.workspaceDir), 10, 20);

    expect(seenOptions).toEqual({ dir: config.projectRoot, limit: 10, offset: 20 });
  });
});

describe("AgentService with V2 sessions", () => {
  it("creates first turn and reuses warm session for the second turn", async () => {
    const config = await createTempConfig();
    const mockSession = createMockSession("claude-1", () => resultStream("claude-1"));
    const factory: SessionFactory = {
      createSession: vi.fn(() => mockSession),
      resumeSession: vi.fn(() => createMockSession("unused", () => resultStream("unused")))
    };
    const service = new AgentService(config, undefined, factory);
    const session = metadata(config.workspaceDir, { hasRun: false });

    await collect(service.stream({ session, request: { prompt: "hello" } }));
    session.hasRun = true;
    session.claudeSessionId = "claude-1";
    await collect(service.stream({ session, request: { prompt: "again" } }));

    expect(factory.createSession).toHaveBeenCalledTimes(1);
    expect(factory.resumeSession).not.toHaveBeenCalled();
    expect(mockSession.send).toHaveBeenNthCalledWith(1, "hello");
    expect(mockSession.send).toHaveBeenNthCalledWith(2, "again");
  });

  it("cold-resumes with persisted Claude session ID", async () => {
    const config = await createTempConfig();
    const resumed = createMockSession("claude-resume", () => resultStream("claude-resume"));
    const factory: SessionFactory = {
      createSession: vi.fn(() => createMockSession("unused", () => resultStream("unused"))),
      resumeSession: vi.fn(() => resumed)
    };
    const service = new AgentService(config, undefined, factory);
    const session = metadata(config.workspaceDir, { hasRun: true, claudeSessionId: "claude-resume" });

    await collect(service.stream({ session, request: { prompt: "continue" } }));

    expect(factory.resumeSession).toHaveBeenCalledWith("claude-resume", expect.any(Object));
    expect(resumed.send).toHaveBeenCalledWith("continue");
  });

  it("throws missing_claude_session_id for already-run sessions without Claude ID", async () => {
    const config = await createTempConfig();
    const service = new AgentService(config, undefined, {
      createSession: vi.fn(() => createMockSession("unused", () => resultStream("unused"))),
      resumeSession: vi.fn(() => createMockSession("unused", () => resultStream("unused")))
    });

    await expect(
      collect(service.stream({ session: metadata(config.workspaceDir, { hasRun: true }), request: { prompt: "continue" } }))
    ).rejects.toMatchObject({ code: "missing_claude_session_id" });
  });

  it("closes on AskUserQuestion and resumes later with answer text", async () => {
    const config = await createTempConfig();
    const first = createMockSession("claude-ask", async function* () {
      yield {
        type: "assistant",
        session_id: "claude-ask",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "toolu_question",
              name: "AskUserQuestion",
              input: { questions: [{ question: "Continue?", options: [] }] }
            }
          ]
        }
      };
    });
    const resumed = createMockSession("claude-ask", () => resultStream("claude-ask"));
    const factory: SessionFactory = {
      createSession: vi.fn(() => first),
      resumeSession: vi.fn(() => resumed)
    };
    const service = new AgentService(config, undefined, factory);
    const session = metadata(config.workspaceDir, { hasRun: false });

    const events = await collect(
      service.stream({
        session,
        request: { prompt: "ask" },
        onClaudeSessionId: (claudeSessionId) => {
          session.claudeSessionId = claudeSessionId;
        }
      })
    );

    expect(events.map((event) => event.type)).toEqual(["message", "question_pending"]);
    expect(first.close).toHaveBeenCalledTimes(1);

    session.hasRun = true;
    await collect(
      service.stream({
        session,
        request: {
          prompt: "answer",
          toolResult: { toolUseId: "toolu_question", content: "Yes" }
        }
      })
    );

    expect(factory.resumeSession).toHaveBeenCalledWith("claude-ask", expect.any(Object));
    expect(resumed.send).toHaveBeenCalledWith(expect.stringContaining("The user answered the AskUserQuestion form"));
    expect(resumed.send).toHaveBeenCalledWith(expect.stringContaining("answer"));
  });

  it("closes/removes sessions on interrupt", async () => {
    const config = await createTempConfig();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mockSession = createMockSession("claude-interrupt", async function* () {
      yield { type: "system", subtype: "init", session_id: "claude-interrupt" };
      await gate;
    });
    const service = new AgentService(config, undefined, {
      createSession: vi.fn(() => mockSession),
      resumeSession: vi.fn(() => createMockSession("unused", () => resultStream("unused")))
    });
    const iterator = service.stream({ session: metadata(config.workspaceDir), request: { prompt: "wait" } });

    await iterator.next();
    await expect(service.interrupt("app-1")).resolves.toBe(true);
    expect(mockSession.close).toHaveBeenCalledTimes(1);
    release();
    await iterator.return?.(undefined);
  });

  it("broadcasts V2 session events to observers", async () => {
    const config = await createTempConfig();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mockSession = createMockSession("claude-observe", async function* () {
      await gate;
      yield { type: "result", session_id: "claude-observe", is_error: false };
    });
    const service = new AgentService(config, undefined, {
      createSession: vi.fn(() => mockSession),
      resumeSession: vi.fn(() => createMockSession("unused", () => resultStream("unused")))
    });
    const iterator = service.stream({ session: metadata(config.workspaceDir), request: { prompt: "observe" } });
    const nextEvent = iterator.next();
    await Promise.resolve();

    const observation = service.observe("app-1");
    const observed = observation.events[Symbol.asyncIterator]();
    release();

    await expect(nextEvent).resolves.toMatchObject({ value: { type: "result" }, done: false });
    await expect(observed.next()).resolves.toMatchObject({ value: { type: "result" }, done: false });
    await iterator.return?.(undefined);
    await observed.return?.(undefined);
  });
});

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function* resultStream(sessionId: string): AsyncGenerator<unknown> {
  yield { type: "result", session_id: sessionId, is_error: false };
}

function createMockSession(id: string, stream: () => AsyncGenerator<unknown>): SessionLike {
  return {
    get sessionId() {
      return id;
    },
    send: vi.fn(),
    stream: vi.fn().mockImplementation(stream),
    close: vi.fn(),
    [Symbol.asyncDispose]: vi.fn()
  } as unknown as SessionLike;
}

function metadata(workspaceDir: string, overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id: "app-1",
    mode: "bypass",
    workspacePath: path.join(workspaceDir, "app-1"),
    createdAt: "now",
    updatedAt: "now",
    hasRun: false,
    ...overrides
  };
}

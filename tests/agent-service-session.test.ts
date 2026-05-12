import fs from "node:fs/promises";
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
    expect(options).not.toHaveProperty("additionalDirectories");
    expect(options).not.toHaveProperty("plugins");
  });

  it("adds the Bottle directory and Claude plugin only when they exist", async () => {
    const config = await createTempConfig();
    await fs.mkdir(path.join(config.bottleDir, ".claude-plugin"), { recursive: true });
    await fs.writeFile(path.join(config.bottleDir, ".claude-plugin", "plugin.json"), "{}", "utf8");
    const session = metadata(config.workspaceDir, { mode: "plan" });

    const options = buildSessionOptions(config, session, { prompt: "hello", model: "claude-sonnet-4-6" });

    expect(options).toMatchObject({
      additionalDirectories: [config.bottleDir],
      plugins: [{ type: "local", path: config.bottleDir }]
    });
  });

  it("falls back to CLAUDE_MODEL and errors clearly when missing", async () => {
    const config = await createTempConfig({ CLAUDE_MODEL: "claude-opus-4-7" });
    const session = metadata(config.workspaceDir);

    expect(buildSessionOptions(config, session, { prompt: "hello" }).model).toBe("claude-opus-4-7");

    const missingModelConfig = await createTempConfig({ CLAUDE_MODEL: "" });
    expect(() => buildSessionOptions(missingModelConfig, session, { prompt: "hello" })).toThrow(/CLAUDE_MODEL/);
  });

  it("appends Bottle rules from .bottle/rules to the Claude Code system prompt and ignores .claude/rules", async () => {
    const config = await createTempConfig();
    const rulesDir = config.rulesDir;
    await fs.mkdir(path.join(rulesDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(rulesDir, "02-component.md"), "Use existing components.", "utf8");
    await fs.writeFile(path.join(rulesDir, "01-development.md"), "Follow project conventions.", "utf8");
    await fs.writeFile(path.join(rulesDir, "nested", "03-api.txt"), "Keep API routes stable.", "utf8");
    await fs.writeFile(path.join(rulesDir, "ignore.json"), "Do not include this.", "utf8");
    await fs.mkdir(path.join(config.projectRoot, ".claude", "rules"), { recursive: true });
    await fs.writeFile(path.join(config.projectRoot, ".claude", "rules", "legacy.md"), "Ignore legacy rules.", "utf8");
    const session = metadata(config.workspaceDir);

    const options = buildSessionOptions(config, session, { prompt: "hello" });

    expect(options.systemPrompt).toEqual(
      expect.objectContaining({
        type: "preset",
        preset: "claude_code"
      })
    );
    const systemPrompt = options.systemPrompt;
    if (!systemPrompt || typeof systemPrompt !== "object" || !("append" in systemPrompt)) {
      throw new Error("Expected appended system prompt");
    }
    expect(systemPrompt.append).toContain("Bottle rules loaded from `rules`");
    expect(systemPrompt.append).toContain("Bottle configuration and discovery are provided from `.bottle` and configured extra skill roots");
    expect(systemPrompt.append).toContain("## 01-development.md");
    expect(systemPrompt.append).toContain("Follow project conventions.");
    expect(systemPrompt.append).toContain("## 02-component.md");
    expect(systemPrompt.append).toContain("## nested/03-api.txt");
    expect(systemPrompt.append).not.toContain("ignore.json");
    expect(systemPrompt.append).not.toContain("Ignore legacy rules.");
    expect(systemPrompt.append.indexOf("01-development.md")).toBeLessThan(systemPrompt.append.indexOf("02-component.md"));
  });

  it("loads valid Bottle agent definitions into Claude session options", async () => {
    const config = await createTempConfig();
    await fs.mkdir(config.agentsDir, { recursive: true });
    await fs.writeFile(
      path.join(config.agentsDir, "api-reviewer.md"),
      [
        "---",
        "name: api-reviewer",
        "description: Reviews API changes",
        "tools: Read, Grep",
        "skills:",
        "  - api-guidance",
        "---",
        "",
        "You review API changes carefully."
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(path.join(config.agentsDir, "invalid.md"), "No metadata", "utf8");
    const session = metadata(config.workspaceDir);

    const options = buildSessionOptions(config, session, { prompt: "hello" });

    expect(options.agents).toEqual({
      "api-reviewer": expect.objectContaining({
        description: "Reviews API changes",
        prompt: "You review API changes carefully.",
        tools: ["Read", "Grep"],
        skills: ["api-guidance"]
      })
    });
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

  it("sends project rules in the prompt body so resumed sessions receive them", async () => {
    const config = await createTempConfig();
    const rulesDir = config.rulesDir;
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.writeFile(path.join(rulesDir, "01-development.md"), "Always inspect the existing module pattern first.", "utf8");
    const mockSession = createMockSession("claude-rules", () => resultStream("claude-rules"));
    const factory: SessionFactory = {
      createSession: vi.fn(() => mockSession),
      resumeSession: vi.fn(() => createMockSession("unused", () => resultStream("unused")))
    };
    const service = new AgentService(config, undefined, factory);

    await collect(service.stream({ session: metadata(config.workspaceDir), request: { prompt: "Create a product module" } }));

    expect(mockSession.send).toHaveBeenCalledWith(expect.stringContaining("<project_rules>"));
    expect(mockSession.send).toHaveBeenCalledWith(expect.stringContaining("Always inspect the existing module pattern first."));
    expect(mockSession.send).toHaveBeenCalledWith(expect.stringContaining("User request:\nCreate a product module"));
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

  it("includes project rules when cold-resuming a persisted Claude session", async () => {
    const config = await createTempConfig();
    const rulesDir = config.rulesDir;
    await fs.mkdir(rulesDir, { recursive: true });
    await fs.writeFile(path.join(rulesDir, "01-development.md"), "Keep generated modules consistent.", "utf8");
    const resumed = createMockSession("claude-rules-resume", () => resultStream("claude-rules-resume"));
    const factory: SessionFactory = {
      createSession: vi.fn(() => createMockSession("unused", () => resultStream("unused"))),
      resumeSession: vi.fn(() => resumed)
    };
    const service = new AgentService(config, undefined, factory);
    const session = metadata(config.workspaceDir, { hasRun: true, claudeSessionId: "claude-rules-resume" });

    await collect(service.stream({ session, request: { prompt: "continue product module" } }));

    expect(factory.resumeSession).toHaveBeenCalledWith(
      "claude-rules-resume",
      expect.objectContaining({
        systemPrompt: expect.objectContaining({
          append: expect.stringContaining("Keep generated modules consistent.")
        })
      })
    );
    expect(resumed.send).toHaveBeenCalledWith(expect.stringContaining("<project_rules>"));
    expect(resumed.send).toHaveBeenCalledWith(expect.stringContaining("Keep generated modules consistent."));
    expect(resumed.send).toHaveBeenCalledWith(expect.stringContaining("User request:\ncontinue product module"));
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

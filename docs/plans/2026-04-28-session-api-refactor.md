# Session API Refactor: Persistent Claude Processes

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Replace per-message `query()` spawning with persistent `createSession`/`resumeSession` processes that stay warm between turns, eliminating subprocess spawn and initialization overhead on resumed sessions.

**Architecture:** The AgentService will maintain a Map of active `SDKSession` instances keyed by session ID. When a user sends a message to an existing session, we reuse the warm process via `session.send()` + `session.stream()` instead of spawning a new `query()`. New sessions still use `createSession()`. Idle sessions are cleaned up after a configurable TTL.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` (v2 Session API: `unstable_v2_createSession`, `unstable_v2_resumeSession`), Node.js, TypeScript, Vitest

---

## Key Concepts

### Current Flow (per-message `query()`)
```
User message → AgentService.stream() → adapter.query() → spawn claude process → init handshake → resume from disk → API call → result → process exits
```
Every message pays: process spawn (~300-500ms) + CLI init + disk replay of entire transcript.

### New Flow (persistent Session)
```
First message → createSession(options) → spawn claude → init handshake → [process stays alive]
Next message → session.send(prompt) → stream() → API call → [process still alive, no re-init]
```
Subsequent messages skip: process spawn, CLI init, settingSources load, MCP server init, and full transcript replay.

### Session Lifecycle
- **Created** on first `messages:stream` for a new session → `createSession()`
- **Resumed** when `hasRun: true` → `resumeSession(sessionId, options)` + `session.send()`
- **Idle cleanup** after configurable TTL (default 5 min) — process killed, removed from map
- **Interrupt** → `session.close()` on the active session, then remove from map

---

### Task 1: Add SessionAdapter interface and SDK Session wrapper

**Files:**
- Create: `src/session-adapter.ts`
- Modify: `src/agent-service.ts:1-10` (imports)

**Step 1: Write the failing test**

Create `tests/session-adapter.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { SessionPool } from "../src/session-adapter.js";

describe("SessionPool", () => {
  it("creates a new session and returns its ID", async () => {
    const mockSession = createMockSession("session-1");
    const pool = new SessionPool({
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn().mockResolvedValue(mockSession),
    });
    const id = await pool.getOrCreate("session-1", { hasRun: false }, defaultOpts());
    expect(id).toBe("session-1");
  });

  it("reuses an active session for subsequent messages", async () => {
    const mockSession = createMockSession("session-1");
    const createSpy = vi.fn().mockResolvedValue(mockSession);
    const pool = new SessionPool({
      createSession: createSpy,
      resumeSession: vi.fn().mockResolvedValue(createMockSession("session-1")),
    });
    await pool.getOrCreate("session-1", { hasRun: false }, defaultOpts());
    const second = await pool.getOrCreate("session-1", { hasRun: true }, defaultOpts());
    expect(createSpy).toHaveBeenCalledTimes(1); // No new process spawned
  });

  it("removes a closed session and creates a new one on next access", async () => {
    const first = createMockSession("session-1");
    const second = createMockSession("session-1");
    first.close(); // simulate process exit
    const createSpy = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const pool = new SessionPool({
      createSession: createSpy,
      resumeSession: vi.fn().mockResolvedValue(createMockSession("session-1")),
    });
    await pool.getOrCreate("session-1", { hasRun: false }, defaultOpts());
    pool.remove("session-1"); // simulate cleanup after close
    await pool.getOrCreate("session-1", { hasRun: true }, defaultOpts());
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it("evicts idle sessions after TTL", async () => {
    vi.useFakeTimers();
    const mockSession = createMockSession("session-1");
    const closeSpy = vi.spyOn(mockSession, "close");
    const pool = new SessionPool(
      {
        createSession: vi.fn().mockResolvedValue(mockSession),
        resumeSession: vi.fn().mockResolvedValue(createMockSession("session-1")),
      },
      { idleTtlMs: 60_000, cleanupIntervalMs: 30_000 }
    );
    await pool.getOrCreate("session-1", { hasRun: false }, defaultOpts());
    vi.advanceTimersByTime(61_000);
    pool.cleanupIdle();
    expect(closeSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not evict recently-active sessions", async () => {
    vi.useFakeTimers();
    const mockSession = createMockSession("session-1");
    const closeSpy = vi.spyOn(mockSession, "close");
    const pool = new SessionPool(
      {
        createSession: vi.fn().mockResolvedValue(mockSession),
        resumeSession: vi.fn().mockResolvedValue(createMockSession("session-1")),
      },
      { idleTtlMs: 60_000, cleanupIntervalMs: 30_000 }
    );
    await pool.getOrCreate("session-1", { hasRun: false }, defaultOpts());
    vi.advanceTimersByTime(30_000);
    pool.touch("session-1"); // mark as recently active
    vi.advanceTimersByTime(30_000);
    pool.cleanupIdle();
    expect(closeSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

function createMockSession(id: string) {
  const listeners: Array<() => void> = [];
  return {
    sessionId: id,
    send: vi.fn(),
    stream: vi.fn().mockReturnValue(async function* () {}),
    close: vi.fn(() => {
      listeners.forEach((l) => l());
    }),
    [Symbol.asyncDispose]: vi.fn(),
    on: vi.fn((_event: string, handler: () => void) => {
      listeners.push(handler);
    }),
  };
}

function defaultOpts() {
  return {
    cwd: "/tmp/test-workspace",
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    systemPrompt: { type: "preset" as const, preset: "claude_code" },
    tools: { type: "preset" as const, preset: "claude_code" },
    settingSources: ["project"],
    persistSession: true,
    maxTurns: 30,
    model: undefined,
    sandbox: undefined,
    env: {},
    disallowedTools: [],
  };
}
```

**Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/session-adapter.test.ts
```
Expected: FAIL — `SessionPool` module not found.

**Step 3: Write the SessionPool implementation**

Create `src/session-adapter.ts`:

```typescript
import type { AgentSdkAdapter, AgentPrompt } from "./agent-service.js";
import type { ClaudeMode, SessionMetadata, StreamMessageRequest } from "./types.js";

export type SessionOptions = {
  cwd: string;
  permissionMode: string;
  allowDangerouslySkipPermissions: boolean;
  systemPrompt: unknown;
  tools: unknown;
  settingSources: string[];
  persistSession: boolean;
  maxTurns: number;
  model?: string;
  sandbox: unknown;
  env: Record<string, string | undefined>;
  disallowedTools: string[];
};

export type SessionLike = {
  sessionId: string;
  send(message: string | Record<string, unknown>): Promise<void>;
  stream(): AsyncGenerator<unknown, void>;
  close(): void;
  [Symbol.asyncDispose](): Promise<void>;
};

export type SessionPoolOptions = {
  idleTtlMs?: number;
  cleanupIntervalMs?: number;
};

export type SessionFactory = {
  createSession(options: SessionOptions): Promise<SessionLike>;
  resumeSession(sessionId: string, options: SessionOptions): Promise<SessionLike>;
};

type PooledSession = {
  session: SessionLike;
  lastActiveAt: number;
};

export class SessionPool {
  private readonly sessions = new Map<string, PooledSession>();
  private readonly factory: SessionFactory;
  private readonly idleTtlMs: number;
  private readonly cleanupIntervalMs: number;

  constructor(factory: SessionFactory, options?: SessionPoolOptions) {
    this.factory = factory;
    this.idleTtlMs = options?.idleTtlMs ?? 5 * 60 * 1000;
    this.cleanupIntervalMs = options?.cleanupIntervalMs ?? 60_000;
  }

  async getOrCreate(
    sessionId: string,
    metadata: { hasRun: boolean },
    options: SessionOptions
  ): Promise<SessionLike> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing.session;
    }
    const session = metadata.hasRun
      ? await this.factory.resumeSession(sessionId, options)
      : await this.factory.createSession(options);
    this.sessions.set(sessionId, { session, lastActiveAt: Date.now() });
    return session;
  }

  touch(sessionId: string): void {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastActiveAt = Date.now();
    }
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): SessionLike | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  cleanupIdle(): void {
    const now = Date.now();
    for (const [id, pooled] of this.sessions) {
      if (now - pooled.lastActiveAt > this.idleTtlMs) {
        pooled.session.close();
        this.sessions.delete(id);
      }
    }
  }

  closeAll(): void {
    for (const [, pooled] of this.sessions) {
      pooled.session.close();
    }
    this.sessions.clear();
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/session-adapter.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/session-adapter.ts tests/session-adapter.test.ts
git commit -m "feat: add SessionPool for persistent SDK sessions"
```

---

### Task 2: Create the real SDK Session adapter

**Files:**
- Modify: `src/agent-service.ts` (add `buildSessionOptions`, update `AgentSdkAdapter`)

**Step 1: Write the failing test**

Add to `tests/session-adapter.test.ts`:

```typescript
import { buildSessionOptions } from "../src/agent-service.js";

describe("buildSessionOptions", () => {
  it("builds options for new session (no resume)", () => {
    const config = { workspaceDir: "/tmp/ws", maxBudgetUsd: 1, maxTurns: 30 } as any;
    const session = { id: "abc-123", workspacePath: "/tmp/ws/abc-123", mode: "bypass", hasRun: false } as SessionMetadata;
    const request = { prompt: "hello" } as StreamMessageRequest;
    const options = buildSessionOptions(config, session, request, new AbortController(), 30);
    expect(options).not.toHaveProperty("resume");
    expect(options.cwd).toBe("/tmp/ws/abc-123");
    expect(options.persistSession).toBe(true);
    expect(options.settingSources).toEqual(["project"]);
  });

  it("resolves model from request when provided", () => {
    const config = { workspaceDir: "/tmp/ws", maxBudgetUsd: 1, maxTurns: 30 } as any;
    const session = { id: "abc-123", workspacePath: "/tmp/ws/abc-123", mode: "bypass", hasRun: true } as SessionMetadata;
    const request = { prompt: "hello", model: "claude-sonnet-4-6" } as StreamMessageRequest;
    const options = buildSessionOptions(config, session, request, new AbortController(), 30);
    expect(options.model).toBe("claude-sonnet-4-6");
  });
});
```

**Step 2: Run test to see it fails**

```bash
npx vitest run tests/session-adapter.test.ts
```
Expected: Some tests may pass (existing `buildAgentOptions`), but new `buildSessionOptions` should fail.

**Step 3: Export `buildSessionOptions` from agent-service.ts**

Add to `src/agent-service.ts` — factor out the options builder so it can be reused for both `query()` and `session` paths:

```typescript
export function buildSessionOptions(
  config: AppConfig,
  session: SessionMetadata,
  request: StreamMessageRequest,
  abortController: AbortController,
  runtimeMaxTurns: number
): Record<string, unknown> {
  // Same as buildAgentOptions but WITHOUT resume/sessionId
  // Those are handled at the session lifecycle level
  const mode = request.mode ?? session.mode;
  return {
    abortController,
    cwd: session.workspacePath,
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
    sandbox: buildSandboxSettings(config, session.workspacePath),
    disallowedTools: mode === "plan" ? ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"] : [],
  };
}
```

Also add the import for `SessionMetadata` to the test file and run:

**Step 4: Run tests**

```bash
npx vitest run tests/session-adapter.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent-service.ts tests/session-adapter.test.ts
git commit -m "feat: add buildSessionOptions for SDK session lifecycle"
```

---

### Task 3: Create the SDK Session adapter factory

**Files:**
- Modify: `src/agent-service.ts` (add `createSessionFactory`, `realSessionFactory`)

**Step 1: Write the failing test**

Add to `tests/session-adapter.test.ts`:

```typescript
import { createSessionFactory } from "../src/agent-service.js";
import { unstable_v2_createSession, unstable_v2_resumeSession } from "@anthropic-ai/claude-agent-sdk";

// Mock the SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  unstable_v2_createSession: vi.fn(),
  unstable_v2_resumeSession: vi.fn(),
}));

describe("createSessionFactory", () => {
  it("returns a factory that calls unstable_v2_createSession for new sessions", async () => {
    const mockSession = createMockSession("new-1");
    (unstable_v2_createSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);
    const factory = createSessionFactory();
    const result = await factory.createSession(defaultOpts());
    expect(unstable_v2_createSession).toHaveBeenCalled();
    expect(result).toBe(mockSession);
  });

  it("returns a factory that calls unstable_v2_resumeSession for resumed sessions", async () => {
    const mockSession = createMockSession("resume-1");
    (unstable_v2_resumeSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockSession);
    const factory = createSessionFactory();
    const result = await factory.resumeSession("resume-1", defaultOpts());
    expect(unstable_v2_resumeSession).toHaveBeenCalledWith("resume-1", expect.any(Object));
    expect(result).toBe(mockSession);
  });
});
```

**Step 2: Run test — should fail because `createSessionFactory` doesn't exist yet**

```bash
npx vitest run tests/session-adapter.test.ts
```
Expected: FAIL

**Step 3: Implement `createSessionFactory` in `agent-service.ts`**

```typescript
import { unstable_v2_createSession, unstable_v2_resumeSession } from "@anthropic-ai/claude-agent-sdk";

export type SessionAdapterFactory = {
  createSession(options: SessionOptions): Promise<SessionLike>;
  resumeSession(sessionId: string, options: SessionOptions): Promise<SessionLike>;
};

export function createSessionFactory(): SessionAdapterFactory {
  return {
    async createSession(options: SessionOptions): Promise<SessionLike> {
      const session = unstable_v2_createSession({
        model: options.model,
        cwd: options.cwd,
        permissionMode: options.permissionMode,
        allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions,
        systemPrompt: options.systemPrompt as string | string[] | { type: "preset"; preset: string },
        tools: options.tools as string[] | { type: "preset"; preset: string },
        settingSources: options.settingSources,
        persistSession: options.persistSession,
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
        env: options.env as Record<string, string>,
        sandbox: options.sandbox as any,
        disallowedTools: options.disallowedTools,
      });
      return session;
    },
    async resumeSession(sessionId: string, options: SessionOptions): Promise<SessionLike> {
      const session = unstable_v2_resumeSession(sessionId, {
        model: options.model,
        cwd: options.cwd,
        permissionMode: options.permissionMode,
        allowDangerouslySkipPermissions: options.allowDangerouslySkipPermissions,
        systemPrompt: options.systemPrompt as string | string[] | { type: "preset"; preset: string },
        tools: options.tools as string[] | { type: "preset"; preset: string },
        settingSources: options.settingSources,
        persistSession: options.persistSession,
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
        env: options.env as Record<string, string>,
        sandbox: options.sandbox as any,
        disallowedTools: options.disallowedTools,
      });
      return session;
    },
  };
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/session-adapter.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent-service.ts tests/session-adapter.test.ts
git commit -m "feat: add createSessionFactory for v2 Session API"
```

---

### Task 4: Refactor AgentService.stream() for session-based streaming

**Files:**
- Modify: `src/agent-service.ts` (replace `query()` path with session pool)

This is the critical task. The `stream()` method currently does:
```typescript
const agentQuery = this.adapter.query({ prompt, options });
for await (const message of agentQuery) { ... }
```

It needs to change to:
```typescript
const session = await this.pool.getOrCreate(session.id, session, options);
session.send(prompt);
for await (const event of session.stream()) { ... }
```

**Step 1: Write the failing test for the new stream behavior**

Add to `tests/session-adapter.test.ts`:

```typescript
describe("AgentService with SessionPool", () => {
  it("uses session pool for streaming instead of per-message query", async () => {
    const sentMessages: unknown[] = [];
    const streamedEvents = [
      { type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } },
      { type: "result", is_error: false },
    ];
    const mockSession = {
      ...createMockSession("pool-1"),
      send: vi.fn(async (msg: unknown) => { sentMessages.push(msg); }),
      stream: vi.fn().mockReturnValue((async function* () {
        for (const event of streamedEvents) yield event;
      })()),
    };

    const factory = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn().mockResolvedValue(mockSession),
    };

    const config = {
      workspaceDir: "/tmp/ws",
      sessionDir: "/tmp/sessions",
      maxBudgetUsd: 1,
      maxTurns: 30,
      runTimeoutMs: 600_000,
      sandboxAllowedDomains: [],
      projectRoot: "/tmp",
      port: 3000,
      bindHost: "0.0.0.0",
      allowedHosts: [],
      trustProxy: false,
      claudeCommandsDir: "/tmp/commands",
      maxConcurrentRuns: 4,
    } as AppConfig;

    const service = new AgentService(config, undefined, {
      createSession: factory.createSession,
      resumeSession: factory.resumeSession,
    });

    const session: SessionMetadata = {
      id: "pool-1",
      workspacePath: "/tmp/ws/pool-1",
      mode: "bypass",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasRun: false,
    };
    const request: StreamMessageRequest = { prompt: "Hello" };

    const events = [];
    for await (const event of service.stream({ session, request })) {
      events.push(event);
    }

    expect(factory.createSession).toHaveBeenCalledTimes(1);
    expect(mockSession.send).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(streamedEvents.length);
  });
});
```

**Step 2: Run test — should fail**

```bash
npx vitest run tests/session-adapter.test.ts
```
Expected: FAIL — `AgentService` constructor doesn't accept session pool yet.

**Step 3: Refactor `AgentService` to support both query (legacy) and session pool paths**

Modify `src/agent-service.ts` to:

1. Add `SessionPool` as an internal field
2. Add a constructor overload that accepts a `SessionFactory`
3. In `stream()`, check if a session pool exists — if so, use `pool.getOrCreate()` + `session.send()` + `session.stream()` instead of `adapter.query()`
4. Keep `defaultAgentSdkAdapter` as the fallback for backward compatibility
5. Normalize the SDK session's output events the same way `normalizeAgentMessage` works

```typescript
export class AgentService {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private maxConcurrentRuns: number;
  private maxTurns: number;
  private readonly pool?: SessionPool;
  private readonly adapter: AgentSdkAdapter;

  constructor(
    private readonly config: AppConfig,
    adapter?: AgentSdkAdapter,
    sessionFactory?: SessionAdapterFactory
  ) {
    this.maxConcurrentRuns = config.maxConcurrentRuns;
    this.maxTurns = config.maxTurns;
    this.adapter = adapter ?? defaultAgentSdkAdapter;
    if (sessionFactory) {
      this.pool = new SessionPool(sessionFactory);
    }
  }

  // ... rest unchanged for query path

  async *stream(input: AgentRunInput): AsyncGenerator<NormalizedAgentEvent> {
    // If we have a session pool, use the persistent session path
    if (this.pool) {
      yield* this.streamWithSession(input);
      return;
    }

    // Original query-based path (unchanged)
    // ...existing code...
  }

  private async *streamWithSession(input: AgentRunInput): AsyncGenerator<NormalizedAgentEvent> {
    const options = buildSessionOptions(
      this.config, input.session, input.request,
      new AbortController(), this.maxTurns
    );
    const session = await this.pool.getOrCreate(
      input.session.id,
      { hasRun: input.session.hasRun },
      options as SessionOptions
    );

    const prompt = buildAgentPrompt(input.request);
    if (typeof prompt === "string") {
      await session.send(prompt);
    } else {
      for await (const message of prompt) {
        await session.send(message);
      }
    }

    // Mark session as active so idle cleanup doesn't evict it
    this.pool.touch(input.session.id);

    for await (const message of session.stream()) {
      const questionTool = getAskUserQuestionToolFromEvent(message);
      const event = normalizeAgentMessage(message);
      broadcastEvent(activeRun, event);
      yield event;
      if (questionTool) {
        // Need to close session for AskUserQuestion flow
        session.close();
        this.pool.remove(input.session.id);
        const pendingEvent = {
          type: "question_pending",
          data: { waitingForUserQuestion: true, toolUseId: questionTool.id, input: questionTool.input },
        };
        yield pendingEvent;
        break;
      }
    }
  }
}
```

**Important remaining issue**: The `streamWithSession` needs to handle the `ActiveRun` tracking, `AbortController`, timeout, and `question_pending` flow. The exact integration will need some refactoring of the existing `stream()` method to extract shared logic. Also, the `AskUserQuestion` tool flow requires special handling since the SDK session stops the current turn but the process stays alive — we need to close and re-resume on the next user message.

**Step 4: Run all tests**

```bash
npx vitest run
```
Expected: All tests pass (both existing and new).

**Step 5: Commit**

```bash
git add src/agent-service.ts tests/session-adapter.test.ts
git commit -m "feat: AgentService.stream uses SessionPool when available"
```

---

### Task 5: Handle AskUserQuestion flow with persistent sessions

**Files:**
- Modify: `src/agent-service.ts` (AskUserQuestion → close session, re-resume)

When a persistent session hits `AskUserQuestion`, the SDK process stays alive but the turn is paused. The current server design closes the `query()` and expects the client to POST again with `toolResult`. With sessions:

1. When `AskUserQuestion` is detected → close the session, remove from pool
2. When the client sends `toolResult` → `resumeSession(sessionId)` + `send(toolResultMessage)` + `stream()`

**Step 1: Write the failing test**

```typescript
describe("AskUserQuestion with persistent sessions", () => {
  it("closes the session on AskUserQuestion and re-resumes with toolResult", async () => {
    const closeSpy = vi.fn();
    const questionTool = {
      type: "tool_use",
      id: "tool-1",
      name: "AskUserQuestion",
      input: { questions: [{ question: "Continue?", options: ["Yes", "No"] }] },
    };

    let callCount = 0;
    const mockSession = {
      ...createMockSession("ask-1"),
      close: closeSpy,
      stream: vi.fn().mockReturnValue((async function* () {
        callCount++;
        if (callCount === 1) {
          yield { type: "assistant", message: { content: [questionTool], stop_reason: "tool_use" } };
          // session stays alive — we detect question and close externally
        } else {
          yield { type: "result", is_error: false };
        }
      })()),
    };

    // On second call, resumeSession returns a fresh session
    let createCount = 0;
    const factory = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn().mockResolvedValue(mockSession),
    };

    // ... test body: stream with AskUserQuestion → close → re-resume with toolResult
  });
});
```

**Step 2: Run test — should fail**

**Step 3: Implement AskUserQuestion handling in `streamWithSession()`**

The key change: When `AskUserQuestion` is detected:
1. Call `session.close()` to end the process
2. Remove from pool
3. Yield `question_pending` event
4. On the next `stream()` call with `toolResult`, the pool's `getOrCreate()` with `hasRun: true` will call `resumeSession()` → new process → send tool result

**Step 4: Run tests**

**Step 5: Commit**

```bash
git commit -m "feat: handle AskUserQuestion with session close/re-resume"
```

---

### Task 6: Add idle session cleanup timer to AgentService

**Files:**
- Modify: `src/agent-service.ts` (add cleanup timer)

**Step 1: Write the failing test**

```typescript
describe("Session cleanup", () => {
  it("evicts idle sessions and closes their processes", async () => {
    vi.useFakeTimers();
    const mockSession = createMockSession("idle-1");
    const closeSpy = vi.spyOn(mockSession, "close");
    const factory = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      resumeSession: vi.fn().mockResolvedValue(createMockSession("idle-1")),
    };
    const service = new AgentService(config, undefined, factory, { idleTtlMs: 5_000 });
    // ... use service, advance time, verify cleanup
    vi.advanceTimersByTime(6_000);
    service.cleanupIdleSessions();
    expect(closeSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
```

**Step 2: Run test — should fail**

**Step 3: Implement cleanup timer in `AgentService`**

Add to constructor:
```typescript
if (this.pool) {
  this.cleanupTimer = setInterval(() => this.pool.cleanupIdle(), 60_000);
}
```

And a `dispose()` method:
```typescript
dispose(): void {
  if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  this.pool?.closeAll();
}
```

**Step 4: Run tests**

**Step 5: Commit**

```bash
git commit -m "feat: add idle session cleanup timer"
```

---

### Task 7: Wire up SessionPool in app.ts and add configuration

**Files:**
- Modify: `src/app.ts` (construct AgentService with session factory)
- Modify: `src/config.ts` (add `SESSION_IDLE_TTL_MS`, `USE_SESSION_API` env vars)

**Step 1: Add config vars**

In `src/config.ts`, add:
```typescript
useSessionApi: boolean;  // ENABLE_SESSION_API env, default false (feature flag)
sessionIdleTtlMs: number; // SESSION_IDLE_TTL_MS env, default 300000 (5 min)
```

**Step 2: Wire up in `app.ts`**

In `createApp()`:
```typescript
const sessionFactory = config.useSessionApi ? createSessionFactory() : undefined;
const agentService = dependencies.agentService ?? new AgentService(config, undefined, sessionFactory);
```

**Step 3: Run all tests**

```bash
npx vitest run
```

**Step 4: Commit**

```bash
git add src/config.ts src/app.ts
git commit -m "feat: wire up SessionPool with feature flag ENABLE_SESSION_API"
```

---

### Task 8: Update the chat-contract client for session-based flow

**Files:**
- Modify: `src/chat-contract.ts` (add session-aware path)

When `ENABLE_SESSION_API` is active on the server, the client no longer needs to create a session via `POST /v1/sessions` first and then stream. The server can auto-create + stream in a single request. However, for now, we keep the existing API contract — the client continues to use the same `POST /v1/sessions/:id/messages:stream` endpoint, and the server internally uses `SessionPool` instead of `query()`.

No client changes needed for the initial rollout. The client remains API-compatible.

**Step 1: Verify chat-contract still works end-to-end**

```bash
npx vitest run tests/chat-contract.test.ts
```

**Step 2: Commit (if any changes needed)**

```bash
git commit -m "chore: verify chat-contract compatibility with session pool"
```

---

### Task 9: Integration test — session reuse eliminates re-spawn

**Files:**
- Create: `tests/session-integration.test.ts`

**Step 1: Write an integration test that verifies session reuse**

This test verifies that when `AgentService` uses `SessionPool`, two consecutive messages to the same session only call `createSession` once (spot check) and `resumeSession` once on the second message.

```typescript
describe("Session integration: reuse across messages", () => {
  it("calls resumeSession for second message on same session", async () => {
    const createCalls: SessionOptions[] = [];
    const resumeCalls: { id: string; opts: SessionOptions }[] = [];

    const firstSession = createMockSession("reuse-1");
    const resumedSession = createMockSession("reuse-1");

    firstSession.send = vi.fn();
    firstSession.stream = vi.fn().mockReturnValue((async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "First response" }] } };
      yield { type: "result", is_error: false, total_cost_usd: 0.01 };
    })());

    resumedSession.stream = vi.fn().mockReturnValue((async function* () {
      yield { type: "assistant", message: { content: [{ type: "text", text: "Second response" }] } };
      yield { type: "result", is_error: false, total_cost_usd: 0.02 };
    })());

    const factory: SessionAdapterFactory = {
      createSession: vi.fn(async (opts) => { createCalls.push(opts); return firstSession; }),
      resumeSession: vi.fn(async (id, opts) => { resumeCalls.push({ id, opts }); return resumedSession; }),
    };

    const service = new AgentService(config, undefined, factory);
    const session = { id: "reuse-1", workspacePath: "/tmp/ws/reuse-1", mode: "bypass" as ClaudeMode, hasRun: false, createdAt: "", updatedAt: "" };

    // First message — creates session
    const events1 = [];
    for await (const e of service.stream({ session, request: { prompt: "Hello" } })) {
      events1.push(e);
    }
    expect(createCalls).toHaveLength(1);
    expect(resumeCalls).toHaveLength(0);

    // Second message — resumes session
    session.hasRun = true;
    const events2 = [];
    for await (const e of service.stream({ session, request: { prompt: "World" } })) {
      events2.push(e);
    }
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0].id).toBe("reuse-1");
  });
});
```

**Step 2: Run the test**

```bash
npx vitest run tests/session-integration.test.ts
```

**Step 3: Commit**

```bash
git add tests/session-integration.test.ts
git commit -m "test: add integration test for session reuse across messages"
```

---

### Task 10: End-to-end verification

**Step 1: Run the full test suite**

```bash
npx vitest run
```
Expected: ALL tests pass.

**Step 2: Manual smoke test with feature flag off**

```bash
ENABLE_SESSION_API= npm start
```
Verify the existing `query()` path still works by sending messages through the test client.

**Step 3: Manual smoke test with feature flag on**

```bash
ENABLE_SESSION_API=true npm start
```
Send a message, wait for response, send another message to the same session. Confirm the second message is faster (no subprocess spawn overhead).

**Step 4: Commit final state**

```bash
git commit -m "feat: persistent session API with feature flag"
```

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| `unstable_v2_createSession` / `unstable_v2_resumeSession` are alpha APIs | Feature flag (`ENABLE_SESSION_API=false` by default); fall back to `query()` |
| SDK session process may crash/leak | `SessionPool.cleanupIdle()` with TTL + `closeAll()` on shutdown |
| Concurrency limit no longer maps 1:1 with `query()` | `maxConcurrentRuns` limits active sessions in `SessionPool.getOrCreate()` |
| `AskUserQuestion` flow differs (session stays alive) | Close session on question → re-resume with `toolResult` |
| Memory pressure from many idle sessions | TTL-based eviction + configurable `SESSION_IDLE_TTL_MS` |
| SDK types are marked `@alpha` | Wrap in adapter interface, isolate from rest of codebase |
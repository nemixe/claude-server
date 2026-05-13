import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AgentService,
  buildCodexClientOptions,
  buildCodexThreadOptions,
  normalizeCodexEvent,
  RunAbortedError,
  RunTimeoutError,
  type CodexSdkAdapter,
  type CodexSdkFactory,
  type CodexThreadLike
} from "../src/agent-service.js";
import type { SessionMetadata } from "../src/types.js";
import { createTempConfig } from "./helpers.js";

describe("Codex AgentService runtime", () => {
  it("maps Bottle modes to Codex sandbox options", async () => {
    const config = await createTempConfig({ AGENT_PROVIDER: "codex", CODEX_MODEL: "gpt-5.5", CODEX_REASONING_EFFORT: "high" });
    await fs.mkdir(config.bottleDir, { recursive: true });
    const session = metadata(config.workspaceDir);

    expect(buildCodexThreadOptions(config, session, { prompt: "plan", mode: "plan" })).toMatchObject({
      model: "gpt-5.5",
      modelReasoningEffort: "high",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      workingDirectory: config.projectRoot,
      additionalDirectories: [config.bottleDir],
      skipGitRepoCheck: true
    });
    expect(buildCodexThreadOptions(config, session, { prompt: "edit", mode: "edit" }).sandboxMode).toBe("workspace-write");
    expect(buildCodexThreadOptions(config, session, { prompt: "run", mode: "bypass" }).sandboxMode).toBe("danger-full-access");
  });

  it("passes Codex client options from config", async () => {
    const config = await createTempConfig({
      AGENT_PROVIDER: "codex",
      CODEX_API_KEY: "codex-secret",
      CODEX_BASE_URL: "https://api.example.com",
      CODEX_PATH: "/usr/local/bin/codex"
    });

    expect(buildCodexClientOptions(config)).toEqual({
      apiKey: "codex-secret",
      baseUrl: "https://api.example.com",
      codexPathOverride: "/usr/local/bin/codex"
    });
  });

  it("passes Bottle discovery folders and catalog to Codex", async () => {
    const extraSkillRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-extra-skills-"));
    const missingSkillRoot = path.join(extraSkillRoot, "missing");
    const config = await createTempConfig({ AGENT_PROVIDER: "codex", BOTTLE_EXTRA_SKILL_ROOTS: `${extraSkillRoot},${missingSkillRoot}` });
    await fs.mkdir(path.join(config.skillsDir, "ux", "references"), { recursive: true });
    await fs.mkdir(config.commandsDir, { recursive: true });
    await fs.mkdir(path.join(extraSkillRoot, "api", "scripts"), { recursive: true });
    await fs.mkdir(path.join(extraSkillRoot, "api", "assets", "template"), { recursive: true });
    await fs.mkdir(path.join(extraSkillRoot, "ux"), { recursive: true });
    await fs.writeFile(path.join(config.commandsDir, "review.md"), "---\ndescription: Review current changes\n---\nReview.", "utf8");
    await fs.writeFile(path.join(config.skillsDir, "ux", "SKILL.md"), "---\ndescription: UX review\n---\nReview UI body should stay out.", "utf8");
    await fs.writeFile(path.join(config.skillsDir, "ux", "references", "colors.md"), "resource content should stay out", "utf8");
    await fs.writeFile(path.join(extraSkillRoot, "api", "SKILL.md"), "---\ndescription: API guidance\n---\nAPI body should stay out.", "utf8");
    await fs.writeFile(path.join(extraSkillRoot, "api", "scripts", "build.js"), "script content should stay out", "utf8");
    await fs.writeFile(path.join(extraSkillRoot, "ux", "SKILL.md"), "---\ndescription: Duplicate UX should be omitted\n---\nDuplicate body.", "utf8");
    let promptText = "";
    const thread = createMockThread(() => codexResultStream("codex-discovery", "Done."), async (input) => {
      promptText = typeof input === "string" ? input : JSON.stringify(input);
    });
    const adapter = createMockCodexAdapter(thread);
    const service = new AgentService(config, undefined, undefined, () => adapter);

    await collect(service.stream({ session: metadata(config.workspaceDir), request: { prompt: "hello" } }));

    expect(adapter.startThread).toHaveBeenCalledWith(expect.objectContaining({ additionalDirectories: [config.bottleDir, extraSkillRoot] }));
    expect(promptText).toContain("Bottle discovery folders:");
    expect(promptText).toContain("Bottle configuration and discovery are provided from `.bottle` and configured extra skill roots");
    expect(promptText).toContain("Treat that Bottle context as the authoritative project guidance");
    expect(promptText).toContain("/review (review.md) - Review current changes");
    expect(promptText).toContain("Skill manifest:");
    expect(promptText).toContain(`- ux - UX review; source: .bottle/skills (${config.skillsDir}); SKILL.md: ${path.join(config.skillsDir, "ux", "SKILL.md")}`);
    expect(promptText).toContain(`- api - API guidance; source: extra-1 (${extraSkillRoot}); SKILL.md: ${path.join(extraSkillRoot, "api", "SKILL.md")}`);
    expect(promptText).toContain("references[colors.md]");
    expect(promptText).toContain("scripts[build.js]");
    expect(promptText).toContain("assets[template/]");
    expect(promptText).not.toContain("Review UI body should stay out");
    expect(promptText).not.toContain("API body should stay out");
    expect(promptText).not.toContain("resource content should stay out");
    expect(promptText).not.toContain("script content should stay out");
    expect(promptText).not.toContain("Duplicate UX should be omitted");
    expect(promptText).not.toContain(missingSkillRoot);
  });

  it("starts a Codex thread and normalizes streamed events", async () => {
    const config = await createTempConfig({ AGENT_PROVIDER: "codex", CODEX_MODEL: "gpt-5.5" });
    const thread = createMockThread(() => codexResultStream("codex-1", "Done."));
    const adapter = createMockCodexAdapter(thread);
    const service = new AgentService(config, undefined, undefined, () => adapter);
    const session = metadata(config.workspaceDir);

    const events = await collect(service.stream({ session, request: { prompt: "hello" } }));

    expect(adapter.startThread).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.5" }));
    expect(adapter.resumeThread).not.toHaveBeenCalled();
    expect(thread.runStreamed).toHaveBeenCalledWith("hello", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(session.agentSessionId).toBe("codex-1");
    expect(events.map((event) => event.type)).toEqual(["codex_event", "message", "codex_event", "result", "codex_event"]);
    expect(events.find((event) => event.type === "message")).toMatchObject({
      data: { message: { role: "assistant", content: "Done." } }
    });
    expect(events.find((event) => event.type === "result")).toMatchObject({
      data: { session_id: "codex-1", result: "Done.", is_error: false }
    });
  });

  it("turns Codex assistant questions into AskUserQuestion pending events", async () => {
    const config = await createTempConfig({ AGENT_PROVIDER: "codex" });
    const thread = createMockThread(() =>
      codexResultStream(
        "codex-question",
        [
          "What fields should `Product` have?",
          "",
          "Please send them like this:",
          "",
          "```txt",
          "name: string, required",
          "price: decimal, required",
          "description: text, optional",
          "```"
        ].join("\n")
      )
    );
    const service = new AgentService(config, undefined, undefined, () => createMockCodexAdapter(thread));
    const session = metadata(config.workspaceDir);

    const events = await collect(service.stream({ session, request: { prompt: "Create crud feature product ask me the fields", mode: "plan" } }));

    expect(events.map((event) => event.type)).toEqual([
      "codex_event",
      "message",
      "codex_event",
      "result",
      "codex_event",
      "question_pending"
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "question_pending",
      data: {
        waitingForUserQuestion: true,
        toolUseId: "codex-question:item-1",
        input: {
          questions: [
            {
              id: "codex-question-1",
              question: "What fields should `Product` have?",
              multiSelect: true,
              options: [
                { label: "name: string, required", description: "" },
                { label: "price: decimal, required", description: "" },
                { label: "description: text, optional", description: "" }
              ]
            }
          ]
        }
      }
    });
    expect(session).toMatchObject({
      status: "awaiting_user_input",
      pendingInterrupt: {
        type: "user_input",
        toolCallId: "codex-question:item-1",
        toolName: "AskUserQuestion"
      }
    });
    expect(events.map((event) => event.type)).not.toContain("approval_pending");
  });

  it("adds fallback choices for generic Codex user questions", async () => {
    const config = await createTempConfig({ AGENT_PROVIDER: "codex" });
    const thread = createMockThread(() =>
      codexResultStream(
        "codex-greeting-question",
        "Hi. What would you like me to work on? I’m in plan mode, so I’ll inspect/read only and give you an implementation plan before any edits."
      )
    );
    const service = new AgentService(config, undefined, undefined, () => createMockCodexAdapter(thread));
    const session = metadata(config.workspaceDir);

    const events = await collect(service.stream({ session, request: { prompt: "Hello", mode: "plan" } }));

    expect(events.at(-1)).toMatchObject({
      type: "question_pending",
      data: {
        input: {
          questions: [
            {
              question: "Hi. What would you like me to work on?",
              options: [
                { label: "Build a feature", description: "Describe the feature or workflow to add." },
                { label: "Fix a bug", description: "Describe the broken behavior and expected result." },
                { label: "Review code", description: "Name the file, change, or area to review." },
                { label: "Explain code", description: "Ask about a file, flow, or error." }
              ]
            }
          ]
        }
      }
    });
  });

  it("turns final Codex plan-mode messages into ExitPlanMode approval events", async () => {
    const config = await createTempConfig({ AGENT_PROVIDER: "codex" });
    let promptText = "";
    const thread = createMockThread(
      () =>
        codexResultStream(
          "codex-plan",
          [
            "Blocked by the current sandbox: the workspace is read-only, and apply_patch was rejected.",
            "",
            "I inspected the repo. The product CRUD feature should be added as:",
            "",
            "- New src/product-store.ts file-backed store",
            "- New /v1/products CRUD routes",
            "- Client helpers and route tests",
            "",
            "I wasn’t able to run tests because no files could be written. Re-run this with write access."
          ].join("\n")
        ),
      async (input) => {
        promptText = typeof input === "string" ? input : JSON.stringify(input);
      }
    );
    const service = new AgentService(config, undefined, undefined, () => createMockCodexAdapter(thread));
    const session = metadata(config.workspaceDir, { mode: "plan" });

    const events = await collect(service.stream({ session, request: { prompt: "Create product CRUD", mode: "plan" } }));

    expect(promptText).toContain("You are in plan mode. Inspect/read only. Do not modify files.");
    expect(promptText).toContain("Use the Bottle discovery folders and configured extra skill roots as the authoritative source for project instructions");
    expect(promptText).toContain("include 2-4 concise suggested options as simple bullet lines");
    expect(events.map((event) => event.type)).toEqual([
      "codex_event",
      "message",
      "codex_event",
      "result",
      "codex_event",
      "approval_pending"
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "approval_pending",
      data: {
        waitingForApproval: true,
        toolUseId: "codex-plan:item-1",
        plan: expect.stringContaining("The product CRUD feature should be added as:")
      }
    });
    const approval = events.at(-1)?.data as { plan?: string };
    expect(approval.plan).not.toContain("Blocked by the current sandbox");
    expect(approval.plan).not.toContain("Re-run this with write access");
    expect(session).toMatchObject({
      status: "awaiting_approval",
      pendingInterrupt: {
        type: "approval",
        toolCallId: "codex-plan:item-1",
        toolName: "ExitPlanMode",
        payload: {
          plan: expect.stringContaining("New /v1/products CRUD routes"),
          action: "exit_plan_mode",
          source: "codex_agent_message"
        }
      }
    });
  });

  it("treats route query strings in Codex plans as approval instead of questions", async () => {
    const config = await createTempConfig({ AGENT_PROVIDER: "codex" });
    const thread = createMockThread(() =>
      codexResultStream(
        "codex-plan-route-query",
        [
          "Sandbox masih menolak semua command baca, jadi scope dari prompt sudah cukup jelas untuk rencana edit.",
          "",
          "**Rencana Implementasi**",
          "",
          "1. Saat edit mode tersedia, baca file wajib:",
          "   - `.bottle/skills/manage-page/SKILL.md`",
          "   - `.clinerules`",
          "",
          "2. Cari implementasi halaman detail:",
          "   - Route aktif: `/configuration/promotion-demotion/a1b2c3d4-5678-4efa-9012-345678901234?tab=promosi`",
          "   - Target: halaman **Detail Konfigurasi Promotion Increase**, tab `promosi`.",
          "",
          "3. Verifikasi:",
          "   - Buka route /configuration/promotion-demotion/a1b2c3d4-5678-4efa-9012-345678901234?tab=promosi saat verifikasi.",
          "   - Buka route detail dengan `tab=promosi`.",
          "   - Pastikan tombol `Edit` dan `Delete` sudah hilang, sementara konten detail dan tab tetap berfungsi."
        ].join("\n")
      )
    );
    const service = new AgentService(config, undefined, undefined, () => createMockCodexAdapter(thread));
    const session = metadata(config.workspaceDir, { mode: "plan" });

    const events = await collect(service.stream({ session, request: { prompt: "Remove detail actions", mode: "plan" } }));
    const eventTypes = events.map((event) => event.type);

    expect(eventTypes).toEqual(["codex_event", "message", "codex_event", "result", "codex_event", "approval_pending"]);
    expect(eventTypes).not.toContain("question_pending");
    expect(events.at(-1)).toMatchObject({
      type: "approval_pending",
      data: {
        waitingForApproval: true,
        toolUseId: "codex-plan:item-1",
        plan: expect.stringContaining("Route aktif:")
      }
    });
    expect(session).toMatchObject({
      status: "awaiting_approval",
      pendingInterrupt: {
        type: "approval",
        toolCallId: "codex-plan:item-1",
        toolName: "ExitPlanMode"
      }
    });
  });

  it("does not synthesize a question from inline-code route query strings", async () => {
    const config = await createTempConfig({ AGENT_PROVIDER: "codex" });
    const thread = createMockThread(() =>
      codexResultStream("codex-inline-route-query", "The active route is `/configuration/promotion-demotion/123?tab=promosi`.")
    );
    const service = new AgentService(config, undefined, undefined, () => createMockCodexAdapter(thread));
    const session = metadata(config.workspaceDir, { mode: "edit" });

    const events = await collect(service.stream({ session, request: { prompt: "Inspect the current route", mode: "edit" } }));

    expect(events.map((event) => event.type)).toEqual(["codex_event", "message", "codex_event", "result", "codex_event"]);
    expect(session.pendingInterrupt).toBeUndefined();
  });

  it("uses proposed_plan content for synthetic Codex approval plans", async () => {
    const config = await createTempConfig({ AGENT_PROVIDER: "codex" });
    const thread = createMockThread(() =>
      codexResultStream("codex-proposed-plan", "<proposed_plan>\n# Build Products\n\n- Add a store.\n</proposed_plan>")
    );
    const service = new AgentService(config, undefined, undefined, () => createMockCodexAdapter(thread));

    const events = await collect(
      service.stream({ session: metadata(config.workspaceDir, { mode: "plan" }), request: { prompt: "Create product CRUD" } })
    );

    expect(events.at(-1)).toMatchObject({
      type: "approval_pending",
      data: {
        plan: "# Build Products\n\n- Add a store."
      }
    });
  });

  it("does not synthesize Codex plan approvals outside plan mode", async () => {
    const config = await createTempConfig({ AGENT_PROVIDER: "codex" });
    const thread = createMockThread(() => codexResultStream("codex-edit", "Implementation plan:\n\n- Add the product store."));
    const service = new AgentService(config, undefined, undefined, () => createMockCodexAdapter(thread));
    const session = metadata(config.workspaceDir, { mode: "edit" });

    const events = await collect(service.stream({ session, request: { prompt: "Create product CRUD", mode: "edit" } }));

    expect(events.map((event) => event.type)).not.toContain("approval_pending");
    expect(session.pendingInterrupt).toBeUndefined();
  });

  it("resumes a persisted Codex thread", async () => {
    const config = await createTempConfig({ AGENT_PROVIDER: "codex" });
    const thread = createMockThread(() => codexResultStream("codex-resume", "Again."));
    const adapter = createMockCodexAdapter(thread);
    const service = new AgentService(config, undefined, undefined, () => adapter);
    const session = metadata(config.workspaceDir, { hasRun: true, agentSessionId: "codex-resume" });

    await collect(service.stream({ session, request: { prompt: "continue" } }));

    expect(adapter.startThread).not.toHaveBeenCalled();
    expect(adapter.resumeThread).toHaveBeenCalledWith("codex-resume", expect.any(Object));
  });

  it("writes prompt images to temporary files and cleans them up", async () => {
    const config = await createTempConfig({ AGENT_PROVIDER: "codex" });
    let imagePath = "";
    const thread = createMockThread(() => codexResultStream("codex-images", "Looked."), async (input) => {
      if (!Array.isArray(input)) throw new Error("Expected structured Codex input");
      imagePath = input.find((item) => item.type === "local_image")?.path ?? "";
      expect(imagePath).toBeTruthy();
      await expect(fs.readFile(imagePath, "utf8")).resolves.toBe("hello");
    });
    const service = new AgentService(config, undefined, undefined, () => createMockCodexAdapter(thread));

    await collect(
      service.stream({
        session: metadata(config.workspaceDir),
        request: {
          prompt: "describe",
          images: [{ name: "pixel.png", mediaType: "image/png", dataBase64: Buffer.from("hello").toString("base64") }]
        }
      })
    );

    await expect(fs.stat(imagePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts an active Codex turn on interrupt", async () => {
    const config = await createTempConfig({ AGENT_PROVIDER: "codex" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seenSignal: AbortSignal | undefined;
    const thread = createMockThread(async function* () {
      yield { type: "thread.started", thread_id: "codex-abort" };
      await gate;
    }, async (_input, options) => {
      seenSignal = options?.signal;
    });
    const service = new AgentService(config, undefined, undefined, () => createMockCodexAdapter(thread));
    const iterator = service.stream({ session: metadata(config.workspaceDir), request: { prompt: "wait" } });

    await iterator.next();
    await expect(service.interrupt("app-1")).resolves.toBe(true);
    expect(seenSignal?.aborted).toBe(true);
    release();
    await iterator.return?.(undefined);
  });

  it("reports an explicit Codex interrupt instead of a generic agent error", async () => {
    const config = await createTempConfig({ AGENT_PROVIDER: "codex" });
    let seenSignal: AbortSignal | undefined;
    const thread = createMockThread(
      async function* () {
        yield { type: "thread.started", thread_id: "codex-interrupt" };
        await new Promise<void>((_, reject) => {
          if (seenSignal?.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          seenSignal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        });
      },
      (_input, options) => {
        seenSignal = options?.signal;
      }
    );
    const service = new AgentService(config, undefined, undefined, () => createMockCodexAdapter(thread));
    const iterator = service.stream({ session: metadata(config.workspaceDir), request: { prompt: "wait" } });

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "codex_event" }, done: false });
    const rejection = iterator.next().catch((error: unknown) => error);
    await Promise.resolve();
    await expect(service.interrupt("app-1")).resolves.toBe(true);

    await expect(rejection).resolves.toBeInstanceOf(RunAbortedError);
    await expect(rejection).resolves.toMatchObject({
      code: "run_interrupted",
      message: "Agent run was interrupted"
    });
  });

  it("reports a run timeout when a Codex stream exceeds RUN_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const config = await createTempConfig({ AGENT_PROVIDER: "codex", RUN_TIMEOUT_MS: "50" });
    let seenSignal: AbortSignal | undefined;
    const thread = createMockThread(
      async function* () {
        yield { type: "thread.started", thread_id: "codex-timeout" };
        await new Promise<void>((_, reject) => {
          seenSignal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        });
      },
      (_input, options) => {
        seenSignal = options?.signal;
      }
    );
    const service = new AgentService(config, undefined, undefined, () => createMockCodexAdapter(thread));

    try {
      const pending = collect(service.stream({ session: metadata(config.workspaceDir), request: { prompt: "wait" } }));
      const rejection = pending.catch((error: unknown) => error);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);

      await expect(rejection).resolves.toBeInstanceOf(RunTimeoutError);
      expect(seenSignal?.aborted).toBe(true);
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  });

  it("normalizes failed Codex turns as Bottle errors", () => {
    expect(
      normalizeCodexEvent({ type: "turn.failed", error: { message: "boom" } }, "codex-1", "")[0]
    ).toMatchObject({ type: "error", data: { error: { code: "codex_turn_failed", message: "boom" } } });
  });
});

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function* codexResultStream(threadId: string, text: string): AsyncGenerator<Parameters<typeof normalizeCodexEvent>[0]> {
  yield { type: "thread.started", thread_id: threadId };
  yield { type: "item.completed", item: { id: "item-1", type: "agent_message", text } };
  yield {
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 }
  };
}

function createMockThread(
  stream: () => AsyncGenerator<Parameters<typeof normalizeCodexEvent>[0]>,
  onRun?: (input: Parameters<CodexThreadLike["runStreamed"]>[0], options: Parameters<CodexThreadLike["runStreamed"]>[1]) => void | Promise<void>
): CodexThreadLike {
  return {
    id: null,
    runStreamed: vi.fn(async (input, options) => {
      await onRun?.(input, options);
      return { events: stream() };
    })
  };
}

function createMockCodexAdapter(thread: CodexThreadLike): CodexSdkAdapter {
  return {
    startThread: vi.fn(() => thread),
    resumeThread: vi.fn(() => thread)
  };
}

function metadata(workspaceDir: string, overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id: "app-1",
    provider: "codex",
    mode: "bypass",
    workspacePath: path.join(workspaceDir, "app-1"),
    createdAt: "now",
    updatedAt: "now",
    hasRun: false,
    ...overrides
  };
}

import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AgentService,
  buildAgentPrompt,
  buildSessionOptions,
  classifyToolResult,
  getAskUserQuestionTool,
  isPendingInterruptPayloadValid,
  MAX_CONSECUTIVE_VALIDATION_ERRORS,
  ValidationErrorLimitError
} from "../src/agent-service.js";
import { buildSandboxSettings } from "../src/sandbox.js";
import type { SessionFactory, SessionLike } from "../src/session-adapter.js";
import type { SessionMetadata } from "../src/types.js";
import { createTempConfig } from "./helpers.js";

describe("sandbox and agent options", () => {
  it("blocks credential paths, unix sockets, and unsandboxed commands", async () => {
    const config = await createTempConfig();
    const sandbox = buildSandboxSettings(config);

    expect(sandbox.enabled).toBe(true);
    expect(sandbox.allowUnsandboxedCommands).toBe(false);
    expect(sandbox.network.allowUnixSockets).toEqual([]);
    expect(sandbox.network.allowAllUnixSockets).toBe(false);
    expect(sandbox.filesystem.allowWrite).toEqual([config.projectRoot]);
    expect(sandbox.filesystem.denyWrite).toEqual([
      config.sessionDir,
      config.workspaceDir,
      path.join(config.projectRoot, ".env"),
      path.join(config.projectRoot, ".env.local")
    ]);
    expect(sandbox.filesystem.denyRead).toContain(config.workspaceDir);
    expect(sandbox.filesystem.denyRead).toContain(config.sessionDir);
    expect(sandbox.filesystem.denyRead).toContain(path.join(config.projectRoot, ".env"));
    expect(sandbox.filesystem.denyRead).toContain(path.join(os.homedir(), ".claude"));
  });

  it("maps modes to Claude Agent SDK permission options", async () => {
    const config = await createTempConfig();
    const session: SessionMetadata = {
      id: "00000000-0000-4000-8000-000000000000",
      mode: "plan",
      workspacePath: path.join(config.workspaceDir, "session"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasRun: false
    };

    const planOptions = buildSessionOptions(config, session, { prompt: "inspect", mode: "plan" });
    const editOptions = buildSessionOptions(config, session, { prompt: "edit", mode: "edit" });
    const bypassOptions = buildSessionOptions(config, session, { prompt: "run", mode: "bypass" });

    expect(planOptions.permissionMode).toBe("plan");
    expect(planOptions.disallowedTools).toContain("Bash");
    expect(planOptions.disallowedTools).not.toContain("Write");
    expect(planOptions.disallowedTools).not.toContain("Edit");
    expect(planOptions.disallowedTools).not.toContain("MultiEdit");
    expect(editOptions.permissionMode).toBe("acceptEdits");
    expect(bypassOptions.permissionMode).toBe("bypassPermissions");
    expect(bypassOptions.allowDangerouslySkipPermissions).toBe(true);
    expect(planOptions.cwd).toBe(config.projectRoot);
    expect(planOptions).not.toHaveProperty("sandbox");
    expect(bypassOptions).not.toHaveProperty("resume");
    expect(bypassOptions).not.toHaveProperty("sessionId");
  });

  it("maps text and image requests to Agent SDK prompt shapes", async () => {
    const textPrompt = buildAgentPrompt({ prompt: "inspect" });
    expect(textPrompt).toBe("inspect");

    const imagePrompt = buildAgentPrompt({
      prompt: "describe this",
      images: [{ mediaType: "image/png", dataBase64: "aGVsbG8=", name: "pixel.png" }]
    });
    expect(typeof imagePrompt).not.toBe("string");

    const messages = [];
    for await (const message of imagePrompt as AsyncIterable<Record<string, unknown>>) {
      messages.push(message);
    }

    expect(messages).toEqual([
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }
          ]
        },
        parent_tool_use_id: null
      }
    ]);
  });

  it("maps AskUserQuestion answers to a normal user prompt", async () => {
    const prompt = buildAgentPrompt({
      prompt: "Subject: SaaS product\ncontinue",
      toolResult: {
        toolUseId: "toolu_question",
        content: JSON.stringify({
          questions: [{ question: "What is the landing page for?" }],
          answers: { "What is the landing page for?": "SaaS product" }
        })
      }
    });

    expect(prompt).toContain("The user answered the AskUserQuestion form");
    expect(prompt).toContain("Do not ask the same questions again");
    expect(prompt).toContain("- What is the landing page for?: SaaS product");
    expect(prompt).toContain("Subject: SaaS product\ncontinue");
  });

  it("maps ExitPlanMode approval results to an execution prompt", async () => {
    const prompt = buildAgentPrompt({
      prompt: "Approved. Continue.",
      toolResult: {
        toolUseId: "toolu_exit",
        kind: "approval",
        approved: true,
        content: JSON.stringify({
          approved: true,
          plan: "1. Update the dispatcher.\n2. Add tests."
        })
      }
    });

    expect(prompt).toContain("User approved exiting plan mode");
    expect(prompt).toContain("1. Update the dispatcher");
    expect(prompt).toContain("Approved. Continue.");
  });

  it("classifies interactive tool failures as control signals with saved tool input", () => {
    expect(
      classifyToolResult(
        { id: "toolu_question", name: "AskUserQuestion", input: { questions: [{ question: "Continue?", options: [] }] } },
        { type: "tool_result", tool_use_id: "toolu_question", is_error: true, content: "Answer questions?" }
      )
    ).toMatchObject({
      kind: "control",
      control: {
        type: "user_input_required",
        questions: [{ question: "Continue?", options: [] }]
      }
    });

    expect(
      classifyToolResult(
        { id: "toolu_exit", name: "ExitPlanMode", input: { plan: "Ship the approved patch." } },
        { type: "tool_result", tool_use_id: "toolu_exit", is_error: true, content: "Exit plan mode?" }
      )
    ).toMatchObject({
      kind: "control",
      control: {
        type: "approval_required",
        plan: "Ship the approved patch."
      }
    });

    expect(
      classifyToolResult(
        { id: "toolu_read", name: "Read", input: { file_path: "missing" } },
        { type: "tool_result", tool_use_id: "toolu_read", is_error: true, content: "ENOENT" }
      )
    ).toMatchObject({ kind: "real_error", message: "ENOENT" });
  });

  it("rejects malformed pending interrupt payloads via the validator", () => {
    expect(
      isPendingInterruptPayloadValid({
        id: "interrupt:toolu_bad",
        type: "user_input",
        toolCallId: "toolu_bad",
        toolName: "AskUserQuestion",
        prompt: "Answer questions?",
        payload: { input: { questions: "[{...}]" }, questions: "[{...}]" }
      })
    ).toBe(false);

    expect(
      isPendingInterruptPayloadValid({
        id: "interrupt:toolu_ok",
        type: "user_input",
        toolCallId: "toolu_ok",
        toolName: "AskUserQuestion",
        prompt: "Answer questions?",
        payload: { input: { questions: [{ question: "What?" }] }, questions: [{ question: "What?" }] }
      })
    ).toBe(true);

    expect(
      isPendingInterruptPayloadValid({
        id: "interrupt:toolu_plan_bad",
        type: "approval",
        toolCallId: "toolu_plan_bad",
        toolName: "ExitPlanMode",
        prompt: "Exit plan mode?",
        payload: { input: {}, action: "exit_plan_mode" }
      })
    ).toBe(false);

    expect(
      isPendingInterruptPayloadValid({
        id: "interrupt:toolu_plan_ok",
        type: "approval",
        toolCallId: "toolu_plan_ok",
        toolName: "ExitPlanMode",
        prompt: "Exit plan mode?",
        payload: { input: { plan: "do it" }, plan: "do it", action: "exit_plan_mode" }
      })
    ).toBe(true);
  });

  it("does not intercept AskUserQuestion when questions input is malformed", async () => {
    const config = await createTempConfig();
    const session: SessionMetadata = {
      id: "00000000-0000-4000-8000-000000000020",
      mode: "plan",
      workspacePath: path.join(config.workspaceDir, "session-bad-question"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasRun: false
    };
    const { service } = createServiceWithStream(config, async function* () {
      yield {
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: null,
          content: [
            {
              type: "tool_use",
              id: "toolu_q",
              name: "AskUserQuestion",
              input: { questions: "[{\"question\": \"What?\"}]" }
            }
          ]
        }
      };
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_q",
              is_error: true,
              content:
                "<tool_use_error>InputValidationError: AskUserQuestion failed due to the following issue:\nThe parameter `questions` type is expected as `array` but provided as `string`</tool_use_error>"
            }
          ]
        }
      };
    });

    const events = [];
    for await (const event of service.stream({ session, request: { prompt: "ask" } })) {
      events.push(event);
    }

    const types = events.map((event) => event.type);
    expect(types).not.toContain("question_pending");
    const validationEvents = events.filter((event) => event.type === "tool_validation_error");
    expect(validationEvents).toHaveLength(1);
    expect(validationEvents[0]).toMatchObject({
      data: { toolUseId: "toolu_q", toolName: "AskUserQuestion", attempts: 1 }
    });
    expect(session.pendingInterrupt).toBeUndefined();
  });

  it("does not intercept ExitPlanMode when plan input is missing", async () => {
    const config = await createTempConfig();
    const session: SessionMetadata = {
      id: "00000000-0000-4000-8000-000000000021",
      mode: "plan",
      workspacePath: path.join(config.workspaceDir, "session-bad-plan"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasRun: false
    };
    const { service } = createServiceWithStream(config, async function* () {
      yield {
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: null,
          content: [{ type: "tool_use", id: "toolu_exit", name: "ExitPlanMode", input: {} }]
        }
      };
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_exit",
              is_error: true,
              content: "<tool_use_error>InputValidationError: plan is required</tool_use_error>"
            }
          ]
        }
      };
    });

    const events = [];
    for await (const event of service.stream({ session, request: { prompt: "plan", mode: "plan" } })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).not.toContain("approval_pending");
    const validationEvents = events.filter((event) => event.type === "tool_validation_error");
    expect(validationEvents).toHaveLength(1);
  });

  it("classifies tool_use_error wrapped failures as validation errors", () => {
    const outcome = classifyToolResult(
      { id: "toolu_q", name: "AskUserQuestion", input: { questions: "oops" } },
      {
        type: "tool_result",
        tool_use_id: "toolu_q",
        is_error: true,
        content:
          "<tool_use_error>InputValidationError: AskUserQuestion failed due to the following issue:\nThe parameter `questions` type is expected as `array` but provided as `string`</tool_use_error>"
      }
    );

    expect(outcome).toMatchObject({ kind: "validation_error" });
    expect((outcome as { message: string }).message).toContain("InputValidationError");
    expect((outcome as { message: string }).message).not.toContain("<tool_use_error>");
  });

  it("emits a tool_validation_error event when the SDK returns a tool_use_error", async () => {
    const config = await createTempConfig();
    const session: SessionMetadata = {
      id: "00000000-0000-4000-8000-000000000010",
      mode: "bypass",
      workspacePath: path.join(config.workspaceDir, "session-validation"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasRun: false
    };
    const { service } = createServiceWithStream(config, async function* () {
      yield {
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: null,
          content: [
            { type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: 5 } }
          ]
        }
      };
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_read",
              is_error: true,
              content:
                "<tool_use_error>InputValidationError: Read failed due to the following issue:\nThe parameter `file_path` type is expected as `string` but provided as `number`</tool_use_error>"
            }
          ]
        }
      };
    });

    const events = [];
    for await (const event of service.stream({ session, request: { prompt: "read" } })) {
      events.push(event);
    }

    const validationEvents = events.filter((event) => event.type === "tool_validation_error");
    expect(validationEvents).toHaveLength(1);
    expect(validationEvents[0]).toMatchObject({
      type: "tool_validation_error",
      data: {
        toolUseId: "toolu_read",
        toolName: "Read",
        attempts: 1,
        limit: MAX_CONSECUTIVE_VALIDATION_ERRORS
      }
    });
    expect((validationEvents[0].data as { message: string }).message).toContain("InputValidationError");
  });

  it("aborts the run after MAX_CONSECUTIVE_VALIDATION_ERRORS for the same exact tool input", async () => {
    const config = await createTempConfig();
    const session: SessionMetadata = {
      id: "00000000-0000-4000-8000-000000000011",
      mode: "bypass",
      workspacePath: path.join(config.workspaceDir, "session-validation-cap"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasRun: false
    };
    const errorContent =
      "<tool_use_error>InputValidationError: parameter shape</tool_use_error>";
    const { service } = createServiceWithStream(config, async function* () {
      for (let i = 0; i < MAX_CONSECUTIVE_VALIDATION_ERRORS + 2; i += 1) {
        const id = `toolu_read_${i}`;
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            stop_reason: null,
            content: [{ type: "tool_use", id, name: "Read", input: { file_path: 5 } }]
          }
        };
        yield {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: errorContent }]
          }
        };
      }
    });

    const events = [];
    let caught: unknown;
    try {
      for await (const event of service.stream({ session, request: { prompt: "read" } })) {
        events.push(event);
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ValidationErrorLimitError);
    const validationEvents = events.filter((event) => event.type === "tool_validation_error");
    expect(validationEvents).toHaveLength(MAX_CONSECUTIVE_VALIDATION_ERRORS);
    expect(validationEvents[validationEvents.length - 1]).toMatchObject({
      data: { attempts: MAX_CONSECUTIVE_VALIDATION_ERRORS, toolName: "Read" }
    });
  });

  it("does not abort validation errors for the same tool with different inputs", async () => {
    const config = await createTempConfig();
    const session: SessionMetadata = {
      id: "00000000-0000-4000-8000-000000000013",
      mode: "bypass",
      workspacePath: path.join(config.workspaceDir, "session-validation-distinct-inputs"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasRun: false
    };
    const errorContent = "<tool_use_error>InputValidationError: parameter shape</tool_use_error>";
    const { service } = createServiceWithStream(config, async function* () {
      for (let i = 0; i < MAX_CONSECUTIVE_VALIDATION_ERRORS + 2; i += 1) {
        const id = `toolu_read_distinct_${i}`;
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            stop_reason: null,
            content: [{ type: "tool_use", id, name: "Read", input: { file_path: i } }]
          }
        };
        yield {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: errorContent }]
          }
        };
      }
    });

    const events = [];
    let caught: unknown;
    try {
      for await (const event of service.stream({ session, request: { prompt: "read" } })) {
        events.push(event);
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeUndefined();
    const validationEvents = events.filter((event) => event.type === "tool_validation_error");
    expect(validationEvents).toHaveLength(MAX_CONSECUTIVE_VALIDATION_ERRORS + 2);
    for (const event of validationEvents) {
      expect((event.data as { attempts: number }).attempts).toBe(1);
    }
  });

  it("resets the validation counter after a successful tool result for the same tool", async () => {
    const config = await createTempConfig();
    const session: SessionMetadata = {
      id: "00000000-0000-4000-8000-000000000012",
      mode: "bypass",
      workspacePath: path.join(config.workspaceDir, "session-validation-reset"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasRun: false
    };
    const errorContent =
      "<tool_use_error>InputValidationError: parameter shape</tool_use_error>";
    const { service } = createServiceWithStream(config, async function* () {
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const errorId = `toolu_err_${cycle}`;
        const okId = `toolu_ok_${cycle}`;
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            stop_reason: null,
            content: [{ type: "tool_use", id: errorId, name: "Read", input: { file_path: 5 } }]
          }
        };
        yield {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: errorId, is_error: true, content: errorContent }]
          }
        };
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            stop_reason: null,
            content: [{ type: "tool_use", id: okId, name: "Read", input: { file_path: "ok.md" } }]
          }
        };
        yield {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: okId, is_error: false, content: "ok" }]
          }
        };
      }
    });

    const events = [];
    let caught: unknown;
    try {
      for await (const event of service.stream({ session, request: { prompt: "read" } })) {
        events.push(event);
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeUndefined();
    const validationEvents = events.filter((event) => event.type === "tool_validation_error");
    expect(validationEvents).toHaveLength(3);
    for (const event of validationEvents) {
      expect((event.data as { attempts: number }).attempts).toBe(1);
    }
  });

  it("detects only AskUserQuestion tool_use messages that stopped for tool use", () => {
    const askTool = getAskUserQuestionTool({
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Let me ask." },
        {
          type: "tool_use",
          id: "toolu_question",
          name: "AskUserQuestion",
          input: { questions: [{ question: "Which stack?", options: [] }] }
        }
      ]
    });

    expect(askTool).toMatchObject({ id: "toolu_question", name: "AskUserQuestion" });
    expect(
      getAskUserQuestionTool({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_glob", name: "Glob", input: { pattern: "**/*" } }]
      })
    ).toBeNull();
    expect(
      getAskUserQuestionTool({
        stop_reason: "end_turn",
        content: [{ type: "tool_use", id: "toolu_question", name: "AskUserQuestion", input: { questions: [] } }]
      })
    ).toBeNull();
    expect(
      getAskUserQuestionTool({
        stop_reason: null,
        content: [{ type: "tool_use", id: "toolu_question_streamed", name: "AskUserQuestion", input: { questions: [] } }]
      })
    ).toMatchObject({ id: "toolu_question_streamed", name: "AskUserQuestion" });
  });

  it("stops streaming after exact AskUserQuestion tool use", async () => {
    const config = await createTempConfig();
    const session: SessionMetadata = {
      id: "00000000-0000-4000-8000-000000000001",
      mode: "bypass",
      workspacePath: path.join(config.workspaceDir, "session-question"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasRun: false
    };
    let closed = false;
    const { service } = createServiceWithStream(
      config,
      async function* () {
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            stop_reason: null,
            content: [
              {
                type: "tool_use",
                id: "toolu_question",
                name: "AskUserQuestion",
                input: { questions: [{ question: "What should I build?", options: [] }] }
              }
            ]
          }
        };
        if (!closed) {
          yield {
            type: "user",
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "toolu_question", is_error: true, content: "Answer questions?" }]
            }
          };
        }
      },
      () => {
        closed = true;
      }
    );

    const events = [];
    for await (const event of service.stream({ session, request: { prompt: "ask" } })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["message", "question_pending"]);
    expect(closed).toBe(true);
    expect(JSON.stringify(events)).not.toContain('"type":"tool_result"');
  });

  it("stops streaming after ExitPlanMode and exposes the plan for approval", async () => {
    const config = await createTempConfig();
    const session: SessionMetadata = {
      id: "00000000-0000-4000-8000-000000000002",
      mode: "plan",
      workspacePath: path.join(config.workspaceDir, "session-exit-plan"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasRun: false
    };
    let closed = false;
    const { service } = createServiceWithStream(
      config,
      async function* () {
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            stop_reason: null,
            content: [
              {
                type: "tool_use",
                id: "toolu_exit",
                name: "ExitPlanMode",
                input: { plan: "Implement the control dispatcher." }
              }
            ]
          }
        };
        if (!closed) {
          yield {
            type: "user",
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "toolu_exit", is_error: true, content: "Exit plan mode?" }]
            }
          };
        }
      },
      () => {
        closed = true;
      }
    );

    const events = [];
    for await (const event of service.stream({ session, request: { prompt: "plan", mode: "plan" } })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["message", "approval_pending"]);
    expect(events[1]).toMatchObject({
      type: "approval_pending",
      data: {
        waitingForApproval: true,
        toolUseId: "toolu_exit",
        plan: "Implement the control dispatcher."
      }
    });
    expect(session).toMatchObject({ status: "awaiting_approval", pendingInterrupt: { type: "approval", toolCallId: "toolu_exit" } });
    expect(closed).toBe(true);
    expect(JSON.stringify(events)).not.toContain('"type":"tool_result"');
  });
});

function createServiceWithStream(
  config: Awaited<ReturnType<typeof createTempConfig>>,
  stream: () => AsyncGenerator<unknown>,
  onClose: () => void = () => undefined
): { service: AgentService; session: SessionLike; factory: SessionFactory } {
  const session = createMockSession("claude-test", stream, onClose);
  const factory: SessionFactory = {
    createSession: vi.fn(() => session),
    resumeSession: vi.fn(() => session)
  };

  return {
    service: new AgentService(config, undefined, factory),
    session,
    factory
  };
}

function createMockSession(id: string, stream: () => AsyncGenerator<unknown>, onClose: () => void): SessionLike {
  return {
    get sessionId() {
      return id;
    },
    send: vi.fn(),
    stream: vi.fn().mockImplementation(stream),
    close: vi.fn(onClose),
    [Symbol.asyncDispose]: vi.fn()
  } as unknown as SessionLike;
}

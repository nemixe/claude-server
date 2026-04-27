import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentService, buildAgentOptions, buildAgentPrompt, getAskUserQuestionTool, type AgentSdkAdapter } from "../src/agent-service.js";
import { buildSandboxSettings } from "../src/sandbox.js";
import type { SessionMetadata } from "../src/types.js";
import { createTempConfig } from "./helpers.js";

describe("sandbox and agent options", () => {
  it("blocks credential paths, unix sockets, and unsandboxed commands", async () => {
    const config = await createTempConfig();
    const workspacePath = path.join(config.workspaceDir, "session-id");
    const sandbox = buildSandboxSettings(config, workspacePath);

    expect(sandbox.enabled).toBe(true);
    expect(sandbox.allowUnsandboxedCommands).toBe(false);
    expect(sandbox.network.allowUnixSockets).toEqual([]);
    expect(sandbox.network.allowAllUnixSockets).toBe(false);
    expect(sandbox.filesystem.allowWrite).toEqual([workspacePath]);
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
      hasRun: true
    };

    const planOptions = buildAgentOptions(config, session, { prompt: "inspect", mode: "plan" }, new AbortController());
    const editOptions = buildAgentOptions(config, session, { prompt: "edit", mode: "edit" }, new AbortController());
    const bypassOptions = buildAgentOptions(config, session, { prompt: "run", mode: "bypass" }, new AbortController());

    expect(planOptions.permissionMode).toBe("plan");
    expect(planOptions.enableFileCheckpointing).toBe(false);
    expect(planOptions.disallowedTools).toContain("Bash");
    expect(editOptions.permissionMode).toBe("acceptEdits");
    expect(editOptions.enableFileCheckpointing).toBe(true);
    expect(bypassOptions.permissionMode).toBe("bypassPermissions");
    expect(bypassOptions.allowDangerouslySkipPermissions).toBe(true);
    expect(bypassOptions.resume).toBe(session.id);
    expect(bypassOptions.sessionId).toBeUndefined();
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

  it("maps AskUserQuestion answers to Agent SDK tool_result prompts", async () => {
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

    const messages = [];
    for await (const message of prompt as AsyncIterable<Record<string, unknown>>) {
      messages.push(message);
    }

    expect(messages).toEqual([
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_question",
              content: JSON.stringify({
                questions: [{ question: "What is the landing page for?" }],
                answers: { "What is the landing page for?": "SaaS product" }
              })
            }
          ]
        },
        parent_tool_use_id: null
      }
    ]);
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
      hasRun: true
    };
    let closed = false;
    const adapter: AgentSdkAdapter = {
      query: () => ({
        close: () => {
          closed = true;
        },
        async *[Symbol.asyncIterator]() {
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
        }
      }),
      getSessionMessages: async () => []
    };

    const events = [];
    for await (const event of new AgentService(config, adapter).stream({ session, request: { prompt: "ask" } })) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(["message", "question_pending"]);
    expect(closed).toBe(true);
    expect(JSON.stringify(events)).not.toContain("Answer questions?");
  });
});

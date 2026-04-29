import { describe, expect, it } from "vitest";
import {
  eventsToBubbleItems,
  extractTextContent,
  getActiveAskUserQuestion,
  getActiveExitPlanApproval,
  normalizeRole,
  shouldSkipDisplayEntry
} from "../client/src/agent-chat/message-event-utils.jsx";
import {
  estimateBase64Bytes,
  extractImageBlocks,
  formatBytes,
  imageSrc,
  redactImageData
} from "../client/src/agent-chat/media-utils.js";

describe("chat message event helpers", () => {
  it("turns prompt events into user bubble items", () => {
    const items = eventsToBubbleItems(
      [
        {
          id: "prompt-1",
          type: "prompt",
          timestamp: new Date(2026, 3, 28, 10, 15).toISOString(),
          data: { prompt: "Summarize the workspace" }
        }
      ],
      "Ada Lovelace"
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: "prompt-1",
      role: "user",
      copyText: "Summarize the workspace",
      className: "ai-chat-bubble-item"
    });
    expect(items[0].styles.content.color).toBeDefined();
  });

  it("detects and closes active AskUserQuestion tool state", () => {
    const questionEvent = {
      id: "message-1",
      type: "message",
      data: {
        message: {
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "question-tool",
              name: "AskUserQuestion",
              input: { questions: [{ id: "scope", question: "Which scope?" }] }
            }
          ]
        }
      }
    };

    expect(getActiveAskUserQuestion([questionEvent])).toMatchObject({
      id: "message-1",
      toolUseId: "question-tool",
      data: { questions: [{ id: "scope", question: "Which scope?" }] }
    });
    expect(getActiveAskUserQuestion([questionEvent, { id: "answer", type: "prompt", data: { prompt: "Client only" } }])).toBeNull();
  });

  it("detects active ExitPlanMode approvals", () => {
    expect(
      getActiveExitPlanApproval([
        {
          id: "approval-1",
          type: "approval_pending",
          data: {
            waitingForApproval: true,
            toolUseId: "exit-plan-tool",
            input: { plan: "Split the large client entry file" }
          }
        }
      ])
    ).toMatchObject({
      id: "approval-1",
      toolUseId: "exit-plan-tool",
      plan: "Split the large client entry file"
    });
  });

  it("keeps display filtering and role normalization stable", () => {
    expect(normalizeRole("tool_use")).toBe("tool");
    expect(normalizeRole("assistant")).toBe("assistant");
    expect(shouldSkipDisplayEntry("message", { type: "system" })).toBe(true);
    expect(shouldSkipDisplayEntry("result", { is_error: false })).toBe(true);
    expect(shouldSkipDisplayEntry("result", { is_error: true })).toBe(false);
  });

  it("extracts text content from common protocol shapes", () => {
    expect(extractTextContent([{ type: "text", text: "first" }, { type: "tool_use", name: "Read" }])).toBe(
      "first\n[tool_use:Read]"
    );
    expect(extractTextContent({ message: { content: "nested" } })).toBe("nested");
  });
});

describe("chat media helpers", () => {
  it("deduplicates image blocks and formats media metadata", () => {
    const data = "QUJDRA==";
    const imageBlock = {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data
      }
    };

    expect(extractImageBlocks([imageBlock, imageBlock])).toEqual([
      {
        mediaType: "image/png",
        dataBase64: data,
        size: 4
      }
    ]);
    expect(estimateBase64Bytes(data)).toBe(4);
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(imageSrc({ mediaType: "image/png", dataBase64: data })).toBe("data:image/png;base64," + data);
  });

  it("redacts large base64 image payloads recursively", () => {
    const data = "a".repeat(120);
    const redacted = redactImageData({ nested: { dataBase64: data } });

    expect(redacted.nested.dataBase64).toContain("base64 image data redacted");
    expect(redacted.nested.dataBase64).toContain("90 B");
  });
});

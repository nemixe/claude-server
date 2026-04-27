import { describe, expect, it, vi } from "vitest";
import {
  createClaudeWebChatContract,
  mapSseEventToWebChatEvent,
  toWebChatMessages,
  type WebChatMessage
} from "../src/chat-contract.js";

describe("web chat contract", () => {
  it("maps persisted Claude messages into legacy web chat messages", () => {
    const messages = toWebChatMessages(
      [
        {
          type: "user",
          uuid: "u1",
          session_id: "s1",
          message: {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }
            ]
          }
        },
        {
          type: "assistant",
          uuid: "a1",
          session_id: "s1",
          message: { role: "assistant", content: [{ type: "text", text: "A small test image." }] }
        }
      ],
      "s1"
    );

    expect(messages).toEqual([
      expect.objectContaining({
        id: "u1",
        sessionId: "s1",
        role: "user",
        text: "What is in this image?",
        images: [expect.objectContaining({ type: "image", mediaType: "image/png", dataBase64: "aGVsbG8=", sizeBytes: 5 })]
      }),
      expect.objectContaining({
        id: "a1",
        sessionId: "s1",
        role: "assistant",
        text: "A small test image.",
        images: []
      })
    ]);
  });

  it("maps SDK result SSE events to run metadata instead of chat messages", () => {
    const event = mapSseEventToWebChatEvent(
      {
        event: "result",
        data: {
          session_id: "s1",
          is_error: false,
          result: "Final answer",
          duration_ms: 123,
          total_cost_usd: 0.01,
          terminal_reason: "completed"
        }
      },
      "fallback"
    );

    expect(event).toEqual({
      type: "run_result",
      raw: expect.any(Object),
      result: expect.objectContaining({
        sessionId: "s1",
        ok: true,
        finalText: "Final answer",
        durationMs: 123,
        totalCostUsd: 0.01,
        terminalReason: "completed"
      })
    });
  });

  it("creates sessions and streams messages through the contract", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/sessions") && init?.method === "POST") {
        return jsonResponse({ id: "s1", sessionId: "s1", mode: "plan", createdAt: "now", updatedAt: "now", hasRun: false }, 201);
      }
      if (url.endsWith("/v1/sessions") && !init?.method) {
        return jsonResponse({
          sessions: [{ id: "s1", sessionId: "s1", mode: "plan", createdAt: "now", updatedAt: "now", hasRun: false }]
        });
      }
      if (url.endsWith("/v1/sessions/s1/messages:stream")) {
        return new Response(
          [
            'event: message\ndata: {"type":"assistant","uuid":"a1","session_id":"s1","message":{"role":"assistant","content":[{"type":"text","text":"Hello back"}]}}\n\n',
            'event: result\ndata: {"session_id":"s1","is_error":false,"result":"Hello back","total_cost_usd":0.02}\n\n',
            'event: done\ndata: {"ok":true}\n\n'
          ].join(""),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
      return new Response("not found", { status: 404 });
    });
    const contract = createClaudeWebChatContract({ baseUrl: "https://api.example.com", fetch: fetchMock });
    const seenMessages: WebChatMessage[] = [];
    const onRunResult = vi.fn();

    const result = await contract.sendMessage(
      { prompt: "Hello", mode: "plan", images: [{ name: "pixel.png", mediaType: "image/png", dataBase64: "aGVsbG8=" }] },
      { onMessage: (message) => seenMessages.push(message), onRunResult }
    );

    expect(result.session.sessionId).toBe("s1");
    expect(seenMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(seenMessages[0].images).toEqual([
      expect.objectContaining({ name: "pixel.png", mediaType: "image/png", dataBase64: "aGVsbG8=" })
    ]);
    expect(onRunResult).toHaveBeenCalledWith(expect.objectContaining({ finalText: "Hello back", totalCostUsd: 0.02 }));
    expect(result.runResult).toEqual(expect.objectContaining({ finalText: "Hello back" }));
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

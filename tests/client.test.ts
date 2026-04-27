import { describe, expect, it, vi } from "vitest";
import { createClaudeClient, readSseStream } from "../src/client.js";

describe("browser client", () => {
  it("parses SSE events and dispatches typed handlers", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message\ndata: {"text":"hello"}\n\n'));
        controller.enqueue(new TextEncoder().encode('event: result\ndata: {"ok":true}\n\n'));
        controller.close();
      }
    });
    const onMessage = vi.fn();
    const onResult = vi.fn();

    await readSseStream(stream, { onMessage, onResult });

    expect(onMessage).toHaveBeenCalledWith({ text: "hello" });
    expect(onResult).toHaveBeenCalledWith({ ok: true });
  });

  it("calls REST endpoints with the configured base URL", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ id: "s1", sessionId: "s1", mode: "plan", createdAt: "now", updatedAt: "now", hasRun: false }), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    });
    const client = createClaudeClient({ baseUrl: "https://api.example.com/", fetch: fetchMock });

    await expect(client.createSession({ mode: "plan" })).resolves.toMatchObject({ sessionId: "s1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/sessions",
      expect.objectContaining({
        method: "POST"
      })
    );
  });

  it("serializes image prompts for streaming requests", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response("event: done\ndata: {\"ok\":true}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    });
    const client = createClaudeClient({ baseUrl: "https://api.example.com/", fetch: fetchMock });

    await client.streamMessage("s1", {
      prompt: "describe this",
      images: [{ name: "pixel.png", mediaType: "image/png", dataBase64: "aGVsbG8=" }]
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/sessions/s1/messages:stream",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "describe this",
          images: [{ name: "pixel.png", mediaType: "image/png", dataBase64: "aGVsbG8=" }]
        })
      })
    );
  });
});

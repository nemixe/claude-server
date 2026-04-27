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

  it("calls Claude command endpoints", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ command: { path: "review/fix.md", content: "Fix it", updatedAt: "now" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = createClaudeClient({ baseUrl: "https://api.example.com/", fetch: fetchMock });

    await expect(client.saveClaudeCommand("s1", { path: "review/fix.md", content: "Fix it" })).resolves.toMatchObject({
      command: { path: "review/fix.md" }
    });
    await client.getClaudeCommand("s1", "review/fix.md");
    await client.deleteClaudeCommand("s1", "review/fix.md");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.example.com/v1/sessions/s1/claude-commands",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ path: "review/fix.md", content: "Fix it" })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.example.com/v1/sessions/s1/claude-commands?path=review%2Ffix.md",
      expect.objectContaining({ headers: expect.objectContaining({ "content-type": "application/json" }) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.example.com/v1/sessions/s1/claude-commands",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ path: "review/fix.md" })
      })
    );
  });

  it("calls workspace fuzzy file search endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ results: [{ path: "src/app.ts", name: "app.ts", type: "file", score: 42, updatedAt: "now" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = createClaudeClient({ baseUrl: "https://api.example.com/", fetch: fetchMock });

    await expect(client.searchFiles("s1", "sat", { limit: 5 })).resolves.toMatchObject({
      results: [{ path: "src/app.ts", type: "file" }]
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/sessions/s1/files:search?q=sat&limit=5",
      expect.objectContaining({
        headers: expect.objectContaining({ "content-type": "application/json" })
      })
    );
  });
});

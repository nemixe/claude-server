import { describe, expect, it, vi } from "vitest";
import { createBottleClient, readSseStream } from "../src/client.js";

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
    const client = createBottleClient({ baseUrl: "https://api.example.com/__bottle", fetch: fetchMock });

    await expect(client.createSession({ mode: "plan", userName: "Ada" })).resolves.toMatchObject({ sessionId: "s1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/__bottle/v1/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ mode: "plan", userName: "Ada" })
      })
    );
  });

  it("supports Codex provider session creation through the Bottle client", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ id: "s1", sessionId: "s1", provider: "codex", mode: "plan", createdAt: "now", updatedAt: "now", hasRun: false }), {
        status: 201,
        headers: { "content-type": "application/json" }
      });
    });
    const client = createBottleClient({ baseUrl: "https://api.example.com/__bottle", fetch: fetchMock });

    await expect(client.createSession({ provider: "codex", mode: "plan" })).resolves.toMatchObject({ provider: "codex" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/__bottle/v1/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ provider: "codex", mode: "plan" })
      })
    );
  });

  it("adds pagination parameters when listing sessions", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ sessions: [], offset: 30, hasMore: false }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = createBottleClient({ baseUrl: "https://api.example.com/__bottle", fetch: fetchMock });

    await client.listSessions({ limit: 30, offset: 30 });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/__bottle/v1/sessions?limit=30&offset=30",
      expect.objectContaining({
        headers: expect.objectContaining({ "content-type": "application/json" })
      })
    );
  });

  it("loads a single session by id", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ id: "s1", sessionId: "s1", mode: "bypass", createdAt: "now", updatedAt: "now", hasRun: false }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = createBottleClient({ baseUrl: "https://api.example.com/__bottle", fetch: fetchMock });

    await expect(client.getSession("s1")).resolves.toMatchObject({ sessionId: "s1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/__bottle/v1/sessions/s1",
      expect.objectContaining({
        headers: expect.objectContaining({ "content-type": "application/json" })
      })
    );
  });

  it("loads configured project root information", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({
        projectRoot: "/repo/app",
        bottleDir: "/repo/.bottle",
        agentsDir: "/repo/.bottle/agents",
        commandsDir: "/repo/.bottle/commands",
        rulesDir: "/repo/.bottle/rules",
        skillsDir: "/repo/.bottle/skills",
        extraSkillRoots: ["/repo/shared-skills"],
        skillRoots: ["/repo/.bottle/skills", "/repo/shared-skills"]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = createBottleClient({ baseUrl: "https://api.example.com/__bottle", fetch: fetchMock });

    await expect(client.getRoot()).resolves.toMatchObject({
      projectRoot: "/repo/app",
      commandsDir: "/repo/.bottle/commands",
      skillRoots: ["/repo/.bottle/skills", "/repo/shared-skills"]
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/__bottle/v1/root",
      expect.objectContaining({
        headers: expect.objectContaining({ "content-type": "application/json" })
      })
    );
  });

  it("loads Bottle discovery metadata", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ protocolVersion: 1, name: "prototype-a", features: { iframeBridge: true } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = createBottleClient({ baseUrl: "https://api.example.com/__bottle", fetch: fetchMock });

    await expect(client.getBottle()).resolves.toMatchObject({ protocolVersion: 1, name: "prototype-a" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/__bottle/v1/bottle",
      expect.objectContaining({
        headers: expect.objectContaining({ "content-type": "application/json" })
      })
    );
  });

  it("loads and updates AI assistant settings", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          maxConcurrentRuns: 4,
          maxTurns: 30,
          defaultAgentProvider: "codex",
          availableAgentProviders: ["claude", "codex"]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    const client = createBottleClient({ baseUrl: "https://api.example.com/__bottle", fetch: fetchMock });

    await expect(client.getSettings()).resolves.toMatchObject({
      defaultAgentProvider: "codex",
      availableAgentProviders: ["claude", "codex"]
    });
    await client.updateSettings({ defaultAgentProvider: "codex" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.example.com/__bottle/v1/settings",
      expect.objectContaining({
        headers: expect.objectContaining({ "content-type": "application/json" })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.example.com/__bottle/v1/settings",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ defaultAgentProvider: "codex" })
      })
    );
  });

  it("adds pagination parameters when loading session messages", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ messages: [], offset: 800, limit: 200, total: 1000, hasMoreBefore: true, hasMoreAfter: false }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = createBottleClient({ baseUrl: "https://api.example.com/__bottle", fetch: fetchMock });

    await client.getMessages("s1", { limit: 200, offset: 800, tail: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/__bottle/v1/sessions/s1/messages?limit=200&offset=800&tail=true",
      expect.objectContaining({
        headers: expect.objectContaining({ "content-type": "application/json" })
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
    const client = createBottleClient({ baseUrl: "https://api.example.com/__bottle", fetch: fetchMock });

    await client.streamMessage("s1", {
      prompt: "describe this",
      images: [{ name: "pixel.png", mediaType: "image/png", dataBase64: "aGVsbG8=" }]
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/__bottle/v1/sessions/s1/messages:stream",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "describe this",
          images: [{ name: "pixel.png", mediaType: "image/png", dataBase64: "aGVsbG8=" }]
        })
      })
    );
  });

  it("calls Bottle command endpoints", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ command: { path: "review/fix.md", content: "Fix it", updatedAt: "now" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = createBottleClient({ baseUrl: "https://api.example.com/__bottle", fetch: fetchMock });

    await expect(client.saveCommand("s1", { path: "review/fix.md", content: "Fix it" })).resolves.toMatchObject({
      command: { path: "review/fix.md" }
    });
    await client.getCommand("s1", "review/fix.md");
    await client.deleteCommand("s1", "review/fix.md");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.example.com/__bottle/v1/commands",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ path: "review/fix.md", content: "Fix it" })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.example.com/__bottle/v1/commands?path=review%2Ffix.md",
      expect.objectContaining({ headers: expect.objectContaining({ "content-type": "application/json" }) })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.example.com/__bottle/v1/commands",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ path: "review/fix.md" })
      })
    );
  });

  it("calls project root fuzzy file search endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ results: [{ path: "src/app.ts", name: "app.ts", type: "file", score: 42, updatedAt: "now" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const client = createBottleClient({ baseUrl: "https://api.example.com/__bottle", fetch: fetchMock });

    await expect(client.searchFiles("s1", "sat", { limit: 5 })).resolves.toMatchObject({
      results: [{ path: "src/app.ts", type: "file" }]
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/__bottle/v1/sessions/s1/files:search?q=sat&limit=5",
      expect.objectContaining({
        headers: expect.objectContaining({ "content-type": "application/json" })
      })
    );

    await expect(client.searchProjectFiles("sat", { limit: 5 })).resolves.toMatchObject({
      results: [{ path: "src/app.ts", type: "file" }]
    });

    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://api.example.com/__bottle/v1/files:search?q=sat&limit=5",
      expect.objectContaining({
        headers: expect.objectContaining({ "content-type": "application/json" })
      })
    );
  });

  it("uses only prefixed /__bottle/v1 routes for AI tool operations", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/sessions")) {
        return new Response(
          JSON.stringify({ id: "s1", sessionId: "s1", mode: "plan", createdAt: "now", updatedAt: "now", hasRun: false }),
          { status: 201, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/messages:stream")) {
        return new Response("event: done\ndata: {\"ok\":true}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      }
      if (url.endsWith("/interrupt")) {
        return new Response(JSON.stringify({ interrupted: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.includes("/files:search")) {
        return new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/v1/commands")) {
        return new Response(JSON.stringify({ commands: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 500 });
    });
    const client = createBottleClient({ baseUrl: "https://api.example.com/__bottle", fetch: fetchMock });

    const session = await client.createSession({ mode: "plan", title: "Prototype" });
    await client.streamMessage(session.sessionId, { prompt: "Change the UI" });
    await client.interrupt(session.sessionId);
    await client.searchFiles(session.sessionId, "button");
    await client.listCommands(session.sessionId);

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).toEqual([
      "https://api.example.com/__bottle/v1/sessions",
      "https://api.example.com/__bottle/v1/sessions/s1/messages:stream",
      "https://api.example.com/__bottle/v1/sessions/s1/interrupt",
      "https://api.example.com/__bottle/v1/sessions/s1/files:search?q=button",
      "https://api.example.com/__bottle/v1/commands"
    ]);
    expect(urls.every((url) => url.includes("/__bottle/v1/"))).toBe(true);
    expect(urls.every((url) => !url.includes("/api/agent"))).toBe(true);
  });
});

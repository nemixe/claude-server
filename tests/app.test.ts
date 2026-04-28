import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentService, type AgentSdkAdapter } from "../src/agent-service.js";
import { createApp } from "../src/app.js";
import type { SessionFactory, SessionLike } from "../src/session-adapter.js";
import { SessionStore } from "../src/session-store.js";
import { SettingsStore } from "../src/settings-store.js";
import { createTempConfig } from "./helpers.js";

describe("Hono API", () => {
  it("serves the browser test client behind the hostname gate", async () => {
    const config = await createTempConfig();
    const app = await createApp({ config });

    const response = await app.request("http://localhost/client", {
      headers: { host: "localhost" }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Claude AI Chat");
    expect(html).toContain('id="root"');
    expect(html).toContain('rel="stylesheet" href="/client/assets/index.css"');
    expect(html).toContain('type="module" src="/client/assets/client.js"');
    expect(html).not.toContain("cdn.jsdelivr.net");
    expect(html).not.toContain("unpkg.com");
  });

  it("creates sessions and streams normalized events", async () => {
    const config = await createTempConfig();
    const adapter: AgentSdkAdapter = {
      query: () =>
        (async function* () {
          yield { type: "assistant", message: { content: "hello" } };
          yield { type: "result", result: "done" };
        })(),
      getSessionMessages: async () => [{ type: "user", message: "hi" }]
    };
    const app = await createApp({
      config,
      sessionStore: new SessionStore(config),
      agentService: new AgentService(config, adapter)
    });

    const createResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan", title: "Test" })
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    const streamResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/messages:stream`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" })
    });

    expect(streamResponse.status).toBe(200);
    const streamText = await streamResponse.text();
    expect(streamText).toContain("event: message");
    expect(streamText).toContain("event: result");
    expect(streamText).toContain("event: done");

    const sessionsResponse = await app.request("http://localhost/v1/sessions", {
      headers: { host: "localhost" }
    });
    const sessionsBody = (await sessionsResponse.json()) as { sessions: Array<Record<string, unknown>> };
    expect(sessionsBody.sessions[0]).toMatchObject({
      id: created.sessionId,
      sessionId: created.sessionId,
      mode: "plan",
      hasRun: true
    });
    expect(sessionsBody.sessions[0]).not.toHaveProperty("workspacePath");

    const messagesResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/messages`, {
      headers: { host: "localhost" }
    });
    expect(messagesResponse.status).toBe(200);
    expect(await messagesResponse.json()).toMatchObject({ messages: [{ type: "user", message: "hi" }] });

    const observeResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/events:stream`, {
      headers: { host: "localhost" }
    });
    expect(observeResponse.status).toBe(200);
    const observeText = await observeResponse.text();
    expect(observeText).toContain("event: status");
    expect(observeText).toContain('"running":false');
  });

  it("persists and exposes optional session user names", async () => {
    const config = await createTempConfig();
    const sessionStore = new SessionStore(config);
    const app = await createApp({ config, sessionStore });

    const namedResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ mode: "bypass", title: "Named", userName: "  Ada Lovelace  " })
    });
    expect(namedResponse.status).toBe(201);
    const named = (await namedResponse.json()) as { sessionId: string; userName?: string };
    expect(named.userName).toBe("Ada Lovelace");

    const guestResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ mode: "bypass", title: "Legacy-like" })
    });
    expect(guestResponse.status).toBe(201);
    const guest = (await guestResponse.json()) as { sessionId: string };

    await expect(sessionStore.get(named.sessionId)).resolves.toMatchObject({ userName: "Ada Lovelace" });

    const sessionsResponse = await app.request("http://localhost/v1/sessions", {
      headers: { host: "localhost" }
    });
    const sessionsBody = (await sessionsResponse.json()) as { sessions: Array<Record<string, unknown>> };
    const namedSession = sessionsBody.sessions.find((session) => session.sessionId === named.sessionId);
    const guestSession = sessionsBody.sessions.find((session) => session.sessionId === guest.sessionId);

    expect(namedSession).toMatchObject({ userName: "Ada Lovelace" });
    expect(guestSession).not.toHaveProperty("userName");
    expect(namedSession).not.toHaveProperty("workspacePath");
  });

  it("paginates the session list", async () => {
    const config = await createTempConfig();
    const sessionStore = new SessionStore(config);
    const app = await createApp({ config, sessionStore });

    await sessionStore.create({ mode: "bypass", title: "First" });
    await sessionStore.create({ mode: "bypass", title: "Second" });
    await sessionStore.create({ mode: "plan", title: "Third" });

    const firstPageResponse = await app.request("http://localhost/v1/sessions?limit=2&offset=0", {
      headers: { host: "localhost" }
    });
    expect(firstPageResponse.status).toBe(200);
    const firstPage = (await firstPageResponse.json()) as { sessions: Array<Record<string, unknown>>; nextOffset?: number; hasMore: boolean };
    expect(firstPage.sessions).toHaveLength(2);
    expect(firstPage.nextOffset).toBe(2);
    expect(firstPage.hasMore).toBe(true);

    const secondPageResponse = await app.request("http://localhost/v1/sessions?limit=2&offset=2", {
      headers: { host: "localhost" }
    });
    const secondPage = (await secondPageResponse.json()) as { sessions: Array<Record<string, unknown>>; hasMore: boolean };
    expect(secondPage.sessions).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);
  });

  it("loads a single public session without scanning session pages", async () => {
    const config = await createTempConfig();
    const sessionStore = new SessionStore(config);
    const app = await createApp({ config, sessionStore });
    const session = await sessionStore.create({ mode: "bypass", title: "Lookup", userName: "Ada" });

    const response = await app.request(`http://localhost/v1/sessions/${session.id}`, {
      headers: { host: "localhost" }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: session.id,
      sessionId: session.id,
      title: "Lookup",
      userName: "Ada"
    });
  });

  it("returns paginated session messages with metadata", async () => {
    const config = await createTempConfig();
    const messages = Array.from({ length: 5 }, (_, index) => ({ type: "user", message: "m" + index }));
    const adapter: AgentSdkAdapter = {
      query: () => (async function* () {})(),
      getSessionMessages: async () => messages
    };
    const sessionStore = new SessionStore(config);
    const app = await createApp({
      config,
      sessionStore,
      agentService: new AgentService(config, adapter)
    });
    const session = await sessionStore.create({ mode: "bypass", title: "History" });

    const fullResponse = await app.request(`http://localhost/v1/sessions/${session.id}/messages`, {
      headers: { host: "localhost" }
    });
    await expect(fullResponse.json()).resolves.toMatchObject({
      messages,
      offset: 0,
      total: 5,
      hasMoreBefore: false,
      hasMoreAfter: false
    });

    const pageResponse = await app.request(`http://localhost/v1/sessions/${session.id}/messages?limit=2&offset=1`, {
      headers: { host: "localhost" }
    });
    await expect(pageResponse.json()).resolves.toMatchObject({
      messages: messages.slice(1, 3),
      offset: 1,
      limit: 2,
      total: 5,
      previousOffset: 0,
      nextOffset: 3,
      hasMoreBefore: true,
      hasMoreAfter: true
    });

    const tailResponse = await app.request(`http://localhost/v1/sessions/${session.id}/messages?limit=2&tail=true`, {
      headers: { host: "localhost" }
    });
    await expect(tailResponse.json()).resolves.toMatchObject({
      messages: messages.slice(3),
      offset: 3,
      limit: 2,
      total: 5,
      previousOffset: 1,
      hasMoreBefore: true,
      hasMoreAfter: false
    });
  });

  it("stores the latest cumulative session cost from result events", async () => {
    const config = await createTempConfig();
    const sessionStore = new SessionStore(config);
    const adapter: AgentSdkAdapter = {
      query: () =>
        (async function* () {
          yield { type: "result", result: "first", total_cost_usd: 0.1537 };
          yield { type: "result", result: "second", total_cost_usd: 0.1682 };
        })(),
      getSessionMessages: async () => []
    };
    const app = await createApp({
      config,
      sessionStore,
      agentService: new AgentService(config, adapter)
    });

    const createResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan", title: "Cost" })
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string };

    const streamResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/messages:stream`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" })
    });
    expect(streamResponse.status).toBe(200);
    await streamResponse.text();

    await expect(sessionStore.get(created.sessionId)).resolves.toMatchObject({ costUsd: 0.1682 });

    const sessionsResponse = await app.request("http://localhost/v1/sessions", {
      headers: { host: "localhost" }
    });
    const sessionsBody = (await sessionsResponse.json()) as { sessions: Array<Record<string, unknown>> };
    expect(sessionsBody.sessions[0]).toMatchObject({ costUsd: 0.1682 });
  });

  it("persists Claude SDK session IDs from V2 stream events", async () => {
    const config = await createTempConfig({ ENABLE_SESSION_API: "true", CLAUDE_MODEL: "claude-sonnet-4-6" });
    const sdkSession = createMockSdkSession("claude-app-1", async function* () {
      yield { type: "result", session_id: "claude-app-1", is_error: false };
    });
    const factory: SessionFactory = {
      createSession: vi.fn(() => sdkSession),
      resumeSession: vi.fn(() => createMockSdkSession("unused", async function* () {}))
    };
    const sessionStore = new SessionStore(config);
    const app = await createApp({
      config,
      sessionStore,
      agentService: new AgentService(config, undefined, factory)
    });

    const createResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ mode: "bypass", title: "V2" })
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const streamResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/messages:stream`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" })
    });

    expect(streamResponse.status).toBe(200);
    expect(await streamResponse.text()).toContain("event: result");
    await expect(sessionStore.get(created.sessionId)).resolves.toMatchObject({
      hasRun: true,
      claudeSessionId: "claude-app-1"
    });

    const sessionsResponse = await app.request("http://localhost/v1/sessions", {
      headers: { host: "localhost" }
    });
    const sessionsBody = (await sessionsResponse.json()) as { sessions: Array<Record<string, unknown>> };
    expect(sessionsBody.sessions[0]).not.toHaveProperty("claudeSessionId");
  });

  it("accepts validated base64 image prompt requests", async () => {
    const config = await createTempConfig();
    const seenPrompts: unknown[] = [];
    const adapter: AgentSdkAdapter = {
      query: (input) => {
        seenPrompts.push(input.prompt);
        return (async function* () {
          yield { type: "result", result: "done" };
        })();
      },
      getSessionMessages: async () => []
    };
    const app = await createApp({
      config,
      sessionStore: new SessionStore(config),
      agentService: new AgentService(config, adapter)
    });

    const createResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan", title: "Images" })
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const streamResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/messages:stream`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "describe this",
        images: [
          { name: "pixel.png", mediaType: "image/png", dataBase64: "data:image/png;base64,aGVsbG8=" },
          { name: "photo.jpg", mediaType: "image/jpeg", dataBase64: "aGVsbG8=" },
          { name: "animation.gif", mediaType: "image/gif", dataBase64: "aGVsbG8=" },
          { name: "screen.webp", mediaType: "image/webp", dataBase64: "aGVsbG8=" }
        ]
      })
    });

    expect(streamResponse.status).toBe(200);
    expect(await streamResponse.text()).toContain("event: result");

    const prompt = seenPrompts[0];
    expect(typeof prompt).not.toBe("string");
    const messages = [];
    for await (const message of prompt as AsyncIterable<Record<string, unknown>>) {
      messages.push(message);
    }
    expect(messages[0]).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "aGVsbG8=" } },
          { type: "image", source: { type: "base64", media_type: "image/gif", data: "aGVsbG8=" } },
          { type: "image", source: { type: "base64", media_type: "image/webp", data: "aGVsbG8=" } }
        ]
      },
      parent_tool_use_id: null
    });
  });

  it("rejects invalid image prompt requests", async () => {
    const config = await createTempConfig();
    const app = await createApp({ config });
    const createResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan", title: "Images" })
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const invalidMediaResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/messages:stream`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "describe this",
        images: [{ mediaType: "image/svg+xml", dataBase64: "aGVsbG8=" }]
      })
    });
    expect(invalidMediaResponse.status).toBe(400);

    const invalidBase64Response = await app.request(`http://localhost/v1/sessions/${created.sessionId}/messages:stream`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "describe this",
        images: [{ mediaType: "image/png", dataBase64: "%%%not-base64%%%" }]
      })
    });
    expect(invalidBase64Response.status).toBe(400);

    const tooManyResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/messages:stream`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "describe this",
        images: Array.from({ length: 6 }, () => ({ mediaType: "image/png", dataBase64: "aGVsbG8=" }))
      })
    });
    expect(tooManyResponse.status).toBe(400);

    const oversizedResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/messages:stream`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "describe this",
        images: [{ mediaType: "image/png", dataBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64") }]
      })
    });
    expect(oversizedResponse.status).toBe(400);
  });

  it("searches project root files and folders with fuzzy path matching", async () => {
    const config = await createTempConfig();
    await fs.mkdir(path.join(config.projectRoot, "src/components"), { recursive: true });
    await fs.mkdir(path.join(config.projectRoot, "docs"), { recursive: true });
    await fs.mkdir(path.join(config.projectRoot, "node_modules/temp/agent-chat"), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(config.projectRoot, "src/components/Button.tsx"), "export const Button = () => null;", "utf8"),
      fs.writeFile(path.join(config.projectRoot, "docs/agent-guide.md"), "# Agent guide", "utf8"),
      fs.writeFile(path.join(config.projectRoot, "node_modules/temp/agent-chat/ignored.js"), "ignored", "utf8")
    ]);
    const app = await createApp({ config });
    const createResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({
        mode: "plan",
        title: "Search"
      })
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const directoryResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/files:search?q=docs`, {
      headers: { host: "localhost" }
    });
    expect(directoryResponse.status).toBe(200);
    const directoryBody = (await directoryResponse.json()) as { results: Array<Record<string, unknown>> };
    expect(directoryBody.results[0]).toMatchObject({
      path: "docs",
      name: "docs",
      type: "directory"
    });

    const fuzzyResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/files:search?q=cmpbtn&limit=3`, {
      headers: { host: "localhost" }
    });
    expect(fuzzyResponse.status).toBe(200);
    const fuzzyBody = (await fuzzyResponse.json()) as { results: Array<Record<string, unknown>> };
    expect(fuzzyBody.results[0]).toMatchObject({
      path: "src/components/Button.tsx",
      name: "Button.tsx",
      type: "file"
    });
    expect(fuzzyBody.results[0]?.score).toEqual(expect.any(Number));
    expect(fuzzyBody.results[0]?.updatedAt).toEqual(expect.any(String));

    const ignoredResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/files:search?q=ignored`, {
      headers: { host: "localhost" }
    });
    expect(ignoredResponse.status).toBe(200);
    await expect(ignoredResponse.json()).resolves.toMatchObject({ results: [] });

    const emptyResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/files:search?q=&limit=2`, {
      headers: { host: "localhost" }
    });
    expect(emptyResponse.status).toBe(200);
    const emptyBody = (await emptyResponse.json()) as { results: Array<Record<string, unknown>> };
    expect(emptyBody.results).toHaveLength(2);
    expect(emptyBody.results[0]).toMatchObject({
      path: "docs",
      score: 0
    });
  });

  it("persists settings to disk via PATCH /v1/settings and reads them back", async () => {
    const config = await createTempConfig();
    const app = await createApp({ config });

    const getResponse = await app.request("http://localhost/v1/settings", {
      headers: { host: "localhost" }
    });
    expect(getResponse.status).toBe(200);
    const initial = (await getResponse.json()) as { maxConcurrentRuns: number; maxTurns: number };
    expect(initial.maxConcurrentRuns).toBe(2);
    expect(initial.maxTurns).toBe(5);

    const patchResponse = await app.request("http://localhost/v1/settings", {
      method: "PATCH",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ maxConcurrentRuns: 8, maxTurns: 50 })
    });
    expect(patchResponse.status).toBe(200);
    const patched = (await patchResponse.json()) as { maxConcurrentRuns: number; maxTurns: number };
    expect(patched.maxConcurrentRuns).toBe(8);
    expect(patched.maxTurns).toBe(50);

    // Verify persisted to file
    const settingsPath = path.join(config.sessionDir, "settings.json");
    const raw = await fs.readFile(settingsPath, "utf8");
    const persisted = JSON.parse(raw);
    expect(persisted.maxConcurrentRuns).toBe(8);
    expect(persisted.maxTurns).toBe(50);

    const sessionsResponse = await app.request("http://localhost/v1/sessions", {
      headers: { host: "localhost" }
    });
    expect(sessionsResponse.status).toBe(200);
    const sessionsBody = (await sessionsResponse.json()) as { sessions: unknown[] };
    expect(sessionsBody.sessions).toEqual([]);

    // Verify a fresh app instance loads persisted values
    const freshApp = await createApp({ config });
    const freshGet = await freshApp.request("http://localhost/v1/settings", {
      headers: { host: "localhost" }
    });
    const freshSettings = (await freshGet.json()) as { maxConcurrentRuns: number; maxTurns: number };
    expect(freshSettings.maxConcurrentRuns).toBe(8);
    expect(freshSettings.maxTurns).toBe(50);
  });
});

function createMockSdkSession(id: string, stream: () => AsyncGenerator<unknown>): SessionLike {
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

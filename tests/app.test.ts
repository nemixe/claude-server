import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentService, type AgentSdkAdapter } from "../src/agent-service.js";
import { createApp } from "../src/app.js";
import { SessionStore } from "../src/session-store.js";
import { createTempConfig } from "./helpers.js";

describe("Hono API", () => {
  it("serves the browser test client behind the hostname gate", async () => {
    const config = await createTempConfig();
    const app = createApp({ config });

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
    const app = createApp({
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
    expect(await messagesResponse.json()).toEqual({ messages: [{ type: "user", message: "hi" }] });

    const observeResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/events:stream`, {
      headers: { host: "localhost" }
    });
    expect(observeResponse.status).toBe(200);
    const observeText = await observeResponse.text();
    expect(observeText).toContain("event: status");
    expect(observeText).toContain('"running":false');
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
    const app = createApp({
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
    const app = createApp({ config });
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

  it("manages per-session Claude command files inside .claude/commands", async () => {
    const config = await createTempConfig();
    const app = createApp({ config });
    const createResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan", title: "Commands" })
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const saveResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/claude-commands`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ path: "review/fix.md", content: "Review and fix this code." })
    });
    expect(saveResponse.status).toBe(201);
    await expect(fs.readFile(path.join(config.claudeCommandsDir, "review/fix.md"), "utf8")).resolves.toBe("Review and fix this code.");
    await expect(
      fs.readFile(path.join(config.workspaceDir, created.sessionId, ".claude/commands/review/fix.md"), "utf8")
    ).resolves.toBe("Review and fix this code.");

    const listResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/claude-commands`, {
      headers: { host: "localhost" }
    });
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({
      commands: [{ path: "review/fix.md", content: "Review and fix this code." }]
    });

    const readResponse = await app.request(
      `http://localhost/v1/sessions/${created.sessionId}/claude-commands?path=${encodeURIComponent(".claude/commands/review/fix.md")}`,
      { headers: { host: "localhost" } }
    );
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toMatchObject({
      command: { path: "review/fix.md", content: "Review and fix this code." }
    });

    const deleteResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/claude-commands`, {
      method: "DELETE",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ path: "review/fix.md" })
    });
    expect(deleteResponse.status).toBe(200);
    await expect(fs.stat(path.join(config.workspaceDir, created.sessionId, ".claude/commands/review/fix.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(fs.stat(path.join(config.claudeCommandsDir, "review/fix.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects Claude command paths outside .claude/commands and non-markdown files", async () => {
    const config = await createTempConfig();
    const app = createApp({ config });
    const createResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan", title: "Commands" })
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const traversalResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/claude-commands`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ path: "../secret.md", content: "bad" })
    });
    expect(traversalResponse.status).toBe(400);

    const nonMarkdownResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/claude-commands`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ path: "review.txt", content: "bad" })
    });
    expect(nonMarkdownResponse.status).toBe(400);
  });

  it("lists repo Claude commands and mirrors them into the selected session workspace", async () => {
    const config = await createTempConfig();
    await fs.mkdir(path.join(config.claudeCommandsDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(config.claudeCommandsDir, "nested/test.md"), "From repo root", "utf8");
    const app = createApp({ config });

    const createResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan", title: "Commands" })
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const listResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/claude-commands`, {
      headers: { host: "localhost" }
    });

    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({
      commands: [{ path: "nested/test.md", content: "From repo root" }]
    });
    await expect(
      fs.readFile(path.join(config.workspaceDir, created.sessionId, ".claude/commands/nested/test.md"), "utf8")
    ).resolves.toBe("From repo root");
  });

  it("searches workspace files and folders with fuzzy path matching", async () => {
    const config = await createTempConfig();
    const app = createApp({ config });
    const createResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({
        mode: "plan",
        title: "Search",
        files: [
          { path: "src/components/Button.tsx", content: "export const Button = () => null;" },
          { path: "docs/agent-guide.md", content: "# Agent guide" }
        ]
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

    const invalidResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/files:search?q=`, {
      headers: { host: "localhost" }
    });
    expect(invalidResponse.status).toBe(400);
  });
});

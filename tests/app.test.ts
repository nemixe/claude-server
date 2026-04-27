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
    expect(html).toContain("Claude API Test Client");
    expect(html).toContain("claude-test-client:last-session");
    expect(html).toContain("sessionList");
    expect(html).toContain("loadSessions");
    expect(html).toContain("session_selected");
    expect(html).toContain("Session History");
    expect(html).toContain("events:stream");
    expect(html).toContain('id="loader"');
    expect(html).toContain("Generating");
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
});

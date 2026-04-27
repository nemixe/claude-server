import { describe, expect, it } from "vitest";
import { AgentService, type AgentSdkAdapter } from "../src/agent-service.js";
import { createApp } from "../src/app.js";
import { SessionStore } from "../src/session-store.js";
import { createTempConfig } from "./helpers.js";

describe("Hono API", () => {
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

    const messagesResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/messages`, {
      headers: { host: "localhost" }
    });
    expect(messagesResponse.status).toBe(200);
    expect(await messagesResponse.json()).toEqual({ messages: [{ type: "user", message: "hi" }] });
  });
});

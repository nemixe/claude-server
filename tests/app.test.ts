import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentService, type AgentSdkAdapter, type CodexSdkAdapter, type CodexThreadLike } from "../src/agent-service.js";
import { createApp, withSseHeartbeat } from "../src/app.js";
import type { SessionFactory, SessionLike } from "../src/session-adapter.js";
import { SessionStore } from "../src/session-store.js";
import { SettingsStore } from "../src/settings-store.js";
import { createTempConfig } from "./helpers.js";

describe("Hono API", () => {
  it("writes SSE keep-alive comments while a stream callback is waiting", async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const stream = {
      aborted: false,
      closed: false,
      write: vi.fn(async (chunk: string) => {
        writes.push(chunk);
      })
    };
    let finish!: () => void;

    try {
      const pending = withSseHeartbeat(
        stream,
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        25
      );

      await vi.advanceTimersByTimeAsync(25);
      expect(writes).toEqual([": keep-alive\n\n"]);

      stream.closed = true;
      await vi.advanceTimersByTimeAsync(25);
      expect(writes).toHaveLength(1);

      finish();
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes Bottle discovery metadata behind the hostname gate", async () => {
    const config = await createTempConfig({ BOTTLE_NAME: "prototype-a", MAIN_APP_URL: "http://localhost:5173" });
    const app = await createApp({ config });

    const response = await app.request("http://localhost/v1/bottle", {
      headers: { host: "localhost" }
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty("appProxyUrl");
    expect(body).not.toHaveProperty("appUrl");
    expect(body).toMatchObject({
      protocolVersion: 1,
      name: "prototype-a",
      apiBaseUrl: "http://localhost",
      mainAppUrl: "http://localhost",
      defaultAgentProvider: "claude",
      availableAgentProviders: ["claude", "codex"],
      features: {
        mainApp: true,
        mainAppProxy: true,
        mainAppDirect: true,
        clientAtRoot: true,
        iframeBridge: true,
        sessions: true,
        streaming: true,
        agents: true,
        commands: true,
        rules: true,
        skills: true,
        authToken: false
      }
    });
  });

  it("exposes API-only Bottle metadata without taking over root routes", async () => {
    const config = await createTempConfig({
      MAIN_APP_URL: "https://ai-proto-dev-1.devnstg.com",
      MAIN_APP_PROXY: "false",
      CLIENT_ORIGINS: "https://ai-wrapper.devnstg.com"
    });
    const app = await createApp({ config });

    const infoResponse = await app.request("http://localhost/v1/bottle", {
      headers: { host: "localhost" }
    });
    const infoBody = await infoResponse.json();

    expect(infoResponse.status).toBe(200);
    expect(infoBody).not.toHaveProperty("appProxyUrl");
    expect(infoBody).toMatchObject({
      apiBaseUrl: "http://localhost",
      mainAppUrl: "https://ai-proto-dev-1.devnstg.com",
      appUrl: "https://ai-proto-dev-1.devnstg.com",
      features: {
        mainApp: true,
        mainAppProxy: false,
        mainAppDirect: false,
        clientAtRoot: false
      }
    });

    const rootResponse = await app.request("http://localhost/", {
      headers: { host: "localhost" }
    });
    expect(rootResponse.status).toBe(404);
  });

  it("advertises appProxyUrl for AI iframe proxy mode while preserving the real main app URL", async () => {
    const config = await createTempConfig({
      MAIN_APP_URL: "https://ai-proto-dev-1.devnstg.com",
      MAIN_APP_PROXY: "true",
      MAIN_APP_DIRECT: "false",
      CLIENT_ORIGINS: "https://ai-wrapper.devnstg.com"
    });
    const app = await createApp({ config });

    const infoResponse = await app.request("http://localhost/v1/bottle", {
      headers: { host: "localhost" }
    });
    const infoBody = await infoResponse.json();

    expect(infoResponse.status).toBe(200);
    expect(infoBody).not.toHaveProperty("appUrl");
    expect(infoBody).toMatchObject({
      apiBaseUrl: "http://localhost",
      mainAppUrl: "https://ai-proto-dev-1.devnstg.com",
      appProxyUrl: "http://localhost/__app/",
      features: {
        mainApp: true,
        mainAppProxy: true,
        mainAppDirect: false,
        clientAtRoot: true
      }
    });
  });

  it("exposes configured project root information", async () => {
    const config = await createTempConfig();
    const app = await createApp({ config });

    const response = await app.request("http://localhost/v1/root", {
      headers: { host: "localhost" }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      projectRoot: config.projectRoot,
      bottleDir: config.bottleDir,
      agentsDir: config.agentsDir,
      commandsDir: config.commandsDir,
      rulesDir: config.rulesDir,
      skillsDir: config.skillsDir,
      extraSkillRoots: config.extraSkillRoots,
      skillRoots: config.skillRoots,
      claudeCommandsDir: config.claudeCommandsDir
    });
  });

  it("serves the optional iframe bridge without hosting the main app", async () => {
    const config = await createTempConfig({
      MAIN_APP_URL: "http://localhost:5173",
      MAIN_APP_PROXY: "false",
      CLIENT_ORIGINS: "http://localhost:5174"
    });
    const app = await createApp({ config });

    const infoResponse = await app.request("http://localhost/v1/bottle", {
      headers: { host: "localhost" }
    });
    await expect(infoResponse.json()).resolves.toMatchObject({
      appUrl: "http://localhost:5173",
      features: { mainApp: true, mainAppProxy: false }
    });

    const bridgeResponse = await app.request("http://localhost/bottle-bridge.js", {
      headers: { host: "localhost" }
    });
    expect(bridgeResponse.status).toBe(200);
    expect(await bridgeResponse.text()).toContain("ai-client:request-context");

    const removedAppHostingResponse = await app.request("http://localhost/app/", {
      headers: { host: "localhost" }
    });
    expect(removedAppHostingResponse.status).toBe(404);
  });

  it("serves AI Client at root until the target URL cookie exists", async () => {
    const clientRequests: string[] = [];
    const clientApp = await createTestHttpServer((request, response) => {
      clientRequests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><body>AI Client</body></html>");
    });
    const upstreamRequests: string[] = [];
    const upstream = await createTestHttpServer((request, response) => {
      upstreamRequests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><head><title>Target</title></head><body>Target App</body></html>");
    });

    try {
      const config = await createTempConfig({
        MAIN_APP_URL: upstream.origin,
        CLIENT_APP_URL: clientApp.origin
      });
      const app = await createApp({ config });

      const clientResponse = await app.request("http://localhost/", {
        headers: { host: "localhost" }
      });
      expect(clientResponse.status).toBe(200);
      expect(await clientResponse.text()).toContain("AI Client");

      const legacyClientResponse = await app.request("http://localhost/__ai_client/", {
        headers: { host: "localhost" }
      });
      expect(legacyClientResponse.status).toBe(404);

      const infoResponse = await app.request("http://localhost/v1/bottle", {
        headers: { host: "localhost" }
      });
      const infoBody = await infoResponse.json();
      expect(infoBody).not.toHaveProperty("appProxyUrl");
      expect(infoBody).not.toHaveProperty("appUrl");
      expect(infoBody.features).toMatchObject({
        mainApp: true,
        mainAppProxy: true,
        mainAppDirect: true,
        clientAtRoot: true
      });
      expect(infoBody.mainAppUrl).toBe("http://localhost");

      const cookieHeaders = {
        host: "localhost",
        cookie: "bottle_target_app_url=http%3A%2F%2Flocalhost%2F"
      };
      const infoWithCookieResponse = await app.request("http://localhost/v1/bottle", {
        headers: cookieHeaders
      });
      const infoWithCookieBody = await infoWithCookieResponse.json();
      expect(infoWithCookieBody.appUrl).toBe("http://localhost/");
      expect(infoWithCookieBody.features.clientAtRoot).toBe(false);

      const rootResponse = await app.request("http://localhost/", {
        headers: cookieHeaders
      });
      expect(rootResponse.status).toBe(200);
      const rootHtml = await rootResponse.text();
      expect(rootHtml).toContain("Target App");
      expect(rootHtml).toContain('<script src="/bottle-bridge.js" data-bottle-bridge></script>');

      const dashboardResponse = await app.request("http://localhost/dashboard?tab=monthly", {
        headers: cookieHeaders
      });
      expect(dashboardResponse.status).toBe(200);
      expect(clientRequests).toEqual(expect.arrayContaining(["/"]));
      expect(upstreamRequests).toEqual(expect.arrayContaining(["/", "/dashboard?tab=monthly"]));
    } finally {
      await clientApp.close();
      await upstream.close();
    }
  });

  it("proxies fixed app routes, rewrites root assets, and injects the generic bridge", async () => {
    const upstreamRequests: string[] = [];
    const upstream = await createTestHttpServer((request, response) => {
      upstreamRequests.push(request.url ?? "");
      if (request.url?.startsWith("/assets/app.js")) {
        response.writeHead(200, { "content-type": "application/javascript", "content-length": "18" });
        response.end("console.log('app')");
        return;
      }

      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'self'",
        "x-frame-options": "DENY"
      });
      response.end(
        '<!doctype html><html><head><title>Target</title><script type="module" src="/assets/app.js"></script></head><body><a href="/activity-log">Activity</a></body></html>'
      );
    });

    try {
      const config = await createTempConfig({ MAIN_APP_URL: upstream.origin, MAIN_APP_DIRECT: "false" });
      const app = await createApp({ config });

      const infoResponse = await app.request("http://localhost/v1/bottle", {
        headers: { host: "localhost" }
      });
      const infoBody = await infoResponse.json();
      expect(infoBody.mainAppUrl).toBe(upstream.origin);
      expect(infoBody.appProxyUrl).toBe("http://localhost/__app/");
      expect(infoBody).not.toHaveProperty("appUrl");

      const htmlResponse = await app.request("http://localhost/__app/dashboard?tab=monthly", {
        headers: { host: "localhost" }
      });
      const html = await htmlResponse.text();

      expect(htmlResponse.status).toBe(200);
      expect(upstreamRequests).toContain("/dashboard?tab=monthly");
      expect(html).toContain("window.__BOTTLE_BRIDGE_CONFIG__");
      expect(html).toContain('"appProxyPath":"/__app"');
      expect(html).toContain('<script src="/bottle-bridge.js" data-bottle-bridge></script>');
      expect(html).toContain('src="/__app/assets/app.js"');
      expect(html).toContain('href="/__app/activity-log"');
      expect(htmlResponse.headers.get("content-security-policy")).toBeNull();
      expect(htmlResponse.headers.get("x-frame-options")).toBeNull();

      const assetResponse = await app.request("http://localhost/__app/assets/app.js", {
        headers: { host: "localhost" }
      });
      expect(assetResponse.status).toBe(200);
      expect(await assetResponse.text()).toBe("console.log('app')");

      const rootAssetResponse = await app.request("http://localhost/assets/app.js", {
        headers: { host: "localhost", referer: "http://localhost/__app/dashboard" }
      });
      expect(rootAssetResponse.status).toBe(200);
      expect(await rootAssetResponse.text()).toBe("console.log('app')");
    } finally {
      await upstream.close();
    }
  });

  it("applies AI client CORS, frame headers, and optional Bottle API token auth", async () => {
    const config = await createTempConfig({
      CLIENT_ORIGINS: "http://localhost:5173",
      BOTTLE_API_TOKEN: "secret",
      BOTTLE_API_TOKEN_REQUIRED: "true"
    });
    const app = await createApp({ config });

    const preflightResponse = await app.request("http://localhost/v1/sessions", {
      method: "OPTIONS",
      headers: {
        host: "localhost",
        origin: "http://localhost:5173",
        "access-control-request-method": "POST"
      }
    });
    expect(preflightResponse.status).toBe(204);
    expect(preflightResponse.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

    const unauthorizedResponse = await app.request("http://localhost/v1/root", {
      headers: { host: "localhost" }
    });
    expect(unauthorizedResponse.status).toBe(401);

    const authorizedResponse = await app.request("http://localhost/v1/root", {
      headers: { host: "localhost", authorization: "Bearer secret", origin: "http://localhost:5173" }
    });
    expect(authorizedResponse.status).toBe(200);
    expect(authorizedResponse.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(authorizedResponse.headers.get("content-security-policy")).toContain("frame-ancestors 'self' http://localhost:5173");
  });

  it("creates sessions and streams normalized events", async () => {
    const config = await createTempConfig();
    const adapter: AgentSdkAdapter = {
      getSessionMessages: async () => [{ type: "user", message: "hi" }]
    };
    const sdkSession = createMockSdkSession("claude-created", async function* () {
      yield { type: "assistant", session_id: "claude-created", message: { content: "hello" } };
      yield { type: "result", session_id: "claude-created", result: "done" };
    });
    const factory: SessionFactory = {
      createSession: vi.fn(() => sdkSession),
      resumeSession: vi.fn(() => sdkSession)
    };
    const app = await createApp({
      config,
      sessionStore: new SessionStore(config),
      agentService: new AgentService(config, adapter, factory)
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

  it("creates Codex sessions, streams normalized events, and caches messages", async () => {
    const config = await createTempConfig();
    const sessionStore = new SessionStore(config);
    const codexThread = createMockCodexThread("codex-app-1", "Codex done.");
    const codexAdapter: CodexSdkAdapter = {
      startThread: vi.fn(() => codexThread),
      resumeThread: vi.fn(() => codexThread)
    };
    const app = await createApp({
      config,
      sessionStore,
      agentService: new AgentService(config, undefined, undefined, () => codexAdapter)
    });

    const createResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ mode: "bypass", provider: "codex", title: "Codex" })
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { sessionId: string; provider: string };
    expect(created.provider).toBe("codex");

    const streamResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/messages:stream`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello codex" })
    });

    expect(streamResponse.status).toBe(200);
    const streamText = await streamResponse.text();
    expect(streamText).toContain("event: codex_event");
    expect(streamText).toContain("event: message");
    expect(streamText).toContain("event: result");
    await expect(sessionStore.get(created.sessionId)).resolves.toMatchObject({
      provider: "codex",
      hasRun: true,
      agentSessionId: "codex-app-1"
    });

    const messagesResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/messages`, {
      headers: { host: "localhost" }
    });
    const messagesBody = (await messagesResponse.json()) as { messages: unknown[] };
    expect(messagesBody.messages).toHaveLength(2);
    expect(messagesBody.messages[0]).toMatchObject({ message: { role: "user", content: "hello codex" } });
    expect(messagesBody.messages[1]).toMatchObject({ message: { role: "assistant", content: "Codex done." } });
  });

  it("streams Codex assistant questions as pending user input", async () => {
    const config = await createTempConfig();
    const sessionStore = new SessionStore(config);
    const codexThread = createMockCodexThread(
      "codex-question-app",
      [
        "What fields should `Product` have?",
        "",
        "```txt",
        "name: string, required",
        "price: decimal, required",
        "```"
      ].join("\n")
    );
    const app = await createApp({
      config,
      sessionStore,
      agentService: new AgentService(config, undefined, undefined, () => ({
        startThread: vi.fn(() => codexThread),
        resumeThread: vi.fn(() => codexThread)
      }))
    });

    const createResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan", provider: "codex", title: "Codex question" })
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const streamResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/messages:stream`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Create crud feature product ask me the fields" })
    });

    expect(streamResponse.status).toBe(200);
    const streamText = await streamResponse.text();
    expect(streamText).toContain("event: question_pending");
    expect(streamText).toContain('"waitingForUserQuestion":true');
    expect(streamText).toContain('"What fields should `Product` have?"');
    expect(streamText).toContain('"label":"name: string, required"');
    expect(streamText).toContain('"multiSelect":true');
    await expect(sessionStore.get(created.sessionId)).resolves.toMatchObject({
      status: "awaiting_user_input",
      pendingInterrupt: {
        type: "user_input",
        toolCallId: "codex-question:item-1",
        toolName: "AskUserQuestion"
      }
    });
  });

  it("streams Codex plan approvals, replays them, and resumes in edit mode after approval", async () => {
    const config = await createTempConfig();
    const sessionStore = new SessionStore(config);
    const codexThread = createMockCodexThread(
      "codex-plan-app",
      "<proposed_plan>\n# Product CRUD\n\n- Add a product store.\n- Add /v1/products routes.\n</proposed_plan>"
    );
    const codexAdapter: CodexSdkAdapter = {
      startThread: vi.fn(() => codexThread),
      resumeThread: vi.fn(() => codexThread)
    };
    const app = await createApp({
      config,
      sessionStore,
      agentService: new AgentService(config, undefined, undefined, () => codexAdapter)
    });

    const createResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan", provider: "codex", title: "Codex plan approval" })
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const streamResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/messages:stream`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Create product CRUD" })
    });
    const streamText = await streamResponse.text();

    expect(streamResponse.status).toBe(200);
    expect(streamText).toContain("event: approval_pending");
    expect(streamText).toContain('"waitingForApproval":true');
    expect(streamText).toContain("# Product CRUD");
    await expect(sessionStore.get(created.sessionId)).resolves.toMatchObject({
      status: "awaiting_approval",
      pendingInterrupt: {
        type: "approval",
        toolCallId: "codex-plan:item-1",
        toolName: "ExitPlanMode"
      }
    });
    expect(codexAdapter.startThread).toHaveBeenCalledTimes(1);
    expect(codexThread.runStreamed).toHaveBeenCalledTimes(1);

    const replayResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/messages:stream`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "continue" })
    });
    const replayText = await replayResponse.text();

    expect(replayResponse.status).toBe(200);
    expect(replayText).toContain("event: approval_pending");
    expect(replayText).toContain('"waitingForApproval":true');
    expect(codexThread.runStreamed).toHaveBeenCalledTimes(1);

    const approvedResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/messages:stream`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "Approved. Continue.",
        toolResult: {
          toolUseId: "codex-plan:item-1",
          kind: "approval",
          approved: true,
          content: JSON.stringify({ approved: true, plan: "# Product CRUD\n\n- Add a product store." })
        }
      })
    });
    const approvedText = await approvedResponse.text();

    expect(approvedResponse.status).toBe(200);
    expect(approvedText).toContain("event: result");
    expect(codexAdapter.resumeThread).toHaveBeenCalledTimes(1);
    expect(codexThread.runStreamed).toHaveBeenCalledTimes(2);
    const updated = await sessionStore.get(created.sessionId);
    expect(updated).toMatchObject({
      mode: "edit",
      status: "done"
    });
    expect(updated).not.toHaveProperty("pendingInterrupt");
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
      getSessionMessages: async () => []
    };
    const sdkSession = createMockSdkSession("claude-cost", async function* () {
      yield { type: "result", session_id: "claude-cost", result: "first", total_cost_usd: 0.1537 };
      yield { type: "result", session_id: "claude-cost", result: "second", total_cost_usd: 0.1682 };
    });
    const factory: SessionFactory = {
      createSession: vi.fn(() => sdkSession),
      resumeSession: vi.fn(() => sdkSession)
    };
    const app = await createApp({
      config,
      sessionStore,
      agentService: new AgentService(config, adapter, factory)
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
    const config = await createTempConfig();
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

  it("pauses on persisted ExitPlanMode approval and resumes in edit mode after approval", async () => {
    const config = await createTempConfig();
    const sessionStore = new SessionStore(config);
    let seenPermissionMode: unknown;
    const sdkSession = createMockSdkSession("claude-approval", async function* () {
      yield { type: "result", session_id: "claude-approval", is_error: false };
    });
    const factory: SessionFactory = {
      createSession: vi.fn((options) => {
        seenPermissionMode = options.permissionMode;
        return sdkSession;
      }),
      resumeSession: vi.fn((_, options) => {
        seenPermissionMode = options.permissionMode;
        return sdkSession;
      })
    };
    const app = await createApp({
      config,
      sessionStore,
      agentService: new AgentService(config, undefined, factory)
    });

    const session = await sessionStore.create({ mode: "plan", title: "Approve" });
    await sessionStore.save({
      ...session,
      status: "awaiting_approval",
      pendingInterrupt: {
        id: "interrupt:toolu_exit",
        type: "approval",
        toolCallId: "toolu_exit",
        toolName: "ExitPlanMode",
        prompt: "Exit plan mode?",
        payload: {
          input: { plan: "Implement the runtime classifier." },
          plan: "Implement the runtime classifier.",
          action: "exit_plan_mode"
        }
      }
    });

    const pausedResponse = await app.request(`http://localhost/v1/sessions/${session.id}/messages:stream`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "continue" })
    });
    const pausedText = await pausedResponse.text();

    expect(pausedResponse.status).toBe(200);
    expect(pausedText).toContain("event: approval_pending");
    expect(pausedText).toContain("Implement the runtime classifier.");
    expect(factory.createSession).not.toHaveBeenCalled();
    expect(factory.resumeSession).not.toHaveBeenCalled();

    const approvedResponse = await app.request(`http://localhost/v1/sessions/${session.id}/messages:stream`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "Approved. Continue.",
        toolResult: {
          toolUseId: "toolu_exit",
          kind: "approval",
          approved: true,
          content: JSON.stringify({ approved: true, plan: "Implement the runtime classifier." })
        }
      })
    });
    const approvedText = await approvedResponse.text();

    expect(approvedResponse.status).toBe(200);
    expect(approvedText).toContain("event: result");
    expect(seenPermissionMode).toBe("acceptEdits");
    const updated = await sessionStore.get(session.id);
    expect(updated).toMatchObject({
      mode: "edit",
      status: "done"
    });
    expect(updated).not.toHaveProperty("pendingInterrupt");
  });

  it("discards a malformed persisted AskUserQuestion interrupt and re-runs the agent", async () => {
    const config = await createTempConfig();
    const sessionStore = new SessionStore(config);
    const sdkSession = createMockSdkSession("claude-bad-interrupt", async function* () {
      yield { type: "result", session_id: "claude-bad-interrupt", is_error: false };
    });
    const factory: SessionFactory = {
      createSession: vi.fn(() => sdkSession),
      resumeSession: vi.fn(() => sdkSession)
    };
    const app = await createApp({
      config,
      sessionStore,
      agentService: new AgentService(config, undefined, factory)
    });

    const session = await sessionStore.create({ mode: "plan", title: "Resume bad interrupt" });
    await sessionStore.save({
      ...session,
      status: "awaiting_user_input",
      pendingInterrupt: {
        id: "interrupt:toolu_bad",
        type: "user_input",
        toolCallId: "toolu_bad",
        toolName: "AskUserQuestion",
        prompt: "Answer questions?",
        payload: {
          input: { questions: "[{\"question\": \"What?\"}]" },
          questions: "[{\"question\": \"What?\"}]"
        }
      }
    });

    const response = await app.request(`http://localhost/v1/sessions/${session.id}/messages:stream`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Continue", mode: "plan" })
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain("event: question_pending");
    expect(factory.createSession).toHaveBeenCalledOnce();

    const updated = await sessionStore.get(session.id);
    expect(updated).not.toHaveProperty("pendingInterrupt");
  });

  it("accepts validated base64 image prompt requests", async () => {
    const config = await createTempConfig();
    const sdkSession = createMockSdkSession("claude-images", async function* () {
      yield { type: "result", session_id: "claude-images", result: "done" };
    });
    const factory: SessionFactory = {
      createSession: vi.fn(() => sdkSession),
      resumeSession: vi.fn(() => sdkSession)
    };
    const app = await createApp({
      config,
      sessionStore: new SessionStore(config),
      agentService: new AgentService(config, undefined, factory)
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

    expect(sdkSession.send).toHaveBeenCalledTimes(1);
    expect(sdkSession.send).toHaveBeenCalledWith(expect.objectContaining({
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
    }));
  });

  it("passes Bottle iframe context into text prompts", async () => {
    const config = await createTempConfig();
    const sdkSession = createMockSdkSession("claude-context", async function* () {
      yield { type: "result", session_id: "claude-context", result: "done" };
    });
    const factory: SessionFactory = {
      createSession: vi.fn(() => sdkSession),
      resumeSession: vi.fn(() => sdkSession)
    };
    const app = await createApp({
      config,
      sessionStore: new SessionStore(config),
      agentService: new AgentService(config, undefined, factory)
    });

    const createResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan", title: "Context" })
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const streamResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}/messages:stream`, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "improve this page",
        context: {
          title: "Dashboard",
          route: "/reports?tab=monthly",
          selectedText: "Revenue card",
          viewport: { width: 1440, height: 900 }
        }
      })
    });

    expect(streamResponse.status).toBe(200);
    await streamResponse.text();
    expect(sdkSession.send).toHaveBeenCalledWith(expect.stringContaining("Bottle main app context:"));
    expect(sdkSession.send).toHaveBeenCalledWith(expect.stringContaining("Dashboard"));
    expect(sdkSession.send).toHaveBeenCalledWith(expect.stringContaining("User prompt:\nimprove this page"));
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

    const rootSearchResponse = await app.request("http://localhost/v1/files:search?q=cmpbtn&limit=3", {
      headers: { host: "localhost" }
    });
    expect(rootSearchResponse.status).toBe(200);
    const rootSearchBody = (await rootSearchResponse.json()) as { results: Array<Record<string, unknown>> };
    expect(rootSearchBody.results[0]).toMatchObject({
      path: "src/components/Button.tsx",
      name: "Button.tsx",
      type: "file"
    });
  });

  it("stores Claude commands only under the configured project root", async () => {
    const config = await createTempConfig();
    const sessionStore = new SessionStore(config);
    const app = await createApp({ config, sessionStore });

    const saveResponse = await app.request("http://localhost/v1/claude-commands", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ path: "review/fix.md", content: "Fix it" })
    });
    expect(saveResponse.status).toBe(201);
    await expect(saveResponse.json()).resolves.toMatchObject({ command: { path: "review/fix.md", content: "Fix it" } });

    const rootCommandPath = path.join(config.commandsDir, "review", "fix.md");
    await expect(fs.readFile(rootCommandPath, "utf8")).resolves.toBe("Fix it");

    const createResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan", title: "No command copy" })
    });
    const created = (await createResponse.json()) as { sessionId: string };
    const session = await sessionStore.get(created.sessionId);
    expect(session).toMatchObject({ workspacePath: config.projectRoot });
    await expect(fs.stat(config.workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });

    const deleteResponse = await app.request("http://localhost/v1/claude-commands", {
      method: "DELETE",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ path: "review/fix.md" })
    });
    expect(deleteResponse.status).toBe(200);
    await expect(fs.stat(rootCommandPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes session metadata without deleting the project root", async () => {
    const config = await createTempConfig();
    const app = await createApp({ config });
    const rootFile = path.join(config.projectRoot, "keep.txt");
    await fs.writeFile(rootFile, "keep me", "utf8");

    const createResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan", title: "Delete" })
    });
    const created = (await createResponse.json()) as { sessionId: string };

    const deleteResponse = await app.request(`http://localhost/v1/sessions/${created.sessionId}`, {
      method: "DELETE",
      headers: { host: "localhost" }
    });

    expect(deleteResponse.status).toBe(200);
    const rootStat = await fs.stat(config.projectRoot);
    expect(rootStat.isDirectory()).toBe(true);
    await expect(fs.readFile(rootFile, "utf8")).resolves.toBe("keep me");
  });

  it("persists settings to disk via PATCH /v1/settings and reads them back", async () => {
    const config = await createTempConfig();
    const app = await createApp({ config });

    const getResponse = await app.request("http://localhost/v1/settings", {
      headers: { host: "localhost" }
    });
    expect(getResponse.status).toBe(200);
    const initial = (await getResponse.json()) as {
      maxConcurrentRuns: number;
      maxTurns: number;
      defaultAgentProvider: string;
      availableAgentProviders: string[];
    };
    expect(initial.maxConcurrentRuns).toBe(2);
    expect(initial.maxTurns).toBe(5);
    expect(initial.defaultAgentProvider).toBe("claude");
    expect(initial.availableAgentProviders).toEqual(["claude", "codex"]);

    const patchResponse = await app.request("http://localhost/v1/settings", {
      method: "PATCH",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ maxConcurrentRuns: 8, maxTurns: 50, defaultAgentProvider: "codex" })
    });
    expect(patchResponse.status).toBe(200);
    const patched = (await patchResponse.json()) as {
      maxConcurrentRuns: number;
      maxTurns: number;
      defaultAgentProvider: string;
      availableAgentProviders: string[];
    };
    expect(patched.maxConcurrentRuns).toBe(8);
    expect(patched.maxTurns).toBe(50);
    expect(patched.defaultAgentProvider).toBe("codex");
    expect(patched.availableAgentProviders).toEqual(["claude", "codex"]);

    // Verify persisted to file
    const settingsPath = path.join(config.sessionDir, "settings.json");
    const raw = await fs.readFile(settingsPath, "utf8");
    const persisted = JSON.parse(raw);
    expect(persisted.maxConcurrentRuns).toBe(8);
    expect(persisted.maxTurns).toBe(50);
    expect(persisted.defaultAgentProvider).toBe("codex");

    const sessionsResponse = await app.request("http://localhost/v1/sessions", {
      headers: { host: "localhost" }
    });
    expect(sessionsResponse.status).toBe(200);
    const sessionsBody = (await sessionsResponse.json()) as { sessions: unknown[] };
    expect(sessionsBody.sessions).toEqual([]);

    const createResponse = await app.request("http://localhost/v1/sessions", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ mode: "plan", title: "Default provider" })
    });
    const created = (await createResponse.json()) as { provider: string };
    expect(created.provider).toBe("codex");

    // Verify a fresh app instance loads persisted values
    const freshApp = await createApp({ config });
    const freshGet = await freshApp.request("http://localhost/v1/settings", {
      headers: { host: "localhost" }
    });
    const freshSettings = (await freshGet.json()) as {
      maxConcurrentRuns: number;
      maxTurns: number;
      defaultAgentProvider: string;
    };
    expect(freshSettings.maxConcurrentRuns).toBe(8);
    expect(freshSettings.maxTurns).toBe(50);
    expect(freshSettings.defaultAgentProvider).toBe("codex");
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

function createMockCodexThread(threadId: string, text: string): CodexThreadLike {
  return {
    id: null,
    runStreamed: vi.fn(async () => ({
      events: codexResultStream(threadId, text)
    }))
  };
}

async function* codexResultStream(threadId: string, text: string): AsyncGenerator<unknown> {
  yield { type: "thread.started", thread_id: threadId };
  yield { type: "item.completed", item: { id: "item-1", type: "agent_message", text } };
  yield {
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 }
  };
}

async function createTestHttpServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      })
  };
}

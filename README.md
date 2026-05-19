# Bottle

Hono-based Bottle runtime for Claude Agent SDK or Codex SDK sessions. Bottle exposes a stable `/__bottle/v1/*` HTTP/SSE API and provides an iframe bridge that lets AI Client send live app context with assistant prompts.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

The API only responds when the request hostname and browser origin match `ALLOWED_HOSTNAMES`. Set `PROJECT_ROOT` to the repository or app workspace the selected agent should operate on. New Bottle bundles advertise both Claude and Codex; choose the provider per session with `provider: "claude"` or `provider: "codex"` in `POST /__bottle/v1/sessions`. If omitted, Claude remains the backward-compatible fallback.

## Bottle + AI Client Integration

Create a portable Bottle bundle for any app or prototype:

```bash
mkdir prototype-a-bundle
cd prototype-a-bundle
npx bottle init --name prototype-a --copy-from /srv/prototype-a
node .bottle/scripts/start-bottle.mjs
```

For a public deployment behind nginx or Cloudflare, include the browser-facing host/origin in the generated config:

```bash
npx bottle init \
  --name prototype-a \
  --copy-from /srv/prototype-a \
  --allowed-hostnames prototype.example.com,localhost,127.0.0.1 \
  --client-origins https://prototype.example.com
```

Keep the host app serving its own `/` and proxy Bottle's unified `/__bottle/*` prefix from the host app when you want same-origin access:

```bash
npx bottle init \
  --name prototype-a \
  --copy-from /srv/prototype-a \
  --allowed-hostnames prototype.example.com,localhost,127.0.0.1 \
  --client-origins https://ai-client.example.com
```

The default bundle shape is:

```txt
bottle-app/
  app/        # copied existing project
  .bottle/    # Bottle config, discovery folders, vendored runtime, and sessions
```

Customize generated bundles from `.bottle/bottle.config.mjs`. The config keeps bundle paths relative so the folder stays portable:

```js
export default {
  projectRoot: "../app",
  bottleDir: ".",
  allowedHostnames: ["localhost", "127.0.0.1", "prototype.example.com"],
  clientOrigins: ["https://prototype.example.com"],
  sessionDir: "../.bottle/sessions"
};
```

`bottle init` vendors a self-contained Bottle runtime into `.bottle/runtime` by default. After initialization, the bundle only needs Node.js to run; it does not need `bottle` installed globally on the target machine. Use `bottle init --no-vendor-runtime` if you prefer the old lightweight bundle that shells out to a global `bottle start`.

Point a browser or AI Client at the Bottle base URL, for example `http://localhost:3001/__bottle`. Bottle exposes its API, bridge, and iframe routes under `/__bottle/*`; the host app keeps serving normal app routes while `/__bottle/iframe/*` fetches the matching route from the detected request origin and injects the bridge server-side.

Bottle-local agent context lives under `.bottle`:

```txt
.bottle/agents/    # Claude-compatible agent definitions
.bottle/commands/  # slash command markdown
.bottle/rules/     # default rules injected into Claude and Codex
.bottle/skills/    # discoverable skills using <name>/SKILL.md
```

The `.bottle` folders are authoritative Bottle context. Codex sessions receive a compact skill manifest from `.bottle/skills` plus any comma-separated `BOTTLE_EXTRA_SKILL_ROOTS` you configure, with `.bottle/skills` taking precedence over duplicate skill names.

For Codex-backed sessions, configure optional SDK settings:

```txt
CODEX_MODEL=
CODEX_API_KEY=
CODEX_BASE_URL=
CODEX_PATH=
CODEX_REASONING_EFFORT=
CODEX_NETWORK_ACCESS=false
CODEX_SKIP_GIT_REPO_CHECK=true
CODEX_PLAN_SANDBOX_MODE=read-only
BOTTLE_EXTRA_SKILL_ROOTS=/shared/skills,/team/skills
```

Codex sandbox defaults are `plan=read-only` and `bypass=danger-full-access`.
On trusted local hosts where the Codex read-only sandbox fails before file inspection with
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`, set
`CODEX_PLAN_SANDBOX_MODE=danger-full-access` as a host workaround. That disables the OS
sandbox for plan mode; Bottle still prompts the model to inspect/read only, but prompt guidance
is not a hard security boundary.

For browser access from a separate AI client origin, set:

```txt
CLIENT_ORIGINS=http://localhost:5173,https://ai-client.example.com
CLIENT_APP_URL=http://localhost:5173
BOTTLE_API_TOKEN=optional-shared-token
```

If `BOTTLE_API_TOKEN` is set, `/__bottle/v1/*` requests must include either `Authorization: Bearer <token>` or `x-bottle-api-token: <token>`. In production, `BOTTLE_API_TOKEN_REQUIRED` defaults to `true`.

## Endpoints

- `GET /health`
- `GET /__bottle/iframe/*`
- `GET /__bottle/v1/bottle`
- `GET /__bottle/bottle-bridge.js`
- `GET /__bottle/v1/root`
- `GET /__bottle/v1/settings`
- `PATCH /__bottle/v1/settings`
- `POST /__bottle/v1/sessions`
- `GET /__bottle/v1/sessions`
- `GET /__bottle/v1/sessions/:sessionId`
- `PATCH /__bottle/v1/sessions/:sessionId`
- `GET /__bottle/v1/sessions/:sessionId/messages`
- `GET /__bottle/v1/sessions/:sessionId/files:search?q=button&limit=50`
- `GET /__bottle/v1/claude-commands`
- `POST /__bottle/v1/claude-commands`
- `DELETE /__bottle/v1/claude-commands`
- `GET /__bottle/v1/sessions/:sessionId/events:stream`
- `POST /__bottle/v1/sessions/:sessionId/messages:stream`
- `POST /__bottle/v1/sessions/:sessionId/interrupt`
- `DELETE /__bottle/v1/sessions/:sessionId`

Modes are `plan` and `bypass`. Tool execution runs from the configured project root with the selected provider's sandbox settings. Session metadata remains under `SESSION_DIR`. The existing `/__bottle/v1/claude-commands` endpoints are compatibility aliases for commands stored in `.bottle/commands`.

`GET /__bottle/v1/settings` includes `defaultAgentProvider` and `availableAgentProviders` so AI Client settings can show both Claude and Codex. `PATCH /__bottle/v1/settings` can persist `defaultAgentProvider`, `maxConcurrentRuns`, and `maxTurns`.

## Iframe Bridge

Bottle serves `/__bottle/bottle-bridge.js` for richer iframe context. Bottle also serves `/__bottle/iframe/*` by fetching the matching non-iframe route from the detected request origin and injecting the bridge into returned HTML. The bridge responds to AI client messages:

```js
{ type: "ai-client:hello", protocolVersion: 1 }
{ type: "ai-client:request-context", requestId: "..." }
```

The iframe replies with:

```js
{ type: "bottle:ready", protocolVersion: 1, appName: "..." }
{ type: "bottle:context", requestId: "...", context: { url, route, title, selectedText, selectedElement, viewport } }
{ type: "bottle:navigation", url, title }
```

`POST /__bottle/v1/sessions/:sessionId/messages:stream` accepts an optional `context` object. Bottle prepends that main app context to the agent prompt before streaming.

Long-running streams send SSE keep-alive comments while the agent is quiet. `RUN_TIMEOUT_MS` controls the hard run timeout and defaults to 60 minutes. Timeout and abort failures are reported with specific codes such as `run_timeout`, `run_interrupted`, and `run_closed` instead of the generic `agent_error`.

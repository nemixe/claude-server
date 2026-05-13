# Bottle

Hono-based Bottle runtime for Claude Agent SDK or Codex SDK sessions. Bottle exposes a stable `/v1/*` HTTP/SSE API, can proxy target apps only for AI iframe sessions, and provides an iframe bridge that lets AI Client send live app context with assistant prompts.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

The API only responds when the request hostname and browser origin match `ALLOWED_HOSTNAMES`. Set `PROJECT_ROOT` to the repository or app workspace the selected agent should operate on. New Bottle bundles advertise both Claude and Codex; choose the provider per session with `provider: "claude"` or `provider: "codex"` in `POST /v1/sessions`. If omitted, Claude remains the backward-compatible fallback.

## Bottle + AI Client Integration

Create a portable Bottle bundle for any app or prototype:

```bash
mkdir prototype-a-bundle
cd prototype-a-bundle
npx bottle init --name prototype-a --copy-from /srv/prototype-a --main-app-url http://localhost:3000
node .bottle/scripts/start-bottle.mjs
```

For a public deployment behind nginx or Cloudflare, include the browser-facing host/origin in the generated config:

```bash
npx bottle init \
  --name prototype-a \
  --copy-from /srv/prototype-a \
  --main-app-url http://localhost:3000 \
  --allowed-hostnames prototype.example.com,localhost,127.0.0.1 \
  --client-origins https://prototype.example.com \
  --trust-proxy
```

For the recommended AI iframe proxy mode, keep normal users on the main app URL and let only the AI iframe travel through Bottle:

```bash
npx bottle init \
  --name prototype-a \
  --copy-from /srv/prototype-a \
  --main-app-url https://prototype.example.com \
  --main-app-proxy true \
  --main-app-direct false \
  --allowed-hostnames ai-wrapper.example.com,localhost,127.0.0.1 \
  --client-origins https://ai-wrapper.example.com \
  --trust-proxy
```

For an API-only Bottle behind a host app that serves its own `/`, disable Bottle root gateway mode:

```bash
npx bottle init \
  --name prototype-a \
  --copy-from /srv/prototype-a \
  --main-app-url https://prototype.example.com \
  --main-app-proxy false \
  --allowed-hostnames prototype.example.com,localhost,127.0.0.1 \
  --client-origins https://ai-client.example.com \
  --trust-proxy
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
  trustProxy: true,
  clientOrigins: ["https://prototype.example.com"],
  mainAppProxy: true,
  mainAppDirect: false,
  sessionDir: "../.bottle/sessions"
};
```

`bottle init` vendors a self-contained Bottle runtime into `.bottle/runtime` by default. After initialization, the bundle only needs Node.js to run; it does not need `bottle` installed globally on the target machine. Use `bottle init --no-vendor-runtime` if you prefer the old lightweight bundle that shells out to a global `bottle start`.

Point a browser or AI Client at the Bottle base URL, for example `http://localhost:3001`. In recommended AI iframe proxy mode (`MAIN_APP_PROXY=true`, `MAIN_APP_DIRECT=false`), normal users continue using `mainAppUrl` directly, while AI iframe sessions should use the `appProxyUrl` returned by `GET /v1/bottle` so Bottle can inject `/bottle-bridge.js` into proxied HTML. In API-only mode (`MAIN_APP_PROXY=false`), Bottle exposes only its own routes such as `/v1/*`, `/health`, and `/bottle-bridge.js`; the host app keeps serving `/` and must include/provide the bridge itself if live iframe context is needed. Single-origin demo mode (`MAIN_APP_PROXY=true`, `MAIN_APP_DIRECT=true`) can route root traffic through Bottle, but it is not recommended for normal production user traffic.

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
BOTTLE_EXTRA_SKILL_ROOTS=/shared/skills,/team/skills
```

For browser access from a separate AI client origin, set:

```txt
CLIENT_ORIGINS=http://localhost:5173,https://ai-client.example.com
MAIN_APP_URL=http://localhost:3000
CLIENT_APP_URL=http://localhost:5173
MAIN_APP_PROXY=true
MAIN_APP_DIRECT=false
BOTTLE_API_TOKEN=optional-shared-token
```

If `BOTTLE_API_TOKEN` is set, `/v1/*` requests must include either `Authorization: Bearer <token>` or `x-bottle-api-token: <token>`. In production, `BOTTLE_API_TOKEN_REQUIRED` defaults to `true`.

## Endpoints

- `GET /health`
- `GET /` (only when Bottle root gateway mode is enabled)
- `GET /__app/*` (AI iframe proxy mode)
- `GET /v1/bottle`
- `GET /bottle-bridge.js`
- `GET /v1/root`
- `GET /v1/settings`
- `PATCH /v1/settings`
- `POST /v1/sessions`
- `GET /v1/sessions`
- `GET /v1/sessions/:sessionId`
- `PATCH /v1/sessions/:sessionId`
- `GET /v1/sessions/:sessionId/messages`
- `GET /v1/sessions/:sessionId/files:search?q=button&limit=50`
- `GET /v1/claude-commands`
- `POST /v1/claude-commands`
- `DELETE /v1/claude-commands`
- `GET /v1/sessions/:sessionId/events:stream`
- `POST /v1/sessions/:sessionId/messages:stream`
- `POST /v1/sessions/:sessionId/interrupt`
- `DELETE /v1/sessions/:sessionId`

Modes are `plan`, `edit`, and `bypass`. Tool execution runs from the configured project root with the selected provider's sandbox settings. Session metadata remains under `SESSION_DIR`. The existing `/v1/claude-commands` endpoints are compatibility aliases for commands stored in `.bottle/commands`.

`GET /v1/settings` includes `defaultAgentProvider` and `availableAgentProviders` so AI Client settings can show both Claude and Codex. `PATCH /v1/settings` can persist `defaultAgentProvider`, `maxConcurrentRuns`, and `maxTurns`.

## Iframe Bridge

Bottle serves `/bottle-bridge.js` for richer iframe context. When `appProxyUrl` is present in `GET /v1/bottle`, AI wrappers should use it for iframe `src`; Bottle injects the bridge into proxied HTML. Target apps can include the bridge manually when proxy mode is disabled. The bridge responds to AI client messages:

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

`POST /v1/sessions/:sessionId/messages:stream` accepts an optional `context` object. Bottle prepends that main app context to the agent prompt before streaming.

Long-running streams send SSE keep-alive comments while the agent is quiet. `RUN_TIMEOUT_MS` controls the hard run timeout and defaults to 60 minutes. Timeout and abort failures are reported with specific codes such as `run_timeout`, `run_interrupted`, and `run_closed` instead of the generic `agent_error`.

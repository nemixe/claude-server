# Bottle

Hono-based Bottle runtime for Claude Agent SDK sessions. Bottle exposes a stable `/v1/*` HTTP/SSE API, advertises the existing main app URL, and serves an optional iframe bridge that lets a separate AI client send live app context with assistant prompts.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

The API only responds when the request hostname and browser origin match `ALLOWED_HOSTNAMES`. Set `PROJECT_ROOT` to the repository or app workspace Claude should operate on.

## Bottle + AI Client Integration

Run a Bottle instance for any app or prototype:

```bash
npx bottle init --name prototype-a --port 3001 --project-root /srv/prototype-a --main-app-url http://localhost:3000
bottle start --config ./bottle.config.mjs
```

The generated config uses isolated data paths:

```txt
SESSION_DIR=.data/bottle/prototype-a/sessions
WORKSPACE_DIR=.data/bottle/prototype-a/workspaces
```

Point the AI client at the Bottle base URL, for example `http://localhost:3001`. The AI client discovers the main app URL through `GET /v1/bottle` and loads that URL directly, so the app keeps its own port.

For browser access from a separate AI client origin, set:

```txt
CLIENT_ORIGINS=http://localhost:5173,https://ai-client.example.com
MAIN_APP_URL=http://localhost:3000
BOTTLE_API_TOKEN=optional-shared-token
```

If `BOTTLE_API_TOKEN` is set, `/v1/*` requests must include either `Authorization: Bearer <token>` or `x-bottle-api-token: <token>`. In production, `BOTTLE_API_TOKEN_REQUIRED` defaults to `true`.

## Endpoints

- `GET /health`
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

Modes are `plan`, `edit`, and `bypass`. Tool execution runs from the configured project root with Agent SDK sandboxing enabled. Session metadata remains under `SESSION_DIR`.

## Iframe Bridge

Bottle serves `/bottle-bridge.js` for web apps that want richer iframe context. Include it from the main app when useful; API-only apps can ignore it. The bridge responds to AI client messages:

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

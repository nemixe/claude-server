# Claude Server

Hono-based API and browser client SDK for Claude Code-like Agent SDK sessions.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

The API only responds when the request hostname and browser origin match `ALLOWED_HOSTNAMES`.

## Endpoints

- `GET /health`
- `POST /v1/sessions`
- `GET /v1/sessions`
- `GET /v1/sessions/:sessionId/messages`
- `POST /v1/sessions/:sessionId/messages:stream`
- `POST /v1/sessions/:sessionId/interrupt`
- `DELETE /v1/sessions/:sessionId`

Modes are `plan`, `edit`, and `bypass`. Tool execution runs from an isolated per-session workspace with Agent SDK sandboxing enabled.

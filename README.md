# Claude Server

Hono-based API and browser client SDK for Claude Code-like Agent SDK sessions.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

The API only responds when the request hostname and browser origin match `ALLOWED_HOSTNAMES`.
Open `http://localhost:3000/client` for a minimal browser client that creates sessions and shows streaming events.
The test client defaults to `30` max turns; lower or raise the server cap with `MAX_TURNS`.
The browser client also supports local PNG, JPEG, GIF, and WebP image prompts. Sent images are passed to Claude as base64 image content blocks and previewed from session history when available.
Set `PROJECT_ROOT` to control the project directory Claude runs in, where `.claude/commands` is read from, and where `@` file mentions search.

## Endpoints

- `GET /health`
- `GET /client`
- `GET /v1/root`
- `POST /v1/sessions`
- `GET /v1/sessions`
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

## Image prompts

```ts
await client.streamMessage(sessionId, {
  prompt: "What is shown in this screenshot?",
  images: [
    {
      name: "screenshot.png",
      mediaType: "image/png",
      dataBase64: "iVBORw0KGgoAAAANSUhEUgAA..."
    }
  ],
  maxTurns: 30
});
```

The API accepts up to 5 images per prompt, 5 MB decoded per image, using `image/jpeg`, `image/png`, `image/gif`, or `image/webp`.

## Project search

Search file and folder paths inside the configured project root with fuzzy matching:

```ts
const { results } = await client.searchFiles(sessionId, "cmpbtn", { limit: 10 });
```

Each result includes `path`, `name`, `type`, `score`, `updatedAt`, and `size` for files. Results are relative to the configured project root. Generated directories such as `.data`, `.git`, `dist`, and `node_modules` are skipped.

## Claude commands

Custom Claude slash commands are stored under `<PROJECT_ROOT>/.claude/commands`. Command paths are normalized relative to that directory and must be Markdown files.

```ts
await client.saveClaudeCommand(sessionId, {
  path: "review/fix.md",
  content: "Review the selected code and propose a focused fix."
});

const { commands } = await client.listClaudeCommands(sessionId);
const { command } = await client.getClaudeCommand(sessionId, "review/fix.md");
await client.deleteClaudeCommand(sessionId, "review/fix.md");
```

The API also accepts `.claude/commands/review/fix.md` as input, but persisted command paths are returned as `review/fix.md`.

## Legacy web chat contract

Use `claude-server/chat-contract` when integrating with an existing chat UI that expects normal chat messages instead of raw Agent SDK events.

```ts
import { createClaudeWebChatContract } from "claude-server/chat-contract";

const chat = createClaudeWebChatContract({ baseUrl: "http://localhost:3000" });

const { session, messages, runResult } = await chat.sendMessage(
  {
    prompt: "Describe this screenshot",
    mode: "plan",
    images: [{ name: "screenshot.png", mediaType: "image/png", dataBase64: "..." }]
  },
  {
    onMessage(message) {
      // Append user/assistant messages to your legacy chat transcript.
      console.log(message.role, message.text, message.images);
    },
    onRunResult(result) {
      // Store cost/usage/terminal metadata outside the chat transcript.
      console.log(result.totalCostUsd, result.terminalReason);
    }
  }
);
```

The contract maps persisted history from `GET /v1/sessions/:sessionId/messages` into `{ role, text, images }` chat messages. Live SDK `result` events are exposed as `runResult` metadata so they do not duplicate the final assistant answer in the chat transcript.

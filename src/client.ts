import type { ClaudeMode, SessionMetadata, StreamMessageRequest, UploadedFile } from "./types.js";

export type ClaudeClientOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
};

export type CreateClientSessionRequest = {
  mode: ClaudeMode;
  title?: string;
  files?: UploadedFile[];
};

export type CreatedSession = {
  sessionId: string;
  mode: ClaudeMode;
  createdAt: string;
};

export type ClientSseEvent = {
  event: string;
  data: unknown;
  id?: string;
};

export type StreamHandlers = {
  signal?: AbortSignal;
  onEvent?: (event: ClientSseEvent) => void;
  onMessage?: (data: unknown) => void;
  onToolUse?: (data: unknown) => void;
  onToolResult?: (data: unknown) => void;
  onResult?: (data: unknown) => void;
  onError?: (data: unknown) => void;
  onDone?: (data: unknown) => void;
};

export function createClaudeClient(options: ClaudeClientOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {})
      }
    });

    if (!response.ok) {
      throw new Error(`Claude API request failed with ${response.status}: ${await response.text()}`);
    }

    return response.json() as Promise<T>;
  }

  return {
    createSession(request: CreateClientSessionRequest): Promise<CreatedSession> {
      return requestJson<CreatedSession>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify(request)
      });
    },

    async streamMessage(sessionId: string, request: StreamMessageRequest, handlers: StreamHandlers = {}): Promise<void> {
      const response = await fetchImpl(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/messages:stream`, {
        method: "POST",
        signal: handlers.signal,
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        throw new Error(`Claude stream request failed with ${response.status}: ${await response.text()}`);
      }

      if (!response.body) {
        throw new Error("Claude stream response did not include a body");
      }

      await readSseStream(response.body, handlers);
    },

    listSessions(): Promise<{ sessions: SessionMetadata[] }> {
      return requestJson<{ sessions: SessionMetadata[] }>("/v1/sessions");
    },

    getMessages(sessionId: string): Promise<{ messages: unknown[] }> {
      return requestJson<{ messages: unknown[] }>(`/v1/sessions/${encodeURIComponent(sessionId)}/messages`);
    },

    interrupt(sessionId: string): Promise<{ interrupted: boolean }> {
      return requestJson<{ interrupted: boolean }>(`/v1/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
        method: "POST",
        body: "{}"
      });
    },

    deleteSession(sessionId: string): Promise<{ deleted: true }> {
      return requestJson<{ deleted: true }>(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE"
      });
    }
  };
}

export async function readSseStream(body: ReadableStream<Uint8Array>, handlers: StreamHandlers): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      dispatchSseEvent(part, handlers);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    dispatchSseEvent(buffer, handlers);
  }
}

function dispatchSseEvent(raw: string, handlers: StreamHandlers): void {
  const parsed = parseSseEvent(raw);
  if (!parsed) return;

  handlers.onEvent?.(parsed);

  if (parsed.event === "message") handlers.onMessage?.(parsed.data);
  if (parsed.event === "tool_use") handlers.onToolUse?.(parsed.data);
  if (parsed.event === "tool_result") handlers.onToolResult?.(parsed.data);
  if (parsed.event === "result") handlers.onResult?.(parsed.data);
  if (parsed.event === "error") handlers.onError?.(parsed.data);
  if (parsed.event === "done") handlers.onDone?.(parsed.data);
}

function parseSseEvent(raw: string): ClientSseEvent | undefined {
  const lines = raw.split(/\r?\n/);
  let event = "message";
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const separatorIndex = line.indexOf(":");
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1).replace(/^ /, "");

    if (field === "event") event = value;
    if (field === "id") id = value;
    if (field === "data") dataLines.push(value);
  }

  if (dataLines.length === 0) return undefined;
  const dataText = dataLines.join("\n");

  return {
    event,
    id,
    data: parseJsonOrText(dataText)
  };
}

function parseJsonOrText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

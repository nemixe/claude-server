import type {
  AgentProvider,
  BottleInfoResponse,
  BottleCommand,
  BottleCommandInput,
  ClaudeCommand,
  ClaudeCommandInput,
  ClaudeMode,
  ListMessagesResponse,
  ListSessionsResponse,
  PublicSession,
  RootInfoResponse,
  SettingsResponse,
  StreamMessageRequest,
  UpdateSettingsRequest,
  UploadedFile,
  WorkspaceSearchResult
} from "./types.js";

export type ClaudeClientOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
};

export type CreateClientSessionRequest = {
  mode: ClaudeMode;
  provider?: AgentProvider;
  title?: string;
  userName?: string;
  files?: UploadedFile[];
};

export type CreatedSession = PublicSession;

export type ListSessionsOptions = {
  limit?: number;
  offset?: number;
};

export type ListMessagesOptions = {
  limit?: number;
  offset?: number;
  tail?: boolean;
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

    listSessions(options: ListSessionsOptions = {}): Promise<ListSessionsResponse> {
      const params = new URLSearchParams();
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      if (options.offset !== undefined) params.set("offset", String(options.offset));
      const query = params.toString();
      return requestJson<ListSessionsResponse>(`/v1/sessions${query ? `?${query}` : ""}`);
    },

    getSession(sessionId: string): Promise<PublicSession> {
      return requestJson<PublicSession>(`/v1/sessions/${encodeURIComponent(sessionId)}`);
    },

    getRoot(): Promise<RootInfoResponse> {
      return requestJson<RootInfoResponse>("/v1/root");
    },

    getBottle(): Promise<BottleInfoResponse> {
      return requestJson<BottleInfoResponse>("/v1/bottle");
    },

    getSettings(): Promise<SettingsResponse> {
      return requestJson<SettingsResponse>("/v1/settings");
    },

    updateSettings(request: UpdateSettingsRequest): Promise<SettingsResponse> {
      return requestJson<SettingsResponse>("/v1/settings", {
        method: "PATCH",
        body: JSON.stringify(request)
      });
    },

    getMessages(sessionId: string, options: ListMessagesOptions = {}): Promise<ListMessagesResponse> {
      const params = new URLSearchParams();
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      if (options.offset !== undefined) params.set("offset", String(options.offset));
      if (options.tail !== undefined) params.set("tail", String(options.tail));
      const query = params.toString();
      return requestJson<ListMessagesResponse>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/messages${query ? `?${query}` : ""}`
      );
    },

    searchFiles(sessionId: string, query: string, options: { limit?: number } = {}): Promise<{ results: WorkspaceSearchResult[] }> {
      const params = new URLSearchParams({ q: query });
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      return requestJson<{ results: WorkspaceSearchResult[] }>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/files:search?${params.toString()}`
      );
    },

    searchProjectFiles(query: string, options: { limit?: number } = {}): Promise<{ results: WorkspaceSearchResult[] }> {
      const params = new URLSearchParams({ q: query });
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      return requestJson<{ results: WorkspaceSearchResult[] }>(`/v1/files:search?${params.toString()}`);
    },

    listCommands(_sessionId?: string): Promise<{ commands: BottleCommand[] }> {
      return requestJson<{ commands: BottleCommand[] }>("/v1/claude-commands");
    },

    getCommand(_sessionId: string | undefined, commandPath: string): Promise<{ command: BottleCommand }> {
      return requestJson<{ command: BottleCommand }>(
        `/v1/claude-commands?path=${encodeURIComponent(commandPath)}`
      );
    },

    saveCommand(_sessionId: string | undefined, command: BottleCommandInput): Promise<{ command: BottleCommand }> {
      return requestJson<{ command: BottleCommand }>("/v1/claude-commands", {
        method: "POST",
        body: JSON.stringify(command)
      });
    },

    deleteCommand(_sessionId: string | undefined, commandPath: string): Promise<{ deleted: true }> {
      return requestJson<{ deleted: true }>("/v1/claude-commands", {
        method: "DELETE",
        body: JSON.stringify({ path: commandPath })
      });
    },

    listClaudeCommands(_sessionId?: string): Promise<{ commands: ClaudeCommand[] }> {
      return requestJson<{ commands: ClaudeCommand[] }>("/v1/claude-commands");
    },

    getClaudeCommand(_sessionId: string | undefined, commandPath: string): Promise<{ command: ClaudeCommand }> {
      return requestJson<{ command: ClaudeCommand }>(
        `/v1/claude-commands?path=${encodeURIComponent(commandPath)}`
      );
    },

    saveClaudeCommand(_sessionId: string | undefined, command: ClaudeCommandInput): Promise<{ command: ClaudeCommand }> {
      return requestJson<{ command: ClaudeCommand }>("/v1/claude-commands", {
        method: "POST",
        body: JSON.stringify(command)
      });
    },

    deleteClaudeCommand(_sessionId: string | undefined, commandPath: string): Promise<{ deleted: true }> {
      return requestJson<{ deleted: true }>("/v1/claude-commands", {
        method: "DELETE",
        body: JSON.stringify({ path: commandPath })
      });
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

export const createBottleClient = createClaudeClient;

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

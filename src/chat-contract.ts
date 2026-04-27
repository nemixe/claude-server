import { createClaudeClient, type ClaudeClientOptions, type ClientSseEvent } from "./client.js";
import type { ClaudeMode, PromptImage, PublicSession, StreamMessageRequest, UploadedFile } from "./types.js";

export type WebChatRole = "user" | "assistant" | "system" | "tool";

export type WebChatImageAttachment = {
  type: "image";
  mediaType: PromptImage["mediaType"];
  name?: string;
  dataBase64?: string;
  url?: string;
  sizeBytes?: number;
};

export type WebChatMessage = {
  id: string;
  sessionId: string;
  role: WebChatRole;
  text: string;
  images: WebChatImageAttachment[];
  createdAt?: string;
  status: "complete" | "streaming" | "error";
  raw?: unknown;
};

export type WebChatRunResult = {
  sessionId: string;
  ok: boolean;
  finalText?: string;
  stopReason?: string;
  terminalReason?: string;
  durationMs?: number;
  totalCostUsd?: number;
  usage?: unknown;
  raw: unknown;
};

export type WebChatEvent =
  | { type: "message"; message: WebChatMessage; raw: ClientSseEvent }
  | { type: "run_result"; result: WebChatRunResult; raw: ClientSseEvent }
  | { type: "error"; error: unknown; raw: ClientSseEvent }
  | { type: "done"; data: unknown; raw: ClientSseEvent }
  | { type: "raw"; raw: ClientSseEvent };

export type CreateWebChatSessionRequest = {
  mode?: ClaudeMode;
  title?: string;
  files?: UploadedFile[];
};

export type SendWebChatMessageRequest = {
  sessionId?: string;
  title?: string;
  prompt: string;
  images?: PromptImage[];
  mode?: ClaudeMode;
  model?: string;
  maxTurns?: number;
};

export type WebChatSendResult = {
  session: PublicSession;
  messages: WebChatMessage[];
  runResult?: WebChatRunResult;
};

export type WebChatConversation = {
  session?: PublicSession;
  messages: WebChatMessage[];
};

export type WebChatHandlers = {
  signal?: AbortSignal;
  onEvent?: (event: WebChatEvent) => void;
  onMessage?: (message: WebChatMessage) => void;
  onRunResult?: (result: WebChatRunResult) => void;
  onError?: (error: unknown) => void;
  onDone?: (data: unknown) => void;
};

export function createClaudeWebChatContract(options: ClaudeClientOptions) {
  const client = createClaudeClient(options);

  async function createSession(request: CreateWebChatSessionRequest = {}): Promise<PublicSession> {
    return client.createSession({
      mode: request.mode ?? "plan",
      title: request.title,
      files: request.files
    });
  }

  return {
    createSession,

    listSessions(): Promise<{ sessions: PublicSession[] }> {
      return client.listSessions();
    },

    async loadConversation(sessionId: string): Promise<WebChatConversation> {
      const [sessionList, history] = await Promise.all([client.listSessions(), client.getMessages(sessionId)]);
      return {
        session: sessionList.sessions.find((session) => session.sessionId === sessionId || session.id === sessionId),
        messages: toWebChatMessages(history.messages, sessionId)
      };
    },

    async sendMessage(request: SendWebChatMessageRequest, handlers: WebChatHandlers = {}): Promise<WebChatSendResult> {
      const session = request.sessionId
        ? await findSession(client, request.sessionId)
        : await createSession({ mode: request.mode, title: request.title });
      const sessionId = session.sessionId;
      const messages: WebChatMessage[] = [];
      let runResult: WebChatRunResult | undefined;
      let sawAssistantMessage = false;

      emitMessage(createUserMessage(sessionId, request), messages, handlers);

      const streamRequest: StreamMessageRequest = {
        prompt: request.prompt,
        ...(request.images?.length ? { images: request.images } : {}),
        mode: request.mode,
        model: request.model,
        maxTurns: request.maxTurns
      };

      await client.streamMessage(sessionId, streamRequest, {
        signal: handlers.signal,
        onEvent(event) {
          const mapped = mapSseEventToWebChatEvent(event, sessionId);
          if (mapped.type === "message") {
            if (mapped.message.role === "assistant") sawAssistantMessage = true;
            emitMessage(mapped.message, messages, handlers, mapped);
            return;
          }

          if (mapped.type === "run_result") {
            runResult = mapped.result;
            if (!sawAssistantMessage && mapped.result.finalText) {
              emitMessage(createAssistantMessageFromResult(sessionId, mapped.result), messages, handlers);
            }
            handlers.onRunResult?.(mapped.result);
          } else if (mapped.type === "error") {
            handlers.onError?.(mapped.error);
          } else if (mapped.type === "done") {
            handlers.onDone?.(mapped.data);
          }

          handlers.onEvent?.(mapped);
        }
      });

      return { session, messages, runResult };
    },

    interrupt(sessionId: string): Promise<{ interrupted: boolean }> {
      return client.interrupt(sessionId);
    },

    deleteSession(sessionId: string): Promise<{ deleted: true }> {
      return client.deleteSession(sessionId);
    },

    raw: client
  };
}

export function toWebChatMessages(messages: unknown[], sessionId: string): WebChatMessage[] {
  return messages.flatMap((message, index) => {
    const mapped = toWebChatMessage(message, sessionId, index);
    return mapped ? [mapped] : [];
  });
}

export function mapSseEventToWebChatEvent(event: ClientSseEvent, fallbackSessionId: string): WebChatEvent {
  if (event.event === "message") {
    const message = toWebChatMessage(event.data, fallbackSessionId);
    return message ? { type: "message", message, raw: event } : { type: "raw", raw: event };
  }

  if (event.event === "result") {
    return { type: "run_result", result: toRunResult(event.data, fallbackSessionId), raw: event };
  }

  if (event.event === "error") {
    return { type: "error", error: event.data, raw: event };
  }

  if (event.event === "done") {
    return { type: "done", data: event.data, raw: event };
  }

  return { type: "raw", raw: event };
}

function emitMessage(
  message: WebChatMessage,
  messages: WebChatMessage[],
  handlers: WebChatHandlers,
  event?: WebChatEvent
): void {
  messages.push(message);
  handlers.onMessage?.(message);
  handlers.onEvent?.(event ?? { type: "message", message, raw: { event: "message", data: message } });
}

async function findSession(client: ReturnType<typeof createClaudeClient>, sessionId: string): Promise<PublicSession> {
  const { sessions } = await client.listSessions();
  const session = sessions.find((candidate) => candidate.sessionId === sessionId || candidate.id === sessionId);
  if (!session) throw new Error(`Session ${sessionId} was not found`);
  return session;
}

function createUserMessage(sessionId: string, request: SendWebChatMessageRequest): WebChatMessage {
  return {
    id: stableId("user"),
    sessionId,
    role: "user",
    text: request.prompt,
    images: (request.images ?? []).map((image) => ({
      type: "image",
      name: image.name,
      mediaType: image.mediaType,
      dataBase64: image.dataBase64,
      sizeBytes: estimateBase64Bytes(image.dataBase64)
    })),
    status: "complete"
  };
}

function createAssistantMessageFromResult(sessionId: string, result: WebChatRunResult): WebChatMessage {
  return {
    id: stableId("assistant"),
    sessionId,
    role: "assistant",
    text: result.finalText ?? "",
    images: [],
    status: result.ok ? "complete" : "error",
    raw: result.raw
  };
}

function toWebChatMessage(value: unknown, fallbackSessionId: string, fallbackIndex = 0): WebChatMessage | undefined {
  if (!isRecord(value)) return undefined;
  const messageRecord = isRecord(value.message) ? value.message : value;
  const role = getRole(value, messageRecord);
  if (!role) return undefined;

  const content = messageRecord.content ?? value.content ?? value.message;
  const text = extractText(content);
  const images = extractImages(content);

  if (!text && images.length === 0) return undefined;

  return {
    id: getString(value.uuid) ?? getString(messageRecord.uuid) ?? stableId(`${role}-${fallbackIndex}`),
    sessionId: getString(value.session_id) ?? getString(messageRecord.session_id) ?? fallbackSessionId,
    role,
    text,
    images,
    createdAt: getString(value.timestamp) ?? getString(messageRecord.timestamp),
    status: "complete",
    raw: value
  };
}

function toRunResult(value: unknown, fallbackSessionId: string): WebChatRunResult {
  const record = isRecord(value) ? value : {};
  return {
    sessionId: getString(record.session_id) ?? fallbackSessionId,
    ok: record.is_error !== true,
    finalText: getString(record.result),
    stopReason: getString(record.stop_reason),
    terminalReason: getString(record.terminal_reason),
    durationMs: getNumber(record.duration_ms),
    totalCostUsd: getNumber(record.total_cost_usd),
    usage: record.usage,
    raw: value
  };
}

function getRole(value: Record<string, unknown>, message: Record<string, unknown>): WebChatRole | undefined {
  const role = getString(message.role) ?? getString(value.type);
  if (role === "user" || role === "assistant" || role === "system") return role;
  if (role === "tool" || role === "tool_use" || role === "tool_result") return "tool";
  return undefined;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!isRecord(block)) return "";
      if (typeof block.text === "string") return block.text;
      if (typeof block.content === "string") return block.content;
      if (block.type === "tool_use" && typeof block.name === "string") return `[tool_use:${block.name}]`;
      if (block.type === "tool_result") return "[tool_result]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractImages(content: unknown): WebChatImageAttachment[] {
  if (!Array.isArray(content)) return [];

  return content.flatMap((block): WebChatImageAttachment[] => {
    if (!isRecord(block) || block.type !== "image" || !isRecord(block.source)) return [];
    const source = block.source;
    const mediaType = getPromptImageMediaType(source.media_type);
    if (!mediaType) return [];

    if (source.type === "base64" && typeof source.data === "string") {
      return [
        {
          type: "image",
          mediaType,
          dataBase64: source.data,
          sizeBytes: estimateBase64Bytes(source.data)
        }
      ];
    }

    if (source.type === "url" && typeof source.url === "string") {
      return [{ type: "image", mediaType, url: source.url }];
    }

    return [];
  });
}

function getPromptImageMediaType(value: unknown): PromptImage["mediaType"] | undefined {
  if (value === "image/jpeg" || value === "image/png" || value === "image/gif" || value === "image/webp") return value;
  return undefined;
}

function estimateBase64Bytes(value: string): number {
  const clean = value.replace(/^data:image\/[^;]+;base64,/i, "").replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function stableId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

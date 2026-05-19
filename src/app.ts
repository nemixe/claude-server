import { Hono, type Context } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { z } from "zod";
import {
  AgentService,
  ConcurrencyLimitError,
  CodexSandboxUnsupportedError,
  isPendingInterruptPayloadValid,
  RunAbortedError,
  RunTimeoutError,
  ValidationErrorLimitError
} from "./agent-service.js";
import {
  BOTTLE_API_PATH,
  bottleInfoForRequest,
  createBottleAuthMiddleware,
  createClientAccessMiddleware,
  registerBottleRoutes
} from "./bottle.js";
import type { AppConfig } from "./config.js";
import { createHostnameGate } from "./hostname-gate.js";
import { createSessionFactory, MissingClaudeSessionIdError } from "./session-adapter.js";
import { SessionStore } from "./session-store.js";
import { SettingsStore } from "./settings-store.js";
import {
  AGENT_PROVIDERS,
  CLAUDE_MODES,
  type AgentProvider,
  type BottleWebAppContext,
  type ListMessagesResponse,
  type ListSessionsResponse,
  type PendingInterrupt,
  type PromptImage,
  type PublicSession,
  type RootInfoResponse,
  type SettingsResponse,
  type SessionMetadata,
  type StreamMessageRequest
} from "./types.js";

const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
const MAX_PROMPT_IMAGES = 5;
const MAX_PROMPT_IMAGE_BYTES = 5 * 1024 * 1024;
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export type AppDependencies = {
  config: AppConfig;
  sessionStore?: SessionStore;
  agentService?: AgentService;
  settingsStore?: SettingsStore;
};

type HeartbeatStream = Pick<SSEStreamingApi, "aborted" | "closed"> & {
  write: (input: string) => Promise<unknown>;
};

function prepareSseResponse(c: Context): void {
  c.header("X-Accel-Buffering", "no");
  c.header("Cache-Control", "no-store, no-cache, no-transform");
  c.header("Connection", "keep-alive");
}

async function writeSseKeepAlive(stream: HeartbeatStream): Promise<void> {
  if (stream.aborted || stream.closed) return;
  try {
    await stream.write(": keep-alive\n\n");
  } catch {
    // The client or an intermediate proxy can close the stream between the
    // state check and the write. Keep-alive failures should not crash Bottle.
  }
}

export async function withSseHeartbeat<T>(
  stream: HeartbeatStream,
  callback: () => Promise<T>,
  intervalMs = SSE_HEARTBEAT_INTERVAL_MS
): Promise<T> {
  let heartbeatWriting = false;
  const heartbeat = setInterval(() => {
    if (stream.aborted || stream.closed) return;
    if (heartbeatWriting) return;
    heartbeatWriting = true;
    void writeSseKeepAlive(stream).finally(() => {
      heartbeatWriting = false;
    });
  }, intervalMs);

  if (typeof heartbeat === "object" && "unref" in heartbeat && typeof heartbeat.unref === "function") {
    heartbeat.unref();
  }

  try {
    return await callback();
  } finally {
    clearInterval(heartbeat);
  }
}

const createSessionSchema = z.object({
  mode: z.enum(CLAUDE_MODES).default("bypass"),
  provider: z.enum(AGENT_PROVIDERS).optional(),
  title: z.string().min(1).max(200).optional(),
  userName: z.string().trim().min(1).max(40).optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        content: z.string().optional(),
        contentBase64: z.string().optional()
      })
    )
    .optional()
});

const promptImageSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    mediaType: z.enum(IMAGE_MEDIA_TYPES),
    dataBase64: z.string().min(1)
  })
  .transform((image, context): PromptImage => {
    const normalized = normalizePromptImage(image);
    if (!normalized.ok) {
      context.addIssue({
        code: "custom",
        path: ["dataBase64"],
        message: normalized.message
      });
      return z.NEVER;
    }
    return normalized.image;
  });

const bottleContextSchema: z.ZodType<BottleWebAppContext> = z
  .object({
    url: z.string().max(2_000).optional(),
    route: z.string().max(2_000).optional(),
    title: z.string().max(500).optional(),
    selectedText: z.string().max(8_000).optional(),
    selectedElement: z.string().max(500).optional(),
    viewport: z
      .object({
        width: z.number().finite().nonnegative(),
        height: z.number().finite().nonnegative()
      })
      .optional()
  })
  .passthrough();

const streamMessageSchema = z.object({
  prompt: z.string().min(1),
  images: z.array(promptImageSchema).max(MAX_PROMPT_IMAGES).optional(),
  context: bottleContextSchema.optional(),
  toolResult: z
    .object({
      toolUseId: z.string().min(1),
      content: z.string().min(1),
      kind: z.enum(["user_input", "approval"]).optional(),
      approved: z.boolean().optional()
    })
    .optional(),
  mode: z.enum(CLAUDE_MODES).optional(),
  model: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().optional()
});

const updateSessionSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    mode: z.enum(CLAUDE_MODES).optional()
  })
  .refine((value) => value.title !== undefined || value.mode !== undefined, {
    message: "Provide title or mode"
  });

const claudeCommandSchema = z.object({
  path: z.string().min(1).max(500),
  content: z.string().max(200_000)
});

const deleteClaudeCommandSchema = z.object({
  path: z.string().min(1).max(500)
});

const workspaceSearchSchema = z.object({
  q: z.string().max(200).default(""),
  limit: z.coerce.number().int().positive().max(200).default(50)
});

const listSessionsSchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).default(0)
});

const listMessagesSchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  tail: z.enum(["true", "false"]).optional().transform((value) => value === "true")
});

export async function createApp(dependencies: AppDependencies): Promise<Hono> {
  const app = new Hono();
  const sessionStore = dependencies.sessionStore ?? new SessionStore(dependencies.config);
  const agentService =
    dependencies.agentService ??
    new AgentService(dependencies.config, undefined, createSessionFactory());
  const settingsStore = dependencies.settingsStore ?? new SettingsStore(dependencies.config);

  // Load persisted settings into the agent service on startup
  const persisted = await settingsStore.load();
  agentService.setMaxConcurrentRuns(persisted.maxConcurrentRuns);
  agentService.setMaxTurns(persisted.maxTurns);
  dependencies.config.defaultAgentProvider = persisted.defaultAgentProvider;

  app.use("*", createHostnameGate(dependencies.config));
  app.use("*", createClientAccessMiddleware(dependencies.config));
  app.use(`${BOTTLE_API_PATH}/*`, createBottleAuthMiddleware(dependencies.config));
  registerBottleRoutes(app, dependencies.config);

  app.get("/health", (c) => {
    return c.json({ ok: true, service: "bottle", timestamp: new Date().toISOString() });
  });

  app.get(`${BOTTLE_API_PATH}/bottle`, (c) => {
    return c.json(bottleInfoForRequest(dependencies.config, c.req.url, c.req.raw.headers));
  });

  app.get(`${BOTTLE_API_PATH}/settings`, (c) => {
    return c.json(settingsResponse(dependencies.config, agentService));
  });

  app.get(`${BOTTLE_API_PATH}/root`, (c) => {
    const rootInfo: RootInfoResponse = {
      projectRoot: dependencies.config.projectRoot,
      bottleDir: dependencies.config.bottleDir,
      agentsDir: dependencies.config.agentsDir,
      commandsDir: dependencies.config.commandsDir,
      rulesDir: dependencies.config.rulesDir,
      skillsDir: dependencies.config.skillsDir,
      extraSkillRoots: dependencies.config.extraSkillRoots,
      skillRoots: dependencies.config.skillRoots,
      claudeCommandsDir: dependencies.config.claudeCommandsDir
    };
    return c.json(rootInfo);
  });

  app.get(`${BOTTLE_API_PATH}/files:search`, async (c) => {
    const query = workspaceSearchSchema.parse({
      q: c.req.query("q"),
      limit: c.req.query("limit")
    });
    const results = await sessionStore.searchProjectFiles(query.q, query.limit);
    return c.json({ results });
  });

  app.patch(`${BOTTLE_API_PATH}/settings`, async (c) => {
    const body = z
      .object({
        maxConcurrentRuns: z.number().int().min(1).max(64).optional(),
        maxTurns: z.number().int().min(1).max(200).optional(),
        defaultAgentProvider: z.enum(AGENT_PROVIDERS).optional()
      })
      .parse(await c.req.json().catch(() => ({})));

    if (body.maxConcurrentRuns !== undefined) {
      agentService.setMaxConcurrentRuns(body.maxConcurrentRuns);
    }
    if (body.maxTurns !== undefined) {
      agentService.setMaxTurns(body.maxTurns);
    }
    if (body.defaultAgentProvider !== undefined) {
      dependencies.config.defaultAgentProvider = body.defaultAgentProvider;
    }

    const settings = await settingsStore.save({
      maxConcurrentRuns: agentService.getMaxConcurrentRuns(),
      maxTurns: agentService.getMaxTurns(),
      defaultAgentProvider: dependencies.config.defaultAgentProvider
    });

    return c.json({
      ...settings,
      availableAgentProviders: [...AGENT_PROVIDERS]
    });
  });

  app.post(`${BOTTLE_API_PATH}/sessions`, async (c) => {
    const body = createSessionSchema.parse(await c.req.json().catch(() => ({})));
    const session = await sessionStore.create(body);
    return c.json(toPublicSession(session), 201);
  });

  app.get(`${BOTTLE_API_PATH}/sessions`, async (c) => {
    const query = listSessionsSchema.parse({
      limit: c.req.query("limit"),
      offset: c.req.query("offset")
    });
    const result = await sessionStore.listPage(query);
    const body: ListSessionsResponse = {
      sessions: result.sessions.map(toPublicSession),
      limit: result.limit,
      offset: result.offset,
      nextOffset: result.nextOffset,
      hasMore: result.hasMore
    };
    return c.json(body);
  });

  app.get(`${BOTTLE_API_PATH}/sessions/:sessionId`, async (c) => {
    const session = await sessionStore.get(c.req.param("sessionId"));
    if (!session) return c.json({ error: { code: "session_not_found", message: "Session not found" } }, 404);
    return c.json(toPublicSession(session));
  });

  app.get(`${BOTTLE_API_PATH}/sessions/:sessionId/messages`, async (c) => {
    const session = await sessionStore.get(c.req.param("sessionId"));
    if (!session) return c.json({ error: { code: "session_not_found", message: "Session not found" } }, 404);

    const query = listMessagesSchema.parse({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
      tail: c.req.query("tail")
    });
    const messages =
      providerForSession(dependencies.config, session) === "codex"
        ? await sessionStore.readAgentMessages(session.id)
        : await agentService.getMessages(session);
    return c.json(pageMessages(messages, query));
  });

  app.get(`${BOTTLE_API_PATH}/claude-commands`, async (c) => {
    const commandPath = c.req.query("path");
    if (commandPath) {
      const command = await sessionStore.readSharedClaudeCommand(commandPath);
      if (!command) return c.json({ error: { code: "command_not_found", message: "Claude command not found" } }, 404);
      return c.json({ command });
    }
    const commands = await sessionStore.listSharedClaudeCommands();
    return c.json({ commands });
  });

  app.post(`${BOTTLE_API_PATH}/claude-commands`, async (c) => {
    const body = claudeCommandSchema.parse(await c.req.json());
    const command = await sessionStore.saveSharedClaudeCommand(body);
    return c.json({ command }, 201);
  });

  app.delete(`${BOTTLE_API_PATH}/claude-commands`, async (c) => {
    const body = deleteClaudeCommandSchema.parse(await c.req.json());
    const deleted = await sessionStore.deleteSharedClaudeCommand(body.path);
    if (!deleted) return c.json({ error: { code: "command_not_found", message: "Claude command not found" } }, 404);
    return c.json({ deleted: true });
  });

  app.get(`${BOTTLE_API_PATH}/sessions/:sessionId/files:search`, async (c) => {
    const session = await sessionStore.get(c.req.param("sessionId"));
    if (!session) return c.json({ error: { code: "session_not_found", message: "Session not found" } }, 404);

    const query = workspaceSearchSchema.parse({
      q: c.req.query("q"),
      limit: c.req.query("limit")
    });
    const results = await sessionStore.searchProjectFiles(query.q, query.limit);
    return c.json({ results });
  });

  app.get(`${BOTTLE_API_PATH}/sessions/:sessionId/events:stream`, async (c) => {
    const session = await sessionStore.get(c.req.param("sessionId"));
    if (!session) return c.json({ error: { code: "session_not_found", message: "Session not found" } }, 404);

    const observation = agentService.observe(session.id);

    prepareSseResponse(c);
    return streamSSE(c, async (stream) => {
      await withSseHeartbeat(stream, async () => {
        await stream.writeSSE({
          event: "status",
          data: JSON.stringify({ running: observation.running })
        });

        for await (const event of observation.events) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event.data)
          });
        }

        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({ observing: false })
        });
      });
    });
  });

  app.post(`${BOTTLE_API_PATH}/sessions/:sessionId/messages:stream`, async (c) => {
    const session = await sessionStore.get(c.req.param("sessionId"));
    if (!session) return c.json({ error: { code: "session_not_found", message: "Session not found" } }, 404);

    const request = streamMessageSchema.parse(await c.req.json());
    applyToolResultToSession(session, request);

    if (session.pendingInterrupt && !isPendingInterruptPayloadValid(session.pendingInterrupt)) {
      delete session.pendingInterrupt;
    }

    if (!session.pendingInterrupt) {
      session.status = session.mode === "plan" ? "planning" : "executing";
    }

    if (request.toolResult || session.pendingInterrupt === undefined) {
      await sessionStore.save(session);
    }

    if (session.pendingInterrupt && !request.toolResult) {
      const pendingEvent = pendingEventFromSessionInterrupt(session.pendingInterrupt);
      prepareSseResponse(c);
      return streamSSE(c, async (stream) => {
        await withSseHeartbeat(stream, async () => {
          await stream.writeSSE({
            event: pendingEvent.type,
            data: JSON.stringify(pendingEvent.data)
          });
          await stream.writeSSE({
            event: "done",
            data: JSON.stringify(donePayloadForPendingEvent(pendingEvent.type))
          });
        });
      });
    }

    prepareSseResponse(c);
    return streamSSE(c, async (stream) => {
      await withSseHeartbeat(stream, async () => {
        let sessionMarkedAsRun = false;
        let persistedAgentSessionId = session.agentSessionId ?? session.claudeSessionId;
        let waitingForUserQuestion = false;
        let waitingForApproval = false;
        if (providerForSession(dependencies.config, session) === "codex") {
          await sessionStore.appendAgentMessages(session.id, [userMessageFromRequest(session, request)]);
        }
        try {
          for await (const event of agentService.stream({
            session,
            request,
            signal: c.req.raw.signal,
            onAgentSessionId: async (agentSessionId) => {
              if (persistedAgentSessionId === agentSessionId) return;
              await sessionStore.setAgentSessionId(session.id, agentSessionId);
              session.agentSessionId = agentSessionId;
              if (providerForSession(dependencies.config, session) === "claude") session.claudeSessionId = agentSessionId;
              persistedAgentSessionId = agentSessionId;
            }
          })) {
            if (!sessionMarkedAsRun) {
              await sessionStore.markRun(session.id);
              session.hasRun = true;
              sessionMarkedAsRun = true;
            }
            if (event.type === "question_pending") waitingForUserQuestion = true;
            if (event.type === "approval_pending") waitingForApproval = true;
            if (event.type === "result" && event.data && typeof event.data === "object") {
              const cost = (event.data as { total_cost_usd?: unknown }).total_cost_usd;
              if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
                session.costUsd = cost;
                await sessionStore.setCost(session.id, cost);
              }
            }
            if (event.type === "question_pending" || event.type === "approval_pending") {
              await sessionStore.save(session);
            }
            if (providerForSession(dependencies.config, session) === "codex" && event.type === "message") {
              await sessionStore.appendAgentMessages(session.id, [event.data]);
            }

            await stream.writeSSE({
              event: event.type,
              data: JSON.stringify(event.data)
            });
          }

          if (!waitingForUserQuestion && !waitingForApproval) {
            session.status = "done";
            delete session.pendingInterrupt;
            await sessionStore.save(session);
          }

          await stream.writeSSE({ event: "done", data: JSON.stringify({ ok: true, waitingForUserQuestion, waitingForApproval }) });
        } catch (error) {
          session.status = "failed";
          await sessionStore.save(session).catch(() => undefined);
          const status =
            error instanceof ConcurrencyLimitError
              ? "concurrency_limit"
              : error instanceof ValidationErrorLimitError
                ? error.code
                : error instanceof CodexSandboxUnsupportedError ||
                    error instanceof MissingClaudeSessionIdError ||
                    error instanceof RunTimeoutError ||
                    error instanceof RunAbortedError
                  ? error.code
                  : "agent_error";
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ error: { code: status, message: errorMessage(error) } })
          });
        }
      });
    });
  });

  app.post(`${BOTTLE_API_PATH}/sessions/:sessionId/interrupt`, async (c) => {
    const session = await sessionStore.get(c.req.param("sessionId"));
    if (!session) return c.json({ error: { code: "session_not_found", message: "Session not found" } }, 404);

    const interrupted = await agentService.interrupt(session.id);
    return c.json({ interrupted });
  });

  app.patch(`${BOTTLE_API_PATH}/sessions/:sessionId`, async (c) => {
    const body = updateSessionSchema.parse(await c.req.json().catch(() => ({})));
    const updated = await sessionStore.update(c.req.param("sessionId"), body);
    if (!updated) return c.json({ error: { code: "session_not_found", message: "Session not found" } }, 404);
    return c.json(toPublicSession(updated));
  });

  app.delete(`${BOTTLE_API_PATH}/sessions/:sessionId`, async (c) => {
    const sessionId = c.req.param("sessionId");
    agentService.closeSession(sessionId);
    const deleted = await sessionStore.delete(sessionId);
    if (!deleted) return c.json({ error: { code: "session_not_found", message: "Session not found" } }, 404);
    return c.json({ deleted: true });
  });

  app.onError((error, c) => {
    if (error instanceof z.ZodError) {
      return c.json({ error: { code: "validation_error", message: z.prettifyError(error) } }, 400);
    }

    if (error instanceof Error && error.message.startsWith("Invalid ")) {
      return c.json({ error: { code: "validation_error", message: error.message } }, 400);
    }

    return c.json({ error: { code: "internal_error", message: errorMessage(error) } }, 500);
  });

  return app;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function applyToolResultToSession(session: SessionMetadata, request: StreamMessageRequest): void {
  if (!request.toolResult || !session.pendingInterrupt) return;

  const pending = session.pendingInterrupt;
  if (request.toolResult.toolUseId !== pending.toolCallId) {
    throw new Error("Invalid tool result: toolUseId does not match the pending interrupt");
  }
  if (request.toolResult.kind && request.toolResult.kind !== pending.type) {
    throw new Error("Invalid tool result: kind does not match the pending interrupt");
  }
  request.toolResult.kind = pending.type;

  if (pending.type === "approval") {
    const approved = request.toolResult.approved ?? parseApprovalContent(request.toolResult.content);
    session.mode = approved ? "bypass" : "plan";
    request.mode = session.mode;
  }

  session.status = session.mode === "plan" ? "planning" : "executing";
  delete session.pendingInterrupt;
}

function parseApprovalContent(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { approved?: unknown }).approved === "boolean") {
      return (parsed as { approved: boolean }).approved;
    }
  } catch {}

  return /\bapproved?\b|\byes\b|\bcontinue\b/i.test(content);
}

function pendingEventFromSessionInterrupt(interrupt: PendingInterrupt): { type: string; data: unknown } {
  const payload = interrupt.payload && typeof interrupt.payload === "object" ? (interrupt.payload as Record<string, unknown>) : {};
  const input = payload.input && typeof payload.input === "object" ? payload.input : interrupt.payload;

  if (interrupt.type === "user_input") {
    return {
      type: "question_pending",
      data: {
        waitingForUserQuestion: true,
        toolUseId: interrupt.toolCallId,
        input,
        interrupt
      }
    };
  }

  return {
    type: "approval_pending",
    data: {
      waitingForApproval: true,
      toolUseId: interrupt.toolCallId,
      input,
      plan: payload.plan,
      interrupt
    }
  };
}

function donePayloadForPendingEvent(eventType: string): { ok: true; waitingForUserQuestion: boolean; waitingForApproval: boolean } {
  return {
    ok: true,
    waitingForUserQuestion: eventType === "question_pending",
    waitingForApproval: eventType === "approval_pending"
  };
}

function pageMessages(
  messages: unknown[],
  options: { limit?: number; offset: number; tail: boolean }
): ListMessagesResponse {
  const total = messages.length;

  if (options.limit === undefined) {
    const offset = Math.min(options.offset, total);
    return {
      messages: messages.slice(offset),
      offset,
      total,
      previousOffset: offset > 0 ? 0 : undefined,
      hasMoreBefore: offset > 0,
      hasMoreAfter: false
    };
  }

  const limit = options.limit;
  const offset = options.tail ? Math.max(total - limit, 0) : Math.min(options.offset, total);
  const page = messages.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMoreBefore = offset > 0;
  const hasMoreAfter = nextOffset < total;

  return {
    messages: page,
    offset,
    limit,
    total,
    previousOffset: hasMoreBefore ? Math.max(offset - limit, 0) : undefined,
    nextOffset: hasMoreAfter ? nextOffset : undefined,
    hasMoreBefore,
    hasMoreAfter
  };
}

function toPublicSession(session: SessionMetadata): PublicSession {
  return {
    id: session.id,
    sessionId: session.id,
    title: session.title,
    userName: session.userName,
    provider: session.provider,
    mode: session.mode,
    status: session.status,
    pendingInterrupt: session.pendingInterrupt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    hasRun: session.hasRun,
    costUsd: session.costUsd
  };
}

function settingsResponse(config: AppConfig, agentService: AgentService): SettingsResponse {
  return {
    maxConcurrentRuns: agentService.getMaxConcurrentRuns(),
    maxTurns: agentService.getMaxTurns(),
    defaultAgentProvider: config.defaultAgentProvider,
    availableAgentProviders: [...AGENT_PROVIDERS]
  };
}

function providerForSession(config: AppConfig, session: Partial<SessionMetadata>): AgentProvider {
  return session.provider ?? config.defaultAgentProvider;
}

function userMessageFromRequest(session: SessionMetadata, request: StreamMessageRequest): unknown {
  const content =
    request.images && request.images.length > 0
      ? [
          { type: "text", text: request.prompt },
          ...request.images.map((image) => ({
            type: "image",
            source: {
              type: "base64",
              media_type: image.mediaType,
              data: image.dataBase64
            }
          }))
        ]
      : request.prompt;

  return {
    type: "user",
    session_id: session.agentSessionId ?? session.id,
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content
    }
  };
}

function normalizePromptImage(image: PromptImage): { ok: true; image: PromptImage } | { ok: false; message: string } {
  const dataUrlMatch = image.dataBase64.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.*)$/is);
  const mediaTypeFromDataUrl = dataUrlMatch?.[1]?.toLowerCase();
  const base64 = (dataUrlMatch ? dataUrlMatch[2] : image.dataBase64).replace(/\s/g, "");

  if (mediaTypeFromDataUrl && mediaTypeFromDataUrl !== image.mediaType) {
    return { ok: false, message: `Image data URL media type ${mediaTypeFromDataUrl} does not match ${image.mediaType}` };
  }

  if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) {
    return { ok: false, message: "Image dataBase64 must be valid base64" };
  }

  const buffer = Buffer.from(base64, "base64");
  if (buffer.length === 0) {
    return { ok: false, message: "Image dataBase64 must decode to bytes" };
  }

  const canonical = buffer.toString("base64").replace(/=+$/, "");
  const comparable = base64.replace(/=+$/, "");
  if (canonical !== comparable) {
    return { ok: false, message: "Image dataBase64 must be valid base64" };
  }

  if (buffer.length > MAX_PROMPT_IMAGE_BYTES) {
    return { ok: false, message: "Image must be 5 MB or smaller" };
  }

  return {
    ok: true,
    image: {
      ...image,
      dataBase64: base64
    }
  };
}

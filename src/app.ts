import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { AgentService, ConcurrencyLimitError } from "./agent-service.js";
import type { AppConfig } from "./config.js";
import { createHostnameGate } from "./hostname-gate.js";
import { createSessionFactory, MissingClaudeSessionIdError } from "./session-adapter.js";
import { SessionStore } from "./session-store.js";
import { SettingsStore } from "./settings-store.js";
import { renderTestClient } from "./test-client.js";
import { CLAUDE_MODES, type ListSessionsResponse, type PromptImage, type PublicSession, type SessionMetadata } from "./types.js";

const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
const MAX_PROMPT_IMAGES = 5;
const MAX_PROMPT_IMAGE_BYTES = 5 * 1024 * 1024;

export type AppDependencies = {
  config: AppConfig;
  sessionStore?: SessionStore;
  agentService?: AgentService;
  settingsStore?: SettingsStore;
};

const createSessionSchema = z.object({
  mode: z.enum(CLAUDE_MODES).default("bypass"),
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

const streamMessageSchema = z.object({
  prompt: z.string().min(1),
  images: z.array(promptImageSchema).max(MAX_PROMPT_IMAGES).optional(),
  toolResult: z
    .object({
      toolUseId: z.string().min(1),
      content: z.string().min(1)
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

export async function createApp(dependencies: AppDependencies): Promise<Hono> {
  const app = new Hono();
  const sessionStore = dependencies.sessionStore ?? new SessionStore(dependencies.config);
  const agentService =
    dependencies.agentService ??
    new AgentService(
      dependencies.config,
      undefined,
      dependencies.config.useSessionApi ? createSessionFactory() : undefined
    );
  const settingsStore = dependencies.settingsStore ?? new SettingsStore(dependencies.config);

  // Load persisted settings into the agent service on startup
  const persisted = await settingsStore.load();
  agentService.setMaxConcurrentRuns(persisted.maxConcurrentRuns);
  agentService.setMaxTurns(persisted.maxTurns);

  app.use("*", createHostnameGate(dependencies.config));
  app.use("/client/assets/*", serveStatic({ root: "./dist" }));

  app.get("/health", (c) => {
    return c.json({ ok: true, service: "claude-server", timestamp: new Date().toISOString() });
  });

  app.get("/v1/settings", (c) => {
    return c.json({
      maxConcurrentRuns: agentService.getMaxConcurrentRuns(),
      maxTurns: agentService.getMaxTurns()
    });
  });

  app.patch("/v1/settings", async (c) => {
    const body = z
      .object({
        maxConcurrentRuns: z.number().int().min(1).max(64).optional(),
        maxTurns: z.number().int().min(1).max(200).optional()
      })
      .parse(await c.req.json().catch(() => ({})));

    if (body.maxConcurrentRuns !== undefined) {
      agentService.setMaxConcurrentRuns(body.maxConcurrentRuns);
    }
    if (body.maxTurns !== undefined) {
      agentService.setMaxTurns(body.maxTurns);
    }

    const settings = await settingsStore.save({
      maxConcurrentRuns: agentService.getMaxConcurrentRuns(),
      maxTurns: agentService.getMaxTurns()
    });

    return c.json({
      maxConcurrentRuns: settings.maxConcurrentRuns,
      maxTurns: settings.maxTurns
    });
  });

  app.get("/client", (c) => {
    return c.html(renderTestClient());
  });

  app.post("/v1/sessions", async (c) => {
    const body = createSessionSchema.parse(await c.req.json().catch(() => ({})));
    const session = await sessionStore.create(body);
    return c.json(toPublicSession(session), 201);
  });

  app.get("/v1/sessions", async (c) => {
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

  app.get("/v1/sessions/:sessionId/messages", async (c) => {
    const session = await sessionStore.get(c.req.param("sessionId"));
    if (!session) return c.json({ error: { code: "session_not_found", message: "Session not found" } }, 404);

    const limit = parseOptionalInteger(c.req.query("limit"));
    const offset = parseOptionalInteger(c.req.query("offset"));
    const messages = await agentService.getMessages(session, limit, offset);
    return c.json({ messages });
  });

  app.get("/v1/claude-commands", async (c) => {
    const commandPath = c.req.query("path");
    if (commandPath) {
      const command = await sessionStore.readSharedClaudeCommand(commandPath);
      if (!command) return c.json({ error: { code: "command_not_found", message: "Claude command not found" } }, 404);
      return c.json({ command });
    }
    const commands = await sessionStore.listSharedClaudeCommands();
    return c.json({ commands });
  });

  app.post("/v1/claude-commands", async (c) => {
    const body = claudeCommandSchema.parse(await c.req.json());
    const command = await sessionStore.saveSharedClaudeCommand(body);
    return c.json({ command }, 201);
  });

  app.delete("/v1/claude-commands", async (c) => {
    const body = deleteClaudeCommandSchema.parse(await c.req.json());
    const deleted = await sessionStore.deleteSharedClaudeCommand(body.path);
    if (!deleted) return c.json({ error: { code: "command_not_found", message: "Claude command not found" } }, 404);
    return c.json({ deleted: true });
  });

  app.get("/v1/sessions/:sessionId/files:search", async (c) => {
    const session = await sessionStore.get(c.req.param("sessionId"));
    if (!session) return c.json({ error: { code: "session_not_found", message: "Session not found" } }, 404);

    const query = workspaceSearchSchema.parse({
      q: c.req.query("q"),
      limit: c.req.query("limit")
    });
    const results = await sessionStore.searchProjectFiles(query.q, query.limit);
    return c.json({ results });
  });

  app.get("/v1/sessions/:sessionId/events:stream", async (c) => {
    const session = await sessionStore.get(c.req.param("sessionId"));
    if (!session) return c.json({ error: { code: "session_not_found", message: "Session not found" } }, 404);

    const observation = agentService.observe(session.id);

    return streamSSE(c, async (stream) => {
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

  app.post("/v1/sessions/:sessionId/messages:stream", async (c) => {
    const session = await sessionStore.get(c.req.param("sessionId"));
    if (!session) return c.json({ error: { code: "session_not_found", message: "Session not found" } }, 404);

    const request = streamMessageSchema.parse(await c.req.json());

    return streamSSE(c, async (stream) => {
      let sessionMarkedAsRun = false;
      let persistedClaudeSessionId = session.claudeSessionId;
      let waitingForUserQuestion = false;
      try {
        for await (const event of agentService.stream({
          session,
          request,
          onClaudeSessionId: async (claudeSessionId) => {
            if (persistedClaudeSessionId === claudeSessionId) return;
            await sessionStore.setClaudeSessionId(session.id, claudeSessionId);
            session.claudeSessionId = claudeSessionId;
            persistedClaudeSessionId = claudeSessionId;
          }
        })) {
          if (!sessionMarkedAsRun) {
            await sessionStore.markRun(session.id);
            sessionMarkedAsRun = true;
          }
          if (event.type === "question_pending") waitingForUserQuestion = true;
          if (event.type === "result" && event.data && typeof event.data === "object") {
            const cost = (event.data as { total_cost_usd?: unknown }).total_cost_usd;
            if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
              await sessionStore.setCost(session.id, cost);
            }
          }

          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event.data)
          });
        }

        await stream.writeSSE({ event: "done", data: JSON.stringify({ ok: true, waitingForUserQuestion }) });
      } catch (error) {
        const status =
          error instanceof ConcurrencyLimitError
            ? "concurrency_limit"
            : error instanceof MissingClaudeSessionIdError
              ? error.code
              : "agent_error";
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ error: { code: status, message: errorMessage(error) } })
        });
      }
    });
  });

  app.post("/v1/sessions/:sessionId/interrupt", async (c) => {
    const session = await sessionStore.get(c.req.param("sessionId"));
    if (!session) return c.json({ error: { code: "session_not_found", message: "Session not found" } }, 404);

    const interrupted = await agentService.interrupt(session.id);
    return c.json({ interrupted });
  });

  app.patch("/v1/sessions/:sessionId", async (c) => {
    const body = updateSessionSchema.parse(await c.req.json().catch(() => ({})));
    const updated = await sessionStore.update(c.req.param("sessionId"), body);
    if (!updated) return c.json({ error: { code: "session_not_found", message: "Session not found" } }, 404);
    return c.json(toPublicSession(updated));
  });

  app.delete("/v1/sessions/:sessionId", async (c) => {
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

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function toPublicSession(session: SessionMetadata): PublicSession {
  return {
    id: session.id,
    sessionId: session.id,
    title: session.title,
    userName: session.userName,
    mode: session.mode,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    hasRun: session.hasRun,
    costUsd: session.costUsd
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

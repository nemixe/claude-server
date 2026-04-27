import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { AgentService, ConcurrencyLimitError } from "./agent-service.js";
import type { AppConfig } from "./config.js";
import { createHostnameGate } from "./hostname-gate.js";
import { SessionStore } from "./session-store.js";
import { CLAUDE_MODES } from "./types.js";

export type AppDependencies = {
  config: AppConfig;
  sessionStore?: SessionStore;
  agentService?: AgentService;
};

const createSessionSchema = z.object({
  mode: z.enum(CLAUDE_MODES).default("plan"),
  title: z.string().min(1).max(200).optional(),
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

const streamMessageSchema = z.object({
  prompt: z.string().min(1),
  mode: z.enum(CLAUDE_MODES).optional(),
  model: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().optional()
});

export function createApp(dependencies: AppDependencies): Hono {
  const app = new Hono();
  const sessionStore = dependencies.sessionStore ?? new SessionStore(dependencies.config);
  const agentService = dependencies.agentService ?? new AgentService(dependencies.config);

  app.use("*", createHostnameGate(dependencies.config));

  app.get("/health", (c) => {
    return c.json({ ok: true, service: "claude-server", timestamp: new Date().toISOString() });
  });

  app.post("/v1/sessions", async (c) => {
    const body = createSessionSchema.parse(await c.req.json().catch(() => ({})));
    const session = await sessionStore.create(body);
    return c.json({ sessionId: session.id, mode: session.mode, createdAt: session.createdAt }, 201);
  });

  app.get("/v1/sessions", async (c) => {
    const sessions = await sessionStore.list();
    return c.json({ sessions });
  });

  app.get("/v1/sessions/:sessionId/messages", async (c) => {
    const session = await sessionStore.get(c.req.param("sessionId"));
    if (!session) return c.json({ error: { code: "session_not_found", message: "Session not found" } }, 404);

    const limit = parseOptionalInteger(c.req.query("limit"));
    const offset = parseOptionalInteger(c.req.query("offset"));
    const messages = await agentService.getMessages(session, limit, offset);
    return c.json({ messages });
  });

  app.post("/v1/sessions/:sessionId/messages:stream", async (c) => {
    const session = await sessionStore.get(c.req.param("sessionId"));
    if (!session) return c.json({ error: { code: "session_not_found", message: "Session not found" } }, 404);

    const request = streamMessageSchema.parse(await c.req.json());

    return streamSSE(c, async (stream) => {
      try {
        for await (const event of agentService.stream({ session, request })) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event.data)
          });
        }

        await sessionStore.markRun(session.id);
        await stream.writeSSE({ event: "done", data: JSON.stringify({ ok: true }) });
      } catch (error) {
        const status = error instanceof ConcurrencyLimitError ? "concurrency_limit" : "agent_error";
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

  app.delete("/v1/sessions/:sessionId", async (c) => {
    const deleted = await sessionStore.delete(c.req.param("sessionId"));
    if (!deleted) return c.json({ error: { code: "session_not_found", message: "Session not found" } }, 404);
    return c.json({ deleted: true });
  });

  app.onError((error, c) => {
    if (error instanceof z.ZodError) {
      return c.json({ error: { code: "validation_error", message: z.prettifyError(error) } }, 400);
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

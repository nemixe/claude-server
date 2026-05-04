import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import type { AppConfig } from "./config.js";
import { createSessionFactory } from "./session-adapter.js";

export type RunningClaudeServer = {
  app: Hono;
  config: AppConfig;
  agentService: AgentService;
  server: ReturnType<typeof serve>;
  stop: () => Promise<void>;
};

export type StartClaudeServerOptions = {
  onListen?: (info: { address: string; port: number }) => void;
};

export async function startClaudeServer(
  config: AppConfig,
  options: StartClaudeServerOptions = {}
): Promise<RunningClaudeServer> {
  const agentService = new AgentService(config, undefined, createSessionFactory());
  const app = await createApp({ config, agentService });
  let stopped = false;

  const server = serve(
    {
      fetch: app.fetch,
      port: config.port,
      hostname: config.bindHost
    },
    options.onListen ??
      ((info) => {
        console.log(`Bottle listening on http://${info.address}:${info.port}`);
      })
  );

  return {
    app,
    config,
    agentService,
    server,
    stop: () =>
      new Promise<void>((resolve) => {
        if (stopped) {
          resolve();
          return;
        }

        stopped = true;
        agentService.dispose();
        server.close(() => resolve());
      })
  };
}

export function installShutdownHandlers(
  running: Pick<RunningClaudeServer, "stop">,
  options: { gracefulMs?: number } = {}
): void {
  const gracefulMs = options.gracefulMs ?? 5_000;
  let shuttingDown = false;

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    void running.stop().finally(() => process.exit(0));
    const forcedExit = setTimeout(() => process.exit(0), gracefulMs);
    forcedExit.unref();
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, shutdown);
  }
}

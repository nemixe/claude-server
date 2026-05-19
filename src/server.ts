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
  const onListen = options.onListen
    ? options.onListen
    : (info: { address: string; port: number }) => {
        console.log(`Bottle listening on http://${info.address}:${info.port}`);
      };

  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    let server: ReturnType<typeof serve> | undefined;
    let settled = false;

    const resolveServer = (): void => {
      if (settled || !server) return;
      settled = true;
      server.off("error", handleServerError);
      resolve(server);
    };

    const rejectServer = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (server) server.off("error", handleServerError);
      reject(error);
      if (server?.listening) {
        server.close(() => {
          // no-op
        });
      }
    };

    const handleServerError = (error: NodeJS.ErrnoException): void => {
      if (error.code === "EADDRINUSE") {
        rejectServer(
          new Error(
            `Port ${config.port} is already in use. Stop the old Bottle process or change PORT before restarting.`
          )
        );
        return;
      }
      rejectServer(
        error instanceof Error ? error : new Error("Failed to start Bottle server due to an unexpected bind error.")
      );
    };

    const handleListen = (info: { address: string; port: number }): void => {
      try {
        onListen(info);
        resolveServer();
      } catch (error) {
        rejectServer(error instanceof Error ? error : new Error("Failed to process Bottle listen callback."));
      }
    };

    try {
      server = serve(
        {
          fetch: app.fetch,
          port: config.port,
          hostname: config.bindHost
        },
        handleListen
      );
    } catch (error) {
      rejectServer(error instanceof Error ? error : new Error("Failed to start Bottle server."));
      return;
    }

    server.on("error", handleServerError);
  });

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

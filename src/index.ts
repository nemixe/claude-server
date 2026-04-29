import "dotenv/config";
import { serve } from "@hono/node-server";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createSessionFactory } from "./session-adapter.js";

const config = loadConfig();
const agentService = new AgentService(config, undefined, createSessionFactory());
const app = await createApp({ config, agentService });

const server = serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: config.bindHost
  },
  (info) => {
    console.log(`Claude server listening on http://${info.address}:${info.port}`);
  }
);

function shutdown(): void {
  agentService.dispose();
  server.close(() => process.exit(0));
  const forcedExit = setTimeout(() => process.exit(0), 5_000);
  forcedExit.unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

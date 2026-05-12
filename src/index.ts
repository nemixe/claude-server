import "dotenv/config";
import { serve } from "@hono/node-server";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { installGatewayUpgradeProxy } from "./gateway.js";
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
    console.log(`Bottle listening on http://${info.address}:${info.port}`);
  }
);
installGatewayUpgradeProxy(server, config);

function shutdown(): void {
  agentService.dispose();
  server.close(() => process.exit(0));
  const forcedExit = setTimeout(() => process.exit(0), 5_000);
  forcedExit.unref();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, shutdown);
}

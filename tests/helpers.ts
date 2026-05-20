import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";

export async function createTempConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): Promise<AppConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-test-"));
  return loadConfig(
    {
      ALLOWED_HOSTNAMES: "localhost,example.com,app.example.com:8443",
      WORKSPACE_DIR: path.join(root, "workspaces"),
      SESSION_DIR: path.join(root, "sessions"),
      MAX_CONCURRENT_RUNS: "2",
      MAX_TURNS: "5",
      MAX_BUDGET_USD: "0.5",
      AGENT_MODEL: "claude-sonnet-4-6",
      ...overrides
    },
    root
  );
}

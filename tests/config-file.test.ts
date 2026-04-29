import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configInputToEnv, defineClaudeServerConfig, loadConfigFromFile } from "../src/config-file.js";

describe("config file loading", () => {
  it("maps typed config input into env-compatible settings", () => {
    expect(
      configInputToEnv(
        defineClaudeServerConfig({
          port: 3003,
          bindHost: "127.0.0.1",
          allowedHostnames: ["app.example.com", "localhost"],
          trustProxy: true,
          projectRoot: "/srv/app",
          sessionDir: ".data/claude-server/app/sessions",
          workspaceDir: ".data/claude-server/app/workspaces",
          maxConcurrentRuns: 5,
          maxTurns: 40,
          claudeModel: "claude-sonnet-4-6"
        })
      )
    ).toMatchObject({
      PORT: "3003",
      BIND_HOST: "127.0.0.1",
      ALLOWED_HOSTNAMES: "app.example.com,localhost",
      TRUST_PROXY: "true",
      PROJECT_ROOT: "/srv/app",
      SESSION_DIR: ".data/claude-server/app/sessions",
      WORKSPACE_DIR: ".data/claude-server/app/workspaces",
      MAX_CONCURRENT_RUNS: "5",
      MAX_TURNS: "40",
      CLAUDE_MODEL: "claude-sonnet-4-6"
    });
  });

  it("loads config files with custom port, project root, and isolated data dirs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-server-config-root-"));
    const configPath = path.join(root, "claude-server.config.mjs");
    await fs.writeFile(
      configPath,
      `export default {
        name: "prototype-c",
        port: 3004,
        projectRoot: ${JSON.stringify(root)},
        allowedHostnames: ["localhost", "prototype.example.com"],
        sessionDir: ".data/claude-server/prototype-c/sessions",
        workspaceDir: ".data/claude-server/prototype-c/workspaces",
        claudeModel: "claude-sonnet-4-6"
      };`,
      "utf8"
    );

    const config = await loadConfigFromFile(configPath, {});

    expect(config.port).toBe(3004);
    expect(config.projectRoot).toBe(root);
    expect(config.sessionDir).toBe(path.join(root, ".data", "claude-server", "prototype-c", "sessions"));
    expect(config.workspaceDir).toBe(path.join(root, ".data", "claude-server", "prototype-c", "workspaces"));
    expect(config.defaultModel).toBe("claude-sonnet-4-6");
    expect(config.allowedHosts).toEqual([{ hostname: "localhost" }, { hostname: "prototype.example.com" }]);
  });
});

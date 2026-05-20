import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { configInputToEnv, defineBottleConfig, loadConfigFromFile } from "../src/config-file.js";

describe("config file loading", () => {
  it("maps typed config input into env-compatible settings", () => {
    expect(
      configInputToEnv(
        defineBottleConfig({
          bottleName: "prototype-a",
          agentProvider: "codex",
          port: 3003,
          bindHost: "127.0.0.1",
          allowedHostnames: ["app.example.com", "localhost"],
          clientOrigins: ["https://client.example.com"],
          clientAppUrl: "http://localhost:5173",
          bottleApiToken: "secret",
          bottleApiTokenRequired: true,
          projectRoot: "/srv/app",
          bottleDir: "/srv/.bottle",
          extraSkillRoots: ["/srv/shared-skills", "/opt/team-skills"],
          sessionDir: ".data/bottle/app/sessions",
          workspaceDir: ".data/bottle/app/workspaces",
          maxConcurrentRuns: 5,
          maxTurns: 40,
          agentModel: "claude-sonnet-4-6",
          codexModel: "gpt-5.5",
          codexReasoningEffort: "high",
          codexNetworkAccess: true,
          codexSkipGitRepoCheck: false,
          codexPlanSandboxMode: "danger-full-access"
        })
      )
    ).toMatchObject({
      PORT: "3003",
      BIND_HOST: "127.0.0.1",
      AGENT_PROVIDER: "codex",
      ALLOWED_HOSTNAMES: "app.example.com,localhost",
      BOTTLE_NAME: "prototype-a",
      CLIENT_ORIGINS: "https://client.example.com",
      CLIENT_APP_URL: "http://localhost:5173",
      BOTTLE_API_TOKEN: "secret",
      BOTTLE_API_TOKEN_REQUIRED: "true",
      PROJECT_ROOT: "/srv/app",
      BOTTLE_DIR: "/srv/.bottle",
      BOTTLE_EXTRA_SKILL_ROOTS: "/srv/shared-skills,/opt/team-skills",
      SESSION_DIR: ".data/bottle/app/sessions",
      WORKSPACE_DIR: ".data/bottle/app/workspaces",
      MAX_CONCURRENT_RUNS: "5",
      MAX_TURNS: "40",
      AGENT_MODEL: "claude-sonnet-4-6",
      CODEX_MODEL: "gpt-5.5",
      CODEX_REASONING_EFFORT: "high",
      CODEX_NETWORK_ACCESS: "true",
      CODEX_SKIP_GIT_REPO_CHECK: "false",
      CODEX_PLAN_SANDBOX_MODE: "danger-full-access"
    });
  });

  it("loads config files with custom port, project root, and isolated data dirs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-config-root-"));
    const configPath = path.join(root, "bottle.config.mjs");
    await fs.writeFile(
      configPath,
      `export default {
        bottleName: "prototype-c",
        port: 3004,
        projectRoot: ${JSON.stringify(root)},
        bottleDir: ".",
        extraSkillRoots: ["../shared-skills", "/opt/team-skills"],
        allowedHostnames: ["localhost", "prototype.example.com"],
        sessionDir: ".data/bottle/prototype-c/sessions",
        workspaceDir: ".data/bottle/prototype-c/workspaces",
        agentModel: "claude-sonnet-4-6"
      };`,
      "utf8"
    );

    const config = await loadConfigFromFile(configPath, {});

    expect(config.port).toBe(3004);
    expect(config.bottleName).toBe("prototype-c");
    expect(config.projectRoot).toBe(root);
    expect(config.bottleDir).toBe(root);
    expect(config.extraSkillRoots).toEqual([path.resolve(root, "..", "shared-skills"), "/opt/team-skills"]);
    expect(config.skillRoots).toEqual([path.join(root, "skills"), path.resolve(root, "..", "shared-skills"), "/opt/team-skills"]);
    expect(config.sessionDir).toBe(path.join(root, ".data", "bottle", "prototype-c", "sessions"));
    expect(config.workspaceDir).toBe(path.join(root, ".data", "bottle", "prototype-c", "workspaces"));
    expect(config.agentModel).toBe("claude-sonnet-4-6");
    expect(config.allowedHosts).toEqual([{ hostname: "localhost" }, { hostname: "prototype.example.com" }]);
  });
});

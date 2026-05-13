import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { getEffectiveOrigin, isAllowedHost, parseAllowedHostList, parseHostLike, parseOrigin } from "../src/hostname.js";

describe("config and hostname parsing", () => {
  it("loads .env style configuration with normalized allowed hosts", () => {
    const config = loadConfig({
      BOTTLE_NAME: "prototype-a",
      ALLOWED_HOSTNAMES: "LOCALHOST,example.com,app.example.com:8443",
      TRUST_PROXY: "true",
      MAX_CONCURRENT_RUNS: "7",
      CLIENT_ORIGINS: "http://localhost:5173,https://client.example.com",
      MAIN_APP_URL: "http://localhost:3000"
    });

    expect(config.bottleName).toBe("prototype-a");
    expect(config.trustProxy).toBe(true);
    expect(config.maxConcurrentRuns).toBe(7);
    expect(config.clientOrigins).toEqual(["http://localhost:5173", "https://client.example.com"]);
    expect(config.mainAppUrl).toBe("http://localhost:3000");
    expect(config.defaultAgentProvider).toBe("claude");
    expect(config.runTimeoutMs).toBe(3_600_000);
    expect(config.allowedHosts).toEqual([
      { hostname: "localhost" },
      { hostname: "example.com" },
      { hostname: "app.example.com", port: "8443" }
    ]);
    expect(config).not.toHaveProperty("useSessionApi");
  });

  it("loads Codex provider configuration", () => {
    const config = loadConfig({
      AGENT_PROVIDER: "codex",
      CODEX_MODEL: "gpt-5.5",
      CODEX_API_KEY: "secret",
      CODEX_BASE_URL: "https://api.example.com",
      CODEX_PATH: "/usr/local/bin/codex",
      CODEX_REASONING_EFFORT: "high",
      CODEX_NETWORK_ACCESS: "true",
      CODEX_SKIP_GIT_REPO_CHECK: "false"
    });

    expect(config.defaultAgentProvider).toBe("codex");
    expect(config.codexModel).toBe("gpt-5.5");
    expect(config.codexApiKey).toBe("secret");
    expect(config.codexBaseUrl).toBe("https://api.example.com");
    expect(config.codexPath).toBe("/usr/local/bin/codex");
    expect(config.codexReasoningEffort).toBe("high");
    expect(config.codexNetworkAccess).toBe(true);
    expect(config.codexSkipGitRepoCheck).toBe(false);
  });

  it("ignores removed ENABLE_SESSION_API values", () => {
    const config = loadConfig({ ENABLE_SESSION_API: "false" });

    expect(config).not.toHaveProperty("useSessionApi");
  });

  it("loads PROJECT_ROOT and resolves default data paths from that root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-server-root-"));
    const config = loadConfig({ PROJECT_ROOT: root }, process.cwd());

    expect(config.projectRoot).toBe(root);
    expect(config.bottleDir).toBe(path.join(root, ".bottle"));
    expect(config.agentsDir).toBe(path.join(root, ".bottle", "agents"));
    expect(config.commandsDir).toBe(path.join(root, ".bottle", "commands"));
    expect(config.rulesDir).toBe(path.join(root, ".bottle", "rules"));
    expect(config.skillsDir).toBe(path.join(root, ".bottle", "skills"));
    expect(config.extraSkillRoots).toEqual([]);
    expect(config.skillRoots).toEqual([path.join(root, ".bottle", "skills")]);
    expect(config.claudeCommandsDir).toBe(path.join(root, ".bottle", "commands"));
    expect(config.workspaceDir).toBe(path.join(root, ".data", "workspaces"));
    expect(config.sessionDir).toBe(path.join(root, ".data", "sessions"));
  });

  it("resolves extra skill roots from env against the configured cwd", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-skill-root-cwd-"));
    const projectRoot = path.join(cwd, "app");
    const absoluteRoot = path.join(cwd, "absolute-skills");
    await fs.mkdir(projectRoot);

    const config = loadConfig(
      {
        PROJECT_ROOT: "app",
        BOTTLE_EXTRA_SKILL_ROOTS: "../shared-skills,absolute-skills"
      },
      cwd
    );

    expect(config.extraSkillRoots).toEqual([path.resolve(cwd, "..", "shared-skills"), absoluteRoot]);
    expect(config.skillRoots).toEqual([path.join(projectRoot, ".bottle", "skills"), path.resolve(cwd, "..", "shared-skills"), absoluteRoot]);
  });

  it("resolves explicit BOTTLE_DIR from the process cwd", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-root-"));
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-cwd-"));
    const config = loadConfig({ PROJECT_ROOT: root, BOTTLE_DIR: "bundle/.bottle" }, cwd);

    expect(config.bottleDir).toBe(path.join(cwd, "bundle", ".bottle"));
    expect(config.commandsDir).toBe(path.join(cwd, "bundle", ".bottle", "commands"));
  });

  it("loads main app URL and token configuration", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-config-root-"));
    const config = loadConfig(
      {
        PROJECT_ROOT: root,
        MAIN_APP_URL: "http://localhost:3000/api",
        BOTTLE_API_TOKEN: "secret",
        BOTTLE_API_TOKEN_REQUIRED: "true"
      },
      process.cwd()
    );

    expect(config.mainAppUrl).toBe("http://localhost:3000/api");
    expect(config.bottleApiToken).toBe("secret");
    expect(config.bottleApiTokenRequired).toBe(true);
  });

  it("supports API-only host app mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-api-only-root-"));
    const config = loadConfig(
      {
        PROJECT_ROOT: root,
        MAIN_APP_URL: "https://ai-proto-dev-1.devnstg.com",
        MAIN_APP_PROXY: "false",
        ALLOWED_HOSTNAMES: "ai-proto-dev-1.devnstg.com,localhost",
        CLIENT_ORIGINS: "https://ai-wrapper.devnstg.com",
        TRUST_PROXY: "true"
      },
      process.cwd()
    );

    expect(config.mainAppUrl).toBe("https://ai-proto-dev-1.devnstg.com");
    expect(config.mainAppProxy).toBe(false);
    expect(config.mainAppDirect).toBe(false);
    expect(config.trustProxy).toBe(true);
    expect(config.clientOrigins).toEqual(["https://ai-wrapper.devnstg.com"]);
    expect(config.allowedHosts).toEqual([{ hostname: "ai-proto-dev-1.devnstg.com" }, { hostname: "localhost" }]);
  });

  it("supports AI iframe proxy mode without direct main app routing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-iframe-proxy-root-"));
    const config = loadConfig(
      {
        PROJECT_ROOT: root,
        MAIN_APP_URL: "https://ai-proto-dev-1.devnstg.com",
        MAIN_APP_PROXY: "true",
        MAIN_APP_DIRECT: "false",
        CLIENT_ORIGINS: "https://ai-wrapper.devnstg.com"
      },
      process.cwd()
    );

    expect(config.mainAppUrl).toBe("https://ai-proto-dev-1.devnstg.com");
    expect(config.mainAppProxy).toBe(true);
    expect(config.mainAppDirect).toBe(false);
    expect(config.clientOrigins).toEqual(["https://ai-wrapper.devnstg.com"]);
  });

  it("serves the AI client from root in conditional gateway mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-root-client-"));
    const config = loadConfig(
      {
        PROJECT_ROOT: root,
        MAIN_APP_URL: "http://localhost:3000",
        CLIENT_APP_PATH: "/__ai_client"
      },
      process.cwd()
    );

    expect(config.clientAppPath).toBe("/");
    expect(config.mainAppProxy).toBe(true);
    expect(config.mainAppDirect).toBe(true);
  });

  it("requires a Bottle API token when production token auth is enabled", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-token-root-"));

    expect(() => loadConfig({ PROJECT_ROOT: root, NODE_ENV: "production" }, process.cwd())).toThrow(/BOTTLE_API_TOKEN is required/);
  });

  it("loads custom multi-instance port and isolated data directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-server-instance-root-"));
    const config = loadConfig(
      {
        PORT: "3002",
        PROJECT_ROOT: root,
        SESSION_DIR: ".data/claude-server/prototype-b/sessions",
        WORKSPACE_DIR: ".data/claude-server/prototype-b/workspaces",
        ALLOWED_HOSTNAMES: "prototype.example.com,localhost"
      },
      process.cwd()
    );

    expect(config.port).toBe(3002);
    expect(config.projectRoot).toBe(root);
    expect(config.sessionDir).toBe(path.join(root, ".data", "claude-server", "prototype-b", "sessions"));
    expect(config.workspaceDir).toBe(path.join(root, ".data", "claude-server", "prototype-b", "workspaces"));
    expect(config.allowedHosts).toEqual([{ hostname: "prototype.example.com" }, { hostname: "localhost" }]);
  });

  it("prefers explicit projectRoot options over PROJECT_ROOT env", async () => {
    const envRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claude-server-env-root-"));
    const optionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claude-server-option-root-"));
    const config = loadConfig({ PROJECT_ROOT: envRoot }, { projectRoot: optionRoot });

    expect(config.projectRoot).toBe(optionRoot);
  });

  it("resolves relative project roots against the configured cwd", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "claude-server-cwd-"));
    const projectRoot = path.join(cwd, "nested-project");
    await fs.mkdir(projectRoot);

    const config = loadConfig({ PROJECT_ROOT: "nested-project" }, cwd);

    expect(config.projectRoot).toBe(projectRoot);
  });

  it("rejects missing or non-directory project roots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-server-invalid-root-"));
    const filePath = path.join(root, "not-a-directory");
    await fs.writeFile(filePath, "not a dir", "utf8");

    expect(() => loadConfig({ PROJECT_ROOT: path.join(root, "missing") }, root)).toThrow(/PROJECT_ROOT must be an existing directory/);
    expect(() => loadConfig({ PROJECT_ROOT: filePath }, root)).toThrow(/PROJECT_ROOT must be a directory/);
  });

  it("ignores ports for hostname-only entries and requires exact ports for port-specific entries", () => {
    const rules = parseAllowedHostList("example.com,app.example.com:8443");

    expect(isAllowedHost(parseHostLike("example.com:3000"), rules)).toBe(true);
    expect(isAllowedHost(parseOrigin("https://example.com"), rules)).toBe(true);
    expect(isAllowedHost(parseHostLike("app.example.com:8443"), rules)).toBe(true);
    expect(isAllowedHost(parseHostLike("app.example.com:3000"), rules)).toBe(false);
  });

  it("builds public origins from forwarded proxy headers only when trusted", () => {
    const headers = new Headers({
      host: "internal:3001",
      "x-forwarded-host": "prototype.example.com",
      "x-forwarded-proto": "https"
    });

    expect(getEffectiveOrigin("http://internal:3001/v1/bottle", headers, true)).toBe("https://prototype.example.com");
    expect(getEffectiveOrigin("http://internal:3001/v1/bottle", headers, false)).toBe("http://internal:3001");
  });
});

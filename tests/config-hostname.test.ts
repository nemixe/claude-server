import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { isAllowedHost, parseAllowedHostList, parseHostLike, parseOrigin } from "../src/hostname.js";

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
    expect(config.allowedHosts).toEqual([
      { hostname: "localhost" },
      { hostname: "example.com" },
      { hostname: "app.example.com", port: "8443" }
    ]);
    expect(config).not.toHaveProperty("useSessionApi");
  });

  it("ignores removed ENABLE_SESSION_API values", () => {
    const config = loadConfig({ ENABLE_SESSION_API: "false" });

    expect(config).not.toHaveProperty("useSessionApi");
  });

  it("loads PROJECT_ROOT and resolves default data paths from that root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-server-root-"));
    const config = loadConfig({ PROJECT_ROOT: root }, process.cwd());

    expect(config.projectRoot).toBe(root);
    expect(config.claudeCommandsDir).toBe(path.join(root, ".claude", "commands"));
    expect(config.workspaceDir).toBe(path.join(root, ".data", "workspaces"));
    expect(config.sessionDir).toBe(path.join(root, ".data", "sessions"));
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
});

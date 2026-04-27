import os from "node:os";
import path from "node:path";
import type { AppConfig } from "./config.js";

export type SandboxSettings = {
  enabled: boolean;
  autoAllowBashIfSandboxed: boolean;
  excludedCommands: string[];
  allowUnsandboxedCommands: boolean;
  network: {
    allowedDomains: string[];
    allowManagedDomainsOnly: boolean;
    allowLocalBinding: boolean;
    allowUnixSockets: string[];
    allowAllUnixSockets: boolean;
  };
  filesystem: {
    allowWrite: string[];
    denyWrite: string[];
    denyRead: string[];
  };
};

export function buildSandboxSettings(config: AppConfig, workspacePath: string): SandboxSettings {
  const homeDir = os.homedir();
  const claudeDir = path.join(homeDir, ".claude");

  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    excludedCommands: [],
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: config.sandboxAllowedDomains,
      allowManagedDomainsOnly: config.sandboxAllowedDomains.length > 0,
      allowLocalBinding: false,
      allowUnixSockets: [],
      allowAllUnixSockets: false
    },
    filesystem: {
      allowWrite: [workspacePath],
      denyWrite: [homeDir, config.sessionDir, config.workspaceDir === workspacePath ? "" : config.workspaceDir].filter(Boolean),
      denyRead: [
        claudeDir,
        path.join(homeDir, ".config", "claude"),
        path.join(homeDir, ".anthropic"),
        path.resolve(".env"),
        path.resolve(".env.local"),
        path.resolve("src"),
        config.sessionDir
      ]
    }
  };
}

export function buildSafeAgentEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return {
    PATH: env.PATH,
    HOME: env.HOME,
    USER: env.USER,
    SHELL: env.SHELL,
    LANG: env.LANG,
    LC_ALL: env.LC_ALL,
    CLAUDE_AGENT_SDK_CLIENT_APP: "claude-server-hono"
  };
}

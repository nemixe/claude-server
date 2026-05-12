import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { loadConfig, type AppConfig, type CodexReasoningEffort } from "./config.js";
import type { AgentProvider } from "./types.js";

export { loadConfig };
export type { AppConfig };

export type ClaudeServerConfigInput = {
  name?: string;
  bottleName?: string;
  agentProvider?: AgentProvider;
  port?: number;
  bindHost?: string;
  allowedHostnames?: string | string[];
  trustProxy?: boolean;
  clientOrigins?: string | string[];
  mainAppUrl?: string;
  appUrl?: string;
  clientAppUrl?: string;
  mainAppProxy?: boolean;
  mainAppDirect?: boolean;
  bottleApiToken?: string;
  bottleApiTokenRequired?: boolean;
  projectRoot?: string;
  bottleDir?: string;
  extraSkillRoots?: string | string[];
  workspaceDir?: string;
  sessionDir?: string;
  maxConcurrentRuns?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  runTimeoutMs?: number;
  sandboxAllowedDomains?: string | string[];
  sessionIdleTtlMs?: number;
  claudeModel?: string;
  defaultModel?: string;
  codexModel?: string;
  codexApiKey?: string;
  codexBaseUrl?: string;
  codexPath?: string;
  codexReasoningEffort?: CodexReasoningEffort;
  codexNetworkAccess?: boolean;
  codexSkipGitRepoCheck?: boolean;
};

export type ClaudeServerConfigFactory = (context: {
  env: NodeJS.ProcessEnv;
  configPath: string;
}) => ClaudeServerConfigInput | Promise<ClaudeServerConfigInput>;

type ConfigModuleExport =
  | ClaudeServerConfigInput
  | ClaudeServerConfigFactory
  | {
      default?: ClaudeServerConfigInput | ClaudeServerConfigFactory;
      config?: ClaudeServerConfigInput | ClaudeServerConfigFactory;
    };

export function defineClaudeServerConfig(config: ClaudeServerConfigInput): ClaudeServerConfigInput {
  return config;
}

export function defineBottleConfig(config: ClaudeServerConfigInput): ClaudeServerConfigInput {
  return config;
}

export async function loadConfigFromFile(
  configPath: string | URL,
  env: NodeJS.ProcessEnv = process.env
): Promise<AppConfig> {
  const resolvedPath = path.resolve(configPath instanceof URL ? fileURLToPath(configPath) : configPath);
  const moduleUrl = `${pathToFileURL(resolvedPath).href}?v=${Date.now()}-${Math.random()}`;
  const loaded = (await import(moduleUrl)) as ConfigModuleExport;
  const configExport = resolveConfigExport(loaded);
  const input = typeof configExport === "function" ? await configExport({ env, configPath: resolvedPath }) : configExport;

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Claude server config must export an object or a config factory");
  }

  return loadConfig(
    {
      ...env,
      ...configInputToEnv(input)
    },
    {
      cwd: path.dirname(resolvedPath),
      projectRoot: input.projectRoot
    }
  );
}

export function configInputToEnv(input: ClaudeServerConfigInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  setEnv(env, "BOTTLE_NAME", input.bottleName ?? input.name);
  setEnv(env, "AGENT_PROVIDER", input.agentProvider);
  setEnv(env, "PROJECT_ROOT", input.projectRoot);
  setEnv(env, "BOTTLE_DIR", input.bottleDir);
  setEnv(env, "BOTTLE_EXTRA_SKILL_ROOTS", csv(input.extraSkillRoots));
  setEnv(env, "PORT", input.port);
  setEnv(env, "BIND_HOST", input.bindHost);
  setEnv(env, "ALLOWED_HOSTNAMES", csv(input.allowedHostnames));
  setEnv(env, "TRUST_PROXY", input.trustProxy);
  setEnv(env, "CLIENT_ORIGINS", csv(input.clientOrigins));
  setEnv(env, "MAIN_APP_URL", input.mainAppUrl ?? input.appUrl);
  setEnv(env, "CLIENT_APP_URL", input.clientAppUrl);
  setEnv(env, "MAIN_APP_PROXY", input.mainAppProxy);
  setEnv(env, "MAIN_APP_DIRECT", input.mainAppDirect);
  setEnv(env, "BOTTLE_API_TOKEN", input.bottleApiToken);
  setEnv(env, "BOTTLE_API_TOKEN_REQUIRED", input.bottleApiTokenRequired);
  setEnv(env, "WORKSPACE_DIR", input.workspaceDir);
  setEnv(env, "SESSION_DIR", input.sessionDir);
  setEnv(env, "MAX_CONCURRENT_RUNS", input.maxConcurrentRuns);
  setEnv(env, "MAX_TURNS", input.maxTurns);
  setEnv(env, "MAX_BUDGET_USD", input.maxBudgetUsd);
  setEnv(env, "RUN_TIMEOUT_MS", input.runTimeoutMs);
  setEnv(env, "SANDBOX_ALLOWED_DOMAINS", csv(input.sandboxAllowedDomains));
  setEnv(env, "SESSION_IDLE_TTL_MS", input.sessionIdleTtlMs);
  setEnv(env, "CLAUDE_MODEL", input.claudeModel ?? input.defaultModel);
  setEnv(env, "CODEX_MODEL", input.codexModel);
  setEnv(env, "CODEX_API_KEY", input.codexApiKey);
  setEnv(env, "CODEX_BASE_URL", input.codexBaseUrl);
  setEnv(env, "CODEX_PATH", input.codexPath);
  setEnv(env, "CODEX_REASONING_EFFORT", input.codexReasoningEffort);
  setEnv(env, "CODEX_NETWORK_ACCESS", input.codexNetworkAccess);
  setEnv(env, "CODEX_SKIP_GIT_REPO_CHECK", input.codexSkipGitRepoCheck);
  return env;
}

function resolveConfigExport(loaded: ConfigModuleExport): ClaudeServerConfigInput | ClaudeServerConfigFactory {
  if (typeof loaded === "function") return loaded;
  if (loaded && typeof loaded === "object") {
    if ("default" in loaded && loaded.default !== undefined) return loaded.default;
    if ("config" in loaded && loaded.config !== undefined) return loaded.config;
  }
  return loaded as ClaudeServerConfigInput;
}

function setEnv(env: NodeJS.ProcessEnv, key: string, value: string | number | boolean | undefined): void {
  if (value === undefined) return;
  env[key] = String(value);
}

function csv(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(",");
  return value;
}

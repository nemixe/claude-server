import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { loadConfig, type AppConfig, type CodexReasoningEffort, type CodexSandboxMode } from "./config.js";
import type { AgentProvider } from "./types.js";

export { loadConfig };
export type { AppConfig };

export type BottleConfigInput = {
  name?: string;
  bottleName?: string;
  agentProvider?: AgentProvider;
  port?: number;
  bindHost?: string;
  allowedHostnames?: string | string[];
  clientOrigins?: string | string[];
  clientAppUrl?: string;
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
  agentModel?: string;
  codexModel?: string;
  codexApiKey?: string;
  codexBaseUrl?: string;
  codexPath?: string;
  codexReasoningEffort?: CodexReasoningEffort;
  codexNetworkAccess?: boolean;
  codexSkipGitRepoCheck?: boolean;
  codexPlanSandboxMode?: CodexSandboxMode;
};

export type BottleConfigFactory = (context: {
  env: NodeJS.ProcessEnv;
  configPath: string;
}) => BottleConfigInput | Promise<BottleConfigInput>;

type ConfigModuleExport =
  | BottleConfigInput
  | BottleConfigFactory
  | {
      default?: BottleConfigInput | BottleConfigFactory;
      config?: BottleConfigInput | BottleConfigFactory;
    };

export function defineBottleConfig(config: BottleConfigInput): BottleConfigInput {
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
    throw new Error("Bottle config must export an object or a config factory");
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

export function configInputToEnv(input: BottleConfigInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  setEnv(env, "BOTTLE_NAME", input.bottleName ?? input.name);
  setEnv(env, "AGENT_PROVIDER", input.agentProvider);
  setEnv(env, "PROJECT_ROOT", input.projectRoot);
  setEnv(env, "BOTTLE_DIR", input.bottleDir);
  setEnv(env, "BOTTLE_EXTRA_SKILL_ROOTS", csv(input.extraSkillRoots));
  setEnv(env, "PORT", input.port);
  setEnv(env, "BIND_HOST", input.bindHost);
  setEnv(env, "ALLOWED_HOSTNAMES", csv(input.allowedHostnames));
  setEnv(env, "CLIENT_ORIGINS", csv(input.clientOrigins));
  setEnv(env, "CLIENT_APP_URL", input.clientAppUrl);
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
  setEnv(env, "AGENT_MODEL", input.agentModel);
  setEnv(env, "CODEX_MODEL", input.codexModel);
  setEnv(env, "CODEX_API_KEY", input.codexApiKey);
  setEnv(env, "CODEX_BASE_URL", input.codexBaseUrl);
  setEnv(env, "CODEX_PATH", input.codexPath);
  setEnv(env, "CODEX_REASONING_EFFORT", input.codexReasoningEffort);
  setEnv(env, "CODEX_NETWORK_ACCESS", input.codexNetworkAccess);
  setEnv(env, "CODEX_SKIP_GIT_REPO_CHECK", input.codexSkipGitRepoCheck);
  setEnv(env, "CODEX_PLAN_SANDBOX_MODE", input.codexPlanSandboxMode);
  return env;
}

function resolveConfigExport(loaded: ConfigModuleExport): BottleConfigInput | BottleConfigFactory {
  if (typeof loaded === "function") return loaded;
  if (loaded && typeof loaded === "object") {
    if ("default" in loaded && loaded.default !== undefined) return loaded.default;
    if ("config" in loaded && loaded.config !== undefined) return loaded.config;
  }
  return loaded as BottleConfigInput;
}

function setEnv(env: NodeJS.ProcessEnv, key: string, value: string | number | boolean | undefined): void {
  if (value === undefined) return;
  env[key] = String(value);
}

function csv(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.join(",");
  return value;
}

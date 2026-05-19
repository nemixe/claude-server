import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { type AllowedHostRule, parseAllowedHostList } from "./hostname.js";
import { AGENT_PROVIDERS, type AgentProvider } from "./types.js";

export const CODEX_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];
export const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

export type AppConfig = {
  bottleName: string;
  defaultAgentProvider: AgentProvider;
  clientAppUrl?: string;
  clientAppPath: "/";
  projectRoot: string;
  port: number;
  bindHost: string;
  allowedHosts: AllowedHostRule[];
  clientOrigins: string[];
  bottleApiToken?: string;
  bottleApiTokenRequired: boolean;
  bottleDir: string;
  agentsDir: string;
  commandsDir: string;
  rulesDir: string;
  skillsDir: string;
  extraSkillRoots: string[];
  skillRoots: string[];
  claudeCommandsDir: string;
  workspaceDir: string;
  sessionDir: string;
  maxConcurrentRuns: number;
  maxTurns: number;
  maxBudgetUsd: number;
  runTimeoutMs: number;
  sandboxAllowedDomains: string[];
  sessionIdleTtlMs: number;
  defaultModel?: string;
  codexModel?: string;
  codexApiKey?: string;
  codexBaseUrl?: string;
  codexPath?: string;
  codexReasoningEffort?: CodexReasoningEffort;
  codexNetworkAccess?: boolean;
  codexSkipGitRepoCheck: boolean;
  codexPlanSandboxMode: CodexSandboxMode;
};

export type LoadConfigOptions = {
  cwd?: string;
  projectRoot?: string;
};

const RawEnvSchema = z.object({
  BOTTLE_NAME: z.string().optional(),
  CLAUDE_SERVER_INSTANCE: z.string().optional(),
  AGENT_PROVIDER: z.string().optional(),
  PROJECT_ROOT: z.string().optional(),
  PORT: z.string().optional(),
  BIND_HOST: z.string().optional(),
  ALLOWED_HOSTNAMES: z.string().optional(),
  CLIENT_ORIGINS: z.string().optional(),
  CLIENT_APP_URL: z.string().optional(),
  BOTTLE_API_TOKEN: z.string().optional(),
  BOTTLE_API_TOKEN_REQUIRED: z.string().optional(),
  BOTTLE_DIR: z.string().optional(),
  BOTTLE_EXTRA_SKILL_ROOTS: z.string().optional(),
  NODE_ENV: z.string().optional(),
  WORKSPACE_DIR: z.string().optional(),
  SESSION_DIR: z.string().optional(),
  MAX_CONCURRENT_RUNS: z.string().optional(),
  MAX_TURNS: z.string().optional(),
  MAX_BUDGET_USD: z.string().optional(),
  RUN_TIMEOUT_MS: z.string().optional(),
  SANDBOX_ALLOWED_DOMAINS: z.string().optional(),
  SESSION_IDLE_TTL_MS: z.string().optional(),
  CLAUDE_MODEL: z.string().optional(),
  CODEX_MODEL: z.string().optional(),
  CODEX_API_KEY: z.string().optional(),
  CODEX_BASE_URL: z.string().optional(),
  CODEX_PATH: z.string().optional(),
  CODEX_REASONING_EFFORT: z.string().optional(),
  CODEX_NETWORK_ACCESS: z.string().optional(),
  CODEX_SKIP_GIT_REPO_CHECK: z.string().optional(),
  CODEX_PLAN_SANDBOX_MODE: z.string().optional()
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: string | LoadConfigOptions = process.cwd()): AppConfig {
  const raw = RawEnvSchema.parse(env);
  const normalizedOptions: LoadConfigOptions = typeof options === "string" ? { cwd: options } : options;
  const cwd = path.resolve(normalizedOptions.cwd ?? process.cwd());
  const projectRoot = resolveExistingProjectRoot(
    normalizeOptionalString(normalizedOptions.projectRoot) ?? normalizeOptionalString(raw.PROJECT_ROOT) ?? cwd,
    cwd
  );
  const allowedHostValue = raw.ALLOWED_HOSTNAMES ?? "localhost,127.0.0.1";
  const allowedHosts = parseAllowedHostList(allowedHostValue);

  if (allowedHosts.length === 0) {
    throw new Error("ALLOWED_HOSTNAMES must contain at least one hostname");
  }
  const bottleApiToken = normalizeOptionalString(raw.BOTTLE_API_TOKEN);
  const bottleApiTokenRequired = parseBoolean(raw.BOTTLE_API_TOKEN_REQUIRED, raw.NODE_ENV === "production", "BOTTLE_API_TOKEN_REQUIRED");
  if (bottleApiTokenRequired && !bottleApiToken) {
    throw new Error("BOTTLE_API_TOKEN is required when BOTTLE_API_TOKEN_REQUIRED is true");
  }
  const bottleDir = resolveBottleDir(raw.BOTTLE_DIR, projectRoot, cwd);
  const commandsDir = path.join(bottleDir, "commands");
  const skillsDir = path.join(bottleDir, "skills");
  const extraSkillRoots = resolveExtraSkillRoots(raw.BOTTLE_EXTRA_SKILL_ROOTS, cwd);

  return {
    bottleName: normalizeOptionalString(raw.BOTTLE_NAME) ?? normalizeOptionalString(raw.CLAUDE_SERVER_INSTANCE) ?? "bottle",
    defaultAgentProvider: parseAgentProvider(raw.AGENT_PROVIDER),
    clientAppUrl: normalizeOptionalUrl(raw.CLIENT_APP_URL ?? "http://localhost:5173", "CLIENT_APP_URL"),
    clientAppPath: "/",
    projectRoot,
    port: parseInteger(raw.PORT, 3001, "PORT"),
    bindHost: raw.BIND_HOST ?? "0.0.0.0",
    allowedHosts,
    clientOrigins: parseOrigins(raw.CLIENT_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173"),
    bottleApiToken,
    bottleApiTokenRequired,
    bottleDir,
    agentsDir: path.join(bottleDir, "agents"),
    commandsDir,
    rulesDir: path.join(bottleDir, "rules"),
    skillsDir,
    extraSkillRoots,
    skillRoots: [skillsDir, ...extraSkillRoots],
    claudeCommandsDir: commandsDir,
    workspaceDir: resolveFromRoot(raw.WORKSPACE_DIR ?? ".data/workspaces", projectRoot),
    sessionDir: resolveFromRoot(raw.SESSION_DIR ?? ".data/sessions", projectRoot),
    maxConcurrentRuns: parseInteger(raw.MAX_CONCURRENT_RUNS, 4, "MAX_CONCURRENT_RUNS"),
    maxTurns: parseInteger(raw.MAX_TURNS, 30, "MAX_TURNS"),
    maxBudgetUsd: parseNumber(raw.MAX_BUDGET_USD, 1, "MAX_BUDGET_USD"),
    runTimeoutMs: parseInteger(raw.RUN_TIMEOUT_MS, 3_600_000, "RUN_TIMEOUT_MS"),
    sandboxAllowedDomains: parseCsv(raw.SANDBOX_ALLOWED_DOMAINS ?? "api.anthropic.com,claude.ai,statsig.anthropic.com"),
    sessionIdleTtlMs: parsePositiveInteger(raw.SESSION_IDLE_TTL_MS, 300_000, "SESSION_IDLE_TTL_MS"),
    defaultModel: normalizeOptionalString(raw.CLAUDE_MODEL),
    codexModel: normalizeOptionalString(raw.CODEX_MODEL),
    codexApiKey: normalizeOptionalString(raw.CODEX_API_KEY),
    codexBaseUrl: normalizeOptionalUrl(raw.CODEX_BASE_URL, "CODEX_BASE_URL"),
    codexPath: normalizeOptionalString(raw.CODEX_PATH),
    codexReasoningEffort: parseCodexReasoningEffort(raw.CODEX_REASONING_EFFORT),
    codexNetworkAccess: parseOptionalBoolean(raw.CODEX_NETWORK_ACCESS, "CODEX_NETWORK_ACCESS"),
    codexSkipGitRepoCheck: parseBoolean(raw.CODEX_SKIP_GIT_REPO_CHECK, true, "CODEX_SKIP_GIT_REPO_CHECK"),
    codexPlanSandboxMode: parseCodexSandboxMode(raw.CODEX_PLAN_SANDBOX_MODE, "read-only", "CODEX_PLAN_SANDBOX_MODE")
  };
}

function parseAgentProvider(value: string | undefined): AgentProvider {
  const normalized = normalizeOptionalString(value) ?? "claude";
  if ((AGENT_PROVIDERS as readonly string[]).includes(normalized)) return normalized as AgentProvider;
  throw new Error(`AGENT_PROVIDER must be one of: ${AGENT_PROVIDERS.join(", ")}`);
}

function parseCodexReasoningEffort(value: string | undefined): CodexReasoningEffort | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  if ((CODEX_REASONING_EFFORTS as readonly string[]).includes(normalized)) return normalized as CodexReasoningEffort;
  throw new Error(`CODEX_REASONING_EFFORT must be one of: ${CODEX_REASONING_EFFORTS.join(", ")}`);
}

function parseCodexSandboxMode(value: string | undefined, fallback: CodexSandboxMode, name: string): CodexSandboxMode {
  const normalized = normalizeOptionalString(value) ?? fallback;
  if ((CODEX_SANDBOX_MODES as readonly string[]).includes(normalized)) return normalized as CodexSandboxMode;
  throw new Error(`${name} must be one of: ${CODEX_SANDBOX_MODES.join(", ")}`);
}

function resolveExistingProjectRoot(value: string, cwd: string): string {
  const resolved = resolveFromRoot(value, cwd);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(`PROJECT_ROOT must be an existing directory: ${resolved}`);
    }
    throw error;
  }

  if (!stat.isDirectory()) {
    throw new Error(`PROJECT_ROOT must be a directory: ${resolved}`);
  }
  return resolved;
}

function resolveFromRoot(value: string, root: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

function resolveBottleDir(value: string | undefined, projectRoot: string, cwd: string): string {
  const normalized = normalizeOptionalString(value);
  if (normalized) {
    return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized);
  }
  return path.join(projectRoot, ".bottle");
}

function resolveExtraSkillRoots(value: string | undefined, cwd: string): string[] {
  return parseCsv(value ?? "").map((entry) => resolveFromRoot(entry, cwd));
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseOrigins(value: string): string[] {
  return parseCsv(value).map((entry) => {
    try {
      return new URL(entry).origin;
    } catch {
      throw new Error(`CLIENT_ORIGINS contains an invalid origin: ${entry}`);
    }
  });
}

function normalizeOptionalUrl(value: string | undefined, name: string): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  try {
    return new URL(normalized).href.replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
}

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === "") return fallback;
  if (/^(true|1|yes)$/i.test(value)) return true;
  if (/^(false|0|no)$/i.test(value)) return false;
  throw new Error(`${name} must be a boolean`);
}

function parseOptionalBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return parseBoolean(value, false, name);
}

function parseInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = parseNumber(value, fallback, name);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = parseInteger(value, fallback, name);
  if (parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

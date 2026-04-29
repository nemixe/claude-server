import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { type AllowedHostRule, parseAllowedHostList } from "./hostname.js";

export type AppConfig = {
  projectRoot: string;
  port: number;
  bindHost: string;
  allowedHosts: AllowedHostRule[];
  trustProxy: boolean;
  claudeCommandsDir: string;
  workspaceDir: string;
  sessionDir: string;
  maxConcurrentRuns: number;
  maxTurns: number;
  maxBudgetUsd: number;
  runTimeoutMs: number;
  sandboxAllowedDomains: string[];
  useSessionApi: boolean;
  sessionIdleTtlMs: number;
  defaultModel?: string;
};

export type LoadConfigOptions = {
  cwd?: string;
  projectRoot?: string;
};

const RawEnvSchema = z.object({
  PROJECT_ROOT: z.string().optional(),
  PORT: z.string().optional(),
  BIND_HOST: z.string().optional(),
  ALLOWED_HOSTNAMES: z.string().optional(),
  TRUST_PROXY: z.string().optional(),
  WORKSPACE_DIR: z.string().optional(),
  SESSION_DIR: z.string().optional(),
  MAX_CONCURRENT_RUNS: z.string().optional(),
  MAX_TURNS: z.string().optional(),
  MAX_BUDGET_USD: z.string().optional(),
  RUN_TIMEOUT_MS: z.string().optional(),
  SANDBOX_ALLOWED_DOMAINS: z.string().optional(),
  ENABLE_SESSION_API: z.string().optional(),
  SESSION_IDLE_TTL_MS: z.string().optional(),
  CLAUDE_MODEL: z.string().optional()
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

  return {
    projectRoot,
    port: parseInteger(raw.PORT, 3000, "PORT"),
    bindHost: raw.BIND_HOST ?? "0.0.0.0",
    allowedHosts,
    trustProxy: parseBoolean(raw.TRUST_PROXY, false, "TRUST_PROXY"),
    claudeCommandsDir: resolveFromRoot(".claude/commands", projectRoot),
    workspaceDir: resolveFromRoot(raw.WORKSPACE_DIR ?? ".data/workspaces", projectRoot),
    sessionDir: resolveFromRoot(raw.SESSION_DIR ?? ".data/sessions", projectRoot),
    maxConcurrentRuns: parseInteger(raw.MAX_CONCURRENT_RUNS, 4, "MAX_CONCURRENT_RUNS"),
    maxTurns: parseInteger(raw.MAX_TURNS, 30, "MAX_TURNS"),
    maxBudgetUsd: parseNumber(raw.MAX_BUDGET_USD, 1, "MAX_BUDGET_USD"),
    runTimeoutMs: parseInteger(raw.RUN_TIMEOUT_MS, 600_000, "RUN_TIMEOUT_MS"),
    sandboxAllowedDomains: parseCsv(raw.SANDBOX_ALLOWED_DOMAINS ?? "api.anthropic.com,claude.ai,statsig.anthropic.com"),
    useSessionApi: parseBoolean(raw.ENABLE_SESSION_API, false, "ENABLE_SESSION_API"),
    sessionIdleTtlMs: parsePositiveInteger(raw.SESSION_IDLE_TTL_MS, 300_000, "SESSION_IDLE_TTL_MS"),
    defaultModel: normalizeOptionalString(raw.CLAUDE_MODEL)
  };
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

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === "") return fallback;
  if (/^(true|1|yes)$/i.test(value)) return true;
  if (/^(false|0|no)$/i.test(value)) return false;
  throw new Error(`${name} must be a boolean`);
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

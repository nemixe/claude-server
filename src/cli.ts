#!/usr/bin/env node
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { loadConfigFromFile } from "./config-file.js";
import { installShutdownHandlers, startClaudeServer } from "./server.js";

type Writable = {
  write(chunk: string): unknown;
};

export type CliOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: Writable;
  stderr?: Writable;
};

type ParsedFlags = {
  values: Map<string, string>;
  booleans: Set<string>;
};

const DEFAULT_ALLOWED_HOSTNAMES = ["localhost", "127.0.0.1"];
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_APP_DIR = "app";
const DEFAULT_BOTTLE_DIR = ".bottle";
const DEFAULT_MAIN_APP_URL = "http://localhost:3000";

export async function runCli(argv = process.argv.slice(2), options: CliOptions = {}): Promise<number> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const [command = "help", ...args] = argv;

  try {
    if (command === "help" || command === "--help" || command === "-h") {
      writeLine(stdout, helpText());
      return 0;
    }

    if (command === "init") {
      await initCommand(args, { cwd, stdout, stderr });
      return 0;
    }

    if (command === "start") {
      await startCommand(args, { cwd, env, stdout });
      return 0;
    }

    writeLine(stderr, `Unknown command: ${command}`);
    writeLine(stderr, helpText());
    return 1;
  } catch (error) {
    writeLine(stderr, error instanceof Error ? error.message : "Unexpected CLI error");
    return 1;
  }
}

async function initCommand(args: string[], options: { cwd: string; stdout: Writable; stderr: Writable }): Promise<void> {
  const flags = parseFlags(args);
  const name = normalizeInstanceName(flags.values.get("name") ?? "prototype");
  const port = parsePort(flags.values.get("port") ?? "3001");
  const bundleRoot = path.resolve(options.cwd, flags.values.get("output-dir") ?? ".");
  const bottleDir = path.resolve(bundleRoot, flags.values.get("bottle-dir") ?? DEFAULT_BOTTLE_DIR);
  const appDir = path.resolve(bundleRoot, flags.values.get("app-dir") ?? DEFAULT_APP_DIR);
  const projectRoot = flags.values.has("project-root")
    ? path.resolve(options.cwd, flags.values.get("project-root") as string)
    : appDir;
  const copyFrom = flags.values.has("copy-from") ? path.resolve(options.cwd, flags.values.get("copy-from") as string) : undefined;
  const force = flags.booleans.has("force");
  const bindHost = flags.values.get("bind-host") ?? "0.0.0.0";
  const allowedHostnames = parseCsv(flags.values.get("allowed-hostnames") ?? DEFAULT_ALLOWED_HOSTNAMES.join(","));
  const mainAppUrl = flags.values.get("main-app-url") ?? flags.values.get("app-url") ?? DEFAULT_MAIN_APP_URL;
  const projectRootConfigValue = relativePath(bottleDir, projectRoot);
  const sessionDir = relativePath(projectRoot, path.join(bottleDir, "sessions"));
  const configPath = path.join(bottleDir, "bottle.config.mjs");
  const envPath = path.join(bottleDir, "bottle.env");
  const appEnvPath = path.join(bottleDir, "app.env");
  const scriptsDir = path.join(bottleDir, "scripts");
  const startScriptPath = path.join(scriptsDir, "start-bottle.mjs");
  const docsPath = path.join(bottleDir, "README.md");

  await fs.mkdir(bundleRoot, { recursive: true });
  await prepareProjectRoot(projectRoot, copyFrom, force);
  await fs.mkdir(bottleDir, { recursive: true });
  await fs.mkdir(scriptsDir, { recursive: true });
  await ensureCanWrite([configPath, envPath, appEnvPath, startScriptPath, docsPath], force);

  await fs.writeFile(
    configPath,
    renderConfigFile({
      name,
      port,
      bindHost,
      projectRoot: projectRootConfigValue,
      allowedHostnames,
      mainAppUrl,
      sessionDir
    }),
    "utf8"
  );
  await fs.writeFile(
    envPath,
    renderEnvFile({
      name,
      port,
      bindHost,
      projectRoot: projectRootConfigValue,
      allowedHostnames,
      mainAppUrl,
      sessionDir
    }),
    "utf8"
  );
  await fs.writeFile(appEnvPath, renderAppEnvFile(), "utf8");
  await fs.writeFile(startScriptPath, renderStartScript(path.relative(scriptsDir, configPath)), "utf8");
  await fs.chmod(startScriptPath, 0o755);
  await fs.writeFile(
    docsPath,
    renderIntegrationDocs({
      name,
      port,
      projectRoot: projectRootConfigValue,
      mainAppUrl,
      configPath: path.relative(bundleRoot, configPath),
      envPath: path.relative(bundleRoot, envPath),
      appEnvPath: path.relative(bundleRoot, appEnvPath),
      startScriptPath: path.relative(bundleRoot, startScriptPath)
    }),
    "utf8"
  );

  writeLine(options.stdout, `Created Bottle integration for ${name}`);
  writeLine(options.stdout, `- ${path.relative(options.cwd, configPath)}`);
  writeLine(options.stdout, `- ${path.relative(options.cwd, envPath)}`);
  writeLine(options.stdout, `- ${path.relative(options.cwd, appEnvPath)}`);
  writeLine(options.stdout, `- ${path.relative(options.cwd, startScriptPath)}`);
  writeLine(options.stdout, `- ${path.relative(options.cwd, docsPath)}`);
}

async function startCommand(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdout: Writable }): Promise<void> {
  const flags = parseFlags(args);
  const configPath = flags.values.get("config");
  const defaultConfigPath = configPath ? undefined : findDefaultConfigPath(options.cwd);
  const config = configPath || defaultConfigPath
    ? await loadConfigFromFile(path.resolve(options.cwd, configPath ?? defaultConfigPath ?? ""), options.env)
    : loadConfig(options.env, options.cwd);
  const running = await startClaudeServer(config, {
    onListen(info) {
      writeLine(options.stdout, `Bottle listening on http://${info.address}:${info.port}`);
    }
  });
  installShutdownHandlers(running);
}

function parseFlags(args: string[]): ParsedFlags {
  const values = new Map<string, string>();
  const booleans = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (!rawKey) {
      throw new Error(`Invalid flag: ${arg}`);
    }

    if (inlineValue !== undefined) {
      values.set(rawKey, inlineValue);
      continue;
    }

    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(rawKey, next);
      index += 1;
      continue;
    }

    booleans.add(rawKey);
  }

  return { values, booleans };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port must be an integer from 1 to 65535");
  }
  return port;
}

function parseCsv(value: string): string[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error("allowed-hostnames must contain at least one host");
  }
  return [...new Set(entries)];
}

function normalizeInstanceName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    throw new Error("name must contain at least one letter or number");
  }
  return normalized;
}

async function ensureCanWrite(filePaths: string[], force: boolean): Promise<void> {
  if (force) return;
  const existing: string[] = [];
  for (const filePath of filePaths) {
    try {
      await fs.access(filePath);
      existing.push(filePath);
    } catch {
      // Missing files are safe to create.
    }
  }
  if (existing.length > 0) {
    throw new Error(`Refusing to overwrite existing files. Re-run with --force: ${existing.join(", ")}`);
  }
}

async function prepareProjectRoot(projectRoot: string, copyFrom: string | undefined, force: boolean): Promise<void> {
  if (!copyFrom) {
    await fs.mkdir(projectRoot, { recursive: true });
    return;
  }

  const source = path.resolve(copyFrom);
  if (!force && !(await isMissingOrEmptyDirectory(projectRoot))) {
    throw new Error(`Refusing to copy into a non-empty app directory. Re-run with --force: ${projectRoot}`);
  }

  await fs.mkdir(projectRoot, { recursive: true });
  await fs.cp(source, projectRoot, {
    recursive: true,
    force,
    filter: (sourcePath) => !shouldSkipCopiedPath(source, sourcePath)
  });
}

async function isMissingOrEmptyDirectory(directory: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(directory);
    return entries.length === 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    throw error;
  }
}

function shouldSkipCopiedPath(root: string, sourcePath: string): boolean {
  const relative = path.relative(root, sourcePath);
  if (!relative) return false;
  const segments = relative.split(path.sep);
  return segments.some((segment) => segment === ".git" || segment === "node_modules" || segment === ".data");
}

function findDefaultConfigPath(cwd: string): string | undefined {
  const candidates = [path.join(cwd, DEFAULT_BOTTLE_DIR, "bottle.config.mjs"), path.join(cwd, "bottle.config.mjs")];
  return candidates.find((candidate) => fsSync.existsSync(candidate));
}

function relativePath(from: string, to: string): string {
  const relative = path.relative(from, to) || ".";
  return relative.split(path.sep).join("/");
}

function renderConfigFile(input: {
  name: string;
  port: number;
  bindHost: string;
  projectRoot: string;
  allowedHostnames: string[];
  mainAppUrl?: string;
  sessionDir: string;
}): string {
  return `export default ${JSON.stringify(
    {
      bottleName: input.name,
      port: input.port,
      bindHost: input.bindHost,
      projectRoot: input.projectRoot,
      allowedHostnames: input.allowedHostnames,
      ...(input.mainAppUrl ? { mainAppUrl: input.mainAppUrl } : {}),
      clientOrigins: ["http://localhost:5173", "http://127.0.0.1:5173"],
      sessionDir: input.sessionDir,
      maxConcurrentRuns: 4,
      maxTurns: 30,
      claudeModel: DEFAULT_MODEL
    },
    null,
    2
  )};
`;
}

function renderEnvFile(input: {
  name: string;
  port: number;
  bindHost: string;
  projectRoot: string;
  allowedHostnames: string[];
  mainAppUrl?: string;
  sessionDir: string;
}): string {
  return `BOTTLE_NAME=${input.name}
PORT=${input.port}
BIND_HOST=${input.bindHost}
ALLOWED_HOSTNAMES=${input.allowedHostnames.join(",")}
TRUST_PROXY=false
CLIENT_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
MAIN_APP_URL=${input.mainAppUrl ?? ""}
BOTTLE_API_TOKEN=
BOTTLE_API_TOKEN_REQUIRED=false
PROJECT_ROOT=${input.projectRoot}
SESSION_DIR=${input.sessionDir}
CLAUDE_MODEL=${DEFAULT_MODEL}
CODEX_MODEL=
CODEX_API_KEY=
CODEX_BASE_URL=
CODEX_PATH=
CODEX_REASONING_EFFORT=
CODEX_NETWORK_ACCESS=false
CODEX_SKIP_GIT_REPO_CHECK=true
MAX_CONCURRENT_RUNS=4
MAX_TURNS=30
MAX_BUDGET_USD=1
RUN_TIMEOUT_MS=600000
SANDBOX_ALLOWED_DOMAINS=api.anthropic.com,claude.ai,statsig.anthropic.com
SESSION_IDLE_TTL_MS=300000
`;
}

function renderAppEnvFile(): string {
  return `APP_HOST=127.0.0.1
APP_PORT=3000
APP_START_COMMAND=
APP_ENV_FILE=../app/.env
`;
}

function renderStartScript(relativeConfigPath: string): string {
  const normalizedConfigPath = relativeConfigPath.split(path.sep).join("/");
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";

const child = spawn("bottle", ["start", "--config", new URL(${JSON.stringify(normalizedConfigPath)}, import.meta.url).pathname], {
  stdio: "inherit"
});

let stopping = false;
let childExited = false;
let forcedExit;

function stopChild(signal) {
  if (stopping) return;
  stopping = true;

  if (!childExited) child.kill(signal);
  forcedExit = setTimeout(() => {
    if (!childExited) child.kill("SIGKILL");
    process.exit(0);
  }, 5000);
  forcedExit.unref();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => stopChild(signal));
}

child.on("exit", (code, signal) => {
  childExited = true;
  if (forcedExit) clearTimeout(forcedExit);
  if (signal && !stopping) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
`;
}

function renderIntegrationDocs(input: {
  name: string;
  port: number;
  projectRoot: string;
  mainAppUrl?: string;
  configPath: string;
  envPath: string;
  appEnvPath: string;
  startScriptPath: string;
}): string {
  return `# Bottle Integration

Instance: ${input.name}

## Start

\`\`\`bash
node ${input.startScriptPath}
# or
bottle start --config ${input.configPath}
\`\`\`

## Generated Files

- \`${input.configPath}\` - typed config for this backend instance.
- \`${input.envPath}\` - Bottle env-file equivalent for process managers.
- \`${input.appEnvPath}\` - optional app launcher/env notes.
- \`${input.startScriptPath}\` - standalone start script.

## Frontend Proxy

Proxy the standard API to this instance:

\`\`\`txt
/v1/* -> http://127.0.0.1:${input.port}/v1/*
\`\`\`

Main app URL advertised to the AI client:

\`\`\`txt
${input.mainAppUrl ?? "(not configured)"}
\`\`\`

Use \`createClaudeClient({ baseUrl })\` from the copied Bottle client contract in AI tools. The configured project root is:

\`\`\`txt
${input.projectRoot}
\`\`\`

For multiple prototypes on the same VPS, repeat \`bottle init\` with a different \`--name\`, \`--port\`, and \`--project-root\`.
`;
}

function helpText(): string {
  return `Usage:
  bottle init --name prototype-a --copy-from /srv/prototype-a --main-app-url http://localhost:3000
  bottle start

Commands:
  init     Generate app/ and .bottle/ bundle files
  start    Start the standard /v1 Bottle server
`;
}

function writeLine(stream: Writable, text: string): void {
  stream.write(`${text}\n`);
}

function isEntrypoint(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const modulePath = fileURLToPath(metaUrl);
  const entryPath = path.resolve(entry);
  if (modulePath === entryPath || pathToFileURL(entryPath).href === metaUrl) return true;
  try {
    return fsSync.realpathSync(modulePath) === fsSync.realpathSync(entryPath);
  } catch {
    return false;
  }
}

if (isEntrypoint(import.meta.url)) {
  runCli().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}

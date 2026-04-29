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
  const projectRoot = path.resolve(options.cwd, flags.values.get("project-root") ?? ".");
  const outputDir = path.resolve(options.cwd, flags.values.get("output-dir") ?? ".");
  const force = flags.booleans.has("force");
  const bindHost = flags.values.get("bind-host") ?? "0.0.0.0";
  const allowedHostnames = parseCsv(flags.values.get("allowed-hostnames") ?? DEFAULT_ALLOWED_HOSTNAMES.join(","));
  const dataPrefix = `.data/claude-server/${name}`;
  const sessionDir = `${dataPrefix}/sessions`;
  const workspaceDir = `${dataPrefix}/workspaces`;
  const configPath = path.join(outputDir, "claude-server.config.mjs");
  const envPath = path.join(outputDir, `.env.claude-server.${name}`);
  const scriptsDir = path.join(outputDir, "scripts");
  const startScriptPath = path.join(scriptsDir, `start-claude-server-${name}.mjs`);
  const docsPath = path.join(outputDir, "CLAUDE_SERVER_INTEGRATION.md");

  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(scriptsDir, { recursive: true });
  await ensureCanWrite([configPath, envPath, startScriptPath, docsPath], force);

  await fs.writeFile(
    configPath,
    renderConfigFile({
      name,
      port,
      bindHost,
      projectRoot,
      allowedHostnames,
      sessionDir,
      workspaceDir
    }),
    "utf8"
  );
  await fs.writeFile(
    envPath,
    renderEnvFile({
      name,
      port,
      bindHost,
      projectRoot,
      allowedHostnames,
      sessionDir,
      workspaceDir
    }),
    "utf8"
  );
  await fs.writeFile(startScriptPath, renderStartScript(path.relative(scriptsDir, configPath)), "utf8");
  await fs.chmod(startScriptPath, 0o755);
  await fs.writeFile(
    docsPath,
    renderIntegrationDocs({
      name,
      port,
      projectRoot,
      configPath: path.relative(outputDir, configPath),
      envPath: path.relative(outputDir, envPath),
      startScriptPath: path.relative(outputDir, startScriptPath)
    }),
    "utf8"
  );

  writeLine(options.stdout, `Created Claude server integration for ${name}`);
  writeLine(options.stdout, `- ${path.relative(options.cwd, configPath)}`);
  writeLine(options.stdout, `- ${path.relative(options.cwd, envPath)}`);
  writeLine(options.stdout, `- ${path.relative(options.cwd, startScriptPath)}`);
  writeLine(options.stdout, `- ${path.relative(options.cwd, docsPath)}`);
}

async function startCommand(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdout: Writable }): Promise<void> {
  const flags = parseFlags(args);
  const configPath = flags.values.get("config");
  const config = configPath
    ? await loadConfigFromFile(path.resolve(options.cwd, configPath), options.env)
    : loadConfig(options.env, options.cwd);
  const running = await startClaudeServer(config, {
    onListen(info) {
      writeLine(options.stdout, `Claude server listening on http://${info.address}:${info.port}`);
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

function renderConfigFile(input: {
  name: string;
  port: number;
  bindHost: string;
  projectRoot: string;
  allowedHostnames: string[];
  sessionDir: string;
  workspaceDir: string;
}): string {
  return `import { defineClaudeServerConfig } from "claude-server/config";

export default defineClaudeServerConfig(${JSON.stringify(
    {
      name: input.name,
      port: input.port,
      bindHost: input.bindHost,
      projectRoot: input.projectRoot,
      allowedHostnames: input.allowedHostnames,
      sessionDir: input.sessionDir,
      workspaceDir: input.workspaceDir,
      maxConcurrentRuns: 4,
      maxTurns: 30,
      claudeModel: DEFAULT_MODEL
    },
    null,
    2
  )});
`;
}

function renderEnvFile(input: {
  name: string;
  port: number;
  bindHost: string;
  projectRoot: string;
  allowedHostnames: string[];
  sessionDir: string;
  workspaceDir: string;
}): string {
  return `CLAUDE_SERVER_INSTANCE=${input.name}
PORT=${input.port}
BIND_HOST=${input.bindHost}
ALLOWED_HOSTNAMES=${input.allowedHostnames.join(",")}
TRUST_PROXY=false
PROJECT_ROOT=${input.projectRoot}
SESSION_DIR=${input.sessionDir}
WORKSPACE_DIR=${input.workspaceDir}
CLAUDE_MODEL=${DEFAULT_MODEL}
MAX_CONCURRENT_RUNS=4
MAX_TURNS=30
MAX_BUDGET_USD=1
RUN_TIMEOUT_MS=600000
SANDBOX_ALLOWED_DOMAINS=api.anthropic.com,claude.ai,statsig.anthropic.com
SESSION_IDLE_TTL_MS=300000
`;
}

function renderStartScript(relativeConfigPath: string): string {
  const normalizedConfigPath = relativeConfigPath.split(path.sep).join("/");
  return `#!/usr/bin/env node
import { loadConfigFromFile } from "claude-server/config";
import { installShutdownHandlers, startClaudeServer } from "claude-server/server";

const config = await loadConfigFromFile(new URL(${JSON.stringify(normalizedConfigPath)}, import.meta.url));
const running = await startClaudeServer(config);
installShutdownHandlers(running);
`;
}

function renderIntegrationDocs(input: {
  name: string;
  port: number;
  projectRoot: string;
  configPath: string;
  envPath: string;
  startScriptPath: string;
}): string {
  return `# Claude Server Integration

Instance: ${input.name}

## Start

\`\`\`bash
node ${input.startScriptPath}
# or
claude-server start --config ${input.configPath}
\`\`\`

## Generated Files

- \`${input.configPath}\` - typed config for this backend instance.
- \`${input.envPath}\` - env-file equivalent for process managers.
- \`${input.startScriptPath}\` - standalone start script.

## Frontend Proxy

Proxy the standard API to this instance:

\`\`\`txt
/v1/* -> http://127.0.0.1:${input.port}/v1/*
\`\`\`

Use \`createClaudeClient({ baseUrl })\` from \`claude-server/client\` in AI tools. The configured project root is:

\`\`\`txt
${input.projectRoot}
\`\`\`

For multiple prototypes on the same VPS, repeat \`claude-server init\` with a different \`--name\`, \`--port\`, and \`--project-root\`.
`;
}

function helpText(): string {
  return `Usage:
  claude-server init --name prototype-a --port 3001 --project-root /srv/prototype-a
  claude-server start --config ./claude-server.config.mjs

Commands:
  init     Generate config, env, start script, and integration notes
  start    Start the standard /v1 Claude server
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

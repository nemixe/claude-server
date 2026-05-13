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
const DEFAULT_CLIENT_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_APP_DIR = "app";
const DEFAULT_BOTTLE_DIR = ".bottle";
const DEFAULT_MAIN_APP_URL = "http://localhost:3000";
const RUNTIME_DIR_NAME = "runtime";
const RUNTIME_SOURCE_ENV = "BOTTLE_RUNTIME_SOURCE_DIR";
const DISCOVERY_DIR_NAMES = ["agents", "commands", "rules", "skills"] as const;
const SKIPPED_COPY_SEGMENTS = new Set([".git", "node_modules", ".data"]);
const RUNTIME_LOCKFILE_NAMES = ["package-lock.json", "npm-shrinkwrap.json"] as const;

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
      await initCommand(args, { cwd, env, stdout, stderr });
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

async function initCommand(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdout: Writable; stderr: Writable }): Promise<void> {
  const flags = parseFlags(args);
  const name = normalizeInstanceName(flags.values.get("name") ?? "prototype");
  const port = parsePort(flags.values.get("port") ?? "3001");
  const bundleRoot = path.resolve(options.cwd, flags.values.get("output-dir") ?? ".");
  const bottleDir = path.resolve(bundleRoot, flags.values.get("bottle-dir") ?? DEFAULT_BOTTLE_DIR);
  const runtimeDir = path.join(bottleDir, RUNTIME_DIR_NAME);
  const appDir = path.resolve(bundleRoot, flags.values.get("app-dir") ?? DEFAULT_APP_DIR);
  const projectRoot = flags.values.has("project-root")
    ? path.resolve(options.cwd, flags.values.get("project-root") as string)
    : appDir;
  const copyFrom = flags.values.has("copy-from") ? path.resolve(options.cwd, flags.values.get("copy-from") as string) : undefined;
  const force = flags.booleans.has("force");
  const bindHost = flags.values.get("bind-host") ?? "0.0.0.0";
  const allowedHostnames = parseCsv(
    flags.values.get("allowed-hostnames") ?? DEFAULT_ALLOWED_HOSTNAMES.join(","),
    "allowed-hostnames"
  );
  const trustProxy = parseOptionalBooleanFlag(flags, "trust-proxy", false);
  const clientOrigins = parseCsv(
    flags.values.get("client-origins") ?? DEFAULT_CLIENT_ORIGINS.join(","),
    "client-origins"
  );
  const mainAppUrl = flags.values.get("main-app-url") ?? flags.values.get("app-url") ?? DEFAULT_MAIN_APP_URL;
  const clientAppUrl = flags.values.get("client-app-url");
  const mainAppProxy = hasOptionalBooleanFlag(flags, "main-app-proxy")
    ? parseOptionalBooleanFlag(flags, "main-app-proxy", true)
    : true;
  const mainAppDirect = hasOptionalBooleanFlag(flags, "main-app-direct")
    ? parseOptionalBooleanFlag(flags, "main-app-direct", false)
    : false;
  const vendorRuntime = !flags.booleans.has("no-vendor-runtime");
  const runtimeSourceRoot = runtimeSourceRootFromEnv(options.env);
  const projectRootConfigValue = relativePath(bottleDir, projectRoot);
  const sessionDir = relativePath(projectRoot, path.join(bottleDir, "sessions"));
  const configPath = path.join(bottleDir, "bottle.config.mjs");
  const scriptsDir = path.join(bottleDir, "scripts");
  const startScriptPath = path.join(scriptsDir, "start-bottle.mjs");
  const docsPath = path.join(bottleDir, "README.md");
  const pluginManifestPath = path.join(bottleDir, ".codex-plugin", "plugin.json");
  const discoveryDirs = DISCOVERY_DIR_NAMES.map((dirName) => path.join(bottleDir, dirName));

  await fs.mkdir(bundleRoot, { recursive: true });
  await prepareProjectRoot(projectRoot, copyFrom, force);
  await fs.mkdir(bottleDir, { recursive: true });
  await fs.mkdir(scriptsDir, { recursive: true });
  await ensureCanWrite([configPath, startScriptPath, docsPath, pluginManifestPath, ...(vendorRuntime ? [runtimeDir] : [])], force);
  await Promise.all([fs.mkdir(path.dirname(pluginManifestPath), { recursive: true }), ...discoveryDirs.map((dirPath) => fs.mkdir(dirPath, { recursive: true }))]);
  if (vendorRuntime) {
    await vendorBottleRuntime(runtimeSourceRoot, runtimeDir, force);
  }

  await fs.writeFile(
    configPath,
    renderConfigFile({
      name,
      port,
      bindHost,
      projectRoot: projectRootConfigValue,
      bottleDir: ".",
      allowedHostnames,
      trustProxy,
      clientOrigins,
      mainAppUrl,
      clientAppUrl,
      mainAppProxy,
      mainAppDirect,
      sessionDir
    }),
    "utf8"
  );
  await fs.writeFile(pluginManifestPath, renderBottlePluginManifest(name), "utf8");
  await fs.writeFile(
    startScriptPath,
    renderStartScript({
      configPath: path.relative(scriptsDir, configPath),
      runtimeCliPath: vendorRuntime ? path.relative(scriptsDir, path.join(runtimeDir, "dist", "cli.js")) : undefined
    }),
    "utf8"
  );
  await fs.chmod(startScriptPath, 0o755);
  await fs.writeFile(
    docsPath,
    renderIntegrationDocs({
      name,
      port,
      projectRoot: projectRootConfigValue,
      mainAppUrl,
      configPath: path.relative(bundleRoot, configPath),
      startScriptPath: path.relative(bundleRoot, startScriptPath),
      discoveryPaths: discoveryDirs.map((dirPath) => path.relative(bundleRoot, dirPath)),
      clientAppUrl,
      mainAppProxy,
      mainAppDirect,
      runtimePath: vendorRuntime ? path.relative(bundleRoot, runtimeDir) : undefined
    }),
    "utf8"
  );

  writeLine(options.stdout, `Created Bottle integration for ${name}`);
  writeLine(options.stdout, `- ${path.relative(options.cwd, configPath)}`);
  writeLine(options.stdout, `- ${path.relative(options.cwd, startScriptPath)}`);
  writeLine(options.stdout, `- ${path.relative(options.cwd, docsPath)}`);
  for (const dirPath of discoveryDirs) writeLine(options.stdout, `- ${path.relative(options.cwd, dirPath)}`);
  if (vendorRuntime) writeLine(options.stdout, `- ${path.relative(options.cwd, runtimeDir)}`);
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

function parseCsv(value: string, name: string): string[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error(`${name} must contain at least one value`);
  }
  return [...new Set(entries)];
}

function parseOptionalBooleanFlag(flags: ParsedFlags, name: string, fallback: boolean): boolean {
  if (flags.booleans.has(name)) return true;
  if (!flags.values.has(name)) return fallback;

  const value = flags.values.get(name);
  if (value === undefined || value === "") return fallback;
  if (/^(true|1|yes)$/i.test(value)) return true;
  if (/^(false|0|no)$/i.test(value)) return false;
  throw new Error(`${name} must be a boolean`);
}

function hasOptionalBooleanFlag(flags: ParsedFlags, name: string): boolean {
  return flags.booleans.has(name) || flags.values.has(name);
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
  return segments.some((segment) => SKIPPED_COPY_SEGMENTS.has(segment));
}

function runtimeSourceRootFromEnv(env: NodeJS.ProcessEnv): string {
  const override = env[RUNTIME_SOURCE_ENV];
  return override ? path.resolve(override) : currentPackageRoot();
}

function currentPackageRoot(): string {
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDir = path.dirname(modulePath);
  const parent = path.dirname(moduleDir);
  if (path.basename(moduleDir) === "dist" || path.basename(moduleDir) === "src") return parent;
  return moduleDir;
}

async function vendorBottleRuntime(sourceRoot: string, runtimeDir: string, force: boolean): Promise<void> {
  const distDir = path.join(sourceRoot, "dist");
  const packageJsonPath = path.join(sourceRoot, "package.json");
  const nodeModulesDir = path.join(sourceRoot, "node_modules");

  await assertRuntimeSourceFile(path.join(distDir, "cli.js"), "Bottle runtime requires dist/cli.js. Run `npm run build` before `bottle init` from a source checkout.");
  await assertRuntimeSourceFile(packageJsonPath, "Bottle runtime requires package.json.");

  if (force) await fs.rm(runtimeDir, { recursive: true, force: true });
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.cp(distDir, path.join(runtimeDir, "dist"), {
    recursive: true,
    force: true,
    dereference: true,
    filter: runtimeCopyFilter
  });
  await fs.copyFile(packageJsonPath, path.join(runtimeDir, "package.json"));
  await copyRuntimeMetadataFile(sourceRoot, runtimeDir, "README.md");
  await copyRuntimeLockfiles(sourceRoot, runtimeDir);

  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { dependencies?: Record<string, string> };
  const dependencyNames = Object.keys(packageJson.dependencies ?? {});
  if (dependencyNames.length === 0) return;

  await assertRuntimeSourceFile(nodeModulesDir, "Bottle runtime dependencies are not installed. Run `npm install` before `bottle init` from a source checkout.");
  await fs.mkdir(path.join(runtimeDir, "node_modules"), { recursive: true });

  const copied = new Set<string>();
  for (const dependencyName of dependencyNames) {
    await copyRuntimeDependency(dependencyName, sourceRoot, sourceRoot, runtimeDir, copied);
  }
}

async function assertRuntimeSourceFile(filePath: string, message: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(message);
  }
}

async function copyRuntimeMetadataFile(sourceRoot: string, runtimeDir: string, filename: string): Promise<void> {
  try {
    await fs.copyFile(path.join(sourceRoot, filename), path.join(runtimeDir, filename));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

async function copyRuntimeLockfiles(sourceRoot: string, runtimeDir: string): Promise<void> {
  for (const filename of RUNTIME_LOCKFILE_NAMES) {
    await copyRuntimeMetadataFile(sourceRoot, runtimeDir, filename);
  }
}

async function copyRuntimeDependency(
  dependencyName: string,
  importerDir: string,
  sourceRoot: string,
  runtimeDir: string,
  copied: Set<string>
): Promise<void> {
  const dependencyDir = await findInstalledDependencyDir(dependencyName, importerDir);
  if (!dependencyDir) return;

  const realDependencyDir = await fs.realpath(dependencyDir);
  if (copied.has(realDependencyDir)) return;
  copied.add(realDependencyDir);

  const relativeDependencyDir = path.relative(sourceRoot, dependencyDir);
  if (relativeDependencyDir.startsWith("..") || path.isAbsolute(relativeDependencyDir)) return;

  const targetDir = path.join(runtimeDir, relativeDependencyDir);
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(dependencyDir, targetDir, {
    recursive: true,
    force: true,
    dereference: true,
    filter: runtimeCopyFilter
  });

  const packageJsonPath = path.join(dependencyDir, "package.json");
  let dependencyPackage: { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
  try {
    dependencyPackage = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  } catch {
    return;
  }

  const childDependencies = Object.keys({
    ...(dependencyPackage.dependencies ?? {}),
    ...(dependencyPackage.optionalDependencies ?? {})
  });
  for (const childDependencyName of childDependencies) {
    await copyRuntimeDependency(childDependencyName, dependencyDir, sourceRoot, runtimeDir, copied);
  }
}

async function findInstalledDependencyDir(dependencyName: string, importerDir: string): Promise<string | undefined> {
  let directory = importerDir;
  while (true) {
    const candidate = path.join(directory, "node_modules", ...dependencyName.split("/"));
    try {
      const stat = await fs.stat(path.join(candidate, "package.json"));
      if (stat.isFile()) return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }

    const next = path.dirname(directory);
    if (next === directory) return undefined;
    directory = next;
  }
}

function runtimeCopyFilter(sourcePath: string): boolean {
  const name = path.basename(sourcePath);
  if (name === ".git" || name === ".cache" || name === ".DS_Store") return false;
  if (name === "test" || name === "tests" || name === "__tests__" || name === "coverage") return false;
  if (sourcePath.endsWith(".map")) return false;
  return true;
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
  bottleDir: string;
  allowedHostnames: string[];
  trustProxy: boolean;
  clientOrigins: string[];
  mainAppUrl?: string;
  clientAppUrl?: string;
  mainAppProxy?: boolean;
  mainAppDirect?: boolean;
  sessionDir: string;
}): string {
  const config: Record<string, unknown> = {
    bottleName: input.name,
    port: input.port,
    bindHost: input.bindHost,
    projectRoot: input.projectRoot,
    bottleDir: input.bottleDir,
    allowedHostnames: input.allowedHostnames,
    trustProxy: input.trustProxy,
    clientOrigins: input.clientOrigins,
    ...(input.mainAppUrl ? { mainAppUrl: input.mainAppUrl } : {}),
    ...(input.clientAppUrl ? { clientAppUrl: input.clientAppUrl } : {}),
    ...(input.mainAppProxy !== undefined ? { mainAppProxy: input.mainAppProxy } : {}),
    ...(input.mainAppDirect !== undefined ? { mainAppDirect: input.mainAppDirect } : {}),
    sessionDir: input.sessionDir,
    claudeModel: DEFAULT_MODEL
  };

  return `export default ${JSON.stringify(config, null, 2)};
`;
}

function renderBottlePluginManifest(name: string): string {
  return `${JSON.stringify(
    {
      name: `${name}-bottle`,
      version: "0.1.0",
      description: "Bottle-local agent discovery for commands, rules, agents, and skills.",
      author: {
        name: "Bottle"
      },
      license: "UNLICENSED",
      agents: "./agents/",
      commands: "./commands/",
      skills: "./skills/",
      interface: {
        displayName: "Bottle Local Discovery",
        shortDescription: "Project-local Bottle agent context",
        longDescription: "Loads Bottle-local commands, agents, rules, and skills from the generated .bottle folder.",
        developerName: "Bottle",
        category: "Coding",
        capabilities: ["Interactive", "Write"],
        defaultPrompt: ["Use the Bottle-local discovery folders for this project."]
      }
    },
    null,
    2
  )}\n`;
}

function renderStartScript(input: { configPath: string; runtimeCliPath?: string }): string {
  const normalizedConfigPath = input.configPath.split(path.sep).join("/");
  const normalizedRuntimeCliPath = input.runtimeCliPath?.split(path.sep).join("/");
  const childSpawn = normalizedRuntimeCliPath
    ? `const runtimeDir = fileURLToPath(new URL("../runtime/", import.meta.url));
const runtimeCliPath = fileURLToPath(new URL(${JSON.stringify(normalizedRuntimeCliPath)}, import.meta.url));

ensureRuntimeDependencies(runtimeDir);

const child = spawn(process.execPath, [runtimeCliPath, "start", "--config", configPath], {
  stdio: "inherit"
});`
    : `const child = spawn("bottle", ["start", "--config", configPath], {
  stdio: "inherit"
});`;
  return `#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configPath = fileURLToPath(new URL(${JSON.stringify(normalizedConfigPath)}, import.meta.url));
${childSpawn}

function ensureRuntimeDependencies(runtimeDir) {
  const dependencyNames = getRuntimeDependencyNames(runtimeDir);
  const missingDependencies = dependencyNames.filter((dependencyName) => !fs.existsSync(packageManifestPath(runtimeDir, dependencyName)));
  if (missingDependencies.length === 0) return;

  console.error(\`[bottle] Installing missing runtime dependencies: \${missingDependencies.join(", ")}\`);
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: runtimeDir,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_update_notifier: "false"
    }
  });

  if (result.error) {
    console.error(\`[bottle] Failed to install runtime dependencies: \${result.error.message}\`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function getRuntimeDependencyNames(runtimeDir) {
  const packageJsonPath = path.join(runtimeDir, "package.json");
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return Object.keys(packageJson.dependencies ?? {});
  } catch (error) {
    console.error(\`[bottle] Failed to read runtime package.json: \${error instanceof Error ? error.message : "unknown error"}\`);
    process.exit(1);
  }
}

function packageManifestPath(runtimeDir, packageName) {
  return path.join(runtimeDir, "node_modules", ...packageName.split("/"), "package.json");
}

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
  clientAppUrl?: string;
  mainAppProxy?: boolean;
  mainAppDirect?: boolean;
  configPath: string;
  startScriptPath: string;
  discoveryPaths: string[];
  runtimePath?: string;
}): string {
  const startCommand = input.runtimePath
    ? `node ${input.startScriptPath}`
    : `node ${input.startScriptPath}
# or
bottle start --config ${input.configPath}`;
  const runtimeDescription = input.runtimePath
    ? `- \`${input.runtimePath}\` - vendored Bottle runtime used by the start script.`
    : "- Runtime is not vendored; this bundle expects `bottle` to be available on PATH.";
  const discoveryDescription = input.discoveryPaths
    .map((dirPath) => `- \`${dirPath}\` - Bottle-local ${path.basename(dirPath)} discovery folder.`)
    .join("\n");
  const mainAppProxyDescription = input.mainAppProxy === false
    ? `This bundle is configured for API-only host mode. Keep the host app serving its own root routes from \`${input.mainAppUrl ?? "(not configured)"}\`, and proxy only \`/v1/*\` plus \`/bottle-bridge.js\` to Bottle. If the iframe needs live page context in this mode, the app must include \`/bottle-bridge.js\` itself.`
    : input.mainAppDirect === false
      ? `This bundle is configured for the recommended AI iframe proxy mode. Keep normal users on the main app URL \`${input.mainAppUrl ?? "(not configured)"}\`. Point AI iframe sessions at the \`appProxyUrl\` returned by \`GET /v1/bottle\` (or \`/__app/*\`) so Bottle can inject \`/bottle-bridge.js\` without proxying normal user traffic.`
      : `This bundle is configured for single-origin demo mode. Bottle can serve AI Client at root and route main-app root traffic through Bottle after the \`bottle_target_app_url\` cookie is set; avoid this mode for normal production user traffic.`;
  const proxyPathLines = [
    `/v1/* -> http://127.0.0.1:${input.port}/v1/*`,
    `/bottle-bridge.js -> http://127.0.0.1:${input.port}/bottle-bridge.js`,
    ...(input.mainAppProxy === false ? [] : [`/__app/* -> http://127.0.0.1:${input.port}/__app/* (AI iframe proxy mode)`])
  ].join("\n");

  return `# Bottle Integration

Instance: ${input.name}

## Start

\`\`\`bash
${startCommand}
\`\`\`

## Generated Files

- \`${input.configPath}\` - customize this backend instance here.
- \`${input.startScriptPath}\` - standalone start script.
${discoveryDescription}
${runtimeDescription}

Use \`${input.configPath}\` for local customization such as ports, project paths, the main app URL, model selection, auth settings, and extra Codex skill roots via \`extraSkillRoots\`.

The generated start script only requires Node.js. It does not require a global Bottle install unless this bundle was created with \`--no-vendor-runtime\`.

Codex skill discovery uses a compact manifest from \`.bottle/skills\` plus any configured \`extraSkillRoots\`; local skills take precedence when names collide.

## Frontend Proxy

Proxy the standard API and bridge paths to this instance:

\`\`\`txt
${proxyPathLines}
\`\`\`

${mainAppProxyDescription}

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
  bottle init --name prototype-a --allowed-hostnames prototype.example.com,localhost --client-origins https://prototype.example.com --trust-proxy
  bottle start

Commands:
  init     Generate app/ and .bottle/ bundle files
  start    Start the standard /v1 Bottle server

Init options:
  --no-vendor-runtime   Generate a lightweight bundle that expects a global bottle command
  --allowed-hostnames   Comma-separated browser-facing hosts allowed to call Bottle
  --client-origins      Comma-separated browser origins allowed for AI Client/CORS/frame access
  --client-app-url      Internal AI Client URL for optional Bottle root gateway mode
  --main-app-proxy      Enable/disable Bottle AI iframe/root proxy mode
  --main-app-direct     Enable single-origin demo routing through Bottle root
  --trust-proxy         Trust X-Forwarded-Host when Bottle runs behind nginx/Cloudflare
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

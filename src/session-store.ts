import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import type { ClaudeCommand, ClaudeCommandInput, ClaudeMode, SessionMetadata, UploadedFile, WorkspaceSearchResult } from "./types.js";

const CLAUDE_COMMANDS_DIR = ".claude/commands";
const DEFAULT_WORKSPACE_SEARCH_LIMIT = 50;
const MAX_WORKSPACE_SEARCH_LIMIT = 200;
const PROJECT_SEARCH_IGNORED_DIRS = new Set([".data", ".git", "dist", "node_modules"]);

export type CreateSessionInput = {
  mode: ClaudeMode;
  title?: string;
  files?: UploadedFile[];
};

export class SessionStore {
  constructor(private readonly config: AppConfig) {}

  async create(input: CreateSessionInput): Promise<SessionMetadata> {
    await this.ensureBaseDirs();

    const id = randomUUID();
    const now = new Date().toISOString();
    const workspacePath = path.join(this.config.workspaceDir, id);
    await fs.mkdir(workspacePath, { recursive: true });

    const metadata: SessionMetadata = {
      id,
      title: input.title,
      mode: input.mode,
      workspacePath,
      createdAt: now,
      updatedAt: now,
      hasRun: false
    };

    await this.writeUploadedFiles(workspacePath, input.files ?? []);
    await this.syncSharedClaudeCommandsToWorkspace(workspacePath);
    await this.save(metadata);
    return metadata;
  }

  async list(): Promise<SessionMetadata[]> {
    await fs.mkdir(this.config.sessionDir, { recursive: true });
    const entries = await fs.readdir(this.config.sessionDir, { withFileTypes: true });
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => this.readMetadata(path.join(this.config.sessionDir, entry.name)))
    );

    return sessions
      .filter((session): session is SessionMetadata => Boolean(session))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(id: string): Promise<SessionMetadata | undefined> {
    return this.readMetadata(this.metadataPath(id));
  }

  async save(metadata: SessionMetadata): Promise<void> {
    await fs.mkdir(this.config.sessionDir, { recursive: true });
    const updated: SessionMetadata = {
      ...metadata,
      updatedAt: new Date().toISOString()
    };
    await fs.writeFile(this.metadataPath(updated.id), `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  }

  async markRun(id: string): Promise<void> {
    const metadata = await this.get(id);
    if (!metadata) return;
    await this.save({ ...metadata, hasRun: true });
  }

  async addCost(id: string, costUsd: number): Promise<void> {
    if (!Number.isFinite(costUsd) || costUsd <= 0) return;
    const metadata = await this.get(id);
    if (!metadata) return;
    const next = (metadata.costUsd ?? 0) + costUsd;
    await this.save({ ...metadata, costUsd: next });
  }

  async update(id: string, patch: { title?: string; mode?: ClaudeMode }): Promise<SessionMetadata | undefined> {
    const metadata = await this.get(id);
    if (!metadata) return undefined;
    const next: SessionMetadata = {
      ...metadata,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {})
    };
    await this.save(next);
    return next;
  }

  async delete(id: string): Promise<boolean> {
    const metadata = await this.get(id);
    if (!metadata) return false;

    await Promise.allSettled([
      fs.rm(this.metadataPath(id), { force: true }),
      fs.rm(metadata.workspacePath, { recursive: true, force: true })
    ]);

    return true;
  }

  async listSharedClaudeCommands(): Promise<ClaudeCommand[]> {
    const commandsPath = this.config.claudeCommandsDir;
    const files = await listMarkdownFiles(commandsPath);
    const commands = await Promise.all(
      files.map(async (relativePath) => this.readClaudeCommandFile(commandsPath, relativePath))
    );

    return commands
      .filter((command): command is ClaudeCommand => Boolean(command))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async readSharedClaudeCommand(commandPath: string): Promise<ClaudeCommand | undefined> {
    const relativePath = sanitizeClaudeCommandPath(commandPath);
    return this.readClaudeCommandFile(this.config.claudeCommandsDir, relativePath);
  }

  async saveSharedClaudeCommand(command: ClaudeCommandInput): Promise<ClaudeCommand> {
    const relativePath = sanitizeClaudeCommandPath(command.path);
    const targetPath = path.join(this.config.claudeCommandsDir, relativePath);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, command.content, "utf8");
    await this.syncSharedClaudeCommandsToAllWorkspaces(relativePath);

    const saved = await this.readClaudeCommandFile(this.config.claudeCommandsDir, relativePath);
    if (!saved) throw new Error(`Could not save Claude command: ${relativePath}`);
    return saved;
  }

  async deleteSharedClaudeCommand(commandPath: string): Promise<boolean> {
    const relativePath = sanitizeClaudeCommandPath(commandPath);
    const targetPath = path.join(this.config.claudeCommandsDir, relativePath);

    let deleted = false;
    try {
      const stat = await fs.stat(targetPath);
      if (!stat.isFile()) return false;
      await fs.rm(targetPath, { force: true });
      await pruneEmptyParents(path.dirname(targetPath), this.config.claudeCommandsDir);
      deleted = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }

    if (!deleted) return false;

    const sessions = await this.list();
    await Promise.all(
      sessions.map(async (session) => {
        const workspaceTargetPath = path.join(session.workspacePath, CLAUDE_COMMANDS_DIR, relativePath);
        try {
          await fs.rm(workspaceTargetPath, { force: true });
          await pruneEmptyParents(path.dirname(workspaceTargetPath), path.join(session.workspacePath, CLAUDE_COMMANDS_DIR));
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") throw error;
        }
      })
    );

    return true;
  }

  private async syncSharedClaudeCommandsToAllWorkspaces(relativePath: string): Promise<void> {
    const sessions = await this.list();
    await Promise.all(
      sessions.map((session) => this.syncSharedClaudeCommandsToWorkspace(session.workspacePath, relativePath))
    );
  }

  async searchProjectFiles(query: string, limit = DEFAULT_WORKSPACE_SEARCH_LIMIT): Promise<WorkspaceSearchResult[]> {
    const normalizedQuery = normalizeSearchValue(query);
    const boundedLimit = Math.min(Math.max(limit, 1), MAX_WORKSPACE_SEARCH_LIMIT);

    const entries = await listSearchEntries(this.config.projectRoot, {
      ignoredDirectoryNames: PROJECT_SEARCH_IGNORED_DIRS,
      ignoredRootPaths: [this.config.workspaceDir, this.config.sessionDir]
    });
    if (!normalizedQuery) {
      return entries
        .map((entry) => ({ ...entry, score: 0 }))
        .sort((left, right) => left.path.localeCompare(right.path))
        .slice(0, boundedLimit);
    }

    return entries
      .map((entry) => {
        const score = fuzzyScore(normalizedQuery, normalizeSearchValue(entry.path));
        if (score === undefined) return undefined;
        return { ...entry, score };
      })
      .filter((entry): entry is WorkspaceSearchResult => Boolean(entry))
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, boundedLimit);
  }

  private async ensureBaseDirs(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.config.workspaceDir, { recursive: true }),
      fs.mkdir(this.config.sessionDir, { recursive: true })
    ]);
  }

  private async readMetadata(filePath: string): Promise<SessionMetadata | undefined> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw) as SessionMetadata;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      throw error;
    }
  }

  private metadataPath(id: string): string {
    return path.join(this.config.sessionDir, `${id}.json`);
  }

  private async writeUploadedFiles(workspacePath: string, files: UploadedFile[]): Promise<void> {
    await Promise.all(
      files.map(async (file) => {
        const relativePath = sanitizeWorkspaceRelativePath(file.path);
        const targetPath = path.join(workspacePath, relativePath);
        const content =
          file.contentBase64 !== undefined ? Buffer.from(file.contentBase64, "base64") : Buffer.from(file.content ?? "", "utf8");

        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, content);
      })
    );
  }

  private async syncSharedClaudeCommandsToWorkspace(workspacePath: string, onlyRelativePath?: string): Promise<void> {
    const files = onlyRelativePath ? [sanitizeClaudeCommandPath(onlyRelativePath)] : await listMarkdownFiles(this.config.claudeCommandsDir);

    await Promise.all(
      files.map(async (relativePath) => {
        const sourcePath = path.join(this.config.claudeCommandsDir, relativePath);
        const targetPath = path.join(workspacePath, CLAUDE_COMMANDS_DIR, relativePath);
        const content = await fs.readFile(sourcePath, "utf8");
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, content, "utf8");
      })
    );
  }

  private async readClaudeCommandFile(rootPath: string, relativePath: string): Promise<ClaudeCommand | undefined> {
    const targetPath = path.join(rootPath, relativePath);

    try {
      const [content, stat] = await Promise.all([fs.readFile(targetPath, "utf8"), fs.stat(targetPath)]);
      if (!stat.isFile()) return undefined;
      return {
        path: relativePath,
        content,
        updatedAt: stat.mtime.toISOString()
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      throw error;
    }
  }
}

export function sanitizeWorkspaceRelativePath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === ".." || path.isAbsolute(normalized)) {
    throw new Error(`Invalid workspace file path: ${value}`);
  }
  return normalized;
}

export function sanitizeClaudeCommandPath(value: string): string {
  const normalized = sanitizeWorkspaceRelativePath(value);
  const withoutPrefix = normalized.startsWith(`${CLAUDE_COMMANDS_DIR}/`)
    ? normalized.slice(CLAUDE_COMMANDS_DIR.length + 1)
    : normalized;

  if (
    !withoutPrefix ||
    withoutPrefix === "." ||
    withoutPrefix.startsWith("../") ||
    withoutPrefix === ".." ||
    withoutPrefix.includes("\0") ||
    path.posix.basename(withoutPrefix).startsWith(".") ||
    !withoutPrefix.endsWith(".md")
  ) {
    throw new Error(`Invalid Claude command path: ${value}`);
  }

  return withoutPrefix;
}

async function listMarkdownFiles(root: string, current: string = root): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) return listMarkdownFiles(root, entryPath);
      if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
      return [path.relative(root, entryPath).replaceAll(path.sep, "/")];
    })
  );

  return files.flat();
}

async function listSearchEntries(
  root: string,
  options: {
    ignoredDirectoryNames?: Set<string>;
    ignoredRootPaths?: string[];
  } = {},
  current: string = root
): Promise<Omit<WorkspaceSearchResult, "score">[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }

  const results = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) return [];
      if (entry.isDirectory() && shouldIgnoreSearchDirectory(entryPath, entry.name, options)) return [];

      const relativePath = path.relative(root, entryPath).replaceAll(path.sep, "/");
      const stat = await fs.stat(entryPath);
      const result: Omit<WorkspaceSearchResult, "score"> = {
        path: relativePath,
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
        ...(entry.isFile() ? { size: stat.size } : {}),
        updatedAt: stat.mtime.toISOString()
      };

      if (!entry.isDirectory()) return [result];
      return [result, ...(await listSearchEntries(root, options, entryPath))];
    })
  );

  return results.flat();
}

function shouldIgnoreSearchDirectory(
  entryPath: string,
  entryName: string,
  options: {
    ignoredDirectoryNames?: Set<string>;
    ignoredRootPaths?: string[];
  }
): boolean {
  if (options.ignoredDirectoryNames?.has(entryName)) return true;

  const normalizedEntryPath = path.resolve(entryPath);
  return Boolean(options.ignoredRootPaths?.some((ignoredPath) => path.resolve(ignoredPath) === normalizedEntryPath));
}

function normalizeSearchValue(value: string): string {
  return value.trim().toLowerCase().replaceAll("\\", "/");
}

function fuzzyScore(query: string, value: string): number | undefined {
  if (value.includes(query)) {
    const start = value.indexOf(query);
    return 10_000 - start * 10 - Math.max(0, value.length - query.length);
  }

  let queryIndex = 0;
  let score = 0;
  let previousMatch = -1;
  for (let valueIndex = 0; valueIndex < value.length && queryIndex < query.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) continue;

    score += previousMatch === valueIndex - 1 ? 25 : 10;
    if (valueIndex === 0 || value[valueIndex - 1] === "/" || value[valueIndex - 1] === "-" || value[valueIndex - 1] === "_") {
      score += 15;
    }
    previousMatch = valueIndex;
    queryIndex += 1;
  }

  if (queryIndex !== query.length) return undefined;
  return score - value.length;
}

async function pruneEmptyParents(current: string, stopAt: string): Promise<void> {
  if (current === stopAt || !current.startsWith(stopAt)) return;

  try {
    await fs.rmdir(current);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTEMPTY") return;
    throw error;
  }

  await pruneEmptyParents(path.dirname(current), stopAt);
}

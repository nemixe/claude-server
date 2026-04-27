import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import type { ClaudeMode, SessionMetadata, UploadedFile } from "./types.js";

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

  async delete(id: string): Promise<boolean> {
    const metadata = await this.get(id);
    if (!metadata) return false;

    await Promise.allSettled([
      fs.rm(this.metadataPath(id), { force: true }),
      fs.rm(metadata.workspacePath, { recursive: true, force: true })
    ]);

    return true;
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
}

export function sanitizeWorkspaceRelativePath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === ".." || path.isAbsolute(normalized)) {
    throw new Error(`Invalid workspace file path: ${value}`);
  }
  return normalized;
}

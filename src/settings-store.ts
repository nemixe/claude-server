import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { AGENT_PROVIDERS, type AgentProvider } from "./types.js";

export type PersistedSettings = {
  maxConcurrentRuns: number;
  maxTurns: number;
  defaultAgentProvider: AgentProvider;
};

export class SettingsStore {
  private readonly filePath: string;
  private cache: PersistedSettings | undefined;

  constructor(private readonly config: AppConfig) {
    this.filePath = path.join(config.sessionDir, "settings.json");
  }

  async load(): Promise<PersistedSettings> {
    if (this.cache) return this.cache;

    const defaults: PersistedSettings = {
      maxConcurrentRuns: this.config.maxConcurrentRuns,
      maxTurns: this.config.maxTurns,
      defaultAgentProvider: this.config.defaultAgentProvider
    };

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
      this.cache = {
        maxConcurrentRuns: Number.isInteger(parsed.maxConcurrentRuns) && parsed.maxConcurrentRuns! >= 1
          ? parsed.maxConcurrentRuns!
          : defaults.maxConcurrentRuns,
        maxTurns: Number.isInteger(parsed.maxTurns) && parsed.maxTurns! >= 1
          ? parsed.maxTurns!
          : defaults.maxTurns,
        defaultAgentProvider: isAgentProvider(parsed.defaultAgentProvider)
          ? parsed.defaultAgentProvider
          : defaults.defaultAgentProvider
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        this.cache = defaults;
      } else {
        throw error;
      }
    }

    return this.cache;
  }

  async save(patch: Partial<PersistedSettings>): Promise<PersistedSettings> {
    const current = await this.load();
    this.cache = {
      maxConcurrentRuns: patch.maxConcurrentRuns ?? current.maxConcurrentRuns,
      maxTurns: patch.maxTurns ?? current.maxTurns,
      defaultAgentProvider: patch.defaultAgentProvider ?? current.defaultAgentProvider
    };

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(this.cache, null, 2)}\n`, "utf8");
    return this.cache;
  }
}

function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === "string" && (AGENT_PROVIDERS as readonly string[]).includes(value);
}

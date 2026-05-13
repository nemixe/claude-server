import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSessionMessages, type AgentDefinition, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  Codex,
  type CodexOptions,
  type Input as CodexInput,
  type ModelReasoningEffort,
  type SandboxMode,
  type ThreadEvent,
  type ThreadOptions
} from "@openai/codex-sdk";
import type { AppConfig } from "./config.js";
import { buildSafeAgentEnv } from "./sandbox.js";
import {
  createSessionFactory,
  MissingClaudeSessionIdError,
  SessionPool,
  type SessionFactory,
  type SessionLike,
  type SessionOptions
} from "./session-adapter.js";
import type { AgentProvider, AgentStatus, ClaudeMode, NormalizedAgentEvent, PendingInterrupt, SessionMetadata, StreamMessageRequest } from "./types.js";

export type AgentPrompt = string | AsyncIterable<SDKUserMessage>;

export type AgentSdkAdapter = {
  getSessionMessages: (sessionId: string, options?: { dir?: string; limit?: number; offset?: number }) => Promise<unknown[]>;
};

export type AgentRunInput = {
  session: SessionMetadata;
  request: StreamMessageRequest;
  signal?: AbortSignal;
  onAgentSessionId?: (agentSessionId: string) => void | Promise<void>;
  onClaudeSessionId?: (claudeSessionId: string) => void | Promise<void>;
};

export type CodexThreadLike = {
  readonly id: string | null;
  runStreamed: (input: CodexInput, options?: { signal?: AbortSignal }) => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
};

export type CodexSdkAdapter = {
  startThread: (options?: ThreadOptions) => CodexThreadLike;
  resumeThread: (id: string, options?: ThreadOptions) => CodexThreadLike;
};

export type CodexSdkFactory = (options: CodexOptions) => CodexSdkAdapter;

export type ToolCallRecord = {
  id: string;
  name: string;
  input: unknown;
};

type ToolLedgerEntry = {
  toolName: string;
  status: "pending" | "completed" | "interrupted" | "failed";
  attempts: number;
  input: unknown;
  interrupt?: PendingInterrupt;
};

type ToolLedger = Map<string, ToolLedgerEntry>;

export type ToolOutcome =
  | { kind: "success"; content: unknown }
  | { kind: "control"; control: ControlSignal }
  | { kind: "validation_error"; message: string }
  | { kind: "real_error"; message: string; retryable: boolean };

export const MAX_CONSECUTIVE_VALIDATION_ERRORS = 3;

const TOOL_USE_ERROR_PATTERN = /<tool_use_error>([\s\S]*?)<\/tool_use_error>/i;
const BOTTLE_RULE_FILE_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const BOTTLE_AGENT_FILE_EXTENSIONS = new Set([".json", ".md"]);
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SKILL_RESOURCE_DIR_NAMES = ["references", "scripts", "assets"] as const;
const BOTTLE_CONFIG_ONLY_NOTICE =
  "Bottle configuration and discovery are provided from `.bottle` and configured extra skill roots. Treat that Bottle context as the authoritative project guidance for this request.";

export type ControlSignal =
  | {
      type: "user_input_required";
      prompt: string;
      questions: unknown;
      toolCallId: string;
    }
  | {
      type: "approval_required";
      action: "exit_plan_mode";
      prompt: string;
      plan: unknown;
      toolCallId: string;
    };

type ActiveRunHandle = {
  close: () => void;
  interrupt?: () => Promise<void>;
};

type RunAbortReason = "timeout" | "interrupted" | "closed" | "disposed" | "client_disconnected";

type ActiveRun = {
  handle: ActiveRunHandle;
  abortController: AbortController;
  abortReason?: RunAbortReason;
  abort: (reason: RunAbortReason) => void;
  observers: Set<EventQueue<NormalizedAgentEvent>>;
  closeOnFinish: boolean;
  closeOnError: boolean;
};

export const defaultAgentSdkAdapter: AgentSdkAdapter = {
  getSessionMessages: (sessionId, options) => getSessionMessages(sessionId, options) as Promise<unknown[]>
};

export const defaultCodexSdkFactory: CodexSdkFactory = (options) => new Codex(options);

export class ConcurrencyLimitError extends Error {
  constructor() {
    super("Too many active Claude runs");
    this.name = "ConcurrencyLimitError";
  }
}

export class ValidationErrorLimitError extends Error {
  readonly code = "tool_validation_limit";
  constructor(
    public readonly toolName: string,
    public readonly attempts: number,
    public readonly lastMessage: string
  ) {
    super(`Tool ${toolName} failed input validation ${attempts} times in a row`);
    this.name = "ValidationErrorLimitError";
  }
}

export class RunTimeoutError extends Error {
  readonly code = "run_timeout";

  constructor(public readonly timeoutMs: number) {
    super(`Agent run timed out after ${formatDuration(timeoutMs)}`);
    this.name = "RunTimeoutError";
  }
}

export class RunAbortedError extends Error {
  readonly code: "run_interrupted" | "run_closed" | "run_disposed" | "client_disconnected";

  constructor(public readonly reason: Exclude<RunAbortReason, "timeout">) {
    super(messageForAbortReason(reason));
    this.name = "RunAbortedError";
    this.code = codeForAbortReason(reason);
  }
}

export class AgentService {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly pool: SessionPool;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private maxConcurrentRuns: number;
  private maxTurns: number;

  constructor(
    private readonly config: AppConfig,
    private readonly adapter: AgentSdkAdapter = defaultAgentSdkAdapter,
    sessionFactory: SessionFactory = createSessionFactory(),
    private readonly codexFactory: CodexSdkFactory = defaultCodexSdkFactory
  ) {
    this.maxConcurrentRuns = config.maxConcurrentRuns;
    this.maxTurns = config.maxTurns;
    this.pool = new SessionPool(sessionFactory, { idleTtlMs: config.sessionIdleTtlMs });
    const timer = setInterval(() => this.pool.cleanupIdle(), Math.min(config.sessionIdleTtlMs, 60_000));
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
    this.cleanupTimer = timer;
  }

  getMaxConcurrentRuns(): number {
    return this.maxConcurrentRuns;
  }

  setMaxConcurrentRuns(value: number): void {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error("maxConcurrentRuns must be a positive integer");
    }
    this.maxConcurrentRuns = value;
  }

  getMaxTurns(): number {
    return this.maxTurns;
  }

  setMaxTurns(value: number): void {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error("maxTurns must be a positive integer");
    }
    this.maxTurns = value;
  }

  async *stream(input: AgentRunInput): AsyncGenerator<NormalizedAgentEvent> {
    if (this.activeRuns.has(input.session.id) || this.activeRuns.size >= this.maxConcurrentRuns) {
      throw new ConcurrencyLimitError();
    }

    const abortController = new AbortController();
    let activeRun: ActiveRun | undefined;
    let timedOut = false;
    let completed = false;
    const abortRun = (reason: RunAbortReason) => {
      if (activeRun && !activeRun.abortReason) activeRun.abortReason = reason;
      if (!abortController.signal.aborted) {
        abortController.abort(reason);
      }
    };
    const onInputAbort = () => {
      abortRun("client_disconnected");
      try {
        activeRun?.handle.close();
      } catch {
        // The stream error path should report the abort reason, not a secondary close failure.
      }
    };
    input.signal?.addEventListener("abort", onInputAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      abortRun("timeout");
      try {
        activeRun?.handle.close();
      } catch {
        // The timeout path should report the timeout, not a secondary close failure.
      }
    }, this.config.runTimeoutMs);

    try {
      const register = (handle: ActiveRunHandle, options: { closeOnFinish: boolean; closeOnError: boolean }): ActiveRun => {
        activeRun = {
          handle,
          abortController,
          abort: abortRun,
          observers: new Set(),
          closeOnFinish: options.closeOnFinish,
          closeOnError: options.closeOnError
        };
        this.activeRuns.set(input.session.id, activeRun);
        return activeRun;
      };

      if (agentProviderForSession(this.config, input.session) === "codex") {
        yield* this.streamWithCodex(input, register);
      } else {
        yield* this.streamWithSession(input, register);
      }
      completed = true;
      if (timedOut) {
        throw new RunTimeoutError(this.config.runTimeoutMs);
      }
    } catch (error) {
      const effectiveError = errorForRunFailure(error, activeRun?.abortReason, this.config.runTimeoutMs, timedOut);
      if (activeRun) {
        if (activeRun.closeOnError) activeRun.handle.close();
        broadcastEvent(activeRun, {
          type: "error",
          data: { error: { code: errorCode(effectiveError), message: errorMessage(effectiveError) } }
        });
      }
      throw effectiveError;
    } finally {
      input.signal?.removeEventListener("abort", onInputAbort);
      clearTimeout(timeout);
      if (!completed) activeRun?.abort(activeRun.abortReason ?? "closed");
      if (activeRun?.closeOnFinish || !completed) activeRun?.handle.close();
      this.pool.markRunning(input.session.id, false);
      this.activeRuns.delete(input.session.id);
      if (activeRun) closeObservers(activeRun);
    }
  }

  observe(sessionId: string): { running: boolean; events: AsyncIterable<NormalizedAgentEvent> } {
    const active = this.activeRuns.get(sessionId);
    if (!active) {
      return {
        running: false,
        events: emptyEvents()
      };
    }

    const queue = new EventQueue<NormalizedAgentEvent>();
    active.observers.add(queue);

    return {
      running: true,
      events: queue.iterate(() => active.observers.delete(queue))
    };
  }

  async interrupt(sessionId: string): Promise<boolean> {
    const active = this.activeRuns.get(sessionId);
    if (!active) return false;

    active.abort("interrupted");
    await active.handle.interrupt?.();
    return true;
  }

  closeSession(sessionId: string): boolean {
    const active = this.activeRuns.get(sessionId);
    if (active) {
      active.abort("closed");
      active.handle.close();
      return true;
    }

    return this.pool.close(sessionId);
  }

  cleanupIdleSessions(): void {
    this.pool.cleanupIdle();
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    for (const [sessionId, active] of this.activeRuns) {
      active.abort("disposed");
      active.handle.close();
      closeObservers(active);
      this.activeRuns.delete(sessionId);
    }
    this.pool.closeAll();
  }

  async getMessages(session: SessionMetadata, limit?: number, offset?: number): Promise<unknown[]> {
    if (agentProviderForSession(this.config, session) === "codex") {
      return [];
    }

    const sessionId = session.agentSessionId ?? session.claudeSessionId;
    if (session.hasRun && !sessionId) {
      throw new MissingClaudeSessionIdError(session.id);
    }

    return this.adapter.getSessionMessages(sessionId ?? session.id, {
      dir: this.config.projectRoot,
      limit,
      offset
    });
  }

  private async *streamWithSession(
    input: AgentRunInput,
    register: (handle: ActiveRunHandle, options: { closeOnFinish: boolean; closeOnError: boolean }) => ActiveRun
  ): AsyncGenerator<NormalizedAgentEvent> {
    const options = buildSessionOptions(this.config, input.session, input.request);
    const sdkSession = this.pool.getOrCreate(input.session, options);
    this.pool.markRunning(input.session.id, true);
    const activeRun = register(
      {
        close: () => {
          this.pool.close(input.session.id);
        },
        interrupt: async () => {
          this.pool.close(input.session.id);
        }
      },
      { closeOnFinish: false, closeOnError: true }
    );

    await sendPrompt(sdkSession, buildAgentPrompt(input.request, projectRulesPromptFromOptions(options)));
    const toolLedger: ToolLedger = new Map();
    const validationCounters = new Map<string, number>();

    for await (const message of sdkSession.stream()) {
      const claudeSessionId = getSessionIdFromEvent(message);
      if (claudeSessionId) {
        await input.onAgentSessionId?.(claudeSessionId);
        await input.onClaudeSessionId?.(claudeSessionId);
      }

      recordToolUses(message, toolLedger);
      const { control: controlResultEvent, validation: validationEvents, terminate } = this.controlEventFromToolResults(
        input.session,
        message,
        toolLedger,
        validationCounters
      );
      for (const validationEvent of validationEvents) {
        yield this.emitEvent(activeRun, validationEvent);
      }
      if (terminate) {
        activeRun.handle.close();
        throw terminate;
      }
      if (controlResultEvent) {
        activeRun.handle.close();
        yield this.emitEvent(activeRun, controlResultEvent);
        break;
      }

      const event = normalizeAgentMessage(message);
      yield this.emitEvent(activeRun, event);
      const pendingEvent = this.controlEventFromToolUse(input.session, message, toolLedger);
      if (pendingEvent) {
        activeRun.handle.close();
        yield this.emitEvent(activeRun, pendingEvent);
        break;
      }
    }

    this.pool.touch(input.session.id);
  }

  private async *streamWithCodex(
    input: AgentRunInput,
    register: (handle: ActiveRunHandle, options: { closeOnFinish: boolean; closeOnError: boolean }) => ActiveRun
  ): AsyncGenerator<NormalizedAgentEvent> {
    const threadOptions = buildCodexThreadOptions(this.config, input.session, input.request);
    const codex = this.codexFactory(buildCodexClientOptions(this.config));
    const persistedThreadId = input.session.agentSessionId;
    const thread =
      input.session.hasRun && persistedThreadId
        ? codex.resumeThread(persistedThreadId, threadOptions)
        : codex.startThread(threadOptions);

    let activeRun!: ActiveRun;
    activeRun = register(
      {
        close: () => activeRun.abort("closed"),
        interrupt: async () => {
          activeRun.abort("interrupted");
        }
      },
      { closeOnFinish: false, closeOnError: false }
    );

    const effectiveMode = input.request.mode ?? input.session.mode;
    const codexInput = await buildCodexInput(
      input.request,
      projectRulesPromptFromCodexOptions(this.config),
      effectiveMode,
      buildBottleDiscoveryCatalog(this.config)
    );
    let lastAgentText = "";
    let lastAgentItemId = "";

    try {
      const streamed = await thread.runStreamed(codexInput.input, { signal: activeRun.abortController.signal });
      for await (const event of streamed.events) {
        if (event.type === "thread.started") {
          input.session.agentSessionId = event.thread_id;
          await input.onAgentSessionId?.(event.thread_id);
        }

        const isTerminalError = event.type === "turn.failed" || event.type === "error";
        const normalized = isTerminalError
          ? [{ type: "codex_event", data: event }]
          : normalizeCodexEvent(event, input.session.agentSessionId ?? thread.id ?? input.session.id, lastAgentText);
        if (event.type === "item.completed" && event.item.type === "agent_message") {
          lastAgentText = event.item.text;
          lastAgentItemId = event.item.id;
        }

        for (const outputEvent of normalized) {
          yield this.emitEvent(activeRun, outputEvent);
        }

        if (event.type === "turn.completed") {
          const interrupt =
            codexQuestionInterruptFromAgentMessage(lastAgentText, lastAgentItemId) ??
            codexPlanInterruptFromAgentMessage(lastAgentText, lastAgentItemId, effectiveMode);
          if (interrupt) {
            input.session.pendingInterrupt = interrupt;
            input.session.status = statusForInterrupt(interrupt);
            yield this.emitEvent(activeRun, pendingEventFromInterrupt(interrupt));
          }
        }

        if (event.type === "turn.failed") {
          throw new Error(event.error.message);
        }
        if (event.type === "error") {
          throw new Error(event.message);
        }
      }
    } finally {
      await codexInput.cleanup();
    }
  }

  private emitEvent(activeRun: ActiveRun, event: NormalizedAgentEvent): NormalizedAgentEvent {
    broadcastEvent(activeRun, event);
    return event;
  }

  private controlEventFromToolUse(
    session: SessionMetadata,
    message: unknown,
    toolLedger: ToolLedger
  ): NormalizedAgentEvent | undefined {
    for (const toolCall of getToolUseBlocksFromEvent(message)) {
      const entry = toolLedger.get(toolCall.id);
      if (entry?.status === "interrupted" && entry.interrupt) {
        session.pendingInterrupt = entry.interrupt;
        session.status = statusForInterrupt(entry.interrupt);
        return pendingEventFromInterrupt(entry.interrupt);
      }

      const control = controlSignalFromToolUse(toolCall);
      if (!control) continue;

      const interrupt = interruptFromControl(toolCall, control);
      toolLedger.set(toolCall.id, {
        toolName: toolCall.name,
        status: "interrupted",
        attempts: entry?.attempts ?? 1,
        input: toolCall.input,
        interrupt
      });
      session.pendingInterrupt = interrupt;
      session.status = statusForInterrupt(interrupt);
      return pendingEventFromInterrupt(interrupt);
    }

    return undefined;
  }

  private controlEventFromToolResults(
    session: SessionMetadata,
    message: unknown,
    toolLedger: ToolLedger,
    validationCounters: Map<string, number>
  ): { control?: NormalizedAgentEvent; validation: NormalizedAgentEvent[]; terminate?: ValidationErrorLimitError } {
    const validation: NormalizedAgentEvent[] = [];
    let terminate: ValidationErrorLimitError | undefined;

    for (const rawResult of getToolResultBlocksFromEvent(message)) {
      const toolCallId = typeof rawResult.tool_use_id === "string" ? rawResult.tool_use_id : undefined;
      if (!toolCallId) continue;

      const entry = toolLedger.get(toolCallId);
      if (!entry) continue;

      const toolCall = { id: toolCallId, name: entry.toolName, input: entry.input };
      const outcome = classifyToolResult(toolCall, rawResult);

      if (outcome.kind === "success") {
        entry.status = "completed";
        validationCounters.clear();
        continue;
      }

      if (outcome.kind === "validation_error") {
        entry.status = "failed";
        const counterKey = validationCounterKey(toolCall);
        const attempts = (validationCounters.get(counterKey) ?? 0) + 1;
        validationCounters.clear();
        validationCounters.set(counterKey, attempts);
        validation.push({
          type: "tool_validation_error",
          data: {
            toolUseId: toolCallId,
            toolName: entry.toolName,
            message: outcome.message,
            attempts,
            limit: MAX_CONSECUTIVE_VALIDATION_ERRORS
          }
        });
        if (attempts >= MAX_CONSECUTIVE_VALIDATION_ERRORS) {
          terminate = new ValidationErrorLimitError(entry.toolName, attempts, outcome.message);
          break;
        }
        continue;
      }

      if (outcome.kind === "real_error") {
        entry.status = "failed";
        validationCounters.clear();
        continue;
      }

      validationCounters.clear();
      const interrupt = interruptFromControl(toolCall, outcome.control);
      entry.status = "interrupted";
      entry.interrupt = interrupt;
      session.pendingInterrupt = interrupt;
      session.status = statusForInterrupt(interrupt);
      return { control: pendingEventFromInterrupt(interrupt), validation };
    }

    return { validation, terminate };
  }
}

class EventQueue<T> {
  private readonly queue: T[] = [];
  private closed = false;
  private waiting: ((result: IteratorResult<T>) => void) | undefined;

  enqueue(value: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ done: false, value });
      return;
    }
    this.queue.push(value);
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ done: true, value: undefined });
    }
  }

  async *iterate(onClose: () => void): AsyncGenerator<T> {
    try {
      while (true) {
        const next = await this.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      onClose();
      this.close();
    }
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.queue.length > 0) {
      return Promise.resolve({ done: false, value: this.queue.shift() as T });
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

function broadcastEvent(activeRun: ActiveRun, event: NormalizedAgentEvent): void {
  for (const observer of activeRun.observers) {
    observer.enqueue(event);
  }
}

function closeObservers(activeRun: ActiveRun): void {
  for (const observer of activeRun.observers) {
    observer.close();
  }
  activeRun.observers.clear();
}

async function* emptyEvents(): AsyncGenerator<NormalizedAgentEvent> {
  return;
}

export function buildCodexClientOptions(config: AppConfig): CodexOptions {
  return {
    ...(config.codexPath ? { codexPathOverride: config.codexPath } : {}),
    ...(config.codexBaseUrl ? { baseUrl: config.codexBaseUrl } : {}),
    ...(config.codexApiKey ? { apiKey: config.codexApiKey } : {})
  };
}

export function buildCodexThreadOptions(config: AppConfig, session: SessionMetadata, request: StreamMessageRequest): ThreadOptions {
  const mode = request.mode ?? session.mode;
  const additionalDirectories = existingDirectories([config.bottleDir, ...config.extraSkillRoots]);
  const options: ThreadOptions = {
    workingDirectory: config.projectRoot,
    sandboxMode: codexSandboxModeFor(mode),
    approvalPolicy: "never",
    skipGitRepoCheck: config.codexSkipGitRepoCheck,
    ...(additionalDirectories.length > 0 ? { additionalDirectories } : {})
  };
  const model = request.model ?? config.codexModel;
  if (model) options.model = model;
  if (config.codexReasoningEffort) options.modelReasoningEffort = config.codexReasoningEffort as ModelReasoningEffort;
  if (config.codexNetworkAccess !== undefined) options.networkAccessEnabled = config.codexNetworkAccess;
  return options;
}

export function buildSessionOptions(config: AppConfig, session: SessionMetadata, request: StreamMessageRequest): SessionOptions {
  const mode = request.mode ?? session.mode;
  const model = request.model ?? config.defaultModel;
  if (!model) {
    throw new Error("CLAUDE_MODEL must be set or the stream request must include model");
  }
  const rulesPrompt = loadBottleRulesPrompt(config);
  const agents = loadBottleAgentDefinitions(config.agentsDir);
  const additionalDirectories = existingDirectories([config.bottleDir]);
  const plugins = existingClaudePlugins(config.bottleDir);

  return {
    model,
    cwd: config.projectRoot,
    ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
    ...(plugins.length > 0 ? { plugins } : {}),
    ...(Object.keys(agents).length > 0 ? { agents } : {}),
    settingSources: ["project"],
    permissionMode: permissionModeFor(mode),
    allowDangerouslySkipPermissions: mode === "bypass",
    ...(rulesPrompt
      ? {
          systemPrompt: {
            type: "preset" as const,
            preset: "claude_code" as const,
            append: rulesPrompt
          }
        }
      : {}),
    env: buildSafeAgentEnv(),
    disallowedTools: disallowedToolsFor(mode)
  };
}

function existingDirectories(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((entryPath) => {
    const resolved = path.resolve(entryPath);
    if (seen.has(resolved)) return false;
    try {
      if (!fs.statSync(entryPath).isDirectory()) return false;
      seen.add(resolved);
      return true;
    } catch {
      return false;
    }
  });
}

function existingClaudePlugins(bottleDir: string): Array<{ type: "local"; path: string }> {
  try {
    if (fs.statSync(path.join(bottleDir, ".claude-plugin", "plugin.json")).isFile()) {
      return [{ type: "local", path: bottleDir }];
    }
  } catch {
    // A Bottle directory without a Claude plugin manifest still provides rules/agents directly.
  }
  return [];
}

export function loadBottleRulesPrompt(config: AppConfig): string | undefined {
  const rulesDir = config.rulesDir;
  const files = collectClaudeRuleFiles(rulesDir, rulesDir).sort((left, right) => left.localeCompare(right));
  const sections = files
    .map((filePath) => {
      const content = fs.readFileSync(filePath, "utf8").trim();
      if (!content) return "";
      const relativePath = path.relative(rulesDir, filePath).split(path.sep).join("/");
      return `## ${relativePath}\n\n${content}`;
    })
    .filter(Boolean);

  if (sections.length === 0) return undefined;

  return [
    `Bottle rules loaded from \`${path.relative(config.bottleDir, rulesDir).split(path.sep).join("/") || "rules"}\`. Follow these rules when working in this repository.`,
    BOTTLE_CONFIG_ONLY_NOTICE,
    ...sections
  ].join("\n\n");
}

function collectClaudeRuleFiles(directory: string, root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectClaudeRuleFiles(entryPath, root));
      continue;
    }
    if (entry.isFile() && BOTTLE_RULE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }
  return files.map((filePath) => path.resolve(root, path.relative(root, filePath)));
}

export function loadBottleAgentDefinitions(agentsDir: string): Record<string, AgentDefinition> {
  const files = collectBottleAgentFiles(agentsDir, agentsDir).sort((left, right) => left.localeCompare(right));
  const agents: Record<string, AgentDefinition> = {};
  for (const filePath of files) {
    const loaded = loadBottleAgentDefinition(agentsDir, filePath);
    if (!loaded) continue;
    agents[loaded.name] = loaded.definition;
  }
  return agents;
}

function collectBottleAgentFiles(directory: string, root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectBottleAgentFiles(entryPath, root));
      continue;
    }
    if (entry.isFile() && BOTTLE_AGENT_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }
  return files.map((filePath) => path.resolve(root, path.relative(root, filePath)));
}

function loadBottleAgentDefinition(root: string, filePath: string): { name: string; definition: AgentDefinition } | undefined {
  const content = fs.readFileSync(filePath, "utf8");
  if (path.extname(filePath).toLowerCase() === ".json") {
    return loadJsonAgentDefinition(root, filePath, content);
  }
  return loadMarkdownAgentDefinition(root, filePath, content);
}

function loadJsonAgentDefinition(root: string, filePath: string, content: string): { name: string; definition: AgentDefinition } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : agentNameFromPath(root, filePath);
  const definition = agentDefinitionFromRecord(parsed, typeof parsed.prompt === "string" ? parsed.prompt : undefined);
  if (!definition) return undefined;
  return { name, definition };
}

function loadMarkdownAgentDefinition(root: string, filePath: string, content: string): { name: string; definition: AgentDefinition } | undefined {
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter) return undefined;
  const name =
    typeof frontmatter.attributes.name === "string" && frontmatter.attributes.name.trim()
      ? frontmatter.attributes.name.trim()
      : agentNameFromPath(root, filePath);
  const definition = agentDefinitionFromRecord(frontmatter.attributes, frontmatter.body.trim());
  if (!definition) return undefined;
  return { name, definition };
}

function agentDefinitionFromRecord(value: Record<string, unknown>, prompt: string | undefined): AgentDefinition | undefined {
  const description = typeof value.description === "string" ? value.description.trim() : "";
  const body = prompt?.trim() ?? "";
  if (!description || !body) return undefined;

  const tools = stringListFromValue(value.tools);
  const disallowedTools = stringListFromValue(value.disallowedTools ?? value.disallowed_tools);
  const skills = stringListFromValue(value.skills);
  const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined;
  const initialPrompt =
    typeof value.initialPrompt === "string" && value.initialPrompt.trim()
      ? value.initialPrompt.trim()
      : typeof value.initial_prompt === "string" && value.initial_prompt.trim()
        ? value.initial_prompt.trim()
        : undefined;
  const maxTurns = integerFromValue(value.maxTurns ?? value.max_turns);

  return {
    description,
    prompt: body,
    ...(tools.length > 0 ? { tools } : {}),
    ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(model ? { model } : {}),
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {})
  };
}

function parseFrontmatter(content: string): { attributes: Record<string, unknown>; body: string } | undefined {
  const match = content.match(FRONTMATTER_PATTERN);
  if (!match) return undefined;
  const attributes: Record<string, unknown> = {};
  let currentListKey: string | undefined;

  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && currentListKey) {
      const list: string[] = Array.isArray(attributes[currentListKey]) ? (attributes[currentListKey] as string[]) : [];
      list.push(unquoteYamlScalar(listMatch[1]));
      attributes[currentListKey] = list;
      continue;
    }

    const keyValue = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!keyValue) {
      currentListKey = undefined;
      continue;
    }
    const key = keyValue[1];
    const rawValue = keyValue[2].trim();
    if (!rawValue) {
      attributes[key] = [];
      currentListKey = key;
      continue;
    }
    currentListKey = undefined;
    attributes[key] = unquoteYamlScalar(rawValue);
  }

  return { attributes, body: content.slice(match[0].length) };
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stringListFromValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function integerFromValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function agentNameFromPath(root: string, filePath: string): string {
  return path
    .relative(root, filePath)
    .replace(/\.[^.]+$/, "")
    .split(path.sep)
    .join("-");
}

export function buildAgentPrompt(request: StreamMessageRequest, projectRulesPrompt?: string): AgentPrompt {
  if (request.toolResult) {
    if (request.toolResult.kind === "approval") return buildApprovalResultPrompt(request, request.toolResult, projectRulesPrompt);
    return buildQuestionAnswerPrompt(request, request.toolResult, projectRulesPrompt);
  }

  const text = prependProjectRulesToPrompt(prependBottleContextToPrompt(request.prompt, request.context), projectRulesPrompt);
  if (!request.images || request.images.length === 0) {
    return text;
  }

  const message: SDKUserMessage = {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text },
        ...request.images.map((image) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: image.mediaType,
            data: image.dataBase64
          }
        }))
      ]
    },
    parent_tool_use_id: null
  };

  return singleMessagePrompt(message);
}

function prependBottleContextToPrompt(prompt: string, context: StreamMessageRequest["context"]): string {
  if (!context || typeof context !== "object") return prompt;

  const lines = ["Bottle main app context:"];
  const title = truncateContextValue(context.title, 300);
  const route = truncateContextValue(context.route, 1_000);
  const url = truncateContextValue(context.url, 1_000);
  const selectedText = truncateContextValue(context.selectedText, 4_000);
  const selectedElement = truncateContextValue(context.selectedElement, 300);
  const viewport =
    context.viewport &&
    Number.isFinite(context.viewport.width) &&
    Number.isFinite(context.viewport.height)
      ? `${Math.round(context.viewport.width)}x${Math.round(context.viewport.height)}`
      : undefined;

  if (title) lines.push(`- Title: ${title}`);
  if (route) lines.push(`- Route: ${route}`);
  if (url) lines.push(`- URL: ${url}`);
  if (selectedElement) lines.push(`- Selected element: ${selectedElement}`);
  if (viewport) lines.push(`- Viewport: ${viewport}`);
  if (selectedText) lines.push(`- Selected text:\n${selectedText}`);

  if (lines.length === 1) return prompt;
  return `${lines.join("\n")}\n\nUser prompt:\n${prompt}`;
}

function truncateContextValue(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
}

function buildApprovalResultPrompt(
  request: StreamMessageRequest,
  toolResult: NonNullable<StreamMessageRequest["toolResult"]>,
  projectRulesPrompt?: string
): AgentPrompt {
  const parsed = parseJsonRecord(toolResult.content);
  const approved = toolResult.approved ?? (typeof parsed?.approved === "boolean" ? parsed.approved : false);
  const feedback = typeof parsed?.feedback === "string" && parsed.feedback.trim() ? parsed.feedback.trim() : "";
  const plan = typeof parsed?.plan === "string" && parsed.plan.trim() ? parsed.plan.trim() : "";

  const text = [
    approved
      ? "User approved exiting plan mode. Continue in execution mode."
      : "User declined exiting plan mode. Continue in plan mode.",
    plan ? `Plan:\n${plan}` : "",
    feedback ? `User feedback:\n${feedback}` : "",
    "",
    "User answer summary:",
    request.prompt
  ]
    .filter((part) => part !== "")
    .join("\n")
    .trim();
  const promptText = prependProjectRulesToPrompt(text, projectRulesPrompt);

  if (!request.images || request.images.length === 0) {
    return promptText;
  }

  const message: SDKUserMessage = {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: promptText },
        ...request.images.map((image) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: image.mediaType,
            data: image.dataBase64
          }
        }))
      ]
    },
    parent_tool_use_id: null
  };

  return singleMessagePrompt(message);
}

function buildQuestionAnswerPrompt(
  request: StreamMessageRequest,
  toolResult: NonNullable<StreamMessageRequest["toolResult"]>,
  projectRulesPrompt?: string
): AgentPrompt {
  const text = [
    "The user answered the AskUserQuestion form. Use these selections and continue the task.",
    "Do not ask the same questions again unless a required detail is still missing.",
    "",
    formatQuestionAnswers(toolResult.content) ?? `Answer payload:\n${toolResult.content}`,
    "",
    "User answer summary:",
    request.prompt
  ]
    .join("\n")
    .trim();
  const promptText = prependProjectRulesToPrompt(text, projectRulesPrompt);

  if (!request.images || request.images.length === 0) {
    return promptText;
  }

  const message: SDKUserMessage = {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: promptText },
        ...request.images.map((image) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: image.mediaType,
            data: image.dataBase64
          }
        }))
      ]
    },
    parent_tool_use_id: null
  };

  return singleMessagePrompt(message);
}

function projectRulesPromptFromOptions(options: SessionOptions): string | undefined {
  const systemPrompt = options.systemPrompt;
  if (!systemPrompt || typeof systemPrompt !== "object" || Array.isArray(systemPrompt)) return undefined;
  if (!("append" in systemPrompt) || typeof systemPrompt.append !== "string") return undefined;
  return systemPrompt.append;
}

function prependProjectRulesToPrompt(prompt: string, projectRulesPrompt?: string): string {
  const rules = projectRulesPrompt?.trim();
  if (!rules) return prompt;
  return [
    "The following Bottle rules are loaded from `.bottle/rules` and apply to this request. Treat them as authoritative repository instructions.",
    "",
    "<project_rules>",
    rules,
    "</project_rules>",
    "",
    "User request:",
    prompt
  ].join("\n");
}

function prependBottleDiscoveryToPrompt(prompt: string, discoveryCatalog?: string): string {
  const catalog = discoveryCatalog?.trim();
  if (!catalog) return prompt;
  return [catalog, "", prompt].join("\n");
}

function formatQuestionAnswers(content: string): string | undefined {
  const parsed = parseJsonRecord(content);
  if (!parsed || !isRecord(parsed.answers)) return undefined;

  const answers = Object.entries(parsed.answers);
  if (answers.length === 0) return undefined;

  return ["Selected answers:", ...answers.map(([question, answer]) => `- ${question}: ${formatAnswerValue(answer)}`)].join("\n");
}

function formatAnswerValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatAnswerValue).join(", ");
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function parseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function* singleMessagePrompt(message: SDKUserMessage): AsyncGenerator<SDKUserMessage> {
  yield message;
}

async function sendPrompt(session: SessionLike, prompt: AgentPrompt): Promise<void> {
  if (typeof prompt === "string") {
    await session.send(prompt);
    return;
  }

  for await (const message of prompt) {
    await session.send(message);
  }
}

export function buildBottleDiscoveryCatalog(config: AppConfig): string | undefined {
  const agents = discoveryEntries(config.agentsDir, [".md", ".json"], "agent");
  const commands = discoveryEntries(config.commandsDir, [".md"], "command");
  const rules = discoveryEntries(config.rulesDir, [".md", ".mdx", ".txt"], "rule", { includeDescription: false });
  const skills = discoverBottleSkills(config);

  if (agents.length === 0 && commands.length === 0 && rules.length === 0 && skills.length === 0) return undefined;

  return [
    "Bottle discovery folders:",
    BOTTLE_CONFIG_ONLY_NOTICE,
    `- Agents: ${formatDiscoveryEntries(config.agentsDir, agents)}`,
    `- Slash commands: ${formatDiscoveryEntries(config.commandsDir, commands)}`,
    `- Rules: ${formatDiscoveryEntries(config.rulesDir, rules)}`,
    "Skill manifest:",
    formatSkillManifest(skills),
    "Use the skill manifest as an index. Choose skills by name and description, then read only the matching `SKILL.md`. Treat extra skill roots as read-only; load references, scripts, or assets only when the selected `SKILL.md` tells you to."
  ].join("\n");
}

function discoveryEntries(
  root: string,
  extensions: string[],
  kind: "agent" | "command" | "rule",
  options: { includeDescription?: boolean } = {}
): DiscoveryEntry[] {
  const includeDescription = options.includeDescription ?? true;
  return collectDiscoveryFiles(root, new Set(extensions))
    .sort((left, right) => left.localeCompare(right))
    .map((filePath) => {
      const relativePath = path.relative(root, filePath).split(path.sep).join("/");
      const content = includeDescription ? safeReadText(filePath) : "";
      return {
        name: kind === "command" ? `/${relativePath.replace(/\.md$/i, "")}` : relativePath.replace(/\.[^.]+$/, ""),
        path: relativePath,
        description: includeDescription ? firstMetadataDescription(content) : undefined
      };
    });
}

type DiscoveryEntry = {
  name: string;
  path: string;
  description?: string;
};

type SkillDiscoveryEntry = DiscoveryEntry & {
  rootLabel: string;
  rootPath: string;
  skillPath: string;
  resources: string[];
};

function discoverBottleSkills(config: AppConfig): SkillDiscoveryEntry[] {
  const discovered: SkillDiscoveryEntry[] = [];
  const seenNames = new Set<string>();

  config.skillRoots.forEach((rootPath, rootIndex) => {
    const files = collectSkillFiles(rootPath, rootPath).sort((left, right) => left.localeCompare(right));
    for (const filePath of files) {
      const skillRoot = path.dirname(filePath);
      const relativeSkillRoot = path.relative(rootPath, skillRoot).split(path.sep).join("/");
      const name = relativeSkillRoot || path.basename(skillRoot);
      if (seenNames.has(name)) continue;
      seenNames.add(name);

      const content = safeReadText(filePath);
      discovered.push({
        name,
        path: path.relative(rootPath, filePath).split(path.sep).join("/"),
        description: firstMetadataDescription(content),
        rootLabel: skillRootLabel(rootIndex),
        rootPath,
        skillPath: filePath,
        resources: skillResourceHints(skillRoot)
      });
    }
  });

  return discovered;
}

function collectSkillFiles(directory: string, root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSkillFiles(entryPath, root));
      continue;
    }
    if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(path.resolve(root, path.relative(root, entryPath)));
    }
  }
  return files;
}

function collectDiscoveryFiles(directory: string, extensions: Set<string>, root: string = directory): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectDiscoveryFiles(entryPath, extensions, root));
      continue;
    }
    if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(path.resolve(root, path.relative(root, entryPath)));
    }
  }
  return files;
}

function formatDiscoveryEntries(root: string, entries: DiscoveryEntry[]): string {
  if (entries.length === 0) return `none found in ${root}`;
  return entries
    .slice(0, 50)
    .map((entry) => {
      const description = entry.description ? ` - ${truncateDiscoveryDescription(entry.description)}` : "";
      return `${entry.name} (${entry.path})${description}`;
    })
    .join("; ");
}

function formatSkillManifest(entries: SkillDiscoveryEntry[]): string {
  if (entries.length === 0) return "none found in configured skill roots";
  return entries
    .slice(0, 50)
    .map((entry) => {
      const description = entry.description ? ` - ${truncateDiscoveryDescription(entry.description)}` : "";
      const resources = entry.resources.length > 0 ? `; resources: ${entry.resources.join("; ")}` : "";
      return `- ${entry.name}${description}; source: ${entry.rootLabel} (${entry.rootPath}); SKILL.md: ${entry.skillPath}${resources}`;
    })
    .join("\n");
}

function skillRootLabel(index: number): string {
  return index === 0 ? ".bottle/skills" : `extra-${index}`;
}

function skillResourceHints(skillRoot: string): string[] {
  return SKILL_RESOURCE_DIR_NAMES.flatMap((dirName) => {
    const entries = shallowResourceEntries(path.join(skillRoot, dirName));
    return entries.length > 0 ? [`${dirName}[${entries.join(", ")}]`] : [];
  });
}

function shallowResourceEntries(directory: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }

  const names = entries
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
    .sort((left, right) => left.localeCompare(right));
  const visible = names.slice(0, 8);
  const remaining = names.length - visible.length;
  return remaining > 0 ? [...visible, `+${remaining} more`] : visible;
}

function firstMetadataDescription(content: string): string | undefined {
  const frontmatter = parseFrontmatter(content);
  const description = frontmatter?.attributes.description;
  if (typeof description === "string" && description.trim()) return description.trim();
  const line = content
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.toLowerCase().startsWith("description:"));
  return line?.slice("description:".length).trim().replace(/^["']|["']$/g, "") || undefined;
}

function truncateDiscoveryDescription(description: string): string {
  return description.length > 180 ? `${description.slice(0, 177)}...` : description;
}

function safeReadText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

async function buildCodexInput(
  request: StreamMessageRequest,
  projectRulesPrompt?: string,
  mode?: ClaudeMode,
  discoveryCatalog?: string
): Promise<{ input: CodexInput; cleanup: () => Promise<void> }> {
  const text = buildCodexPromptText(request, projectRulesPrompt, mode, discoveryCatalog);
  if (!request.images || request.images.length === 0) {
    return { input: text, cleanup: async () => undefined };
  }

  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "bottle-codex-images-"));
  const imageInputs = await Promise.all(
    request.images.map(async (image, index) => {
      const filePath = path.join(directory, `${index + 1}-${sanitizeImageFileName(image.name, image.mediaType)}`);
      await fsPromises.writeFile(filePath, Buffer.from(image.dataBase64, "base64"));
      return { type: "local_image" as const, path: filePath };
    })
  );

  return {
    input: [{ type: "text", text }, ...imageInputs],
    cleanup: async () => {
      await fsPromises.rm(directory, { recursive: true, force: true });
    }
  };
}

function buildCodexPromptText(
  request: StreamMessageRequest,
  projectRulesPrompt?: string,
  mode?: ClaudeMode,
  discoveryCatalog?: string
): string {
  if (request.toolResult) {
    const text =
      request.toolResult.kind === "approval"
        ? buildApprovalResultText(request, request.toolResult)
        : buildQuestionAnswerText(request, request.toolResult);
    return prependBottleDiscoveryToPrompt(
      prependProjectRulesToPrompt(prependCodexPlanGuidanceToPrompt(text, mode, request.toolResult.kind), projectRulesPrompt),
      discoveryCatalog
    );
  }

  const text = prependBottleContextToPrompt(request.prompt, request.context);
  return prependBottleDiscoveryToPrompt(
    prependProjectRulesToPrompt(prependCodexPlanGuidanceToPrompt(text, mode), projectRulesPrompt),
    discoveryCatalog
  );
}

function buildApprovalResultText(
  request: StreamMessageRequest,
  toolResult: NonNullable<StreamMessageRequest["toolResult"]>
): string {
  const parsed = parseJsonRecord(toolResult.content);
  const approved = toolResult.approved ?? (typeof parsed?.approved === "boolean" ? parsed.approved : false);
  const feedback = typeof parsed?.feedback === "string" && parsed.feedback.trim() ? parsed.feedback.trim() : "";
  const plan = typeof parsed?.plan === "string" && parsed.plan.trim() ? parsed.plan.trim() : "";

  return [
    approved
      ? "User approved exiting plan mode. Continue in execution mode."
      : "User declined exiting plan mode. Continue in plan mode.",
    plan ? `Plan:\n${plan}` : "",
    feedback ? `User feedback:\n${feedback}` : "",
    "",
    "User answer summary:",
    request.prompt
  ]
    .filter((part) => part !== "")
    .join("\n")
    .trim();
}

function buildQuestionAnswerText(
  request: StreamMessageRequest,
  toolResult: NonNullable<StreamMessageRequest["toolResult"]>
): string {
  return [
    "The user answered the AskUserQuestion form. Use these selections and continue the task.",
    "Do not ask the same questions again unless a required detail is still missing.",
    "",
    formatQuestionAnswers(toolResult.content) ?? `Answer payload:\n${toolResult.content}`,
    "",
    "User answer summary:",
    request.prompt
  ]
    .join("\n")
    .trim();
}

function prependCodexPlanGuidanceToPrompt(
  prompt: string,
  mode?: ClaudeMode,
  toolResultKind?: NonNullable<StreamMessageRequest["toolResult"]>["kind"]
): string {
  if (mode !== "plan" || toolResultKind === "approval") return prompt;

  return [
    "Bottle plan mode guidance:",
    "You are in plan mode. Inspect/read only. Do not modify files.",
    "Use the Bottle discovery folders and configured extra skill roots as the authoritative source for project instructions.",
    "Present an implementation plan and stop; Bottle will ask the user for approval before edit mode.",
    "If you need user input before planning, ask one direct question and include 2-4 concise suggested options as simple bullet lines when reasonable.",
    "",
    prompt
  ].join("\n");
}

function sanitizeImageFileName(name: string | undefined, mediaType: NonNullable<StreamMessageRequest["images"]>[number]["mediaType"]): string {
  const fallback = `image.${extensionForMediaType(mediaType)}`;
  const base = (name ?? fallback)
    .replace(/[/\\]/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || fallback;
}

function extensionForMediaType(mediaType: NonNullable<StreamMessageRequest["images"]>[number]["mediaType"]): string {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/gif") return "gif";
  if (mediaType === "image/webp") return "webp";
  return "png";
}

function permissionModeFor(mode: ClaudeMode): "plan" | "bypassPermissions" | "acceptEdits" {
  if (mode === "plan") return "plan";
  if (mode === "bypass") return "bypassPermissions";
  return "acceptEdits";
}

function codexSandboxModeFor(mode: ClaudeMode): SandboxMode {
  if (mode === "plan") return "read-only";
  if (mode === "bypass") return "danger-full-access";
  return "workspace-write";
}

function disallowedToolsFor(mode: ClaudeMode): string[] {
  // Claude Code plan mode still needs Write available for the generated plan file.
  // The built-in plan permission mode owns the read-only guard for implementation files.
  return mode === "plan" ? ["Bash"] : [];
}

function projectRulesPromptFromCodexOptions(config: AppConfig): string | undefined {
  return loadBottleRulesPrompt(config);
}

function agentProviderForSession(config: AppConfig, session: Partial<SessionMetadata>): AgentProvider {
  return session.provider ?? config.defaultAgentProvider;
}

function codexQuestionInterruptFromAgentMessage(text: string, itemId: string): PendingInterrupt | undefined {
  const questions = extractCodexUserQuestions(text);
  if (questions.length === 0) return undefined;

  const toolCallId = `codex-question:${itemId || "agent-message"}`;
  return {
    id: `interrupt:${toolCallId}`,
    type: "user_input",
    toolCallId,
    toolName: "AskUserQuestion",
    prompt: questions[0]?.question ?? "Answer the Codex question.",
    payload: {
      input: {
        questions,
        source: "codex_agent_message",
        message: text
      }
    }
  };
}

function codexPlanInterruptFromAgentMessage(text: string, itemId: string, mode: ClaudeMode): PendingInterrupt | undefined {
  if (mode !== "plan") return undefined;
  const plan = normalizeCodexPlanText(text);
  if (!plan) return undefined;

  const toolCallId = `codex-plan:${itemId || "agent-message"}`;
  return {
    id: `interrupt:${toolCallId}`,
    type: "approval",
    toolCallId,
    toolName: "ExitPlanMode",
    prompt: "Exit plan mode?",
    payload: {
      input: {
        plan,
        source: "codex_agent_message",
        message: text
      },
      plan,
      action: "exit_plan_mode",
      source: "codex_agent_message"
    }
  };
}

function normalizeCodexPlanText(text: string): string {
  const proposedPlan = text.match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i)?.[1]?.trim();
  if (proposedPlan) return proposedPlan;

  let normalized = text.trim();
  const blockedPattern =
    /^Blocked by the current sandbox:[\s\S]*?(?=\n\s*(?:I inspected the repo\.|The .+ should be added as:|- |\d+[.)] |#{1,6}\s|\*\*))/i;
  normalized = normalized.replace(blockedPattern, "").trim();

  const trailingPatterns = [
    /\n\s*I wasn[’']t able to run tests[\s\S]*$/i,
    /\n\s*Re-run this with write access[\s\S]*$/i,
    /\n\s*I couldn[’']t modify files[\s\S]*$/i
  ];
  for (const pattern of trailingPatterns) {
    normalized = normalized.replace(pattern, "").trim();
  }

  return normalized;
}

function extractCodexUserQuestions(
  text: string
): Array<{ id: string; question: string; multiSelect?: boolean; options: Array<{ label: string; description: string }> }> {
  const cleaned = stripFencedCodeBlocks(text);
  const candidates: string[] = [];

  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = normalizeQuestionDetectionLine(rawLine);
    if (!line.includes("?")) continue;

    for (const match of line.match(/[^?]+?\?/g) ?? []) {
      const question = match.trim();
      if (question.length < 8 || isClosingQuestion(question)) continue;
      candidates.push(question);
    }
  }

  if (candidates.length === 0) {
    const imperative = firstImperativeUserInputRequest(cleaned);
    if (imperative) candidates.push(imperative);
  }

  return Array.from(new Set(candidates)).slice(0, 3).map((question, index) => {
    const extractedOptions = index === 0 ? extractCodexQuestionOptions(text, question) : [];
    const questionOptions =
      extractedOptions.length > 0
        ? extractedOptions
        : index === 0
          ? fallbackCodexQuestionOptions(question)
          : [];
    return {
      id: `codex-question-${index + 1}`,
      question,
      ...(extractedOptions.length > 1 ? { multiSelect: true } : {}),
      options: questionOptions
    };
  });
}

function fallbackCodexQuestionOptions(question: string): Array<{ label: string; description: string }> {
  if (!/\bwhat\b[\s\S]*\b(work on|build|do|help with)\b/i.test(question)) return [];

  return [
    {
      label: "Build a feature",
      description: "Describe the feature or workflow to add."
    },
    {
      label: "Fix a bug",
      description: "Describe the broken behavior and expected result."
    },
    {
      label: "Review code",
      description: "Name the file, change, or area to review."
    },
    {
      label: "Explain code",
      description: "Ask about a file, flow, or error."
    }
  ];
}

function stripFencedCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ");
}

function normalizeQuestionDetectionLine(line: string): string {
  return line
    .replace(/`[^`\r\n]*(?:`|$)/g, (inlineCode) => (inlineCode.includes("?") ? " " : inlineCode))
    .replace(/\bhttps?:\/\/\S+/gi, maskQuestionMarks)
    .replace(/(^|[\s([{])\/[^\s`)\]}>"']*\?[^\s`)\]}>"']*/g, maskQuestionMarks)
    .replace(/^[\s>*-]*(?:\d+[.)]\s*)?/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function maskQuestionMarks(text: string): string {
  return text.replace(/\?/g, "");
}

function extractCodexQuestionOptions(text: string, question: string): Array<{ label: string; description: string }> {
  const labels: string[] = [];
  const fencedBlockPattern = /```[^\n\r]*(?:\r?\n)([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fencedBlockPattern.exec(text)) !== null) {
    labels.push(...extractOptionLabelsFromLines(match[1] ?? ""));
  }

  if (labels.length === 0) labels.push(...extractLocalOptionLabels(text, question));

  return Array.from(new Set(labels)).slice(0, 12).map((label) => ({
    label,
    description: ""
  }));
}

function extractLocalOptionLabels(text: string, question: string): string[] {
  const lines = stripFencedCodeBlocks(text).split(/\r?\n/);
  const questionIndex = lines.findIndex((line) => normalizeQuestionDetectionLine(line).includes(question));
  if (questionIndex < 0) return [];

  const labels: string[] = [];
  for (const rawLine of lines.slice(questionIndex + 1, questionIndex + 9)) {
    if (rawLine.trim() === "") {
      if (labels.length > 0) break;
      continue;
    }

    const label = extractNonFencedOptionLabel(rawLine);
    if (label) {
      labels.push(label);
      continue;
    }

    if (labels.length > 0) break;
  }

  return labels;
}

function extractNonFencedOptionLabel(line: string): string | undefined {
  if (!/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)) return undefined;
  const label = line
    .replace(/^[\s>*-]*(?:\d+[.)]\s*)?/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!isUsefulCodexOptionLabel(label)) return undefined;
  if (label.endsWith(":") && !/\b(required|optional|default|true|false|yes|no|enable|disable)\b/i.test(label)) return undefined;
  return label;
}

function extractOptionLabelsFromLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^[\s>*-]*(?:\d+[.)]\s*)?/, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((line) => isUsefulCodexOptionLabel(line));
}

function isUsefulCodexOptionLabel(line: string): boolean {
  if (line.length < 3 || line.length > 140) return false;
  if (line.includes("?")) return false;
  if (/^(```|example:?|please\b|i['’]ll\b|unless\b)/i.test(line)) return false;
  return /[:,=]|\b(required|optional|default|true|false|yes|no|enable|disable)\b/i.test(line);
}

function firstImperativeUserInputRequest(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.replace(/^[\s>*-]*(?:\d+[.)]\s*)?/, "").replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!line) return undefined;
  if (!/^(please\s+)?(provide|share|tell me|choose|select|confirm|list|send)\b/i.test(line)) return undefined;
  return line.endsWith(".") ? line.slice(0, -1) : line;
}

function isClosingQuestion(question: string): boolean {
  return /^(anything else|any other questions|can i help with anything else|would you like anything else)\??$/i.test(question);
}

export function normalizeCodexEvent(event: ThreadEvent, sessionId: string, finalText: string): NormalizedAgentEvent[] {
  const rawEvent = { type: "codex_event", data: event };

  if (event.type === "item.completed" && event.item.type === "agent_message") {
    return [
      {
        type: "message",
        data: {
          type: "assistant",
          session_id: sessionId,
          message: {
            role: "assistant",
            content: event.item.text
          },
          codex_item: event.item
        }
      },
      rawEvent
    ];
  }

  if (event.type === "item.completed" && event.item.type === "error") {
    return [
      {
        type: "error",
        data: { error: { code: "codex_item_error", message: event.item.message }, codex_item: event.item }
      },
      rawEvent
    ];
  }

  if (event.type === "turn.completed") {
    return [
      {
        type: "result",
        data: {
          session_id: sessionId,
          is_error: false,
          result: finalText,
          usage: event.usage,
          codex_event: event
        }
      },
      rawEvent
    ];
  }

  if (event.type === "turn.failed") {
    return [
      {
        type: "error",
        data: { error: { code: "codex_turn_failed", message: event.error.message }, codex_event: event }
      },
      rawEvent
    ];
  }

  if (event.type === "error") {
    return [
      {
        type: "error",
        data: { error: { code: "codex_error", message: event.message }, codex_event: event }
      },
      rawEvent
    ];
  }

  return [rawEvent];
}

export function normalizeAgentMessage(message: unknown): NormalizedAgentEvent {
  if (message && typeof message === "object") {
    const record = message as Record<string, unknown>;
    if (typeof record.type === "string") {
      if (record.type === "result") return { type: "result", data: message };
      if (record.type === "assistant") return { type: "message", data: message };
      if (record.type === "user") return { type: "message", data: message };
      if (record.type === "system") return { type: "system", data: message };
      if (record.type === "tool_use") return { type: "tool_use", data: message };
      if (record.type === "tool_result") return { type: "tool_result", data: message };
      return { type: record.type, data: message };
    }

    if ("result" in record) {
      return { type: "result", data: message };
    }
  }

  return { type: "message", data: message };
}

export function classifyToolResult(toolCall: ToolCallRecord, rawResult: unknown): ToolOutcome {
  const result = isRecord(rawResult) ? rawResult : {};
  const contentText = toolResultContentText(result);

  if (result.is_error !== true) {
    return { kind: "success", content: result.content };
  }

  if (toolCall.name === "AskUserQuestion" && contentText === "Answer questions?") {
    return {
      kind: "control",
      control: {
        type: "user_input_required",
        prompt: contentText,
        questions: inputProperty(toolCall.input, "questions"),
        toolCallId: toolCall.id
      }
    };
  }

  if (toolCall.name === "ExitPlanMode" && contentText === "Exit plan mode?") {
    return {
      kind: "control",
      control: {
        type: "approval_required",
        action: "exit_plan_mode",
        prompt: contentText,
        plan: inputProperty(toolCall.input, "plan"),
        toolCallId: toolCall.id
      }
    };
  }

  const validationMatch = contentText.match(TOOL_USE_ERROR_PATTERN);
  if (validationMatch) {
    return {
      kind: "validation_error",
      message: validationMatch[1].trim() || contentText
    };
  }

  return {
    kind: "real_error",
    message: contentText || "Tool failed",
    retryable: false
  };
}

export function getAskUserQuestionTool(message: unknown): Record<string, unknown> | null {
  return getNamedToolUse(message, "AskUserQuestion");
}

function getNamedToolUse(message: unknown, toolName: string): Record<string, unknown> | null {
  const messageRecord = protocolMessage(message);
  if (!messageRecord) return null;
  if (messageRecord.stop_reason !== "tool_use" && messageRecord.stop_reason !== null && messageRecord.stop_reason !== undefined) {
    return null;
  }

  const tool = getToolUseBlocks(messageRecord).find((block) => block.name === toolName);
  return tool ? ({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input } as Record<string, unknown>) : null;
}

function recordToolUses(message: unknown, toolLedger: ToolLedger): void {
  for (const toolCall of getToolUseBlocksFromEvent(message)) {
    const existing = toolLedger.get(toolCall.id);
    if (existing?.status === "interrupted" || existing?.status === "completed") continue;

    toolLedger.set(toolCall.id, {
      toolName: toolCall.name,
      status: "pending",
      attempts: (existing?.attempts ?? 0) + 1,
      input: toolCall.input,
      interrupt: existing?.interrupt
    });
  }
}

function validationCounterKey(toolCall: ToolCallRecord): string {
  return `${toolCall.name}\0${stableToolInputKey(toolCall.input)}`;
}

function stableToolInputKey(input: unknown): string {
  try {
    return JSON.stringify(sortToolInputValue(input)) ?? String(input);
  } catch {
    return String(input);
  }
}

function sortToolInputValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortToolInputValue);
  if (!isRecord(value)) return value;

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((sorted, key) => {
      sorted[key] = sortToolInputValue(value[key]);
      return sorted;
    }, {});
}

function getToolUseBlocksFromEvent(event: unknown): ToolCallRecord[] {
  const record = isRecord(event) ? event : undefined;
  if (record?.type === "tool_use") return getToolUseBlocks(record);
  if (record?.type === "assistant" || record?.type === "message" || record?.type === "user") {
    return getToolUseBlocks(record.message ?? record);
  }
  return getToolUseBlocks(event);
}

function getToolUseBlocks(message: unknown): ToolCallRecord[] {
  const messageRecord = protocolMessage(message);
  if (!messageRecord) return [];
  const blocks = Array.isArray(messageRecord.content) ? messageRecord.content : [];
  const tools: ToolCallRecord[] = [];

  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type !== "tool_use") continue;
    if (typeof block.id !== "string" || typeof block.name !== "string") continue;
    tools.push({ id: block.id, name: block.name, input: block.input });
  }

  if (messageRecord.type === "tool_use" && typeof messageRecord.id === "string" && typeof messageRecord.name === "string") {
    tools.push({ id: messageRecord.id, name: messageRecord.name, input: messageRecord.input });
  }

  return tools;
}

function getToolResultBlocksFromEvent(event: unknown): Record<string, unknown>[] {
  const record = isRecord(event) ? event : undefined;
  if (record?.type === "tool_result") return [record];
  if (record?.type === "assistant" || record?.type === "message" || record?.type === "user") {
    return getToolResultBlocks(record.message ?? record);
  }
  return getToolResultBlocks(event);
}

function getToolResultBlocks(message: unknown): Record<string, unknown>[] {
  const messageRecord = protocolMessage(message);
  if (!messageRecord) return [];
  const blocks = Array.isArray(messageRecord.content) ? messageRecord.content : [];
  const results: Record<string, unknown>[] = [];

  for (const block of blocks) {
    if (isRecord(block) && block.type === "tool_result") results.push(block);
  }

  if (messageRecord.type === "tool_result") results.push(messageRecord);
  return results;
}

function protocolMessage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.message)) return value.message;
  return value;
}

export function isPendingInterruptPayloadValid(interrupt: PendingInterrupt): boolean {
  const payload = isRecord(interrupt.payload) ? interrupt.payload : {};
  const input = isRecord(payload.input) ? payload.input : payload;

  if (interrupt.toolName === "AskUserQuestion") {
    const questions = isRecord(payload) && "questions" in payload ? payload.questions : input.questions;
    return Array.isArray(questions) && questions.length > 0;
  }

  if (interrupt.toolName === "ExitPlanMode") {
    const plan = isRecord(payload) && "plan" in payload ? payload.plan : input.plan;
    return typeof plan === "string" && plan.trim() !== "";
  }

  return true;
}

function controlSignalFromToolUse(toolCall: ToolCallRecord): ControlSignal | undefined {
  if (toolCall.name === "AskUserQuestion") {
    const questions = inputProperty(toolCall.input, "questions");
    if (!Array.isArray(questions) || questions.length === 0) return undefined;
    return {
      type: "user_input_required",
      prompt: "Answer questions?",
      questions,
      toolCallId: toolCall.id
    };
  }

  if (toolCall.name === "ExitPlanMode") {
    const plan = inputProperty(toolCall.input, "plan");
    if (typeof plan !== "string" || plan.trim() === "") return undefined;
    return {
      type: "approval_required",
      action: "exit_plan_mode",
      prompt: "Exit plan mode?",
      plan,
      toolCallId: toolCall.id
    };
  }

  return undefined;
}

function interruptFromControl(toolCall: ToolCallRecord, control: ControlSignal): PendingInterrupt {
  if (control.type === "user_input_required") {
    return {
      id: `interrupt:${toolCall.id}`,
      type: "user_input",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      prompt: control.prompt,
      payload: {
        input: toolCall.input,
        questions: control.questions
      }
    };
  }

  return {
    id: `interrupt:${toolCall.id}`,
    type: "approval",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    prompt: control.prompt,
    payload: {
      input: toolCall.input,
      plan: control.plan,
      action: control.action
    }
  };
}

function pendingEventFromInterrupt(interrupt: PendingInterrupt): NormalizedAgentEvent {
  const payload = isRecord(interrupt.payload) ? interrupt.payload : {};
  const input = isRecord(payload.input) ? payload.input : interrupt.payload;

  if (interrupt.type === "user_input") {
    return {
      type: "question_pending",
      data: {
        waitingForUserQuestion: true,
        toolUseId: interrupt.toolCallId,
        input,
        interrupt
      }
    };
  }

  return {
    type: "approval_pending",
    data: {
      waitingForApproval: true,
      toolUseId: interrupt.toolCallId,
      input,
      plan: payload.plan,
      interrupt
    }
  };
}

function statusForInterrupt(interrupt: PendingInterrupt): AgentStatus {
  return interrupt.type === "approval" ? "awaiting_approval" : "awaiting_user_input";
}

function inputProperty(input: unknown, property: string): unknown {
  return isRecord(input) ? input[property] : undefined;
}

function toolResultContentText(result: Record<string, unknown>): string {
  const content = result.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part) && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content === undefined || content === null) return "";
  return String(content).trim();
}

function getSessionIdFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  return typeof record.session_id === "string" ? record.session_id : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function errorCode(error: unknown): string {
  if (error instanceof ConcurrencyLimitError) return "concurrency_limit";
  if (error instanceof ValidationErrorLimitError) return error.code;
  if (error instanceof MissingClaudeSessionIdError) return error.code;
  if (error instanceof RunTimeoutError || error instanceof RunAbortedError) return error.code;
  return "agent_error";
}

function errorForRunFailure(error: unknown, abortReason: RunAbortReason | undefined, timeoutMs: number, timedOut: boolean): unknown {
  if (timedOut || abortReason === "timeout") return new RunTimeoutError(timeoutMs);
  if (abortReason) return new RunAbortedError(abortReason);
  return error;
}

function codeForAbortReason(reason: Exclude<RunAbortReason, "timeout">): RunAbortedError["code"] {
  if (reason === "interrupted") return "run_interrupted";
  if (reason === "client_disconnected") return "client_disconnected";
  if (reason === "disposed") return "run_disposed";
  return "run_closed";
}

function messageForAbortReason(reason: Exclude<RunAbortReason, "timeout">): string {
  if (reason === "interrupted") return "Agent run was interrupted";
  if (reason === "client_disconnected") return "Agent stream client disconnected before the run completed";
  if (reason === "disposed") return "Agent service shut down before the run completed";
  return "Agent run was closed before it completed";
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  return `${minutes}m`;
}

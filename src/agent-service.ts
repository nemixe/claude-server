import fs from "node:fs";
import path from "node:path";
import { getSessionMessages, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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
import type { AgentStatus, ClaudeMode, NormalizedAgentEvent, PendingInterrupt, SessionMetadata, StreamMessageRequest } from "./types.js";

export type AgentPrompt = string | AsyncIterable<SDKUserMessage>;

export type AgentSdkAdapter = {
  getSessionMessages: (sessionId: string, options?: { dir?: string; limit?: number; offset?: number }) => Promise<unknown[]>;
};

export type AgentRunInput = {
  session: SessionMetadata;
  request: StreamMessageRequest;
  onClaudeSessionId?: (claudeSessionId: string) => void | Promise<void>;
};

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
const CLAUDE_RULES_DIR = ".claude/rules";
const CLAUDE_RULE_FILE_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);

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

type ActiveRun = {
  handle: ActiveRunHandle;
  abortController: AbortController;
  observers: Set<EventQueue<NormalizedAgentEvent>>;
  closeOnFinish: boolean;
  closeOnError: boolean;
};

export const defaultAgentSdkAdapter: AgentSdkAdapter = {
  getSessionMessages: (sessionId, options) => getSessionMessages(sessionId, options) as Promise<unknown[]>
};

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

export class AgentService {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly pool: SessionPool;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private maxConcurrentRuns: number;
  private maxTurns: number;

  constructor(
    private readonly config: AppConfig,
    private readonly adapter: AgentSdkAdapter = defaultAgentSdkAdapter,
    sessionFactory: SessionFactory = createSessionFactory()
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
    const timeout = setTimeout(() => {
      abortController.abort();
      activeRun?.handle.close();
    }, this.config.runTimeoutMs);

    try {
      const register = (handle: ActiveRunHandle, options: { closeOnFinish: boolean; closeOnError: boolean }): ActiveRun => {
        activeRun = {
          handle,
          abortController,
          observers: new Set(),
          closeOnFinish: options.closeOnFinish,
          closeOnError: options.closeOnError
        };
        this.activeRuns.set(input.session.id, activeRun);
        return activeRun;
      };

      yield* this.streamWithSession(input, register);
    } catch (error) {
      if (activeRun) {
        if (activeRun.closeOnError) activeRun.handle.close();
        broadcastEvent(activeRun, { type: "error", data: { error: { code: "agent_error", message: errorMessage(error) } } });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (activeRun?.closeOnFinish) activeRun.handle.close();
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

    active.abortController.abort();
    await active.handle.interrupt?.();
    return true;
  }

  closeSession(sessionId: string): boolean {
    const active = this.activeRuns.get(sessionId);
    if (active) {
      active.abortController.abort();
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
      active.abortController.abort();
      active.handle.close();
      closeObservers(active);
      this.activeRuns.delete(sessionId);
    }
    this.pool.closeAll();
  }

  async getMessages(session: SessionMetadata, limit?: number, offset?: number): Promise<unknown[]> {
    if (session.hasRun && !session.claudeSessionId) {
      throw new MissingClaudeSessionIdError(session.id);
    }

    const sessionId = session.claudeSessionId ?? session.id;
    return this.adapter.getSessionMessages(sessionId, {
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

export function buildSessionOptions(config: AppConfig, session: SessionMetadata, request: StreamMessageRequest): SessionOptions {
  const mode = request.mode ?? session.mode;
  const model = request.model ?? config.defaultModel;
  if (!model) {
    throw new Error("CLAUDE_MODEL must be set or the stream request must include model");
  }
  const rulesPrompt = loadClaudeRulesPrompt(config.projectRoot);

  return {
    model,
    cwd: config.projectRoot,
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

export function loadClaudeRulesPrompt(projectRoot: string): string | undefined {
  const rulesDir = path.join(projectRoot, CLAUDE_RULES_DIR);
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
    `Project-specific rules loaded from \`${CLAUDE_RULES_DIR}\`. Follow these rules when working in this repository.`,
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
    if (entry.isFile() && CLAUDE_RULE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }
  return files.map((filePath) => path.resolve(root, path.relative(root, filePath)));
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
    "The following project rules are loaded from `.claude/rules` and apply to this request. Treat them as authoritative repository instructions.",
    "",
    "<project_rules>",
    rules,
    "</project_rules>",
    "",
    "User request:",
    prompt
  ].join("\n");
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

function permissionModeFor(mode: ClaudeMode): "plan" | "bypassPermissions" | "acceptEdits" {
  if (mode === "plan") return "plan";
  if (mode === "bypass") return "bypassPermissions";
  return "acceptEdits";
}

function disallowedToolsFor(mode: ClaudeMode): string[] {
  // Claude Code plan mode still needs Write available for the generated plan file.
  // The built-in plan permission mode owns the read-only guard for implementation files.
  return mode === "plan" ? ["Bash"] : [];
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

export const CLAUDE_MODES = ["plan", "edit", "bypass"] as const;
export const AGENT_PROVIDERS = ["claude", "codex"] as const;
export const BOTTLE_PROTOCOL_VERSION = 1 as const;

export type ClaudeMode = (typeof CLAUDE_MODES)[number];
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export type AgentStatus =
  | "planning"
  | "executing"
  | "awaiting_user_input"
  | "awaiting_approval"
  | "done"
  | "failed";

export type PendingInterrupt = {
  id: string;
  type: "user_input" | "approval";
  toolCallId: string;
  toolName: "AskUserQuestion" | "ExitPlanMode" | string;
  prompt: string;
  payload: unknown;
};

export type UploadedFile = {
  path: string;
  content?: string;
  contentBase64?: string;
};

export type ClaudeCommand = {
  path: string;
  content: string;
  updatedAt: string;
};

export type ClaudeCommandInput = {
  path: string;
  content: string;
};

export type BottleCommand = ClaudeCommand;
export type BottleCommandInput = ClaudeCommandInput;

export type WorkspaceSearchResult = {
  path: string;
  name: string;
  type: "file" | "directory";
  score: number;
  size?: number;
  updatedAt: string;
};

export type RootInfoResponse = {
  projectRoot: string;
  bottleDir: string;
  agentsDir: string;
  commandsDir: string;
  rulesDir: string;
  skillsDir: string;
  extraSkillRoots: string[];
  skillRoots: string[];
  claudeCommandsDir: string;
};

export type BottleWebAppContext = {
  url?: string;
  route?: string;
  title?: string;
  selectedText?: string;
  selectedElement?: string;
  viewport?: {
    width: number;
    height: number;
  };
  [key: string]: unknown;
};

export type BottleInfoResponse = {
  protocolVersion: typeof BOTTLE_PROTOCOL_VERSION;
  name: string;
  apiBaseUrl: string;
  appUrl?: string;
  mainAppUrl?: string;
  appProxyUrl?: string;
  defaultAgentProvider: AgentProvider;
  availableAgentProviders: AgentProvider[];
  features: {
    mainApp: boolean;
    mainAppProxy: boolean;
    mainAppDirect?: boolean;
    clientAtRoot?: boolean;
    iframeBridge: boolean;
    sessions: boolean;
    streaming: boolean;
    settings: boolean;
    claudeCommands: boolean;
    agents: boolean;
    commands: boolean;
    rules: boolean;
    skills: boolean;
    workspaceSearch: boolean;
    authToken: boolean;
  };
};

export type PromptImage = {
  name?: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  dataBase64: string;
};

export type SessionMetadata = {
  id: string;
  title?: string;
  userName?: string;
  provider: AgentProvider;
  mode: ClaudeMode;
  status?: AgentStatus;
  pendingInterrupt?: PendingInterrupt;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  hasRun: boolean;
  agentSessionId?: string;
  claudeSessionId?: string;
  costUsd?: number;
};

export type PublicSession = {
  id: string;
  sessionId: string;
  title?: string;
  userName?: string;
  provider: AgentProvider;
  mode: ClaudeMode;
  status?: AgentStatus;
  pendingInterrupt?: PendingInterrupt;
  createdAt: string;
  updatedAt: string;
  hasRun: boolean;
  costUsd?: number;
};

export type ListSessionsResponse = {
  sessions: PublicSession[];
  limit?: number;
  offset: number;
  nextOffset?: number;
  hasMore: boolean;
};

export type ListMessagesResponse = {
  messages: unknown[];
  offset: number;
  limit?: number;
  total: number;
  previousOffset?: number;
  nextOffset?: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
};

export type SettingsResponse = {
  maxConcurrentRuns: number;
  maxTurns: number;
  defaultAgentProvider: AgentProvider;
  availableAgentProviders: AgentProvider[];
};

export type UpdateSettingsRequest = {
  maxConcurrentRuns?: number;
  maxTurns?: number;
  defaultAgentProvider?: AgentProvider;
};

export type NormalizedAgentEvent = {
  type: string;
  data: unknown;
};

export type StreamMessageRequest = {
  prompt: string;
  images?: PromptImage[];
  context?: BottleWebAppContext;
  toolResult?: {
    toolUseId: string;
    content: string;
    kind?: "user_input" | "approval";
    approved?: boolean;
  };
  mode?: ClaudeMode;
  model?: string;
  maxTurns?: number;
};

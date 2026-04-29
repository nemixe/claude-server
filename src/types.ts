export const CLAUDE_MODES = ["plan", "edit", "bypass"] as const;

export type ClaudeMode = (typeof CLAUDE_MODES)[number];

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
  claudeCommandsDir: string;
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
  mode: ClaudeMode;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  hasRun: boolean;
  claudeSessionId?: string;
  costUsd?: number;
};

export type PublicSession = {
  id: string;
  sessionId: string;
  title?: string;
  userName?: string;
  mode: ClaudeMode;
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

export type NormalizedAgentEvent = {
  type: string;
  data: unknown;
};

export type StreamMessageRequest = {
  prompt: string;
  images?: PromptImage[];
  toolResult?: {
    toolUseId: string;
    content: string;
  };
  mode?: ClaudeMode;
  model?: string;
  maxTurns?: number;
};

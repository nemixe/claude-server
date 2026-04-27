export const CLAUDE_MODES = ["plan", "edit", "bypass"] as const;

export type ClaudeMode = (typeof CLAUDE_MODES)[number];

export type UploadedFile = {
  path: string;
  content?: string;
  contentBase64?: string;
};

export type SessionMetadata = {
  id: string;
  title?: string;
  mode: ClaudeMode;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  hasRun: boolean;
};

export type PublicSession = {
  id: string;
  sessionId: string;
  title?: string;
  mode: ClaudeMode;
  createdAt: string;
  updatedAt: string;
  hasRun: boolean;
};

export type NormalizedAgentEvent = {
  type: string;
  data: unknown;
};

export type StreamMessageRequest = {
  prompt: string;
  mode?: ClaudeMode;
  model?: string;
  maxTurns?: number;
};

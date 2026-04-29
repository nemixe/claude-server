import {
  formatMessageTimestamp,
  getDisplayLabel,
  getUserAccentStyle
} from "./chat-ui-utils.js";
import {
  AssistantAvatar,
  BubbleHeader,
  MessageContent,
  UserAvatar
} from "./message-content.jsx";
import { extractImageBlocks, redactImageData } from "./media-utils.js";

const ACTIVITY_ROLE = "assistant_activity";
const GUEST_USER_NAME = "Guest";

export function eventsToBubbleItems(events, userName = GUEST_USER_NAME) {
  const userLabel = getDisplayLabel(userName || GUEST_USER_NAME);
  const items = events.flatMap((entry) => {
    if (!entry) return [];
    if (shouldSkipDisplayEntry(entry.type, entry.data)) return [];
    const displayType = getDisplayEntryType(entry.type, entry.data);
    const timestamp = formatMessageTimestamp(entry.timestamp);
    const meta = timestamp;

    if (displayType === "prompt") {
      const images = Array.isArray(entry.data?.images) ? entry.data.images : [];
      const text = entry.data?.prompt ? String(entry.data.prompt) : "";
      return [
        createBubbleItem(entry.id, "user", {
          header: <BubbleHeader label={userLabel} meta={meta} timeFirst />,
          avatar: <UserAvatar label={userLabel} />,
          content: <MessageContent text={text} images={images} />,
          copyText: text,
          styles: getUserBubbleStyles(userLabel)
        })
      ];
    }

    if (displayType === "history") {
      if (entry.data && entry.data.empty) return [createActivity(entry.id, "History", "No saved messages yet for this session.")];
      return toProtocolItems(entry.data, meta, entry.id, userLabel);
    }

    if (displayType === "message") {
      return toProtocolItems(entry.data, timestamp, entry.id, userLabel);
    }

    if (displayType === "result") {
      return resultToItems(entry, displayType);
    }

    if (displayType === "client_error" || displayType === "error") {
      return [createActivity(entry.id, "Error", activityText(entry.type, entry.data), "error")];
    }

    return [createToolActivity(entry.id, activityLabel(entry.type, entry.data), activityText(entry.type, entry.data), activityTone(entry.type))];
  });

  return mergeToolResultsIntoToolUse(items);
}

function resultToItems(entry, type = entry.type) {
  const data = entry.data;
  return [createActivity(entry.id, "Run error", activityText(type, data), "error")];
}

export function shouldSkipDisplayEntry(type, data) {
  const displayType = getDisplayEntryType(type, data);
  if (displayType === "system") return true;
  if (displayType === "result") return !(data && typeof data === "object" && data.is_error === true);
  if (displayType !== "history" && displayType !== "message") return false;

  return getProtocolRole(data) === "system";
}

function getDisplayEntryType(type, data) {
  if (type !== "history" && type !== "message") return type;

  const messageType = data && typeof data === "object" ? data.type : undefined;
  if (messageType === "system" || messageType === "result") return messageType;
  return type;
}

function getProtocolRole(value) {
  if (!value || typeof value !== "object") return null;
  const record = value;
  const messageRecord = record.message && typeof record.message === "object" ? record.message : record;
  return normalizeRole(messageRecord.role || record.type);
}

function mergeToolResultsIntoToolUse(items) {
  const toolUseById = new Map();

  for (const item of items) {
    if (item.role === ACTIVITY_ROLE && item.toolUseId && item.label && item.label.startsWith("Tool use")) {
      toolUseById.set(item.toolUseId, item);
    }
  }

  const merged = [];

  for (const item of items) {
    if (item.role === ACTIVITY_ROLE && item.toolUseId && item.label === "Tool result") {
      const parent = toolUseById.get(item.toolUseId);
      if (parent) {
        parent.toolResult = item.details || item.content || "";
        continue;
      }
    }
    merged.push(item);
  }

  return merged;
}

export function findFirstUserPrompt(messages) {
  if (!Array.isArray(messages)) return "";
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.parent_tool_use_id) continue;
    const inner = message.message && typeof message.message === "object" ? message.message : message;
    const role = inner.role || message.type;
    if (role !== "user") continue;
    const content = inner.content !== undefined ? inner.content : message.content;
    if (typeof content === "string" && content.trim()) return content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join(" ")
      .trim();
    if (text) return text;
  }
  return "";
}

export function getActiveAskUserQuestion(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index];
    if (!entry) continue;
    if (entry.type === "question_pending" && entry.data?.waitingForUserQuestion && Array.isArray(entry.data?.input?.questions)) {
      return {
        id: entry.id,
        data: entry.data.input,
        toolUseId: entry.data.toolUseId
      };
    }
    const tool = findAskUserQuestionTool(entry.data);
    if (tool?.input) {
      return {
        id: entry.id,
        data: tool.input,
        toolUseId: tool.id
      };
    }
    if (closesAskUserQuestion(entry)) return null;
  }
  return null;
}

export function getActiveExitPlanApproval(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index];
    if (!entry) continue;
    if (entry.type === "approval_pending" && entry.data?.waitingForApproval) {
      const input = entry.data.input && typeof entry.data.input === "object" ? entry.data.input : {};
      return {
        id: entry.id,
        data: input,
        plan: typeof entry.data.plan === "string" ? entry.data.plan : typeof input.plan === "string" ? input.plan : "",
        toolUseId: entry.data.toolUseId
      };
    }
    const tool = findExitPlanModeTool(entry.data);
    if (tool?.input) {
      return {
        id: entry.id,
        data: tool.input,
        plan: typeof tool.input.plan === "string" ? tool.input.plan : "",
        toolUseId: tool.id
      };
    }
    if (closesExitPlanApproval(entry)) return null;
  }
  return null;
}

function closesAskUserQuestion(entry) {
  if (!entry) return false;
  if (entry.type === "prompt" || entry.type === "result") return true;
  if (entry.type === "done") return !entry.data?.waitingForUserQuestion;
  if (entry.type !== "history" && entry.type !== "message") return false;

  const record = entry.data && typeof entry.data === "object" ? entry.data : {};
  const message = record.message && typeof record.message === "object" ? record.message : record;
  const role = normalizeRole(message.role || record.type);
  const content = message.content !== undefined ? message.content : record.content;
  const blocks = Array.isArray(content) ? content : [];

  if (role !== "user") return false;
  if (record.parent_tool_use_id || message.parent_tool_use_id) return false;
  if (!Array.isArray(content)) return Boolean(extractTextContent(content));
  const toolResults = blocks.filter((block) => block && typeof block === "object" && block.type === "tool_result");
  if (toolResults.length > 0) {
    const allErrored = toolResults.every((block) => block.is_error === true);
    if (allErrored) return false;
    return true;
  }
  return blocks.some((block) => block && typeof block === "object" && block.type === "text" && String(block.text || "").trim());
}

function closesExitPlanApproval(entry) {
  if (!entry) return false;
  if (entry.type === "done") return !entry.data?.waitingForApproval;
  return closesAskUserQuestion(entry);
}

function findAskUserQuestionTool(value) {
  if (!value || typeof value !== "object") return null;
  const record = value;
  const message = record.message && typeof record.message === "object" ? record.message : record;
  if (message.stop_reason !== "tool_use") return null;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return (
    blocks.find(
      (block) =>
        block &&
        typeof block === "object" &&
        block.type === "tool_use" &&
        block.name === "AskUserQuestion" &&
        block.input &&
        Array.isArray(block.input.questions)
    ) || null
  );
}

function findExitPlanModeTool(value) {
  if (!value || typeof value !== "object") return null;
  const record = value;
  const message = record.message && typeof record.message === "object" ? record.message : record;
  if (message.stop_reason !== "tool_use" && message.stop_reason !== null && message.stop_reason !== undefined) return null;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return (
    blocks.find(
      (block) =>
        block &&
        typeof block === "object" &&
        block.type === "tool_use" &&
        block.name === "ExitPlanMode" &&
        typeof block.id === "string"
    ) || null
  );
}

function toProtocolItems(value, meta, keyBase, userName = GUEST_USER_NAME) {
  if (!value || typeof value !== "object") return [];
  const record = value;
  const messageRecord = record.message && typeof record.message === "object" ? record.message : record;
  const rawRole = normalizeRole(messageRecord.role || record.type);
  if (!rawRole) return [];
  const isAgentToolEcho =
    rawRole === "user" &&
    (record.parent_tool_use_id || messageRecord.parent_tool_use_id);
  const role = isAgentToolEcho ? "assistant" : rawRole;

  const content = messageRecord.content !== undefined ? messageRecord.content : record.content !== undefined ? record.content : record.message;
  const blocks = Array.isArray(content) ? content : [];
  const items = [];

  if (!Array.isArray(content)) {
    const text = extractTextContent(content);
    const images = extractImageBlocks(content);
    if (!text && images.length === 0) return [];
    items.push(
      createBubbleItem(keyBase, role === "user" ? "user" : "assistant", {
        header: <BubbleHeader label={role === "user" ? userName : "Agent"} meta={meta} timeFirst={role === "user"} />,
        avatar: role === "assistant" ? <AssistantAvatar /> : <UserAvatar label={userName} />,
        content: <MessageContent text={text} images={images} />,
        copyText: text,
        styles: role === "user" ? getUserBubbleStyles(userName) : undefined
      })
    );
    return items;
  }

  const hasProtocolBlocks = blocks.some((block) => block && typeof block === "object" && ["tool_result", "tool_use", "thinking"].includes(block.type));
  const humanUser = role === "user" && !hasProtocolBlocks;
  if (humanUser) {
    const text = extractTextContent(blocks);
    const images = extractImageBlocks(blocks);
    if (text || images.length > 0) {
      items.push(
        createBubbleItem(keyBase, "user", {
          header: <BubbleHeader label={userName} meta={meta} timeFirst />,
          avatar: <UserAvatar label={userName} />,
          content: <MessageContent text={text} images={images} />,
          copyText: text,
          styles: getUserBubbleStyles(userName)
        })
      );
    }
    return items;
  }

  let textParts = [];
  let imageParts = [];

  function flushText(index) {
    const text = textParts.join("\n").trim();
    if (!text && imageParts.length === 0) return;
    items.push(
      createBubbleItem(`${keyBase}:text:${index}`, role === "user" ? ACTIVITY_ROLE : "assistant", {
        header: role === "assistant" ? <BubbleHeader label="Agent" meta={meta} /> : undefined,
        avatar: role === "assistant" ? <AssistantAvatar /> : undefined,
        content: role === "assistant" ? <MessageContent text={text} images={imageParts} /> : `User protocol input\n\n${text}`,
        copyText: text
      })
    );
    textParts = [];
    imageParts = [];
  }

  blocks.forEach((block, index) => {
    if (typeof block === "string") {
      textParts.push(block);
      return;
    }
    if (!block || typeof block !== "object") return;

    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      return;
    }
    if (block.type === "image") {
      imageParts.push(...extractImageBlocks(block));
      return;
    }
    if (block.type === "tool_use") {
      flushText(index);
      items.push(createToolActivity(`${keyBase}:tool_use:${index}`, "Tool use" + (block.name ? ": " + block.name : ""), formatToolUseBlock(block), "tool", block.id));
      return;
    }
    if (block.type === "tool_result") {
      flushText(index);
      items.push(createToolActivity(`${keyBase}:tool_result:${index}`, "Tool result", formatToolResultBlock(block), "tool", block.tool_use_id));
      return;
    }
    if (block.type === "thinking") {
      flushText(index);
      items.push(createToolActivity(`${keyBase}:thinking:${index}`, "Assistant thinking", formatThinkingBlock(block), "muted"));
      return;
    }

    const text = extractTextContent(block);
    if (text) textParts.push(text);
  });

  flushText(blocks.length);
  return items;
}

function createBubbleItem(key, role, options) {
  return {
    key,
    role,
    header: options.header,
    avatar: options.avatar,
    content: options.content,
    copyText: options.copyText,
    styles: options.styles,
    className: "ai-chat-bubble-item"
  };
}

function getUserBubbleStyles(userName) {
  const accentStyle = getUserAccentStyle(userName);
  return {
    content: {
      background: accentStyle["--ai-chat-user-accent-bg"],
      backgroundColor: accentStyle["--ai-chat-user-accent-bg"],
      color: accentStyle["--ai-chat-user-accent-fg"]
    }
  };
}

function createActivity(key, label, text, tone = "muted") {
  return {
    key,
    role: ACTIVITY_ROLE,
    tone,
    content: [label, text].filter(Boolean).join("\n\n")
  };
}

function createToolActivity(key, label, details, tone = "tool", toolUseId) {
  return {
    key,
    role: ACTIVITY_ROLE,
    tone,
    collapsible: true,
    label,
    details: details || "",
    toolUseId: toolUseId || null,
    toolResult: null
  };
}

export function normalizeRole(value) {
  if (value === "user" || value === "assistant" || value === "system") return value;
  if (value === "tool" || value === "tool_use" || value === "tool_result") return "tool";
  return null;
}

function formatToolResultBlock(block) {
  const body = extractTextContent(block.content) || (typeof block.content === "string" ? block.content : JSON.stringify(redactImageData(block.content), null, 2));
  return body;
}

function formatToolUseBlock(block) {
  return [
    block.id ? "Tool use id: `" + block.id + "`" : "",
    block.input ? "```json\n" + JSON.stringify(redactImageData(block.input), null, 2) + "\n```" : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatThinkingBlock(block) {
  const value = block.thinking ?? block.text ?? block.content;
  const text = extractTextContent(value);
  if (text) return formatMaybeJsonMarkdown(text);
  if (value && typeof value === "object") return formatJsonMarkdown(value);
  return formatJsonMarkdown(block);
}

function formatMaybeJsonMarkdown(value) {
  const text = String(value ?? "");
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("```") || !/^[\[{]/.test(trimmed)) return text;

  try {
    return formatJsonMarkdown(JSON.parse(trimmed));
  } catch {
    return text;
  }
}

function formatJsonMarkdown(value) {
  return "```json\n" + JSON.stringify(redactImageData(value), null, 2) + "\n```";
}

function activityTone(type) {
  if (type === "client_error" || type === "error") return "error";
  if (type === "result" || type === "command_saved" || type === "command_deleted") return "success";
  if (type === "tool_use" || type === "tool_result" || type === "system") return "tool";
  return "muted";
}

function activityLabel(type, data) {
  if (type === "result") return "Run result";
  if (type === "tool_use") return "Tool use" + (data && data.name ? ": " + data.name : "");
  if (type === "tool_result") return "Tool result";
  if (type === "system") return "System";
  if (type === "command_saved") return "Command saved";
  if (type === "command_deleted") return "Command deleted";
  if (type === "session_created") return "Session created";
  if (type === "session_selected") return "Session selected";
  if (type === "session_restored") return "Session restored";
  if (type === "client") return "Client";
  return titleFromEventType(type);
}

function activityText(type, data) {
  if (typeof data === "string") return data;
  if (type === "result" && data && typeof data === "object") {
    return [
      data.result ? String(data.result) : "",
      data.terminal_reason ? "Terminal reason: " + data.terminal_reason : "",
      Number.isFinite(data.duration_ms) ? "Duration: " + data.duration_ms + " ms" : "",
      Number.isFinite(data.total_cost_usd) ? "Cost: $" + data.total_cost_usd : ""
    ]
      .filter(Boolean)
      .join("\n");
  }

  const text = extractTextContent(data);
  if (text) return text;
  return JSON.stringify(redactImageData(data), null, 2);
}

export function extractTextContent(value) {
  if (typeof value === "string") return value;
  if (!value) return "";
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (typeof block === "string") return block;
        if (!block || typeof block !== "object") return "";
        if (typeof block.text === "string") return block.text;
        if (typeof block.content === "string") return block.content;
        if (block.type === "tool_use") return "[tool_use" + (block.name ? ":" + block.name : "") + "]";
        if (block.type === "tool_result") return "[tool_result]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (typeof value.result === "string") return value.result;
    if (value.message !== value) return extractTextContent(value.message);
  }
  return "";
}

function titleFromEventType(value) {
  return String(value || "event")
    .replace(/[_:]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const AVATAR_THEMES = [
  { bg: "#dbeafe", fg: "#1e3a8a" },
  { bg: "#cffafe", fg: "#155e75" },
  { bg: "#d1fae5", fg: "#065f46" },
  { bg: "#fef3c7", fg: "#92400e" },
  { bg: "#fee2e2", fg: "#991b1b" },
  { bg: "#ede9fe", fg: "#5b21b6" },
  { bg: "#fce7f3", fg: "#9d174d" },
  { bg: "#e0e7ff", fg: "#3730a3" },
  { bg: "#ccfbf1", fg: "#0f766e" },
  { bg: "#ffedd5", fg: "#9a3412" },
  { bg: "#f3e8ff", fg: "#6b21a8" },
  { bg: "#ecfccb", fg: "#3f6212" },
  { bg: "#e0f2fe", fg: "#075985" },
  { bg: "#fae8ff", fg: "#86198f" },
  { bg: "#dcfce7", fg: "#166534" },
  { bg: "#fef9c3", fg: "#854d0e" }
];

export function normalizeUserLabel(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

export function getDisplayLabel(value) {
  return normalizeUserLabel(value) || "Anonymous";
}

export function getAvatarThemeFromLabel(value) {
  const label = getDisplayLabel(value);
  let hash = 0;

  for (let index = 0; index < label.length; index += 1) {
    hash = (hash * 31 + label.charCodeAt(index)) >>> 0;
  }

  return AVATAR_THEMES[hash % AVATAR_THEMES.length];
}

export function getUserAccentStyle(value) {
  const theme = getAvatarThemeFromLabel(value);

  return {
    "--ai-chat-user-accent-bg": theme.bg,
    "--ai-chat-user-accent-bg-hover": hexToRgba(theme.bg, 0.68),
    "--ai-chat-user-accent-bg-active": hexToRgba(theme.bg, 0.82),
    "--ai-chat-user-accent-border": hexToRgba(theme.fg, 0.28),
    "--ai-chat-user-accent-ring": hexToRgba(theme.fg, 0.18),
    "--ai-chat-user-accent-fg": theme.fg,
    "--ai-chat-user-accent-muted": hexToRgba(theme.fg, 0.68),
    "--ai-chat-user-accent-strong": theme.bg,
    "--ai-chat-user-accent-strong-text": theme.fg
  };
}

export function getCreateButtonAccentStyle(value) {
  const theme = getAvatarThemeFromLabel(value);

  return {
    "--ai-chat-create-accent-border": hexToRgba(theme.fg, 0.28),
    "--ai-chat-create-accent-bg-hover": hexToRgba(theme.bg, 0.68),
    "--ai-chat-create-accent-fg": theme.fg
  };
}

function hexToRgba(value, alpha) {
  const hex = typeof value === "string" ? value.replace("#", "") : "";
  if (!/^[0-9a-f]{6}$/i.test(hex)) return `rgba(22, 119, 255, ${alpha})`;

  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export function normalizeSessionTitle(title, fallback = "Untitled chat") {
  if (typeof title !== "string") return fallback;
  const normalized = title.replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

const PROMPT_TITLE_MAX_CHARS = 100;

export function derivePromptTitle(value, max = PROMPT_TITLE_MAX_CHARS) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= max) return normalized;
  const sliced = normalized.slice(0, max).replace(/\s+\S*$/, "").trim();
  return (sliced || normalized.slice(0, max).trim()) + "…";
}

export function formatSessionCost(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  if (value < 0.01) return "<$0.01";
  return "$" + value.toFixed(value < 1 ? 3 : 2);
}

export function formatSessionTimestamp(value) {
  if (!value) return "Recently";

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";

  const now = new Date();
  const isSameDay =
    now.getFullYear() === date.getFullYear() &&
    now.getMonth() === date.getMonth() &&
    now.getDate() === date.getDate();

  if (isSameDay) {
    return date.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit"
    });
  }

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric"
  });
}

const MESSAGE_TIMESTAMP_KEYS = ["timestamp", "createdAt", "created_at"];

export function getMessageTimestamp(value) {
  if (!value || typeof value !== "object") return "";

  return readTimestampFromRecord(value) || readTimestampFromRecord(value.message);
}

export function formatMessageTimestamp(value) {
  const date = toValidDate(value);
  if (!date) return "";

  const now = new Date();
  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
  const isSameDay =
    now.getFullYear() === date.getFullYear() &&
    now.getMonth() === date.getMonth() &&
    now.getDate() === date.getDate();

  if (isSameDay) return time;

  return [
    date.toLocaleDateString([], {
      month: "short",
      day: "numeric"
    }),
    time
  ].join(", ");
}

function readTimestampFromRecord(value) {
  if (!value || typeof value !== "object") return "";

  for (const key of MESSAGE_TIMESTAMP_KEYS) {
    const timestamp = normalizeTimestamp(value[key]);
    if (timestamp) return timestamp;
  }

  return "";
}

function normalizeTimestamp(value) {
  const date = toValidDate(value);
  return date ? date.toISOString() : "";
}

function toValidDate(value) {
  if (!value) return null;

  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date;
}

export function resolveAskUserQuestionData(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const questions = Array.isArray(source.questions) ? source.questions : [];

  return {
    text: typeof source.text === "string" ? source.text : "",
    questions: questions.map((question, index) => ({
      header:
        typeof question?.header === "string" && question.header.trim()
          ? question.header.trim()
          : `Step ${index + 1}`,
      question:
        typeof question?.question === "string" && question.question.trim()
          ? question.question.trim()
          : "",
      multiSelect: Boolean(question?.multiSelect),
      options: Array.isArray(question?.options)
        ? question.options
            .map((option) => ({
              label: typeof option?.label === "string" ? option.label.trim() : "",
              description:
                typeof option?.description === "string"
                  ? option.description.trim()
                  : ""
            }))
            .filter((option) => option.label)
        : []
    }))
  };
}

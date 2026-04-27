const AVATAR_THEMES = [
  { bg: "#2563eb", fg: "#ffffff" },
  { bg: "#0891b2", fg: "#ffffff" },
  { bg: "#059669", fg: "#ffffff" },
  { bg: "#ca8a04", fg: "#111827" },
  { bg: "#dc2626", fg: "#ffffff" },
  { bg: "#9333ea", fg: "#ffffff" }
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

export function normalizeSessionTitle(title, fallback = "Untitled chat") {
  if (typeof title !== "string") return fallback;
  const normalized = title.replace(/\s+/g, " ").trim();
  return normalized || fallback;
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

const DEFAULT_CHAT_WIDTH = 920;
const DEFAULT_CHAT_HEIGHT = 780;
const MIN_CHAT_WIDTH = 640;
const MIN_CHAT_HEIGHT = 420;
export const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const MIN_MAIN_COLUMN_WIDTH = 340;
const VIEWPORT_PADDING = 12;

export function initialChatFrame() {
  const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2);
  const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2);
  const width = Math.min(DEFAULT_CHAT_WIDTH, Math.max(Math.min(MIN_CHAT_WIDTH, availableWidth), window.innerWidth - 48));
  const height = Math.min(DEFAULT_CHAT_HEIGHT, Math.max(Math.min(MIN_CHAT_HEIGHT, availableHeight), window.innerHeight - 48));
  return clampChatFrame({
    x: Math.max(16, window.innerWidth - width - 28),
    y: 28,
    width,
    height
  });
}

export function clampChatFrame(frame) {
  const maxWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2);
  const maxHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2);
  const minWidth = Math.min(MIN_CHAT_WIDTH, maxWidth);
  const minHeight = Math.min(MIN_CHAT_HEIGHT, maxHeight);
  const width = clampNumber(frame.width, minWidth, maxWidth);
  const height = clampNumber(frame.height, minHeight, maxHeight);
  return {
    x: clampNumber(frame.x, VIEWPORT_PADDING, Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING)),
    y: clampNumber(frame.y, VIEWPORT_PADDING, Math.max(VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING)),
    width,
    height
  };
}

export function clampSidebarWidth(width, container) {
  const containerWidth = container?.getBoundingClientRect().width || DEFAULT_CHAT_WIDTH;
  const maxWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, containerWidth - MIN_MAIN_COLUMN_WIDTH));
  return Math.round(clampNumber(width, MIN_SIDEBAR_WIDTH, maxWidth));
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function beginResizeInteraction(cursor) {
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  document.body.classList.add("ai-chat-resizing");
  document.body.style.cursor = cursor;
  document.body.style.userSelect = "none";
  return () => {
    document.body.classList.remove("ai-chat-resizing");
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
  };
}

export function beginDragInteraction() {
  const previousUserSelect = document.body.style.userSelect;
  document.body.classList.add("ai-chat-dragging");
  document.body.style.userSelect = "none";
  return () => {
    document.body.classList.remove("ai-chat-dragging");
    document.body.style.userSelect = previousUserSelect;
  };
}

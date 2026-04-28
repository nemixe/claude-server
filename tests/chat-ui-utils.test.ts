import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatMessageTimestamp,
  getAvatarThemeFromLabel,
  getMessageTimestamp,
  getUserAccentStyle
} from "../client/src/agent-chat/chat-ui-utils.js";

describe("chat UI timestamp helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats a top-level timestamp", () => {
    const now = new Date(2026, 3, 28, 12, 0);
    const messageDate = new Date(2026, 3, 28, 10, 15);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const timestamp = getMessageTimestamp({ timestamp: messageDate.toISOString() });

    expect(timestamp).toBe(messageDate.toISOString());
    expect(formatMessageTimestamp(timestamp)).toBe(
      messageDate.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit"
      })
    );
  });

  it("formats a nested message timestamp", () => {
    const now = new Date(2026, 3, 28, 12, 0);
    const messageDate = new Date(2026, 3, 27, 10, 15);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const timestamp = getMessageTimestamp({ message: { timestamp: messageDate.toISOString() } });

    expect(timestamp).toBe(messageDate.toISOString());
    expect(formatMessageTimestamp(timestamp)).toBe(
      [
        messageDate.toLocaleDateString([], {
          month: "short",
          day: "numeric"
        }),
        messageDate.toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit"
        })
      ].join(", ")
    );
  });

  it("uses created-at fields as timestamp data", () => {
    const createdAt = new Date(2026, 3, 28, 9, 30).toISOString();

    expect(getMessageTimestamp({ createdAt })).toBe(createdAt);
    expect(getMessageTimestamp({ created_at: createdAt })).toBe(createdAt);
  });

  it("falls back to empty strings when no valid time data exists", () => {
    expect(getMessageTimestamp({})).toBe("");
    expect(getMessageTimestamp({ timestamp: "not a date", message: { timestamp: "also not a date" } })).toBe("");
    expect(formatMessageTimestamp("")).toBe("");
    expect(formatMessageTimestamp("not a date")).toBe("");
  });
});

describe("chat UI user accent helpers", () => {
  it("derives accent variables from the avatar theme", () => {
    const avatarTheme = getAvatarThemeFromLabel("Jason");
    const accentStyle = getUserAccentStyle("Jason");

    expect(accentStyle["--ai-chat-user-accent-bg"]).toBe(avatarTheme.bg);
    expect(accentStyle["--ai-chat-user-accent-fg"]).toBe(avatarTheme.fg);
    expect(accentStyle["--ai-chat-user-accent-bg-hover"]).toMatch(/^rgba\(/);
    expect(accentStyle["--ai-chat-user-accent-ring"]).toMatch(/^rgba\(/);
  });
});

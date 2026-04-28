import { Button, Input, Select } from "antd";
import { PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import {
  formatSessionCost,
  formatSessionTimestamp,
  getAvatarThemeFromLabel,
  getDisplayLabel,
  normalizeSessionTitle
} from "./chat-ui-utils.js";

const GUEST_USER_NAME = "Guest";

export default function SessionSidebar({
  filteredSessions,
  activeSessionKey,
  sessionSearchQuery,
  setSessionSearchQuery,
  creatorFilter,
  setCreatorFilter,
  creatorFilterOptions,
  onCreateNewSession,
  onSessionSelect,
  onRefreshSessions
}) {
  return (
    <>
      <div className="ai-chat-sessions-controls">
        <div className="ai-chat-sessions-header-row">
          <span className="ai-chat-sessions-heading">Sessions</span>
          <Select
            size="small"
            variant="borderless"
            className="ai-chat-session-creator-filter"
            value={creatorFilter || ""}
          onChange={(value) => setCreatorFilter(value || "")}
          options={[{ value: "", label: "All creators" }].concat(creatorFilterOptions || [])}
          optionFilterProp="label"
          popupMatchSelectWidth={false}
          aria-label="Filter sessions by creator"
        />
        </div>
        <Input
          size="small"
          placeholder="Search sessions"
          prefix={<SearchOutlined />}
          value={sessionSearchQuery}
          onChange={(event) => setSessionSearchQuery(event.target.value)}
          allowClear
          aria-label="Search sessions"
        />
        <Button
          size="small"
          type="text"
          icon={<ReloadOutlined />}
          onClick={onRefreshSessions}
          aria-label="Refresh sessions"
          title="Refresh sessions"
        />
      </div>
      <div className="ai-chat-sessions-list" role="list" aria-label="Chat sessions">
        <button
          type="button"
          className="ai-chat-session-item ai-chat-session-item-create"
          onClick={onCreateNewSession}
          aria-label="New session"
          title="New Session"
          role="listitem"
        >
          <span className="ai-chat-session-create-label">
            <PlusOutlined />
            <span>New Session</span>
          </span>
        </button>
        {filteredSessions.length === 0 ? (
          <p className="ai-chat-sessions-empty">No sessions found.</p>
        ) : null}
        {filteredSessions.map((session) => {
          const id = session.sessionId || session.id || "";
          const isActive = id === activeSessionKey;
          const userName = getDisplayLabel(session.userName || GUEST_USER_NAME);
          const avatarTheme = getAvatarThemeFromLabel(userName);
          const timestamp = formatSessionTimestamp(session.updatedAt ?? session.createdAt);
          const cost = formatSessionCost(session.costUsd);
          return (
            <button
              key={id}
              type="button"
              className={`ai-chat-session-item${isActive ? " active" : ""}`}
              onClick={() => onSessionSelect(id)}
              role="listitem"
              aria-current={isActive ? "true" : undefined}
            >
              <span
                className="ai-chat-session-avatar"
                style={{ background: avatarTheme.bg, color: avatarTheme.fg }}
                aria-hidden="true"
              >
                {initialsFromName(userName)}
              </span>
              <span className="ai-chat-session-body">
                <span className="ai-chat-session-title">
                  {normalizeSessionTitle(session.title, id ? `Session ${id.slice(0, 8)}` : "New chat")}
                </span>
                <span className="ai-chat-session-meta">
                  <span className="ai-chat-session-user" title={userName}>
                    {userName}
                  </span>
                  <span className="ai-chat-session-details">
                    {[timestamp, session.mode, cost]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function initialsFromName(value) {
  const words = getDisplayLabel(value)
    .split(/\s+/)
    .filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0] || GUEST_USER_NAME];
  return letters
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

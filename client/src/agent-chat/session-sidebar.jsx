import { Button, Input } from "antd";
import { FilterOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { formatSessionCost, formatSessionTimestamp, normalizeSessionTitle } from "./chat-ui-utils.js";

export default function SessionSidebar({
  filteredSessions,
  activeSessionKey,
  sessionSearchQuery,
  setSessionSearchQuery,
  hideEmptySessions,
  setHideEmptySessions,
  onCreateNewSession,
  onSessionSelect,
  onRefreshSessions
}) {
  return (
    <>
      <div className="ai-chat-sessions-controls">
        <Input
          size="small"
          placeholder="Search..."
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
        <Button
          size="small"
          type="text"
          icon={<FilterOutlined />}
          className={hideEmptySessions ? "ai-chat-filter-active" : ""}
          onClick={() => setHideEmptySessions((value) => !value)}
          aria-pressed={hideEmptySessions}
          aria-label={hideEmptySessions ? "Show empty sessions" : "Hide empty sessions"}
          title={hideEmptySessions ? "Show empty sessions" : "Hide empty sessions"}
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
          return (
            <button
              key={id}
              type="button"
              className={`ai-chat-session-item${isActive ? " active" : ""}`}
              onClick={() => onSessionSelect(id)}
              role="listitem"
              aria-current={isActive ? "true" : undefined}
            >
              <span className="ai-chat-session-title">
                {normalizeSessionTitle(session.title, id ? `Session ${id.slice(0, 8)}` : "New chat")}
              </span>
              <span className="ai-chat-session-meta">
                {[
                  formatSessionTimestamp(session.updatedAt ?? session.createdAt),
                  session.mode,
                  formatSessionCost(session.costUsd)
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

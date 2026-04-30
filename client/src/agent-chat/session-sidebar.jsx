import { useCallback, useMemo, useRef } from "react";
import { Button, Input, Select } from "antd";
import { PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  formatSessionCost,
  formatSessionTimestamp,
  getAvatarThemeFromLabel,
  getDisplayLabel,
  normalizeSessionTitle
} from "./chat-ui-utils.js";

const GUEST_USER_NAME = "Guest";
const SESSION_ROW_HEIGHT = 62;
const CREATE_ROW_HEIGHT = 70;
const STATUS_ROW_HEIGHT = 44;
const LOAD_MORE_ROW_HEIGHT = 52;

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
  onRefreshSessions,
  onLoadMoreSessions,
  hasMoreSessions,
  isLoadingSessions
}) {
  const listRef = useRef(null);
  const rows = useMemo(() => {
    const nextRows = [{ type: "create", key: "create" }];
    if (filteredSessions.length === 0) {
      nextRows.push({ type: "empty", key: "empty" });
    } else {
      filteredSessions.forEach((session) => {
        nextRows.push({ type: "session", key: getSessionId(session), session });
      });
    }
    if (isLoadingSessions) nextRows.push({ type: "loading", key: "loading" });
    else if (hasMoreSessions) nextRows.push({ type: "load-more", key: "load-more" });
    return nextRows;
  }, [filteredSessions, hasMoreSessions, isLoadingSessions]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: (index) => rowHeight(rows[index]),
    overscan: 8
  });

  const handleListScroll = useCallback(
    (event) => {
      if (!hasMoreSessions || isLoadingSessions || !onLoadMoreSessions) return;
      const list = event.currentTarget;
      const remaining = list.scrollHeight - list.scrollTop - list.clientHeight;
      if (remaining <= 56) onLoadMoreSessions();
    },
    [hasMoreSessions, isLoadingSessions, onLoadMoreSessions]
  );

  return (
    <>
      <div className="ai-chat-sessions-controls">
        <div className="ai-chat-sessions-header-row">
          <span className="ai-chat-sessions-heading">Sessions</span>
          <Select
            size="small"
            variant="borderless"
            className="ai-chat-session-creator-filter"
            popupClassName="ai-chat-session-creator-filter-popup"
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
      <div
        ref={listRef}
        className="ai-chat-sessions-list"
        role="list"
        aria-label="Chat sessions"
        onScroll={handleListScroll}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            return (
              <div
                key={row.key}
                data-index={virtualRow.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                  paddingBottom: 4
                }}
              >
                {row.type === "create" ? (
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
                ) : row.type === "empty" ? (
                  <p className="ai-chat-sessions-empty">No sessions found.</p>
                ) : row.type === "loading" ? (
                  <p className="ai-chat-sessions-empty">Loading sessions...</p>
                ) : row.type === "load-more" ? (
                  <button type="button" className="ai-chat-sessions-load-more" onClick={onLoadMoreSessions}>
                    Load more sessions
                  </button>
                ) : (
                  <SessionRow
                    session={row.session}
                    activeSessionKey={activeSessionKey}
                    onSessionSelect={onSessionSelect}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function rowHeight(row) {
  if (row?.type === "create") return CREATE_ROW_HEIGHT;
  if (row?.type === "load-more") return LOAD_MORE_ROW_HEIGHT;
  if (row?.type === "empty" || row?.type === "loading") return STATUS_ROW_HEIGHT;
  return SESSION_ROW_HEIGHT;
}

function SessionRow({ session, activeSessionKey, onSessionSelect }) {
  const id = getSessionId(session);
  const isActive = id === activeSessionKey;
  const userName = getDisplayLabel(session.userName || GUEST_USER_NAME);
  const avatarTheme = getAvatarThemeFromLabel(userName);
  const timestamp = formatSessionTimestamp(session.updatedAt ?? session.createdAt);
  const cost = formatSessionCost(session.costUsd);

  return (
    <button
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
            {[timestamp, session.mode, cost].filter(Boolean).join(" · ")}
          </span>
        </span>
      </span>
    </button>
  );
}

function getSessionId(session) {
  return session.sessionId || session.id || "";
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

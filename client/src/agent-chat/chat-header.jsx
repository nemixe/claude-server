import { Button, Dropdown, Space } from "antd";
import {
  CloseOutlined,
  DownloadOutlined,
  FileSearchOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MinusOutlined
} from "@ant-design/icons";
import { getAvatarThemeFromLabel, getDisplayLabel } from "./chat-ui-utils.js";

export default function ChatHeader({
  isSidebarOpen,
  onToggleSidebar,
  hasStreamingSessions,
  streamingCount,
  activeSessionParticipants,
  connectionId,
  hasCurrentUserIdentity,
  currentUserDisplayLabel,
  onLogout,
  onClose,
  onMinimize,
  onExportSession,
  onOpenHistory,
  canExportSession,
  dragHandleProps,
  status,
  isMinimized
}) {
  return (
    <div className="ai-chat-header" {...dragHandleProps}>
      <div className="ai-chat-title-shell">
        <Button
          size="middle"
          type="text"
          className="ai-chat-sidebar-toggle"
          icon={isSidebarOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
          onClick={onToggleSidebar}
          onMouseDown={(event) => event.stopPropagation()}
          title={isSidebarOpen ? "Hide Sessions" : "Show Sessions"}
          aria-label={isSidebarOpen ? "Hide sessions sidebar" : "Show sessions sidebar"}
        />
        <div className="ai-chat-title-wrap">
          <div className="ai-chat-title-main">
            {hasStreamingSessions ? `AI Assistant (${streamingCount} running)` : "AI Assistant"}
          </div>
          {activeSessionParticipants.length > 0 ? (
            <div className="ai-chat-title-presence" role="status" aria-label="Session participants">
              <span className="ai-chat-title-presence-count">
                {`${activeSessionParticipants.length} collaborator${activeSessionParticipants.length > 1 ? "s" : ""}`}
              </span>
              <span className="ai-chat-title-presence-list" role="list">
                {activeSessionParticipants.map((participant) => {
                  const participantLabel = getDisplayLabel(participant.user_label);
                  const isCurrentConnection =
                    Boolean(connectionId) && participant.connection_id === connectionId;
                  return (
                    <span
                      key={`${participant.connection_id || participantLabel}-${participantLabel}`}
                      className={`ai-chat-presence-chip${isCurrentConnection ? " is-self" : ""}`}
                      role="listitem"
                    >
                      <span
                        className="ai-chat-presence-dot"
                        style={{ backgroundColor: getAvatarThemeFromLabel(participantLabel).bg }}
                      />
                      <span className="ai-chat-presence-label">{participantLabel}</span>
                      {isCurrentConnection ? <span className="ai-chat-presence-self">(you)</span> : null}
                    </span>
                  );
                })}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <Space size={4} onMouseDown={(event) => event.stopPropagation()}>
        <span className={`ai-chat-status-chip${hasStreamingSessions ? " is-running" : ""}`}>
          {status}
        </span>
        {canExportSession ? (
          <Button
            size="small"
            type="text"
            icon={<DownloadOutlined />}
            aria-label="Export session as JSON"
            title="Export session as JSON"
            onClick={onExportSession}
          />
        ) : null}
        <Button
          size="small"
          type="text"
          icon={<FileSearchOutlined />}
          aria-label="Open raw session history"
          title="Raw session history"
          onClick={onOpenHistory}
        />
        {hasCurrentUserIdentity ? (
          <Dropdown
            menu={{
              items: [
                {
                  key: "logout",
                  label: "Logout",
                  icon: <LogoutOutlined />,
                  onClick: onLogout
                }
              ]
            }}
            trigger={["click"]}
          >
            <Button size="small" type="text" aria-label="User menu" title="User menu">
              {`Name: ${currentUserDisplayLabel}`}
            </Button>
          </Dropdown>
        ) : null}
        <Button
          size="small"
          type="text"
          icon={<MinusOutlined />}
          aria-label={isMinimized ? "Restore chat" : "Minimize chat"}
          onClick={onMinimize}
        />
        <Button
          size="small"
          type="text"
          icon={<CloseOutlined />}
          aria-label="Close chat"
          onClick={onClose}
        />
      </Space>
    </div>
  );
}

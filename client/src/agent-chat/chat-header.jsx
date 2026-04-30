import { Button, Dropdown, Space } from "antd";
import {
  ArrowLeftOutlined,
  CloseOutlined,
  DownloadOutlined,
  FileSearchOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoreOutlined
} from "@ant-design/icons";
import { getAvatarThemeFromLabel } from "./chat-ui-utils.js";

export default function ChatHeader({
  title = "AI Assistant",
  showBackButton = false,
  hideSidebarToggle = false,
  hideStatusDot = false,
  isSidebarOpen,
  onToggleSidebar,
  onBack,
  hasStreamingSessions,
  hasCurrentUserIdentity,
  currentUserDisplayLabel,
  onLogout,
  onClose,
  onExportSession,
  onOpenHistory,
  canExportSession,
  dragHandleProps,
  status
}) {
  const menuItems = [
    {
      key: "history",
      label: "Raw history",
      icon: <FileSearchOutlined />,
      onClick: onOpenHistory
    },
    {
      key: "export",
      label: "Export JSON",
      icon: <DownloadOutlined />,
      disabled: !canExportSession,
      onClick: onExportSession
    }
  ];

  return (
    <div className="ai-chat-header" {...dragHandleProps}>
      <div className="ai-chat-title-shell">
        {showBackButton ? (
          <Button
            size="middle"
            type="text"
            className="ai-chat-header-back"
            icon={<ArrowLeftOutlined />}
            onClick={onBack}
            onMouseDown={(event) => event.stopPropagation()}
            title="Back"
            aria-label="Back to chat"
          />
        ) : !hideSidebarToggle ? (
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
        ) : null}
        {!hideStatusDot ? (
          <span
            className={`ai-chat-status-dot${hasStreamingSessions ? " is-running" : ""}`}
            role="status"
            aria-label={status}
            title={status}
          />
        ) : null}
        <div className="ai-chat-title-main">{title}</div>
      </div>

      {hasCurrentUserIdentity && currentUserDisplayLabel ? (
        <Dropdown
          menu={{
            items: [{
              key: "logout",
              label: "Logout",
              icon: <LogoutOutlined />,
              onClick: onLogout
            }]
          }}
          trigger={["click"]}
        >
          <button
            type="button"
            className="ai-chat-header-identity"
            title="User menu"
          >
            <span
              className="ai-chat-header-identity-avatar"
              style={{ background: getAvatarThemeFromLabel(currentUserDisplayLabel).bg, color: getAvatarThemeFromLabel(currentUserDisplayLabel).fg }}
            >
              {currentUserDisplayLabel.charAt(0).toUpperCase()}
            </span>
            <span className="ai-chat-header-identity-name">{currentUserDisplayLabel}</span>
          </button>
        </Dropdown>
      ) : null}

      <Space className="ai-chat-header-actions" size={2} onMouseDown={(event) => event.stopPropagation()}>
        <Dropdown menu={{ items: menuItems }} trigger={["click"]}>
          <Button
            size="small"
            type="text"
            icon={<MoreOutlined />}
            aria-label="More panel actions"
            title="More"
          />
        </Dropdown>
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

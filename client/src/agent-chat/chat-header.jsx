import { Button, Dropdown, Space } from "antd";
import {
  CloseOutlined,
  DownloadOutlined,
  FileSearchOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MinusOutlined,
  MoreOutlined
} from "@ant-design/icons";

export default function ChatHeader({
  isSidebarOpen,
  onToggleSidebar,
  hasStreamingSessions,
  hasCurrentUserIdentity,
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

  if (hasCurrentUserIdentity) {
    menuItems.push(
      { type: "divider" },
      {
        key: "logout",
        label: "Logout",
        icon: <LogoutOutlined />,
        onClick: onLogout
      }
    );
  }

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
        <span
          className={`ai-chat-status-dot${hasStreamingSessions ? " is-running" : ""}`}
          role="status"
          aria-label={status}
          title={status}
        />
        <div className="ai-chat-title-main">AI Assistant</div>
      </div>

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

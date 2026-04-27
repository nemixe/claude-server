import { Button, Dropdown, Space } from "antd";
import {
    CloseOutlined,
    DownloadOutlined,
    LogoutOutlined,
    MenuFoldOutlined,
    MenuUnfoldOutlined,
} from "@ant-design/icons";
import {
    getDisplayLabel,
    getAvatarThemeFromLabel,
} from "./chat-ui-utils";

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
    onExportSession,
    canExportSession,
}) {
    return (
        <div className="ai-chat-header">
            <div className="ai-chat-title-shell">
                <Button
                    size="middle"
                    type="text"
                    className="ai-chat-sidebar-toggle"
                    icon={isSidebarOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
                    onClick={onToggleSidebar}
                    onMouseDown={(e) => e.stopPropagation()}
                    title={isSidebarOpen ? "Hide Sessions" : "Show Sessions"}
                    aria-label={
                        isSidebarOpen
                            ? "Hide sessions sidebar"
                            : "Show sessions sidebar"
                    }
                />
                <div className="ai-chat-title-wrap">
                    <div className="ai-chat-title-main">
                        {hasStreamingSessions
                            ? `AI Assistant (${streamingCount} running)`
                            : "AI Assistant"}
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
                                        Boolean(connectionId) &&
                                        participant.connection_id === connectionId;
                                    return (
                                        <span
                                            key={`${participant.connection_id || participantLabel}-${participantLabel}`}
                                            className={`ai-chat-presence-chip${isCurrentConnection ? " is-self" : ""}`}
                                            role="listitem"
                                        >
                                            <span
                                                className="ai-chat-presence-dot"
                                                style={{
                                                    backgroundColor: getAvatarThemeFromLabel(participantLabel).bg,
                                                }}
                                            />
                                            <span className="ai-chat-presence-label">
                                                {participantLabel}
                                            </span>
                                            {isCurrentConnection ? (
                                                <span className="ai-chat-presence-self">(you)</span>
                                            ) : null}
                                        </span>
                                    );
                                })}
                            </span>
                        </div>
                    ) : null}
                </div>
            </div>

            <Space size={4} onMouseDown={(e) => e.stopPropagation()}>
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
                {hasCurrentUserIdentity ? (
                    <Dropdown
                        menu={{
                            items: [
                                {
                                    key: "logout",
                                    label: "Logout",
                                    icon: <LogoutOutlined />,
                                    onClick: onLogout,
                                },
                            ],
                        }}
                        trigger={["click"]}
                    >
                        <Button
                            size="small"
                            type="text"
                            aria-label="User menu"
                            title="User menu"
                        >
                            {`Name: ${currentUserDisplayLabel}`}
                        </Button>
                    </Dropdown>
                ) : null}
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

import { Button, Input } from "antd";
import {
    PlusOutlined,
    SearchOutlined,
    FilterOutlined,
} from "@ant-design/icons";
import {
    isDraftSessionId,
    normalizeSessionTitle,
    formatSessionTimestamp,
} from "./chat-ui-utils";

export default function SessionSidebar({
    filteredSessions,
    activeSessionKey,
    sessionListError,
    sessionSearchQuery,
    setSessionSearchQuery,
    hideCliSessions,
    setHideCliSessions,
    onCreateNewSession,
    onSessionSelect,
}) {
    return (
        <>
            <div className="ai-chat-sessions-controls">
                <Input
                    size="small"
                    placeholder="Search..."
                    prefix={<SearchOutlined />}
                    value={sessionSearchQuery}
                    onChange={(e) => setSessionSearchQuery(e.target.value)}
                    allowClear
                    aria-label="Search sessions"
                />
                <Button
                    size="small"
                    type="text"
                    icon={<FilterOutlined />}
                    className={hideCliSessions ? "ai-chat-filter-active" : ""}
                    onClick={() => setHideCliSessions((v) => !v)}
                    aria-pressed={hideCliSessions}
                    aria-label={hideCliSessions ? "Show all sessions" : "Hide Claude Code sessions"}
                    title={hideCliSessions ? "Show all sessions" : "Hide Claude Code sessions"}
                />
            </div>
            {sessionListError ? (
                <p className="ai-chat-sessions-error" role="alert">{sessionListError}</p>
            ) : null}
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
                {filteredSessions.map((session) => {
                    const isActive = session.session_id === activeSessionKey;
                    return (
                        <button
                            key={session.session_id}
                            type="button"
                            className={`ai-chat-session-item${isActive ? " active" : ""}`}
                            onClick={() => {
                                void onSessionSelect(session.session_id);
                            }}
                            role="listitem"
                            aria-current={isActive ? "true" : undefined}
                        >
                            <span className="ai-chat-session-title">
                                {normalizeSessionTitle(
                                    session.title,
                                    isDraftSessionId(session.session_id)
                                        ? "New chat"
                                        : `Session ${session.session_id.slice(0, 8)}`,
                                )}
                            </span>
                            <span className="ai-chat-session-meta">
                                {formatSessionTimestamp(
                                    session.updated_at ?? session.created_at,
                                )}
                            </span>
                        </button>
                    );
                })}
            </div>
        </>
    );
}

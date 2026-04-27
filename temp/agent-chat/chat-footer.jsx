import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "antd";
import {
    AimOutlined,
    EditOutlined,
    CloseOutlined,
    SendOutlined,
    PauseOutlined,
    PaperClipOutlined,
} from "@ant-design/icons";
import AskUserQuestionFooter from "./ask-user-question-footer";
import ContextRulesDropdown from "./context-rules-dropdown";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_IMAGE_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
]);
const DEFAULT_SLASH_COMMANDS = [
    { id: "explain", name: "explain", description: "Explain the current selection or issue." },
    { id: "fix", name: "fix", description: "Suggest a concrete UI fix." },
    { id: "summarize", name: "summarize", description: "Summarize the current thread." },
    { id: "plan", name: "plan", description: "Break the task into small next steps." },
];

function subsequenceMatch(query, text) {
    let queryIndex = 0;
    for (let textIndex = 0; textIndex < text.length && queryIndex < query.length; textIndex += 1) {
        if (text[textIndex] === query[queryIndex]) {
            queryIndex += 1;
        }
    }
    return queryIndex === query.length;
}

function fuzzyScore(query, candidate) {
    const normalizedQuery = query.toLowerCase();
    const normalizedCandidate = candidate.toLowerCase();
    const isFolder = normalizedCandidate.endsWith("/");
    const trimmedCandidate = isFolder ? normalizedCandidate.slice(0, -1) : normalizedCandidate;
    const segments = trimmedCandidate.split("/");
    const name = segments.pop() || "";
    const parentDirs = segments;

    if (name === normalizedQuery) return 0;
    if (name.startsWith(normalizedQuery)) return 1;
    if (name.includes(normalizedQuery)) return 2;
    if (subsequenceMatch(normalizedQuery, name)) return 3;

    for (const dir of parentDirs) {
        if (dir === normalizedQuery) return 4;
    }
    for (const dir of parentDirs) {
        if (dir.startsWith(normalizedQuery)) return 5;
    }
    for (const dir of parentDirs) {
        if (dir.includes(normalizedQuery)) return 6;
    }
    if (normalizedCandidate.includes(normalizedQuery)) return 7;
    if (subsequenceMatch(normalizedQuery, normalizedCandidate)) return 8;
    return -1;
}

function detectMentionAtCursor(text, cursorPos) {
    let index = cursorPos - 1;

    while (index >= 0) {
        if (text[index] === "@") {
            if (index === 0 || /\s/.test(text[index - 1])) {
                const query = text.slice(index + 1, cursorPos);
                if (!/\s/.test(query)) {
                    return { query, startIndex: index };
                }
            }
            return null;
        }

        if (/\s/.test(text[index])) {
            return null;
        }

        index -= 1;
    }

    return null;
}

export default function ChatFooter({
    senderValue,
    setSenderValue,
    permissionMode,
    showQuestionFooter,
    activeAskUserQuestionData,
    activeAskUserQuestionMessageId,
    hasGrabContext,
    isAnnotating,
    latestAnnotation,
    isStreamingActiveSession,
    isSessionOwner,
    hasChipAnswer,
    setHasChipAnswer,
    askQuestionFooterRef,
    onPermissionChange,
    onActivateInspect,
    onInspectPillClear,
    onStartAnnotating,
    onClearAnnotation,
    onStopStreaming,
    onSubmit,
    contextRules,
    contextDisabledIds,
    onContextToggle,
    senderTheme,
    pendingUploads,
    onAddUploads,
    onRemoveUpload,
    onClearUploads,
    slashCommands = DEFAULT_SLASH_COMMANDS,
    mentionSuggestions = [],
}) {
    const fileInputRef = useRef(null);
    const senderRef = useRef(null);
    const dropdownRef = useRef(null);
    const mentionDropdownRef = useRef(null);
    const [isSlashActive, setIsSlashActive] = useState(false);
    const [slashFilterText, setSlashFilterText] = useState("");
    const [highlightIndex, setHighlightIndex] = useState(0);
    const [isMentionActive, setIsMentionActive] = useState(false);
    const [mentionQuery, setMentionQuery] = useState("");
    const [mentionStartIndex, setMentionStartIndex] = useState(-1);
    const [mentionHighlightIndex, setMentionHighlightIndex] = useState(0);

    const filteredCommands = useMemo(() => {
        if (!isSlashActive) return [];
        const lower = slashFilterText.toLowerCase();
        return slashCommands.filter(
            (command) =>
                command.name.toLowerCase().includes(lower) ||
                command.description?.toLowerCase().includes(lower),
        );
    }, [isSlashActive, slashCommands, slashFilterText]);

    const filteredFiles = useMemo(() => {
        if (!isMentionActive) return [];
        if (!mentionQuery) return mentionSuggestions.slice(0, 50);

        return mentionSuggestions
            .map((filePath) => ({ filePath, score: fuzzyScore(mentionQuery, filePath) }))
            .filter((item) => item.score >= 0)
            .sort((left, right) => left.score - right.score || left.filePath.localeCompare(right.filePath))
            .slice(0, 50)
            .map((item) => item.filePath);
    }, [isMentionActive, mentionQuery, mentionSuggestions]);

    const openSlash = useCallback((filterText) => {
        setIsSlashActive(true);
        setSlashFilterText(filterText);
        setHighlightIndex(0);
    }, []);

    const closeSlash = useCallback(() => {
        setIsSlashActive(false);
        setSlashFilterText("");
        setHighlightIndex(0);
    }, []);

    const moveHighlight = useCallback((direction) => {
        setHighlightIndex((previous) => {
            const length = filteredCommands.length;
            if (length === 0) return 0;
            return direction === "up"
                ? (previous - 1 + length) % length
                : (previous + 1) % length;
        });
    }, [filteredCommands.length]);

    const updateMention = useCallback((text, cursorPos) => {
        const result = detectMentionAtCursor(text, cursorPos);

        if (result) {
            setIsMentionActive(true);
            setMentionQuery(result.query);
            setMentionStartIndex(result.startIndex);
            setMentionHighlightIndex(0);
            return;
        }

        setIsMentionActive(false);
        setMentionQuery("");
        setMentionStartIndex(-1);
        setMentionHighlightIndex(0);
    }, []);

    const closeMention = useCallback(() => {
        setIsMentionActive(false);
        setMentionQuery("");
        setMentionStartIndex(-1);
        setMentionHighlightIndex(0);
    }, []);

    const moveMentionHighlight = useCallback((direction) => {
        setMentionHighlightIndex((previous) => {
            const length = filteredFiles.length;
            if (length === 0) return 0;
            return direction === "up"
                ? (previous - 1 + length) % length
                : (previous + 1) % length;
        });
    }, [filteredFiles.length]);

    const selectCommand = (cmd) => {
        setSenderValue(`/${cmd.name} `);
        closeSlash();
        senderRef.current?.focus();
    };

    const selectFile = (filePath) => {
        const el = senderRef.current;
        const cursorPos = el?.selectionStart ?? senderValue.length;
        const before = senderValue.slice(0, mentionStartIndex);
        const after = senderValue.slice(cursorPos);
        const insertion = `@${filePath} `;
        const newValue = before + insertion + after;
        const newCursorPos = before.length + insertion.length;
        setSenderValue(newValue);
        closeMention();
        // Restore cursor position after React re-render
        requestAnimationFrame(() => {
            if (el) {
                el.focus();
                el.setSelectionRange(newCursorPos, newCursorPos);
            }
        });
    };

    // Slash detection on value change
    useEffect(() => {
        if (senderValue.startsWith("/")) {
            openSlash(senderValue.slice(1));
        } else if (isSlashActive) {
            closeSlash();
        }
    }, [senderValue]);

    // Mention detection on value change (cursor-aware)
    useEffect(() => {
        const el = senderRef.current;
        if (el) {
            updateMention(senderValue, el.selectionStart ?? senderValue.length);
        }
    }, [senderValue]);

    const handleFileSelect = useCallback((event) => {
        const files = Array.from(event.target.files || []);
        if (files.length === 0) return;

        const validFiles = [];
        const expectedCount = files.filter((f) => f.size <= MAX_FILE_SIZE).length;
        if (expectedCount === 0) {
            event.target.value = "";
            return;
        }

        for (const file of files) {
            if (file.size > MAX_FILE_SIZE) {
                console.warn(`File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB): ${file.name}`);
                continue;
            }

            const isImage = ALLOWED_IMAGE_TYPES.has(file.type);
            const reader = new FileReader();

            reader.onload = (e) => {
                validFiles.push({
                    id: `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    name: file.name,
                    type: file.type || "application/octet-stream",
                    size: file.size,
                    dataUrl: e.target?.result || "",
                    isImage,
                });

                // Add when all files in this batch are read
                if (validFiles.length === expectedCount) {
                    onAddUploads(validFiles);
                }
            };

            // Always read as data URL for persistence
            reader.readAsDataURL(file);
        }

        // Reset input so the same file can be selected again
        event.target.value = "";
    }, [onAddUploads]);

    const handleUploadButtonClick = useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    // Click-away dismissal
    useEffect(() => {
        if (!isSlashActive && !isMentionActive) return undefined;
        const handleClickOutside = (event) => {
            const inputEl = senderRef.current?.closest(".ai-chat-input");
            if (inputEl && !inputEl.contains(event.target)) {
                if (isSlashActive) closeSlash();
                if (isMentionActive) closeMention();
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [isSlashActive, isMentionActive, closeSlash, closeMention]);

    // Scroll highlighted item into view (slash)
    useEffect(() => {
        if (!isSlashActive || !dropdownRef.current) return;
        const item = dropdownRef.current.children[highlightIndex];
        if (item) item.scrollIntoView({ block: "nearest" });
    }, [highlightIndex, isSlashActive]);

    // Scroll highlighted item into view (mention)
    useEffect(() => {
        if (!isMentionActive || !mentionDropdownRef.current) return;
        const item = mentionDropdownRef.current.children[mentionHighlightIndex];
        if (item) item.scrollIntoView({ block: "nearest" });
    }, [mentionHighlightIndex, isMentionActive]);

    const handleTextareaKeyDown = (event) => {
        // Mention keyboard navigation (takes priority when active)
        if (isMentionActive && filteredFiles.length > 0) {
            if (event.key === "ArrowUp") {
                event.preventDefault();
                moveMentionHighlight("up");
                return;
            }
            if (event.key === "ArrowDown") {
                event.preventDefault();
                moveMentionHighlight("down");
                return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                selectFile(filteredFiles[mentionHighlightIndex]);
                return;
            }
        }
        if (event.key === "Escape" && isMentionActive) {
            event.preventDefault();
            closeMention();
            return;
        }

        // Slash-command keyboard navigation
        if (isSlashActive && filteredCommands.length > 0) {
            if (event.key === "ArrowUp") {
                event.preventDefault();
                moveHighlight("up");
                return;
            }
            if (event.key === "ArrowDown") {
                event.preventDefault();
                moveHighlight("down");
                return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                selectCommand(filteredCommands[highlightIndex]);
                return;
            }
        }
        if (event.key === "Escape" && isSlashActive) {
            event.preventDefault();
            closeSlash();
            return;
        }

        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            // Prevent submission if not the session owner
            if (!isSessionOwner) {
                return;
            }
            if (showQuestionFooter && askQuestionFooterRef.current) {
                const result = askQuestionFooterRef.current.submitCurrentStep(senderValue);
                setSenderValue("");
                event.target.style.height = "auto";
                if (result.ready) {
                    const answer = askQuestionFooterRef.current.getComposedAnswer();
                    if (answer) {
                        void onSubmit(answer);
                        askQuestionFooterRef.current.resetSelections();
                    }
                }
                return;
            }
            if (senderValue.trim() && !isStreamingActiveSession) {
                void onSubmit(senderValue);
                setSenderValue("");
                event.target.style.height = "auto";
            }
        }
    };

    const handleSendClick = () => {
        if (showQuestionFooter && askQuestionFooterRef.current) {
            const result = askQuestionFooterRef.current.submitCurrentStep(senderValue);
            setSenderValue("");
            if (result.ready) {
                const answer = askQuestionFooterRef.current.getComposedAnswer();
                if (answer) {
                    void onSubmit(answer);
                    askQuestionFooterRef.current.resetSelections();
                }
            }
            return;
        }
        if (senderValue.trim()) {
            void onSubmit(senderValue);
            setSenderValue("");
        }
    };

    const showSlashDropdown = isSlashActive && filteredCommands.length > 0;
    const showMentionDropdown = isMentionActive && filteredFiles.length > 0;
    const toHexWithAlpha = (color, alphaHex) => {
        const normalized = typeof color === "string" ? color.trim() : "";
        if (!/^#[\da-fA-F]{6}$/.test(normalized)) {
            return normalized;
        }

        return `${normalized}${alphaHex}`;
    };
    const senderUiStyle = senderTheme?.bg
        ? {
            "--ai-chat-sender-color": senderTheme.bg,
            "--ai-chat-sender-fg": senderTheme.fg || "#ffffff",
            "--ai-chat-sender-soft": toHexWithAlpha(senderTheme.bg, "1a"),
            "--ai-chat-sender-soft-hover": toHexWithAlpha(senderTheme.bg, "29"),
            "--ai-chat-sender-focus": toHexWithAlpha(senderTheme.bg, "33"),
        }
        : undefined;

    return (
        <div className="ai-chat-footer" style={senderUiStyle}>
            <div className="ai-chat-footer-toolbar" role="toolbar" aria-label="Chat controls">
                <Button
                    size="small"
                    shape="round"
                    icon={<AimOutlined />}
                    className={hasGrabContext ? "is-active" : ""}
                    onClick={onActivateInspect}
                    aria-label="Inspect element"
                >
                    Inspect
                </Button>
                {hasGrabContext ? (
                    <Button
                        size="small"
                        shape="circle"
                        icon={<CloseOutlined style={{ fontSize: 11 }} />}
                        onClick={onInspectPillClear}
                        aria-label="Clear selected inspect context"
                        title="Clear selected inspect context"
                    />
                ) : null}
                <Button
                    size="small"
                    shape="round"
                    icon={<EditOutlined />}
                    className={isAnnotating || latestAnnotation ? "is-active" : ""}
                    onClick={onStartAnnotating}
                    aria-label={isAnnotating ? "Stop annotating" : "Annotate"}
                    title={isAnnotating ? "Stop Annotating" : "Annotate"}
                >
                    Annotate
                </Button>
                {latestAnnotation ? (
                    <Button
                        size="small"
                        shape="circle"
                        icon={<CloseOutlined style={{ fontSize: 11 }} />}
                        onClick={onClearAnnotation}
                        aria-label="Clear annotation"
                        title="Clear annotation"
                    />
                ) : null}
                <Button
                    size="small"
                    shape="round"
                    icon={<PaperClipOutlined />}
                    onClick={handleUploadButtonClick}
                    disabled={!isSessionOwner || isStreamingActiveSession}
                    aria-label="Upload files"
                    title="Upload files or images"
                >
                    Upload
                </Button>
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,text/*,application/pdf,application/json,application/javascript,application/css,.md,.txt,.csv,.xml,.yaml,.yml,.toml,.html,.js,.jsx,.ts,.tsx,.py,.java,.rb,.go,.rs,.php,.c,.cpp,.h,.sh,.sql"
                    onChange={handleFileSelect}
                    style={{ display: "none" }}
                />
                {contextRules?.length > 0 ? (
                    <ContextRulesDropdown
                        rules={contextRules}
                        disabledIds={contextDisabledIds}
                        onToggle={onContextToggle}
                    />
                ) : null}
                <div className="ai-chat-mode-toggle" aria-label="Permission mode">
                    <button
                        type="button"
                        className={`ai-chat-mode-btn ${permissionMode === "plan" || showQuestionFooter ? "is-active" : ""}`}
                        onClick={() => onPermissionChange("plan")}
                        disabled={showQuestionFooter}
                        aria-pressed={permissionMode === "plan" || showQuestionFooter}
                    >
                        Plan
                    </button>
                    <button
                        type="button"
                        className={`ai-chat-mode-btn ${permissionMode === "acceptEdits" ? "is-active" : ""}`}
                        onClick={() => onPermissionChange("acceptEdits")}
                        disabled={showQuestionFooter}
                        aria-pressed={permissionMode === "acceptEdits"}
                    >
                        Accept Edits
                    </button>
                    <button
                        type="button"
                        className={`ai-chat-mode-btn ${permissionMode === "bypassPermissions" ? "is-active" : ""}`}
                        onClick={() => onPermissionChange("bypassPermissions")}
                        disabled={showQuestionFooter}
                        aria-pressed={permissionMode === "bypassPermissions"}
                    >
                        Bypass
                    </button>
                </div>
            </div>
            {showQuestionFooter ? (
                <AskUserQuestionFooter
                    ref={askQuestionFooterRef}
                    questionData={activeAskUserQuestionData}
                    questionMessageId={activeAskUserQuestionMessageId}
                    senderValue={senderValue}
                    onSelectionChange={setHasChipAnswer}
                />
            ) : null}
            {pendingUploads.length > 0 ? (
                <div className="ai-chat-upload-preview">
                    {pendingUploads.map((file) => (
                        <div key={file.id} className="ai-chat-upload-card">
                            {file.isImage && file.dataUrl ? (
                                <img
                                    src={file.dataUrl}
                                    alt={file.name}
                                    className="ai-chat-upload-card-thumb"
                                />
                            ) : null}
                            <div className="ai-chat-upload-card-info">
                                <span className="ai-chat-upload-card-name" title={file.name}>
                                    {file.isImage ? "🖼️" : "📄"} {file.name}
                                </span>
                                {file.size ? (
                                    <span className="ai-chat-upload-card-size">
                                        {file.size < 1024 ? `${file.size} B`
                                            : file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KB`
                                            : `${(file.size / (1024 * 1024)).toFixed(1)} MB`}
                                    </span>
                                ) : null}
                            </div>
                            <button
                                type="button"
                                className="ai-chat-upload-card-remove"
                                onClick={() => onRemoveUpload(file.id)}
                                aria-label={`Remove ${file.name}`}
                                title={`Remove ${file.name}`}
                            >
                                <CloseOutlined style={{ fontSize: 10 }} />
                            </button>
                        </div>
                    ))}
                </div>
            ) : null}
            <div className="ai-chat-input">
                {showSlashDropdown ? (
                    <div
                        ref={dropdownRef}
                        className="ai-chat-slash-dropdown"
                        role="listbox"
                        aria-label="Slash commands"
                    >
                        {filteredCommands.map((cmd, index) => (
                            <div
                                key={cmd.id}
                                className={`ai-chat-slash-dropdown-item${index === highlightIndex ? " is-highlighted" : ""}`}
                                role="option"
                                aria-selected={index === highlightIndex}
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    selectCommand(cmd);
                                }}
                                onMouseEnter={() => setHighlightIndex(index)}
                            >
                                <span className="ai-chat-slash-dropdown-name">/{cmd.name}</span>
                                {cmd.description ? (
                                    <span className="ai-chat-slash-dropdown-desc">{cmd.description}</span>
                                ) : null}
                            </div>
                        ))}
                    </div>
                ) : null}
                {showMentionDropdown ? (
                    <div
                        ref={mentionDropdownRef}
                        className="ai-chat-slash-dropdown"
                        role="listbox"
                        aria-label="File mentions"
                    >
                        {filteredFiles.map((filePath, index) => {
                            const isFolder = filePath.endsWith("/");
                            const trimmed = isFolder ? filePath.slice(0, -1) : filePath;
                            const displayName = trimmed.split("/").pop();
                            return (
                                <div
                                    key={filePath}
                                    className={`ai-chat-slash-dropdown-item${index === mentionHighlightIndex ? " is-highlighted" : ""}`}
                                    role="option"
                                    aria-selected={index === mentionHighlightIndex}
                                    onMouseDown={(e) => {
                                        e.preventDefault();
                                        selectFile(filePath);
                                    }}
                                    onMouseEnter={() => setMentionHighlightIndex(index)}
                                >
                                    <span className="ai-chat-slash-dropdown-name">{isFolder ? `${displayName}/` : displayName}</span>
                                    <span className="ai-chat-slash-dropdown-desc">{filePath}</span>
                                </div>
                            );
                        })}
                    </div>
                ) : null}
                <textarea
                    ref={senderRef}
                    className="ai-chat-input-textarea"
                    aria-label="Message input"
                    placeholder={
                        !isSessionOwner
                            ? "View only - you cannot interact with this session"
                            : showQuestionFooter
                                ? "Or type a custom answer..."
                                : "Ask AI about this page..."
                    }
                    value={senderValue}
                    onChange={(event) => {
                        setSenderValue(event.target.value);
                        event.target.style.height = "auto";
                        event.target.style.height = `${event.target.scrollHeight}px`;
                    }}
                    onSelect={(event) => {
                        // Track cursor movement for @-mention detection
                        updateMention(event.target.value, event.target.selectionStart);
                    }}
                    onKeyDown={handleTextareaKeyDown}
                    rows={1}
                    disabled={!isSessionOwner}
                />
                {isStreamingActiveSession ? (
                    <button
                        className="ai-chat-input-btn ai-chat-input-btn-stop"
                        onClick={onStopStreaming}
                        aria-label="Stop generation"
                        title="Stop"
                    >
                        <PauseOutlined />
                    </button>
                ) : (
                    <button
                        className="ai-chat-input-btn ai-chat-input-btn-send"
                        onClick={handleSendClick}
                        disabled={
                            !isSessionOwner ||
                            (showQuestionFooter ? !(senderValue.trim() || hasChipAnswer) : !senderValue.trim())
                        }
                        aria-label="Send message"
                        title="Send"
                    >
                        <SendOutlined />
                    </button>
                )}
            </div>
        </div>
    );
}

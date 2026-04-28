import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "antd";
import {
  AimOutlined,
  CloseOutlined,
  EditOutlined,
  PaperClipOutlined,
  PauseOutlined,
  SendOutlined
} from "@ant-design/icons";
import AskUserQuestionFooter from "./ask-user-question-footer.jsx";

const modeOptions = [
  { value: "plan", label: "Plan" },
  { value: "bypass", label: "Bypass" }
];

function subsequenceMatch(query, text) {
  let queryIndex = 0;
  for (let textIndex = 0; textIndex < text.length && queryIndex < query.length; textIndex += 1) {
    if (text[textIndex] === query[queryIndex]) queryIndex += 1;
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
        if (!/\s/.test(query)) return { query, startIndex: index };
      }
      return null;
    }

    if (/\s/.test(text[index])) return null;
    index -= 1;
  }

  return null;
}

export default function ChatFooter({
  senderValue,
  setSenderValue,
  permissionMode,
  onPermissionChange,
  showQuestionFooter,
  activeAskUserQuestionData,
  activeAskUserQuestionMessageId,
  activeAskUserQuestionToolUseId,
  hasGrabContext,
  isAnnotating,
  latestAnnotation,
  isStreamingActiveSession,
  isSessionOwner,
  hasChipAnswer,
  setHasChipAnswer,
  askQuestionFooterRef,
  onActivateInspect,
  onInspectPillClear,
  onStartAnnotating,
  onClearAnnotation,
  onStopStreaming,
  onSubmit,
  pendingUploads,
  onAddUploads,
  onRemoveUpload,
  onClearUploads,
  slashCommands,
  mentionSuggestions,
  mentionStatus = "idle",
  onMentionSearch,
  formatBytes,
  estimateBase64Bytes,
  imageSrc
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
        command.description?.toLowerCase().includes(lower)
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

  const closeSlash = useCallback(() => {
    setIsSlashActive(false);
    setSlashFilterText("");
    setHighlightIndex(0);
  }, []);

  useEffect(() => {
    if (senderValue.startsWith("/")) {
      setIsSlashActive(true);
      setSlashFilterText(senderValue.slice(1));
      setHighlightIndex(0);
    } else if (isSlashActive) {
      closeSlash();
    }
  }, [senderValue, isSlashActive, closeSlash]);

  useEffect(() => {
    const el = senderRef.current;
    if (el) updateMention(senderValue, el.selectionStart ?? senderValue.length);
  }, [senderValue, updateMention]);

  useEffect(() => {
    if (!onMentionSearch) return undefined;
    if (!isMentionActive) {
      onMentionSearch(null);
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      onMentionSearch(mentionQuery);
    }, mentionQuery.trim() ? 120 : 0);

    return () => window.clearTimeout(timeoutId);
  }, [isMentionActive, mentionQuery, onMentionSearch]);

  useEffect(() => {
    if (!isSlashActive || !dropdownRef.current) return;
    const item = dropdownRef.current.children[highlightIndex];
    if (item) item.scrollIntoView({ block: "nearest" });
  }, [highlightIndex, isSlashActive]);

  useEffect(() => {
    if (!isMentionActive || !mentionDropdownRef.current) return;
    const item = mentionDropdownRef.current.children[mentionHighlightIndex];
    if (item) item.scrollIntoView({ block: "nearest" });
  }, [mentionHighlightIndex, isMentionActive]);

  const selectCommand = (command) => {
    setSenderValue(`/${command.name} `);
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
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        el.setSelectionRange(newCursorPos, newCursorPos);
      }
    });
  };

  const moveHighlight = (direction) => {
    setHighlightIndex((previous) => {
      const length = filteredCommands.length;
      if (length === 0) return 0;
      return direction === "up" ? (previous - 1 + length) % length : (previous + 1) % length;
    });
  };

  const moveMentionHighlight = (direction) => {
    setMentionHighlightIndex((previous) => {
      const length = filteredFiles.length;
      if (length === 0) return 0;
      return direction === "up" ? (previous - 1 + length) % length : (previous + 1) % length;
    });
  };

  const handleSend = () => {
    if (showQuestionFooter && askQuestionFooterRef.current) {
      const result = askQuestionFooterRef.current.submitCurrentStep(senderValue);
      setSenderValue("");
      if (result.ready) {
        const answer = askQuestionFooterRef.current.getComposedAnswer();
        const toolResultContent = askQuestionFooterRef.current.getComposedToolResultContent();
        if (answer) {
          void onSubmit(answer, {
            toolResult: activeAskUserQuestionToolUseId && toolResultContent
              ? {
                  toolUseId: activeAskUserQuestionToolUseId,
                  content: toolResultContent
                }
              : undefined
          });
          askQuestionFooterRef.current.resetSelections();
        }
      }
      return;
    }

    if (!senderValue.trim() || isStreamingActiveSession) return;
    void onSubmit(senderValue);
  };

  const handleTextareaKeyDown = (event) => {
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
      handleSend();
    }
  };

  const handleFileSelect = (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length > 0) void onAddUploads(files);
    event.target.value = "";
  };

  const showSlashDropdown = isSlashActive && filteredCommands.length > 0;
  const showMentionDropdown = isMentionActive && (filteredFiles.length > 0 || mentionStatus !== "idle");

  const mentionEmptyText = {
    loading: "Searching files...",
    empty: mentionQuery.trim() ? "No matching files" : "No files in this session",
    error: "Could not search files",
    "needs-session": "Select or create a session to search files"
  }[mentionStatus] || "No files found";

  return (
    <div className="ai-chat-footer">
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
          onClick={() => fileInputRef.current?.click()}
          disabled={!isSessionOwner || isStreamingActiveSession}
          aria-label="Upload images"
          title="Upload images"
        >
          Upload
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp"
          onChange={handleFileSelect}
          style={{ display: "none" }}
        />
        {pendingUploads.length > 0 ? (
          <Button
            size="small"
            shape="circle"
            icon={<CloseOutlined style={{ fontSize: 11 }} />}
            onClick={onClearUploads}
            aria-label="Clear uploads"
            title="Clear uploads"
          />
        ) : null}
        <div className="ai-chat-mode-toggle" aria-label="Permission mode">
          {modeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`ai-chat-mode-btn ${permissionMode === option.value ? "is-active" : ""}`}
              onClick={() => onPermissionChange(option.value)}
              aria-pressed={permissionMode === option.value}
            >
              {option.label}
            </button>
          ))}
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
              <img src={file.previewUrl || imageSrc(file)} alt={file.name || file.mediaType} className="ai-chat-upload-card-thumb" />
              <div className="ai-chat-upload-card-info">
                <span className="ai-chat-upload-card-name" title={file.name}>
                  {file.name || file.mediaType}
                </span>
                <span className="ai-chat-upload-card-size">
                  {formatBytes(file.size || estimateBase64Bytes(file.dataBase64))}
                </span>
              </div>
              <button
                type="button"
                className="ai-chat-upload-card-remove"
                onClick={() => onRemoveUpload(file.id)}
                aria-label={`Remove ${file.name || "upload"}`}
              >
                <CloseOutlined style={{ fontSize: 10 }} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="ai-chat-input">
        {showSlashDropdown ? (
          <div ref={dropdownRef} className="ai-chat-slash-dropdown" role="listbox" aria-label="Slash commands">
            {filteredCommands.map((command, index) => (
              <div
                key={command.id}
                className={`ai-chat-slash-dropdown-item${index === highlightIndex ? " is-highlighted" : ""}`}
                role="option"
                aria-selected={index === highlightIndex}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectCommand(command);
                }}
                onMouseEnter={() => setHighlightIndex(index)}
              >
                <span className="ai-chat-slash-dropdown-name">/{command.name}</span>
                {command.description ? <span className="ai-chat-slash-dropdown-desc">{command.description}</span> : null}
              </div>
            ))}
          </div>
        ) : null}
        {showMentionDropdown ? (
          <div ref={mentionDropdownRef} className="ai-chat-slash-dropdown" role="listbox" aria-label="File mentions">
            {filteredFiles.length === 0 ? (
              <div className="ai-chat-slash-dropdown-item is-disabled" role="option" aria-disabled="true">
                <span className="ai-chat-slash-dropdown-desc">{mentionEmptyText}</span>
              </div>
            ) : null}
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
                  onMouseDown={(event) => {
                    event.preventDefault();
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
                : "Enter a prompt... Shift+Enter for a new line"
          }
          value={senderValue}
          onChange={(event) => {
            setSenderValue(event.target.value);
            event.target.style.height = "auto";
            event.target.style.height = `${event.target.scrollHeight}px`;
          }}
          onSelect={(event) => updateMention(event.target.value, event.target.selectionStart)}
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
            onClick={handleSend}
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

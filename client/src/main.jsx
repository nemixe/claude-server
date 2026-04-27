import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "./styles.css";
import { Bubble } from "@ant-design/x";
import {
  CheckOutlined,
  CloseOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  FileSearchOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MinusOutlined,
  PaperClipOutlined,
  PauseOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SendOutlined,
  SettingOutlined,
  ToolOutlined
} from "@ant-design/icons";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Alert,
  Button,
  Collapse,
  Drawer,
  Input,
  InputNumber,
  List,
  Select,
  Space,
  Spin,
  Tag,
  Timeline,
  Tooltip,
  Typography
} from "antd";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const { Text } = Typography;
const { TextArea } = Input;

const storageKey = "claude-test-client:last-session";
const imageMediaTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const maxImages = 5;
const maxImageBytes = 5 * 1024 * 1024;
const defaultPrompt = "Inspect the current workspace and summarize what you can do.";
const MESSAGE_LIST_BOTTOM_THRESHOLD_PX = 24;
const ESTIMATE_SIZE = 86;
const OVERSCAN = 10;
const BUBBLE_GAP = 4;
const ACTIVITY_ROLE = "assistant_activity";
const GROUP_ROLE = "assistant_activity_group";

const modeOptions = [
  { value: "plan", label: "Plan" },
  { value: "edit", label: "Accept Edits" },
  { value: "bypass", label: "Bypass" }
];

const modeLabel = {
  plan: "Plan",
  edit: "Accept Edits",
  bypass: "Bypass"
};

function App() {
  const [baseUrl, setBaseUrl] = useState(window.location.origin);
  const [status, setStatus] = useState("Idle");
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState([]);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [hideEmptySessions, setHideEmptySessions] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isClosed, setIsClosed] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [mode, setMode] = useState("plan");
  const [maxTurns, setMaxTurns] = useState(30);
  const [prompt, setPrompt] = useState(defaultPrompt);
  const [selectedImages, setSelectedImages] = useState([]);
  const [events, setEvents] = useState([]);
  const [commands, setCommands] = useState([]);
  const [selectedCommandPath, setSelectedCommandPath] = useState("");
  const [commandPath, setCommandPath] = useState("");
  const [commandContent, setCommandContent] = useState("");
  const [commandsHint, setCommandsHint] = useState("Pick a session to manage slash commands");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLimit, setSearchLimit] = useState(20);
  const [searchResults, setSearchResults] = useState([]);
  const [searchHint, setSearchHint] = useState("Pick a session to search files and folders");
  const [isSending, setIsSending] = useState(false);
  const [isObservedRunning, setIsObservedRunning] = useState(false);
  const [historyCopyLabel, setHistoryCopyLabel] = useState("Copy JSON");
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [position, setPosition] = useState(initialChatPosition);
  const controllerRef = useRef();
  const observeControllerRef = useRef();
  const sessionIdRef = useRef("");
  const baseUrlRef = useRef(baseUrl);
  const commandsRef = useRef([]);
  const historyCopyTimeoutRef = useRef();
  const chatRef = useRef(null);
  const positionRef = useRef(position);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    baseUrlRef.current = baseUrl;
  }, [baseUrl]);

  useEffect(() => {
    commandsRef.current = commands;
  }, [commands]);

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    loadSessions({ restoreSaved: true });
    return () => {
      stopObserving();
      if (historyCopyTimeoutRef.current) window.clearTimeout(historyCopyTimeoutRef.current);
      if (controllerRef.current) controllerRef.current.abort();
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      setPosition((current) => clampPosition(current.x, current.y, chatRef.current));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const busy = isSending || isObservedRunning;
  const activeSession = sessions.find((session) => getSessionId(session) === sessionId);
  const filteredSessions = useMemo(() => {
    const query = sessionSearchQuery.trim().toLowerCase();
    return sessions
      .filter((session) => {
        if (hideEmptySessions && !session.hasRun) return false;
        if (!query) return true;
        const id = getSessionId(session);
        return [session.title, id, session.mode].filter(Boolean).join(" ").toLowerCase().includes(query);
      })
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  }, [hideEmptySessions, sessionSearchQuery, sessions]);

  const commandOptions = [{ value: "", label: commands.length > 0 ? "Choose a command" : "No command selected" }].concat(
    commands.map((command) => ({ value: command.path, label: command.path }))
  );

  const slashCommands = useMemo(() => {
    const known = commands.map((command) => ({
      id: command.path,
      name: command.path.replace(/^\.?claude\/commands\//, "").replace(/\.md$/, ""),
      description: command.content ? firstLine(command.content) : command.path
    }));
    if (known.length > 0) return known;
    return [
      { id: "plan", name: "plan", description: "Break the task into small next steps." },
      { id: "fix", name: "fix", description: "Suggest a concrete fix." },
      { id: "review", name: "review", description: "Review the current implementation." }
    ];
  }, [commands]);

  const bubbleItems = useMemo(() => eventsToBubbleItems(events), [events]);
  const bubbleRoles = useMemo(
    () => ({
      user: { placement: "end" },
      assistant: { placement: "start" },
      assistant_stream: { placement: "start", classNames: { content: "ai-chat-stream-content" } }
    }),
    []
  );

  function apiPath(path) {
    return String(baseUrlRef.current || "").replace(/\/$/, "") + path;
  }

  function appendEntry(type, data) {
    setEvents((current) =>
      current.concat([{ id: Date.now() + ":" + Math.random(), time: new Date().toLocaleTimeString(), type, data }])
    );
  }

  async function getJson(path) {
    const response = await fetch(apiPath(path));
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  async function postJson(path, body) {
    const response = await fetch(apiPath(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  async function loadSessions(options = {}) {
    const saved = readSavedSession();
    if (options.restoreSaved && saved && saved.baseUrl) {
      setBaseUrl(saved.baseUrl);
      baseUrlRef.current = saved.baseUrl;
    }

    try {
      const result = await getJson("/v1/sessions");
      const nextSessions = Array.isArray(result.sessions) ? result.sessions : [];
      setSessions(nextSessions);
      if (!options.restoreSaved || !saved) return;

      const restored = nextSessions.find((session) => getSessionId(session) === saved.sessionId);
      if (!restored) {
        forgetSession();
        appendEntry("client", { restored: false, reason: "Last session was not found on the server" });
        return;
      }

      selectSession(restored, "session_restored");
    } catch (error) {
      appendEntry("client_error", "Could not load sessions: " + errorMessage(error));
    }
  }

  async function createSession() {
    stopObserving();
    setStatus("Creating session");
    try {
      const created = await postJson("/v1/sessions", {
        mode,
        title: "AI chat panel"
      });
      const id = created.sessionId || created.id;
      setSessionId(id);
      rememberSession({ sessionId: id });
      setEvents([]);
      appendEntry("session_created", created);
      setSearchResults([]);
      setSearchHint("Enter a query to search this session workspace");
      await loadSessions({ restoreSaved: false });
      await loadClaudeCommands(id);
      observeSession(id);
      setStatus("Idle");
    } catch (error) {
      setStatus("Error");
      appendEntry("client_error", "Could not create session: " + errorMessage(error));
    }
  }

  async function loadSessionView(id, eventName, session) {
    stopObserving();
    setEvents([]);
    setSearchResults([]);
    setSearchHint("Enter a query to search this session workspace");

    if (session) appendEntry(eventName, session);
    await loadClaudeCommands(id);

    try {
      const result = await getJson("/v1/sessions/" + encodeURIComponent(id) + "/messages");
      const messages = Array.isArray(result.messages) ? result.messages : [];
      if (messages.length === 0) {
        appendEntry("history", { empty: true });
      } else {
        messages.forEach((message) => appendEntry("history", message));
      }
    } catch (error) {
      appendEntry("client_error", "Could not load session history: " + errorMessage(error));
    }

    observeSession(id);
  }

  async function runPrompt(value) {
    const nextPrompt = String(value ?? prompt).trim();
    if (!nextPrompt) return;

    setIsSending(true);
    setStatus("Generating");
    const controller = new AbortController();
    controllerRef.current = controller;
    let activeSessionId = sessionIdRef.current;

    try {
      if (!activeSessionId) {
        const created = await postJson("/v1/sessions", {
          mode,
          title: "AI chat panel"
        });
        activeSessionId = created.sessionId || created.id;
        setSessionId(activeSessionId);
        rememberSession({ sessionId: activeSessionId });
        await loadSessions({ restoreSaved: false });
        await loadClaudeCommands(activeSessionId);
      }

      stopObserving();
      const images = selectedImages.map((image) => ({
        name: image.name,
        mediaType: image.mediaType,
        dataBase64: image.dataBase64
      }));
      appendEntry("prompt", { prompt: nextPrompt, mode, images });
      setPrompt("");

      const response = await fetch(apiPath("/v1/sessions/" + encodeURIComponent(activeSessionId) + "/messages:stream"), {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: nextPrompt,
          images: images.length > 0 ? images : undefined,
          mode,
          maxTurns: Number(maxTurns || 30)
        })
      });

      if (!response.ok || !response.body) throw new Error(await response.text());

      await readSse(response.body);
      setStatus("Complete");
      setSelectedImages([]);
      await loadSessions({ restoreSaved: false });
      observeSession(activeSessionId);
    } catch (error) {
      setStatus("Error");
      appendEntry("client_error", errorMessage(error));
      if (activeSessionId) observeSession(activeSessionId);
    } finally {
      setIsSending(false);
      controllerRef.current = undefined;
    }
  }

  async function interrupt() {
    const id = sessionIdRef.current;
    if (!id) return;
    await fetch(apiPath("/v1/sessions/" + encodeURIComponent(id) + "/interrupt"), { method: "POST" });
    appendEntry("client", { interrupted: true });
  }

  async function loadClaudeCommands(id) {
    const activeSessionId = id || sessionIdRef.current;
    setCommands([]);
    setSelectedCommandPath("");

    if (!activeSessionId) {
      clearCommandEditor();
      setCommandsHint("Pick a session to manage slash commands");
      return;
    }

    setCommandsHint("Loading commands from .claude/commands");
    try {
      const result = await getJson("/v1/sessions/" + encodeURIComponent(activeSessionId) + "/claude-commands");
      const nextCommands = Array.isArray(result.commands) ? result.commands : [];
      setCommands(nextCommands);
      setCommandsHint(
        nextCommands.length > 0
          ? "Commands live in this session workspace under .claude/commands"
          : "No commands saved yet for this session"
      );
    } catch (error) {
      setCommandsHint("Could not load commands");
      appendEntry("client_error", "Could not load Claude commands: " + errorMessage(error));
    }
  }

  async function loadClaudeCommand(path) {
    const id = sessionIdRef.current;
    if (!id || !path) return;

    const existing = commandsRef.current.find((command) => command.path === path);
    if (existing) {
      showCommand(existing);
      return;
    }

    try {
      const result = await getJson("/v1/sessions/" + encodeURIComponent(id) + "/claude-commands?path=" + encodeURIComponent(path));
      if (result && result.command) {
        mergeCommand(result.command);
        showCommand(result.command);
      }
    } catch (error) {
      appendEntry("client_error", "Could not load Claude command: " + errorMessage(error));
    }
  }

  async function saveCommand() {
    const id = sessionIdRef.current;
    if (!id) {
      appendEntry("client_error", "Select or create a session before saving commands");
      return;
    }

    const path = String(commandPath || "").trim();
    if (!path) {
      appendEntry("client_error", "Command path is required");
      return;
    }

    try {
      const result = await postJson("/v1/sessions/" + encodeURIComponent(id) + "/claude-commands", {
        path,
        content: String(commandContent || "")
      });
      if (result && result.command) {
        mergeCommand(result.command);
        showCommand(result.command);
        appendEntry("command_saved", { path: result.command.path, updatedAt: result.command.updatedAt });
      }
    } catch (error) {
      appendEntry("client_error", "Could not save Claude command: " + errorMessage(error));
    }
  }

  async function deleteCommand() {
    const id = sessionIdRef.current;
    if (!id) {
      appendEntry("client_error", "Select or create a session before deleting commands");
      return;
    }

    const path = String(commandPath || selectedCommandPath || "").trim();
    if (!path) {
      appendEntry("client_error", "Choose a command to delete");
      return;
    }

    try {
      const response = await fetch(apiPath("/v1/sessions/" + encodeURIComponent(id) + "/claude-commands"), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path })
      });
      if (!response.ok) throw new Error(await response.text());
      const nextCommands = commandsRef.current.filter((command) => command.path !== path);
      setCommands(nextCommands);
      clearCommandEditor();
      appendEntry("command_deleted", { path });
      setCommandsHint(nextCommands.length > 0 ? "Commands live in this session workspace under .claude/commands" : "No commands saved yet for this session");
    } catch (error) {
      appendEntry("client_error", "Could not delete Claude command: " + errorMessage(error));
    }
  }

  async function runWorkspaceSearch() {
    const id = sessionIdRef.current;
    if (!id) {
      appendEntry("client_error", "Select or create a session before searching the workspace");
      return;
    }

    const query = String(searchQuery || "").trim();
    if (!query) {
      setSearchResults([]);
      setSearchHint("Enter a query to search this session workspace");
      return;
    }

    setSearchHint("Searching workspace paths");
    try {
      const result = await getJson(
        "/v1/sessions/" +
          encodeURIComponent(id) +
          "/files:search?q=" +
          encodeURIComponent(query) +
          "&limit=" +
          encodeURIComponent(String(searchLimit || 20))
      );
      const nextResults = Array.isArray(result.results) ? result.results : [];
      setSearchResults(nextResults);
      setSearchHint(
        nextResults.length > 0
          ? "Search results from the selected session workspace"
          : "No matching files or folders in this session workspace"
      );
    } catch (error) {
      setSearchHint("Could not search workspace");
      appendEntry("client_error", "Could not search workspace: " + errorMessage(error));
    }
  }

  async function observeSession(id) {
    stopObserving();
    const controller = new AbortController();
    observeControllerRef.current = controller;

    try {
      const response = await fetch(apiPath("/v1/sessions/" + encodeURIComponent(id) + "/events:stream"), {
        signal: controller.signal
      });
      if (!response.ok || !response.body) throw new Error(await response.text());
      await readSse(response.body, "observer");
    } catch (error) {
      if (controller.signal.aborted) return;
      appendEntry("client_error", "Could not observe session events: " + errorMessage(error));
    } finally {
      if (observeControllerRef.current === controller) {
        observeControllerRef.current = undefined;
        setIsObservedRunning(false);
      }
    }
  }

  function stopObserving() {
    if (observeControllerRef.current) {
      observeControllerRef.current.abort();
      observeControllerRef.current = undefined;
    }
  }

  async function readSse(body, source) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || "";
      parts.forEach((part) => emitSse(part, source));
    }

    buffer += decoder.decode();
    if (buffer.trim()) emitSse(buffer, source);
  }

  function emitSse(raw, source) {
    let event = "message";
    const data = [];

    raw.split(/\r?\n/).forEach((line) => {
      if (!line || line.startsWith(":")) return;
      const index = line.indexOf(":");
      const field = index === -1 ? line : line.slice(0, index);
      const value = index === -1 ? "" : line.slice(index + 1).replace(/^ /, "");
      if (field === "event") event = value;
      if (field === "data") data.push(value);
    });

    const parsed = parseJsonOrText(data.join("\n"));
    if (event === "status" && parsed && typeof parsed.running === "boolean") {
      setIsObservedRunning(parsed.running);
      return;
    }
    if (event === "done" && source === "observer" && parsed && parsed.observing === false) {
      setIsObservedRunning(false);
      return;
    }
    appendEntry(event, parsed);
  }

  async function onFilesSelected(files) {
    try {
      setSelectedImages((current) => {
        if (current.length >= maxImages) return current;
        return current;
      });
      const nextImages = await readPromptImages(files);
      setSelectedImages((current) => current.concat(nextImages).slice(0, maxImages));
    } catch (error) {
      appendEntry("client_error", errorMessage(error));
    }
  }

  async function readPromptImages(files) {
    const remaining = maxImages - selectedImages.length;
    if (files.length > remaining) throw new Error("Choose " + maxImages + " images or fewer");
    return Promise.all(
      files.map(async (file) => {
        if (!imageMediaTypes.has(file.type)) throw new Error(file.name + " is not a supported image type");
        if (file.size > maxImageBytes) throw new Error(file.name + " is larger than 5 MB");
        const dataUrl = await readAsDataUrl(file);
        const commaIndex = dataUrl.indexOf(",");
        return {
          id: "upload-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          name: file.name,
          mediaType: file.type,
          size: file.size,
          previewUrl: dataUrl,
          dataBase64: commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1)
        };
      })
    );
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result || "")));
      reader.addEventListener("error", () => reject(reader.error || new Error("Could not read image")));
      reader.readAsDataURL(file);
    });
  }

  function selectSession(session, eventName) {
    const id = getSessionId(session);
    setSessionId(id);
    setMode(session.mode || mode);
    rememberSession({ sessionId: id });
    loadSessionView(id, eventName, session);
  }

  function onSessionSelect(id) {
    const selected = sessions.find((session) => getSessionId(session) === id);
    if (!selected) {
      forgetSession();
      appendEntry("session", { active: false });
      return;
    }
    selectSession(selected, "session_selected");
  }

  function forgetSession() {
    stopObserving();
    setIsObservedRunning(false);
    setSessionId("");
    sessionIdRef.current = "";
    setCommands([]);
    setSearchResults([]);
    localStorage.removeItem(storageKey);
    setEvents([]);
    clearCommandEditor();
    setCommandsHint("Pick a session to manage slash commands");
    setSearchHint("Pick a session to search files and folders");
  }

  function rememberSession(session) {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        sessionId: session.sessionId,
        baseUrl: String(baseUrlRef.current || "").replace(/\/$/, "")
      })
    );
  }

  function readSavedSession() {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || "null");
    } catch {
      return null;
    }
  }

  function showCommand(command) {
    setCommandPath(command.path || "");
    setCommandContent(command.content || "");
    setSelectedCommandPath(command.path || "");
  }

  function clearCommandEditor() {
    setCommandPath("");
    setCommandContent("");
    setSelectedCommandPath("");
  }

  function mergeCommand(command) {
    const nextCommands = commandsRef.current.filter((item) => item.path !== command.path);
    nextCommands.push(command);
    nextCommands.sort((left, right) => String(left.path).localeCompare(String(right.path)));
    setCommands(nextCommands);
  }

  async function copySessionHistoryJson() {
    const payload = events.map((entry) => ({
      time: entry.time,
      type: entry.type,
      data: entry.data
    }));

    try {
      await writeClipboard(JSON.stringify(payload, null, 2));
      setHistoryCopyLabel("Copied");
    } catch {
      setHistoryCopyLabel("Copy failed");
    }

    if (historyCopyTimeoutRef.current) window.clearTimeout(historyCopyTimeoutRef.current);
    historyCopyTimeoutRef.current = window.setTimeout(() => {
      setHistoryCopyLabel("Copy JSON");
    }, 1600);
  }

  function startDrag(event) {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target.closest("button, input, textarea, select, a, .ant-dropdown, .ant-drawer")) return;
    const origin = positionRef.current;
    const dragStart = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      originX: origin.x,
      originY: origin.y
    };

    function move(pointerEvent) {
      setPosition(clampPosition(dragStart.originX + pointerEvent.clientX - dragStart.pointerX, dragStart.originY + pointerEvent.clientY - dragStart.pointerY, chatRef.current));
    }

    function stop() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  if (isClosed) {
    return (
      <div className="client-stage">
        <button
          type="button"
          className="ai-chat-launcher"
          onClick={() => {
            setIsClosed(false);
            setIsMinimized(false);
          }}
        >
          <span>AI Assistant</span>
          <SendOutlined />
        </button>
      </div>
    );
  }

  return (
    <div className="client-stage">
      <div
        ref={chatRef}
        className={["ai-chat-floating", isMinimized ? "is-minimized" : ""].filter(Boolean).join(" ")}
        style={{ left: position.x, top: position.y }}
      >
        <div className="ai-chat-card">
          <ChatHeader
            isSidebarOpen={isSidebarOpen}
            onToggleSidebar={() => setIsSidebarOpen((value) => !value)}
            hasStreamingSessions={busy}
            streamingCount={busy ? 1 : 0}
            activeSessionParticipants={activeSession ? [{ connection_id: sessionId, user_label: activeSession.title || "Session" }] : []}
            connectionId={sessionId}
            hasCurrentUserIdentity={Boolean(activeSession)}
            currentUserDisplayLabel={activeSession ? activeSession.title || "Claude session" : "No session"}
            onClose={() => setIsClosed(true)}
            onMinimize={() => setIsMinimized((value) => !value)}
            onExportSession={copySessionHistoryJson}
            onOpenHistory={() => setIsHistoryOpen(true)}
            canExportSession={events.length > 0}
            dragHandleProps={{ onPointerDown: startDrag }}
            status={busy ? "Generating" : status}
            isMinimized={isMinimized}
          />
          {!isMinimized ? (
            <div className={["ai-chat-two-columns", "is-narrow", isSidebarOpen ? "sidebar-open" : ""].join(" ")}>
              {isSidebarOpen ? (
                <aside className="ai-chat-sidebar-column is-open">
                  <div className="ai-chat-sessions-header">
                    <span>Sessions</span>
                    <Tag color={sessionId ? "blue" : "default"}>{sessionId ? "Active" : "New"}</Tag>
                  </div>
                  <SessionSidebar
                    filteredSessions={filteredSessions}
                    activeSessionKey={sessionId}
                    sessionSearchQuery={sessionSearchQuery}
                    setSessionSearchQuery={setSessionSearchQuery}
                    hideEmptySessions={hideEmptySessions}
                    setHideEmptySessions={setHideEmptySessions}
                    onCreateNewSession={createSession}
                    onSessionSelect={onSessionSelect}
                    onRefreshSessions={() => loadSessions({ restoreSaved: false })}
                  />
                  <DeveloperTools
                    baseUrl={baseUrl}
                    setBaseUrl={setBaseUrl}
                    sessionId={sessionId}
                    maxTurns={maxTurns}
                    setMaxTurns={setMaxTurns}
                    commandsHint={commandsHint}
                    commandOptions={commandOptions}
                    selectedCommandPath={selectedCommandPath}
                    commandPath={commandPath}
                    commandContent={commandContent}
                    setSelectedCommandPath={setSelectedCommandPath}
                    setCommandPath={setCommandPath}
                    setCommandContent={setCommandContent}
                    loadClaudeCommand={loadClaudeCommand}
                    loadClaudeCommands={loadClaudeCommands}
                    saveCommand={saveCommand}
                    deleteCommand={deleteCommand}
                    clearCommandEditor={clearCommandEditor}
                    searchQuery={searchQuery}
                    setSearchQuery={setSearchQuery}
                    searchLimit={searchLimit}
                    setSearchLimit={setSearchLimit}
                    searchHint={searchHint}
                    searchResults={searchResults}
                    runWorkspaceSearch={runWorkspaceSearch}
                    clearSearch={() => {
                      setSearchQuery("");
                      setSearchResults([]);
                    }}
                    clearEvents={() => setEvents([])}
                    openHistory={() => setIsHistoryOpen(true)}
                  />
                </aside>
              ) : null}
              {isSidebarOpen ? (
                <button className="ai-chat-sidebar-backdrop" type="button" aria-label="Hide sessions" onClick={() => setIsSidebarOpen(false)} />
              ) : null}
              <main className="ai-chat-main-column">
                <AgentChatMessageList bubbleItems={bubbleItems} bubbleRoles={bubbleRoles} isStreaming={busy} open={!isClosed && !isMinimized} />
                <ChatFooter
                  senderValue={prompt}
                  setSenderValue={setPrompt}
                  permissionMode={mode}
                  onPermissionChange={setMode}
                  isStreamingActiveSession={isSending}
                  isSessionOwner={true}
                  onStopStreaming={interrupt}
                  onSubmit={runPrompt}
                  pendingUploads={selectedImages}
                  onAddUploads={onFilesSelected}
                  onRemoveUpload={(id) => setSelectedImages((current) => current.filter((image) => image.id !== id))}
                  onClearUploads={() => setSelectedImages([])}
                  slashCommands={slashCommands}
                  maxTurns={maxTurns}
                  setMaxTurns={setMaxTurns}
                />
              </main>
            </div>
          ) : null}
        </div>
      </div>
      <Drawer
        title="Session History"
        placement="right"
        width={560}
        open={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
        extra={
          <Space>
            <Button size="small" disabled={events.length === 0} icon={<CopyOutlined />} onClick={copySessionHistoryJson}>
              {historyCopyLabel}
            </Button>
            <Button size="small" onClick={() => setEvents([])}>
              Clear
            </Button>
          </Space>
        }
      >
        <LegacyEventsList events={events} />
      </Drawer>
    </div>
  );
}

function ChatHeader({
  isSidebarOpen,
  onToggleSidebar,
  hasStreamingSessions,
  streamingCount,
  activeSessionParticipants,
  connectionId,
  hasCurrentUserIdentity,
  currentUserDisplayLabel,
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
              <span className="ai-chat-title-presence-count">{status}</span>
              <span className="ai-chat-title-presence-list" role="list">
                {activeSessionParticipants.map((participant) => {
                  const participantLabel = getDisplayLabel(participant.user_label);
                  const isCurrentConnection = Boolean(connectionId) && participant.connection_id === connectionId;
                  const theme = getAvatarThemeFromLabel(participantLabel);
                  return (
                    <span
                      key={`${participant.connection_id || participantLabel}-${participantLabel}`}
                      className={`ai-chat-presence-chip${isCurrentConnection ? " is-self" : ""}`}
                      role="listitem"
                    >
                      <span className="ai-chat-presence-dot" style={{ backgroundColor: theme.bg }} />
                      <span className="ai-chat-presence-label">{participantLabel}</span>
                      {isCurrentConnection ? <span className="ai-chat-presence-self">(you)</span> : null}
                    </span>
                  );
                })}
              </span>
            </div>
          ) : (
            <div className="ai-chat-title-presence-count">{status}</div>
          )}
        </div>
      </div>

      <Space size={4} onMouseDown={(event) => event.stopPropagation()}>
        {hasStreamingSessions ? <Spin size="small" /> : null}
        <Button
          size="small"
          type="text"
          icon={<DownloadOutlined />}
          aria-label="Copy session as JSON"
          title="Copy session as JSON"
          disabled={!canExportSession}
          onClick={onExportSession}
        />
        <Button
          size="small"
          type="text"
          icon={<FileSearchOutlined />}
          aria-label="Open raw session history"
          title="Raw session history"
          onClick={onOpenHistory}
        />
        {hasCurrentUserIdentity ? (
          <Button size="small" type="text" aria-label="Session label" title="Current session">
            {`Name: ${currentUserDisplayLabel}`}
          </Button>
        ) : null}
        <Button
          size="small"
          type="text"
          icon={<MinusOutlined />}
          aria-label={isMinimized ? "Restore chat" : "Minimize chat"}
          onClick={onMinimize}
        />
        <Button size="small" type="text" icon={<CloseOutlined />} aria-label="Close chat" onClick={onClose} />
      </Space>
    </div>
  );
}

function SessionSidebar({
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
        <Tooltip title="Refresh sessions">
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={onRefreshSessions} aria-label="Refresh sessions" />
        </Tooltip>
        <Tooltip title={hideEmptySessions ? "Show empty sessions" : "Hide empty sessions"}>
          <Button
            size="small"
            type="text"
            icon={<FilterGlyph />}
            className={hideEmptySessions ? "ai-chat-filter-active" : ""}
            onClick={() => setHideEmptySessions((value) => !value)}
            aria-pressed={hideEmptySessions}
            aria-label={hideEmptySessions ? "Show empty sessions" : "Hide empty sessions"}
          />
        </Tooltip>
      </div>
      <div className="ai-chat-sessions-list" role="list" aria-label="Chat sessions">
        <button type="button" className="ai-chat-session-item ai-chat-session-item-create" onClick={onCreateNewSession} aria-label="New session" role="listitem">
          <span className="ai-chat-session-create-label">
            <PlusOutlined />
            <span>New Session</span>
          </span>
        </button>
        {filteredSessions.map((session) => {
          const id = getSessionId(session);
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
                {[formatSessionTimestamp(session.updatedAt ?? session.createdAt), session.mode, session.hasRun ? "run" : "empty"].filter(Boolean).join(" · ")}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function DeveloperTools(props) {
  const collapseItems = [
    {
      key: "settings",
      label: (
        <span className="ai-chat-tool-label">
          <SettingOutlined /> Prompt Controls
        </span>
      ),
      children: (
        <div className="ai-chat-tool-panel">
          <label className="ai-chat-field">
            <span>API base URL</span>
            <Input size="small" value={props.baseUrl} placeholder="http://localhost:3000" onChange={(event) => props.setBaseUrl(event.target.value)} />
          </label>
          <label className="ai-chat-field">
            <span>Max turns</span>
            <InputNumber size="small" min={1} value={props.maxTurns} onChange={(value) => props.setMaxTurns(value || 30)} style={{ width: "100%" }} />
          </label>
          <Space size={6} wrap>
            <Button size="small" onClick={props.openHistory}>
              Raw History
            </Button>
            <Button size="small" onClick={props.clearEvents}>
              Clear Events
            </Button>
          </Space>
        </div>
      )
    },
    {
      key: "commands",
      label: (
        <span className="ai-chat-tool-label">
          <ToolOutlined /> Claude Commands
        </span>
      ),
      children: (
        <div className="ai-chat-tool-panel">
          <p className="ai-chat-tool-hint">{props.commandsHint}</p>
          <label className="ai-chat-field">
            <span>Commands</span>
            <Select
              size="small"
              value={props.selectedCommandPath}
              disabled={!props.sessionId}
              options={props.commandOptions}
              onChange={(value) => {
                props.setSelectedCommandPath(value);
                value ? props.loadClaudeCommand(value) : props.clearCommandEditor();
              }}
            />
          </label>
          <label className="ai-chat-field">
            <span>Command path</span>
            <Input size="small" disabled={!props.sessionId} value={props.commandPath} placeholder="review/fix.md" onChange={(event) => props.setCommandPath(event.target.value)} />
          </label>
          <label className="ai-chat-field">
            <span>Command content</span>
            <TextArea disabled={!props.sessionId} rows={5} value={props.commandContent} placeholder="Write the Claude slash command markdown here." onChange={(event) => props.setCommandContent(event.target.value)} />
          </label>
          <Space size={6} wrap>
            <Button size="small" type="primary" disabled={!props.sessionId} onClick={props.saveCommand}>
              Save
            </Button>
            <Button size="small" disabled={!props.sessionId} onClick={props.clearCommandEditor}>
              New
            </Button>
            <Button size="small" danger disabled={!props.sessionId} icon={<DeleteOutlined />} onClick={props.deleteCommand}>
              Delete
            </Button>
            <Button size="small" disabled={!props.sessionId} icon={<ReloadOutlined />} onClick={() => props.loadClaudeCommands()}>
              Refresh
            </Button>
          </Space>
        </div>
      )
    },
    {
      key: "search",
      label: (
        <span className="ai-chat-tool-label">
          <FileSearchOutlined /> Workspace Search
        </span>
      ),
      children: (
        <div className="ai-chat-tool-panel">
          <p className="ai-chat-tool-hint">{props.searchHint}</p>
          <div className="ai-chat-search-row">
            <Input size="small" disabled={!props.sessionId} value={props.searchQuery} placeholder="cmpbtn" onChange={(event) => props.setSearchQuery(event.target.value)} onPressEnter={props.runWorkspaceSearch} />
            <InputNumber size="small" disabled={!props.sessionId} min={1} max={200} value={props.searchLimit} onChange={(value) => props.setSearchLimit(value || 20)} />
          </div>
          <Space size={6} wrap>
            <Button size="small" type="primary" disabled={!props.sessionId} onClick={props.runWorkspaceSearch}>
              Search
            </Button>
            <Button size="small" disabled={!props.sessionId} onClick={props.clearSearch}>
              Clear
            </Button>
          </Space>
          <SearchResults results={props.searchResults} query={props.searchQuery} />
        </div>
      )
    }
  ];

  return <Collapse size="small" ghost className="ai-chat-tools" items={collapseItems} defaultActiveKey={["settings"]} />;
}

function ChatFooter({
  senderValue,
  setSenderValue,
  permissionMode,
  onPermissionChange,
  isStreamingActiveSession,
  isSessionOwner,
  onStopStreaming,
  onSubmit,
  pendingUploads,
  onAddUploads,
  onRemoveUpload,
  onClearUploads,
  slashCommands,
  maxTurns,
  setMaxTurns
}) {
  const fileInputRef = useRef(null);
  const senderRef = useRef(null);
  const dropdownRef = useRef(null);
  const [isSlashActive, setIsSlashActive] = useState(false);
  const [slashFilterText, setSlashFilterText] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);

  const filteredCommands = useMemo(() => {
    if (!isSlashActive) return [];
    const lower = slashFilterText.toLowerCase();
    return slashCommands.filter((command) => command.name.toLowerCase().includes(lower) || command.description?.toLowerCase().includes(lower));
  }, [isSlashActive, slashCommands, slashFilterText]);

  useEffect(() => {
    if (senderValue.startsWith("/")) {
      setIsSlashActive(true);
      setSlashFilterText(senderValue.slice(1));
      setHighlightIndex(0);
    } else if (isSlashActive) {
      setIsSlashActive(false);
      setSlashFilterText("");
      setHighlightIndex(0);
    }
  }, [senderValue, isSlashActive]);

  useEffect(() => {
    if (!isSlashActive || !dropdownRef.current) return;
    const item = dropdownRef.current.children[highlightIndex];
    if (item) item.scrollIntoView({ block: "nearest" });
  }, [highlightIndex, isSlashActive]);

  const selectCommand = (command) => {
    setSenderValue(`/${command.name} `);
    setIsSlashActive(false);
    senderRef.current?.focus();
  };

  const moveHighlight = (direction) => {
    setHighlightIndex((previous) => {
      const length = filteredCommands.length;
      if (length === 0) return 0;
      return direction === "up" ? (previous - 1 + length) % length : (previous + 1) % length;
    });
  };

  const handleTextareaKeyDown = (event) => {
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
      setIsSlashActive(false);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSendClick();
    }
  };

  const handleSendClick = () => {
    if (!senderValue.trim() || isStreamingActiveSession) return;
    void onSubmit(senderValue);
  };

  const handleFileSelect = (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length > 0) void onAddUploads(files);
    event.target.value = "";
  };

  const showSlashDropdown = isSlashActive && filteredCommands.length > 0;

  return (
    <div className="ai-chat-footer">
      <div className="ai-chat-footer-toolbar" role="toolbar" aria-label="Chat controls">
        <Button size="small" shape="round" icon={<PaperClipOutlined />} onClick={() => fileInputRef.current?.click()} disabled={!isSessionOwner || isStreamingActiveSession} aria-label="Upload images">
          Upload
        </Button>
        <input ref={fileInputRef} type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" onChange={handleFileSelect} style={{ display: "none" }} />
        {pendingUploads.length > 0 ? (
          <Button size="small" shape="circle" icon={<CloseOutlined style={{ fontSize: 11 }} />} onClick={onClearUploads} aria-label="Clear uploads" title="Clear uploads" />
        ) : null}
        <span className="ai-chat-turns-control">
          <span>Turns</span>
          <InputNumber size="small" min={1} value={maxTurns} onChange={(value) => setMaxTurns(value || 30)} />
        </span>
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
      {pendingUploads.length > 0 ? (
        <div className="ai-chat-upload-preview">
          {pendingUploads.map((file) => (
            <div key={file.id} className="ai-chat-upload-card">
              <img src={file.previewUrl || imageSrc(file)} alt={file.name || file.mediaType} className="ai-chat-upload-card-thumb" />
              <div className="ai-chat-upload-card-info">
                <span className="ai-chat-upload-card-name" title={file.name}>
                  {file.name || file.mediaType}
                </span>
                <span className="ai-chat-upload-card-size">{formatBytes(file.size || estimateBase64Bytes(file.dataBase64))}</span>
              </div>
              <button type="button" className="ai-chat-upload-card-remove" onClick={() => onRemoveUpload(file.id)} aria-label={`Remove ${file.name || "upload"}`}>
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
        <textarea
          ref={senderRef}
          className="ai-chat-input-textarea"
          aria-label="Message input"
          placeholder={!isSessionOwner ? "View only - you cannot interact with this session" : "Ask AI about this workspace..."}
          value={senderValue}
          onChange={(event) => {
            setSenderValue(event.target.value);
            event.target.style.height = "auto";
            event.target.style.height = `${event.target.scrollHeight}px`;
          }}
          onKeyDown={handleTextareaKeyDown}
          rows={1}
          disabled={!isSessionOwner}
        />
        {isStreamingActiveSession ? (
          <button className="ai-chat-input-btn ai-chat-input-btn-stop" onClick={onStopStreaming} aria-label="Stop generation" title="Stop">
            <PauseOutlined />
          </button>
        ) : (
          <button className="ai-chat-input-btn ai-chat-input-btn-send" onClick={handleSendClick} disabled={!isSessionOwner || !senderValue.trim()} aria-label="Send message" title="Send">
            <SendOutlined />
          </button>
        )}
      </div>
    </div>
  );
}

const AgentChatMessageList = forwardRef(({ bubbleItems, bubbleRoles, isStreaming, open }, ref) => {
  const scrollElementRef = useRef(null);
  const isPinnedToBottomRef = useRef(true);
  const processedItems = useMemo(() => groupBubbleItems(bubbleItems), [bubbleItems]);

  const virtualizer = useVirtualizer({
    count: processedItems.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => ESTIMATE_SIZE,
    overscan: OVERSCAN
  });

  useEffect(() => {
    if (!open || !isStreaming || processedItems.length === 0) return;
    const el = scrollElementRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > MESSAGE_LIST_BOTTOM_THRESHOLD_PX) {
      isPinnedToBottomRef.current = false;
      return;
    }
    virtualizer.scrollToIndex(processedItems.length - 1, { align: "end" });
  }, [open, isStreaming, processedItems, virtualizer]);

  useEffect(() => {
    if (!open || processedItems.length === 0 || !isPinnedToBottomRef.current) return;
    virtualizer.scrollToIndex(processedItems.length - 1, { align: "end" });
  }, [open, processedItems.length, virtualizer]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToMessage: (messageId) => {
        const index = processedItems.findIndex((item) => {
          if (item.role === GROUP_ROLE) return item.items.some((child) => child.key === messageId);
          return item.key === messageId;
        });
        if (index < 0) return false;
        virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
        return true;
      },
      scrollToBottom: () => {
        if (processedItems.length === 0) return;
        virtualizer.scrollToIndex(processedItems.length - 1, { align: "end" });
      }
    }),
    [processedItems, virtualizer]
  );

  const handleScroll = useCallback(() => {
    const el = scrollElementRef.current;
    if (!el) return;
    isPinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= MESSAGE_LIST_BOTTOM_THRESHOLD_PX;
  }, []);

  const virtualItems = virtualizer.getVirtualItems();

  if (processedItems.length === 0) {
    return (
      <div ref={scrollElementRef} className="ai-chat-messages ai-chat-empty-state" role="log" aria-label="Chat messages">
        <div>
          <h1>Claude AI Chat</h1>
          <p>Choose or create a session, then ask about this workspace.</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={scrollElementRef} className="ai-chat-messages" role="log" aria-label="Chat messages" aria-live="polite" aria-busy={isStreaming} onScroll={handleScroll}>
      <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
        {virtualItems.map((virtualRow) => {
          const item = processedItems[virtualRow.index];
          const isGroup = item.role === GROUP_ROLE;

          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
                paddingBottom: BUBBLE_GAP
              }}
            >
              {isGroup ? (
                <ActivityTimeline
                  items={item.items}
                  isLastGroup={(() => {
                    if (!isStreaming) return false;
                    const next = processedItems[virtualRow.index + 1];
                    return !next || next.loading === true;
                  })()}
                />
              ) : (
                <MessageBubble roleConfig={bubbleRoles[item.role] || {}} item={item} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

AgentChatMessageList.displayName = "AgentChatMessageList";

const MessageBubble = memo(({ roleConfig, item }) => {
  const textContent = useMemo(() => (item.loading ? "" : item.copyText || extractTextFromReact(item.content)), [item.content, item.copyText, item.loading]);

  return (
    <Bubble
      placement={roleConfig.placement}
      styles={roleConfig.styles}
      classNames={roleConfig.classNames}
      messageRender={roleConfig.messageRender}
      content={item.content}
      loading={item.loading}
      className={item.className}
      header={item.header}
      avatar={item.avatar}
      footer={textContent ? () => <div className="ai-chat-bubble-footer"><CopyButton text={textContent} /></div> : undefined}
    />
  );
});

MessageBubble.displayName = "MessageBubble";

const ActivityTimeline = memo(({ items, isLastGroup }) => {
  const timelineItems = items.map((item, index) => {
    const isLast = index === items.length - 1;
    return {
      color: item.tone === "error" ? "red" : "gray",
      dot: isLast && isLastGroup ? <Spin size="small" /> : undefined,
      children: <MarkdownText text={String(item.content ?? "")} className="ai-chat-timeline-item-content" />
    };
  });

  return (
    <div className="ai-chat-activity-timeline">
      <Timeline items={timelineItems} />
    </div>
  );
});

ActivityTimeline.displayName = "ActivityTimeline";

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!text || copied) return;
    try {
      await writeClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [copied, text]);

  if (!text) return null;

  return (
    <button type="button" className="ai-chat-copy-button" onClick={handleCopy} title={copied ? "Copied!" : "Copy message"}>
      {copied ? <CheckOutlined /> : <CopyOutlined />}
    </button>
  );
}

function MarkdownText({ text, className = "" }) {
  return (
    <div className={["ai-chat-markdown", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => {
            void node;
            return <a {...props} target="_blank" rel="noreferrer noopener" />;
          }
        }}
      >
        {String(text || "")}
      </ReactMarkdown>
    </div>
  );
}

function MessageContent({ text, images }) {
  return (
    <div className="ai-chat-message-content">
      {text ? <MarkdownText text={text} /> : null}
      <ImageAttachmentGrid images={images} />
    </div>
  );
}

function ImageAttachmentGrid({ images }) {
  if (!images || images.length === 0) return null;
  return (
    <div className="ai-chat-attachment-body">
      {images.map((image, index) => (
        <figure className="ai-chat-attachment-row" key={String(index) + ":" + (image.name || image.mediaType || "")}>
          <div className="ai-chat-attachment-thumb">
            <img src={imageSrc(image)} alt={image.name || image.mediaType || "Image attachment"} />
          </div>
          <figcaption className="ai-chat-attachment-note">
            {[image.name || image.mediaType, formatBytes(image.size || image.sizeBytes || estimateBase64Bytes(image.dataBase64))].filter(Boolean).join(" · ")}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

function SearchResults({ results, query }) {
  if (!results || results.length === 0) {
    return <Alert className="ai-chat-search-empty" type="info" message={String(query || "").trim() ? "No matching files or folders" : "Search results will appear here"} />;
  }
  return (
    <List
      className="ai-chat-search-results"
      size="small"
      dataSource={results}
      renderItem={(result) => (
        <List.Item>
          <div>
            <strong>{result.name || result.path || "Untitled"}</strong>
            <code className="search-result-path">{result.path || ""}</code>
            <div className="search-result-meta">
              {[result.type || "file", Number.isFinite(result.score) ? "score " + result.score : "", result.size ? formatBytes(result.size) : "", result.updatedAt ? new Date(result.updatedAt).toLocaleString() : ""]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
        </List.Item>
      )}
    />
  );
}

function LegacyEventsList({ events }) {
  if (events.length === 0) {
    return <Alert type="info" message="Session history and streaming events will appear here." />;
  }
  return (
    <div className="legacy-events-list">
      {events.map((entry) => {
        const images = extractImageBlocks(entry.data);
        return (
          <article key={entry.id} className="legacy-event-entry">
            <div className="legacy-event-title">[{entry.time}] {entry.type}</div>
            <pre>{JSON.stringify(redactImageData(entry.data), null, 2)}</pre>
            <ImageAttachmentGrid images={images} />
          </article>
        );
      })}
    </div>
  );
}

function eventsToBubbleItems(events) {
  return events.flatMap((entry) => {
    if (!entry) return [];
    const meta = [entry.time, entry.type === "history" ? "history" : ""].filter(Boolean).join(" · ");

    if (entry.type === "prompt") {
      const images = Array.isArray(entry.data?.images) ? entry.data.images : [];
      const text = entry.data?.prompt ? String(entry.data.prompt) : "";
      return [
        createBubbleItem(entry.id, "user", {
          header: <BubbleHeader label="You" meta={[entry.time, modeLabel[entry.data?.mode]].filter(Boolean).join(" · ")} />,
          content: <MessageContent text={text} images={images} />,
          copyText: text
        })
      ];
    }

    if (entry.type === "history") {
      if (entry.data && entry.data.empty) return [createActivity(entry.id, "History", "No saved messages yet for this session.")];
      return toProtocolItems(entry.data, meta, entry.id);
    }

    if (entry.type === "message") {
      return toProtocolItems(entry.data, entry.time, entry.id);
    }

    if (entry.type === "result") {
      return resultToItems(entry);
    }

    if (entry.type === "client_error" || entry.type === "error") {
      return [createActivity(entry.id, "Error", activityText(entry.type, entry.data), "error")];
    }

    return [createActivity(entry.id, activityLabel(entry.type, entry.data), activityText(entry.type, entry.data), activityTone(entry.type))];
  });
}

function resultToItems(entry) {
  const data = entry.data;
  if (data && typeof data === "object" && data.is_error === true) {
    return [createActivity(entry.id, "Run error", activityText(entry.type, data), "error")];
  }
  const text = data && typeof data === "object" && data.result ? String(data.result) : "";
  if (!text) return [createActivity(entry.id, "Run result", activityText(entry.type, data), "success")];
  const meta = [
    entry.time,
    data.terminal_reason ? "terminal: " + data.terminal_reason : "",
    Number.isFinite(data.duration_ms) ? formatDuration(data.duration_ms) : "",
    Number.isFinite(data.total_cost_usd) ? "$" + data.total_cost_usd : ""
  ]
    .filter(Boolean)
    .join(" · ");
  return [
    createBubbleItem(entry.id, "assistant", {
      header: <BubbleHeader label="Claude" meta={meta} />,
      avatar: <AssistantAvatar />,
      content: <MarkdownText text={text} />,
      copyText: text
    })
  ];
}

function toProtocolItems(value, meta, keyBase) {
  if (!value || typeof value !== "object") return [];
  const record = value;
  const messageRecord = record.message && typeof record.message === "object" ? record.message : record;
  const role = normalizeRole(messageRecord.role || record.type);
  if (!role) return [];

  const content = messageRecord.content !== undefined ? messageRecord.content : record.content !== undefined ? record.content : record.message;
  const blocks = Array.isArray(content) ? content : [];
  const items = [];

  if (role === "system") {
    items.push(createActivity(`${keyBase}:system`, "System", extractTextContent(content) || JSON.stringify(redactImageData(content), null, 2), "tool"));
    return items;
  }

  if (!Array.isArray(content)) {
    const text = extractTextContent(content);
    const images = extractImageBlocks(content);
    if (!text && images.length === 0) return [];
    items.push(
      createBubbleItem(keyBase, role === "user" ? "user" : "assistant", {
        header: <BubbleHeader label={role === "user" ? "You" : "Claude"} meta={meta} />,
        avatar: role === "assistant" ? <AssistantAvatar /> : undefined,
        content: <MessageContent text={text} images={images} />,
        copyText: text
      })
    );
    return items;
  }

  const hasProtocolBlocks = blocks.some((block) => block && typeof block === "object" && ["tool_result", "tool_use", "thinking"].includes(block.type));
  const humanUser = role === "user" && !hasProtocolBlocks;
  if (humanUser) {
    const text = extractTextContent(blocks);
    const images = extractImageBlocks(blocks);
    if (text || images.length > 0) {
      items.push(
        createBubbleItem(keyBase, "user", {
          header: <BubbleHeader label="You" meta={meta} />,
          content: <MessageContent text={text} images={images} />,
          copyText: text
        })
      );
    }
    return items;
  }

  let textParts = [];
  let imageParts = [];

  function flushText(index) {
    const text = textParts.join("\n").trim();
    if (!text && imageParts.length === 0) return;
    items.push(
      createBubbleItem(`${keyBase}:text:${index}`, role === "user" ? ACTIVITY_ROLE : "assistant", {
        header: role === "assistant" ? <BubbleHeader label="Claude" meta={meta} /> : undefined,
        avatar: role === "assistant" ? <AssistantAvatar /> : undefined,
        content: role === "assistant" ? <MessageContent text={text} images={imageParts} /> : `User protocol input\n\n${text}`,
        copyText: text
      })
    );
    textParts = [];
    imageParts = [];
  }

  blocks.forEach((block, index) => {
    if (typeof block === "string") {
      textParts.push(block);
      return;
    }
    if (!block || typeof block !== "object") return;

    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      return;
    }
    if (block.type === "image") {
      imageParts.push(...extractImageBlocks(block));
      return;
    }
    if (block.type === "tool_use") {
      flushText(index);
      items.push(createActivity(`${keyBase}:tool_use:${index}`, "Tool use" + (block.name ? ": " + block.name : ""), formatToolUseBlock(block), "tool"));
      return;
    }
    if (block.type === "tool_result") {
      flushText(index);
      items.push(createActivity(`${keyBase}:tool_result:${index}`, "Tool result", formatToolResultBlock(block), "tool"));
      return;
    }
    if (block.type === "thinking") {
      flushText(index);
      items.push(createActivity(`${keyBase}:thinking:${index}`, "Assistant thinking", formatThinkingBlock(block), "muted"));
      return;
    }

    const text = extractTextContent(block);
    if (text) textParts.push(text);
  });

  flushText(blocks.length);
  return items;
}

function createBubbleItem(key, role, options) {
  return {
    key,
    role,
    header: options.header,
    avatar: options.avatar,
    content: options.content,
    copyText: options.copyText,
    className: "ai-chat-bubble-item"
  };
}

function createActivity(key, label, text, tone = "muted") {
  return {
    key,
    role: ACTIVITY_ROLE,
    tone,
    content: [label, text].filter(Boolean).join("\n\n")
  };
}

function groupBubbleItems(items) {
  const result = [];
  let i = 0;
  while (i < items.length) {
    if (items[i].role === ACTIVITY_ROLE) {
      const children = [];
      const groupKey = items[i].key;
      while (i < items.length && items[i].role === ACTIVITY_ROLE) {
        children.push(items[i]);
        i++;
      }
      result.push({ key: groupKey, role: GROUP_ROLE, items: children });
    } else {
      result.push(items[i]);
      i++;
    }
  }
  return result;
}

function BubbleHeader({ label, meta }) {
  return (
    <div className="ai-chat-bubble-header-inline">
      <span>{label}</span>
      {meta ? <small>{meta}</small> : null}
    </div>
  );
}

function AssistantAvatar() {
  return <div className="ai-chat-avatar">AI</div>;
}

function FilterGlyph() {
  return <span className="ai-chat-filter-glyph">≡</span>;
}

function normalizeRole(value) {
  if (value === "user" || value === "assistant" || value === "system") return value;
  if (value === "tool" || value === "tool_use" || value === "tool_result") return "tool";
  return null;
}

function formatToolResultBlock(block) {
  const body = extractTextContent(block.content) || (typeof block.content === "string" ? block.content : JSON.stringify(redactImageData(block.content), null, 2));
  return [block.tool_use_id ? "Tool use id: `" + block.tool_use_id + "`" : "", body].filter(Boolean).join("\n\n");
}

function formatToolUseBlock(block) {
  return [
    block.name ? "Name: `" + block.name + "`" : "",
    block.id ? "Tool use id: `" + block.id + "`" : "",
    block.input ? "```json\n" + JSON.stringify(redactImageData(block.input), null, 2) + "\n```" : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatThinkingBlock(block) {
  return extractTextContent(block.thinking || block.text || block.content) || JSON.stringify(redactImageData(block), null, 2);
}

function activityTone(type) {
  if (type === "client_error" || type === "error") return "error";
  if (type === "result" || type === "command_saved" || type === "command_deleted") return "success";
  if (type === "tool_use" || type === "tool_result" || type === "system") return "tool";
  return "muted";
}

function activityLabel(type, data) {
  if (type === "result") return "Run result";
  if (type === "tool_use") return "Tool use" + (data && data.name ? ": " + data.name : "");
  if (type === "tool_result") return "Tool result";
  if (type === "system") return "System";
  if (type === "command_saved") return "Command saved";
  if (type === "command_deleted") return "Command deleted";
  if (type === "session_created") return "Session created";
  if (type === "session_selected") return "Session selected";
  if (type === "session_restored") return "Session restored";
  if (type === "client") return "Client";
  return titleFromEventType(type);
}

function activityText(type, data) {
  if (typeof data === "string") return data;
  if (type === "result" && data && typeof data === "object") {
    return [
      data.result ? String(data.result) : "",
      data.terminal_reason ? "Terminal reason: " + data.terminal_reason : "",
      Number.isFinite(data.duration_ms) ? "Duration: " + data.duration_ms + " ms" : "",
      Number.isFinite(data.total_cost_usd) ? "Cost: $" + data.total_cost_usd : ""
    ]
      .filter(Boolean)
      .join("\n");
  }

  const text = extractTextContent(data);
  if (text) return text;
  return JSON.stringify(redactImageData(data), null, 2);
}

function extractTextContent(value) {
  if (typeof value === "string") return value;
  if (!value) return "";
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (typeof block === "string") return block;
        if (!block || typeof block !== "object") return "";
        if (typeof block.text === "string") return block.text;
        if (typeof block.content === "string") return block.content;
        if (block.type === "tool_use") return "[tool_use" + (block.name ? ":" + block.name : "") + "]";
        if (block.type === "tool_result") return "[tool_result]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (typeof value.result === "string") return value.result;
    if (value.message !== value) return extractTextContent(value.message);
  }
  return "";
}

function extractTextFromReact(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractTextFromReact).join("");
  if (content?.props?.children) return extractTextFromReact(content.props.children);
  return "";
}

function extractImageBlocks(value) {
  const images = [];
  const seen = new Set();

  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    if (node.type === "image" && node.source && node.source.type === "base64" && node.source.data && node.source.media_type) {
      const key = node.source.media_type + ":" + String(node.source.data).slice(0, 40);
      if (!seen.has(key)) {
        seen.add(key);
        images.push({
          mediaType: node.source.media_type,
          dataBase64: node.source.data,
          size: estimateBase64Bytes(node.source.data)
        });
      }
    }

    if (node.mediaType && node.dataBase64) {
      const key = node.mediaType + ":" + String(node.dataBase64).slice(0, 40);
      if (!seen.has(key)) {
        seen.add(key);
        images.push({
          name: node.name,
          mediaType: node.mediaType,
          dataBase64: node.dataBase64,
          size: node.size || estimateBase64Bytes(node.dataBase64)
        });
      }
    }

    Object.values(node).forEach(visit);
  }

  visit(value);
  return images;
}

function redactImageData(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactImageData);

  const copy = {};
  Object.entries(value).forEach(([key, item]) => {
    if ((key === "data" || key === "dataBase64") && typeof item === "string" && item.length > 80) {
      copy[key] = "[base64 image data redacted, " + formatBytes(estimateBase64Bytes(item)) + "]";
    } else {
      copy[key] = redactImageData(item);
    }
  });
  return copy;
}

function imageSrc(image) {
  if (image.previewUrl) return image.previewUrl;
  if (image.url) return image.url;
  if (image.dataBase64 && image.mediaType) return "data:" + image.mediaType + ";base64," + image.dataBase64;
  return "";
}

function getSessionId(session) {
  return session.sessionId || session.id || "";
}

function normalizeUserLabel(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function getDisplayLabel(value) {
  return normalizeUserLabel(value) || "Anonymous";
}

function getAvatarThemeFromLabel(value) {
  const themes = [
    { bg: "#2563eb", fg: "#ffffff" },
    { bg: "#0891b2", fg: "#ffffff" },
    { bg: "#059669", fg: "#ffffff" },
    { bg: "#ca8a04", fg: "#111827" },
    { bg: "#dc2626", fg: "#ffffff" },
    { bg: "#9333ea", fg: "#ffffff" }
  ];
  const label = getDisplayLabel(value);
  let hash = 0;
  for (let index = 0; index < label.length; index += 1) {
    hash = (hash * 31 + label.charCodeAt(index)) >>> 0;
  }
  return themes[hash % themes.length];
}

function normalizeSessionTitle(title, fallback = "Untitled chat") {
  if (typeof title !== "string") return fallback;
  const normalized = title.replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function formatSessionTimestamp(value) {
  if (!value) return "Recently";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  const now = new Date();
  const isSameDay = now.getFullYear() === date.getFullYear() && now.getMonth() === date.getMonth() && now.getDate() === date.getDate();
  if (isSameDay) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/).find((line) => line.trim())?.trim() || "";
}

function titleFromEventType(value) {
  return String(value || "event")
    .replace(/[_:]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function writeClipboard(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) throw new Error("Clipboard copy failed");
}

function initialChatPosition() {
  const width = Math.min(920, Math.max(720, window.innerWidth - 48));
  return {
    x: Math.max(16, window.innerWidth - width - 28),
    y: 28
  };
}

function clampPosition(x, y, element) {
  const width = element?.offsetWidth || Math.min(920, window.innerWidth - 32);
  const height = element?.offsetHeight || Math.min(740, window.innerHeight - 32);
  const padding = 12;
  return {
    x: Math.min(Math.max(padding, x), Math.max(padding, window.innerWidth - width - padding)),
    y: Math.min(Math.max(padding, y), Math.max(padding, window.innerHeight - Math.min(height, window.innerHeight - padding) - padding))
  };
}

function estimateBase64Bytes(value) {
  if (!value) return 0;
  const clean = String(value).replace(/^data:image\/[^;]+;base64,/i, "").replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "";
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  return (value / (1024 * 1024)).toFixed(1) + " MB";
}

function formatDuration(value) {
  if (!Number.isFinite(value)) return "";
  if (value < 1000) return value + " ms";
  return (value / 1000).toFixed(1) + " s";
}

function parseJsonOrText(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function errorMessage(error) {
  return String(error && error.message ? error.message : error);
}

createRoot(document.getElementById("root")).render(<App />);

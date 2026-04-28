import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "./styles.css";
import {
  CopyOutlined,
  DeleteOutlined,
  ReloadOutlined,
  SendOutlined,
  SettingOutlined,
  ToolOutlined
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Collapse,
  Drawer,
  Input,
  InputNumber,
  Select,
  Space
} from "antd";
import AgentChatMessageList from "./agent-chat/agent-chat-message-list.jsx";
import ChatFooter from "./agent-chat/chat-footer.jsx";
import ChatHeader from "./agent-chat/chat-header.jsx";
import MarkdownText from "./agent-chat/markdown-text.jsx";
import SessionSidebar from "./agent-chat/session-sidebar.jsx";
import { derivePromptTitle } from "./agent-chat/chat-ui-utils.js";

const { TextArea } = Input;

const storageKey = "claude-test-client:last-session";
const imageMediaTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const maxImages = 5;
const maxImageBytes = 5 * 1024 * 1024;
const ACTIVITY_ROLE = "assistant_activity";
const DEFAULT_CHAT_WIDTH = 920;
const DEFAULT_CHAT_HEIGHT = 780;
const MIN_CHAT_WIDTH = 640;
const MIN_CHAT_HEIGHT = 420;
const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const MIN_MAIN_COLUMN_WIDTH = 340;
const VIEWPORT_PADDING = 12;

const modeLabel = {
  plan: "Plan",
  bypass: "Bypass"
};

function App() {
  const [status, setStatus] = useState("Idle");
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState([]);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [hideEmptySessions, setHideEmptySessions] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isClosed, setIsClosed] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [mode, setMode] = useState("bypass");
  const [maxTurns, setMaxTurns] = useState(30);
  const [prompt, setPrompt] = useState("");
  const [selectedImages, setSelectedImages] = useState([]);
  const [events, setEvents] = useState([]);
  const [commands, setCommands] = useState([]);
  const [selectedCommandPath, setSelectedCommandPath] = useState("");
  const [commandPath, setCommandPath] = useState("");
  const [commandContent, setCommandContent] = useState("");
  const [commandsHint, setCommandsHint] = useState("Pick a session to manage slash commands");
  const [fileMentionSuggestions, setFileMentionSuggestions] = useState([]);
  const [fileMentionStatus, setFileMentionStatus] = useState("idle");
  const [isSending, setIsSending] = useState(false);
  const [isObservedRunning, setIsObservedRunning] = useState(false);
  const [historyCopyLabel, setHistoryCopyLabel] = useState("Copy JSON");
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [chatFrame, setChatFrame] = useState(initialChatFrame);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [hasGrabContext, setHasGrabContext] = useState(false);
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [latestAnnotation, setLatestAnnotation] = useState(null);
  const [hasChipAnswer, setHasChipAnswer] = useState(false);
  const controllerRef = useRef();
  const observeControllerRef = useRef();
  const askQuestionFooterRef = useRef(null);
  const sessionIdRef = useRef("");
  const baseUrlRef = useRef(window.location.origin);
  const mentionSearchRequestRef = useRef(0);
  const commandsRef = useRef([]);
  const historyCopyTimeoutRef = useRef();
  const chatRef = useRef(null);
  const chatFrameRef = useRef(chatFrame);
  const sidebarRef = useRef(null);
  const sidebarWidthRef = useRef(sidebarWidth);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    commandsRef.current = commands;
  }, [commands]);

  useEffect(() => {
    chatFrameRef.current = chatFrame;
  }, [chatFrame]);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

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
      setChatFrame((current) => clampChatFrame(current));
      setSidebarWidth((current) => clampSidebarWidth(current, chatRef.current));
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
  const activeAskUserQuestion = useMemo(() => getActiveAskUserQuestion(events), [events]);

  const searchFileMentions = useCallback(async (query) => {
    const requestId = mentionSearchRequestRef.current + 1;
    mentionSearchRequestRef.current = requestId;

    const activeSessionId = sessionIdRef.current;
    if (query === null) {
      setFileMentionSuggestions([]);
      setFileMentionStatus("idle");
      return;
    }
    if (!activeSessionId) {
      setFileMentionSuggestions([]);
      setFileMentionStatus("needs-session");
      return;
    }
    const normalizedQuery = String(query || "").trim();

    setFileMentionStatus("loading");
    try {
      const result = await getJson(
        "/v1/sessions/" +
          encodeURIComponent(activeSessionId) +
          "/files:search?q=" +
          encodeURIComponent(normalizedQuery) +
          "&limit=50"
      );
      if (mentionSearchRequestRef.current !== requestId) return;
      const paths = (Array.isArray(result.results) ? result.results : [])
        .map((item) => item.path)
        .filter(Boolean);
      setFileMentionSuggestions(Array.from(new Set(paths)));
      setFileMentionStatus(paths.length > 0 ? "ready" : "empty");
    } catch {
      if (mentionSearchRequestRef.current === requestId) {
        setFileMentionSuggestions([]);
        setFileMentionStatus("error");
      }
    }
  }, []);

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

  async function patchJson(path, body) {
    const response = await fetch(apiPath(path), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  async function loadSessions(options = {}) {
    const saved = readSavedSession();
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

  function createSession() {
    forgetSession();
    setStatus("Idle");
  }

  async function loadSessionView(id, eventName, session) {
    stopObserving();
    setEvents([]);
    setFileMentionSuggestions([]);
    setFileMentionStatus("idle");

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
      await backfillSessionTitle(id, session, messages);
    } catch (error) {
      appendEntry("client_error", "Could not load session history: " + errorMessage(error));
    }

    observeSession(id);
  }

  async function backfillSessionTitle(id, session, messages) {
    if (!isGenericSessionTitle(session?.title)) return;
    const firstPrompt = findFirstUserPrompt(messages);
    const derived = derivePromptTitle(firstPrompt);
    if (!derived) return;
    try {
      await patchJson("/v1/sessions/" + encodeURIComponent(id), { title: derived });
      await loadSessions({ restoreSaved: false });
    } catch {}
  }

  async function runPrompt(value, options = {}) {
    const nextPrompt = String(value ?? prompt).trim();
    if (!nextPrompt) return;

    setIsSending(true);
    setStatus("Generating");
    const controller = new AbortController();
    controllerRef.current = controller;
    let activeSessionId = sessionIdRef.current;

    const derivedTitle = derivePromptTitle(nextPrompt);
    let shouldPatchTitle = false;

    try {
      if (!activeSessionId) {
        const created = await postJson("/v1/sessions", {
          mode,
          title: derivedTitle
        });
        activeSessionId = created.sessionId || created.id;
        setSessionId(activeSessionId);
        rememberSession({ sessionId: activeSessionId });
        await loadSessions({ restoreSaved: false });
        await loadClaudeCommands(activeSessionId);
      } else {
        const existing = sessions.find((session) => getSessionId(session) === activeSessionId);
        if (isGenericSessionTitle(existing?.title)) shouldPatchTitle = true;
      }

      stopObserving();
      if (shouldPatchTitle) {
        try {
          await patchJson("/v1/sessions/" + encodeURIComponent(activeSessionId), { title: derivedTitle });
        } catch {}
      }
      const images = options.toolResult ? [] : selectedImages.map((image) => ({
        name: image.name,
        mediaType: image.mediaType,
        dataBase64: image.dataBase64
      }));
      appendEntry("prompt", { prompt: nextPrompt, mode, images, toolResult: options.toolResult });
      setPrompt("");

      const response = await fetch(apiPath("/v1/sessions/" + encodeURIComponent(activeSessionId) + "/messages:stream"), {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: nextPrompt,
          images: images.length > 0 ? images : undefined,
          toolResult: options.toolResult,
          mode,
          maxTurns: Number(maxTurns || 30)
        })
      });

      if (!response.ok || !response.body) throw new Error(await response.text());

      const streamOutcome = await readSse(response.body);
      if (streamOutcome.waitingForUserQuestion) {
        setStatus("Waiting for user");
      } else if (streamOutcome.ok) {
        setStatus("Complete");
      } else {
        setStatus("Error");
      }
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
    const outcome = { ok: true, waitingForUserQuestion: false };

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || "";
      parts.forEach((part) => updateStreamOutcome(outcome, emitSse(part, source), source));
    }

    buffer += decoder.decode();
    if (buffer.trim()) updateStreamOutcome(outcome, emitSse(buffer, source), source);
    return outcome;
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
      return { event, data: parsed, consumed: true };
    }
    if (event === "done" && source === "observer" && parsed && parsed.observing === false) {
      setIsObservedRunning(false);
      return { event, data: parsed, consumed: true };
    }
    appendEntry(event, parsed);
    return { event, data: parsed, consumed: false };
  }

  function updateStreamOutcome(outcome, emitted, source) {
    if (!emitted || source === "observer") return;
    if (emitted.event === "question_pending") {
      outcome.waitingForUserQuestion = true;
      outcome.ok = true;
    }
    if (emitted.event === "done") {
      outcome.waitingForUserQuestion = Boolean(emitted.data?.waitingForUserQuestion);
      outcome.ok = emitted.data?.ok !== false;
    }
    if (emitted.event === "error") {
      outcome.ok = false;
    }
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
    setMode(session?.mode === "plan" || session?.mode === "bypass" ? session.mode : "bypass");
    rememberSession({ sessionId: id });
    loadSessionView(id, eventName, session);
  }

  function changeMode(nextMode) {
    setMode(nextMode);
    const id = sessionIdRef.current;
    if (!id) return;
    patchJson("/v1/sessions/" + encodeURIComponent(id), { mode: nextMode })
      .then(() => loadSessions({ restoreSaved: false }))
      .catch(() => {});
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
    setFileMentionSuggestions([]);
    setFileMentionStatus("idle");
    localStorage.removeItem(storageKey);
    setEvents([]);
    clearCommandEditor();
    setCommandsHint("Pick a session to manage slash commands");
  }

  function rememberSession(session) {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        sessionId: session.sessionId
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

  function activateInspect() {
    setHasGrabContext(true);
    appendEntry("client", { inspectContext: "workspace", active: true });
  }

  function clearInspectContext() {
    setHasGrabContext(false);
    appendEntry("client", { inspectContext: "workspace", active: false });
  }

  function toggleAnnotating() {
    setIsAnnotating((current) => {
      const next = !current;
      if (next) {
        const annotation = { label: "Manual annotation context", createdAt: new Date().toISOString() };
        setLatestAnnotation(annotation);
        appendEntry("client", { annotation });
      }
      return next;
    });
  }

  function clearAnnotation() {
    setIsAnnotating(false);
    setLatestAnnotation(null);
    appendEntry("client", { annotation: null });
  }

  function startDrag(event) {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target.closest("button, input, textarea, select, a, .ant-dropdown, .ant-drawer")) return;
    const origin = chatFrameRef.current;
    const dragStart = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      originX: origin.x,
      originY: origin.y
    };

    function move(pointerEvent) {
      setChatFrame((current) =>
        clampChatFrame({
          ...current,
          x: dragStart.originX + pointerEvent.clientX - dragStart.pointerX,
          y: dragStart.originY + pointerEvent.clientY - dragStart.pointerY
        })
      );
    }

    function stop() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function startWindowResize(event, direction) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const origin = chatFrameRef.current;
    const resizeStart = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      width: origin.width,
      height: origin.height
    };
    const cursor = direction === "south" ? "ns-resize" : direction === "east" ? "ew-resize" : "nwse-resize";
    const restoreInteraction = beginResizeInteraction(cursor);

    function move(pointerEvent) {
      const deltaX = pointerEvent.clientX - resizeStart.pointerX;
      const deltaY = pointerEvent.clientY - resizeStart.pointerY;
      setChatFrame((current) =>
        clampChatFrame({
          ...current,
          width: direction === "south" ? resizeStart.width : resizeStart.width + deltaX,
          height: direction === "east" ? resizeStart.height : resizeStart.height + deltaY
        })
      );
      setSidebarWidth((current) => clampSidebarWidth(current, chatRef.current));
    }

    function stop() {
      restoreInteraction();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function startSidebarResize(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const resizeStart = {
      pointerX: event.clientX,
      width: sidebarWidthRef.current
    };
    const restoreInteraction = beginResizeInteraction("col-resize");

    function move(pointerEvent) {
      setSidebarWidth(clampSidebarWidth(resizeStart.width + pointerEvent.clientX - resizeStart.pointerX, chatRef.current));
    }

    function stop() {
      restoreInteraction();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  const chatHeader = (
    <ChatHeader
      isSidebarOpen={isSidebarOpen}
      onToggleSidebar={() => setIsSidebarOpen((value) => !value)}
      hasStreamingSessions={busy}
      hasCurrentUserIdentity={Boolean(activeSession)}
      onLogout={forgetSession}
      onClose={() => setIsClosed(true)}
      onMinimize={() => setIsMinimized((value) => !value)}
      onExportSession={copySessionHistoryJson}
      onOpenHistory={() => setIsHistoryOpen(true)}
      canExportSession={events.length > 0}
      dragHandleProps={{ onPointerDown: startDrag }}
      status={busy ? "Generating" : status}
      isMinimized={isMinimized}
    />
  );

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
        style={{
          left: chatFrame.x,
          top: chatFrame.y,
          width: chatFrame.width,
          ...(isMinimized ? {} : { height: chatFrame.height })
        }}
      >
        <div className="ai-chat-card">
          {isMinimized ? (
            chatHeader
          ) : (
            <div className={["ai-chat-two-columns", "is-narrow", isSidebarOpen ? "sidebar-open" : ""].join(" ")}>
              <aside
                ref={sidebarRef}
                className={["ai-chat-sidebar-column", isSidebarOpen ? "is-open" : ""].filter(Boolean).join(" ")}
                style={{ "--ai-chat-sidebar-width": sidebarWidth + "px" }}
                aria-hidden={isSidebarOpen ? undefined : "true"}
              >
                {isSidebarOpen ? (
                  <>
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
                      clearEvents={() => setEvents([])}
                      openHistory={() => setIsHistoryOpen(true)}
                    />
                    <button
                      type="button"
                      className="ai-chat-sidebar-resize-handle"
                      aria-label="Resize sessions sidebar"
                      title="Resize sidebar"
                      onPointerDown={startSidebarResize}
                    />
                  </>
                ) : null}
              </aside>
              {isSidebarOpen ? (
                <button className="ai-chat-sidebar-backdrop" type="button" aria-label="Hide sessions" onClick={() => setIsSidebarOpen(false)} />
              ) : null}
              <main className="ai-chat-main-column">
                {chatHeader}
                <AgentChatMessageList
                  bubbleItems={bubbleItems}
                  bubbleRoles={bubbleRoles}
                  isStreaming={busy}
                  open={!isClosed && !isMinimized}
                  writeClipboard={writeClipboard}
                />
                <ChatFooter
                  senderValue={prompt}
                  setSenderValue={setPrompt}
                  permissionMode={mode}
                  onPermissionChange={changeMode}
                  showQuestionFooter={Boolean(activeAskUserQuestion)}
                  activeAskUserQuestionData={activeAskUserQuestion?.data}
                  activeAskUserQuestionMessageId={activeAskUserQuestion?.id}
                  activeAskUserQuestionToolUseId={activeAskUserQuestion?.toolUseId}
                  hasGrabContext={hasGrabContext}
                  isAnnotating={isAnnotating}
                  latestAnnotation={latestAnnotation}
                  isStreamingActiveSession={isSending}
                  isSessionOwner={true}
                  hasChipAnswer={hasChipAnswer}
                  setHasChipAnswer={setHasChipAnswer}
                  askQuestionFooterRef={askQuestionFooterRef}
                  onActivateInspect={activateInspect}
                  onInspectPillClear={clearInspectContext}
                  onStartAnnotating={toggleAnnotating}
                  onClearAnnotation={clearAnnotation}
                  onStopStreaming={interrupt}
                  onSubmit={runPrompt}
                  pendingUploads={selectedImages}
                  onAddUploads={onFilesSelected}
                  onRemoveUpload={(id) => setSelectedImages((current) => current.filter((image) => image.id !== id))}
                  onClearUploads={() => setSelectedImages([])}
                  slashCommands={slashCommands}
                  mentionSuggestions={fileMentionSuggestions}
                  mentionStatus={fileMentionStatus}
                  onMentionSearch={searchFileMentions}
                  formatBytes={formatBytes}
                  estimateBase64Bytes={estimateBase64Bytes}
                  imageSrc={imageSrc}
                />
              </main>
            </div>
          )}
        </div>
        {!isMinimized ? (
          <>
            <button
              type="button"
              className="ai-chat-window-resize-handle ai-chat-window-resize-east"
              aria-label="Resize chat width"
              title="Resize width"
              onPointerDown={(event) => startWindowResize(event, "east")}
            />
            <button
              type="button"
              className="ai-chat-window-resize-handle ai-chat-window-resize-south"
              aria-label="Resize chat height"
              title="Resize height"
              onPointerDown={(event) => startWindowResize(event, "south")}
            />
            <button
              type="button"
              className="ai-chat-window-resize-handle ai-chat-window-resize-southeast"
              aria-label="Resize chat window"
              title="Resize window"
              onPointerDown={(event) => startWindowResize(event, "southeast")}
            />
          </>
        ) : null}
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
            <span>Max turns</span>
            <InputNumber
              size="small"
              min={1}
              value={props.maxTurns}
              onChange={(value) => props.setMaxTurns(value || 30)}
              style={{ width: "100%" }}
            />
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
            <Input
              size="small"
              disabled={!props.sessionId}
              value={props.commandPath}
              placeholder="review/fix.md"
              onChange={(event) => props.setCommandPath(event.target.value)}
            />
          </label>
          <label className="ai-chat-field">
            <span>Command content</span>
            <TextArea
              disabled={!props.sessionId}
              rows={5}
              value={props.commandContent}
              placeholder="Write the Claude slash command markdown here."
              onChange={(event) => props.setCommandContent(event.target.value)}
            />
          </label>
          <Space size={6} wrap>
            <Button size="small" type="primary" disabled={!props.sessionId} onClick={props.saveCommand}>
              Save
            </Button>
            <Button size="small" disabled={!props.sessionId} onClick={props.clearCommandEditor}>
              New
            </Button>
            <Button
              size="small"
              danger
              disabled={!props.sessionId}
              icon={<DeleteOutlined />}
              onClick={props.deleteCommand}
            >
              Delete
            </Button>
            <Button
              size="small"
              disabled={!props.sessionId}
              icon={<ReloadOutlined />}
              onClick={() => props.loadClaudeCommands()}
            >
              Refresh
            </Button>
          </Space>
        </div>
      )
    },
  ];

  return (
    <Collapse
      size="small"
      ghost
      className="ai-chat-tools"
      items={collapseItems}
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

    return [createToolActivity(entry.id, activityLabel(entry.type, entry.data), activityText(entry.type, entry.data), activityTone(entry.type))];
  });
}

function resultToItems(entry) {
  const data = entry.data;
  if (data && typeof data === "object" && data.is_error === true) {
    return [createActivity(entry.id, "Run error", activityText(entry.type, data), "error")];
  }
  return [];
}

const LEGACY_GENERIC_TITLES = new Set(["AI chat panel", "Untitled chat", "New chat"]);

function isGenericSessionTitle(title) {
  if (typeof title !== "string") return true;
  const trimmed = title.trim();
  if (!trimmed) return true;
  return LEGACY_GENERIC_TITLES.has(trimmed);
}

function findFirstUserPrompt(messages) {
  if (!Array.isArray(messages)) return "";
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.parent_tool_use_id) continue;
    const inner = message.message && typeof message.message === "object" ? message.message : message;
    const role = inner.role || message.type;
    if (role !== "user") continue;
    const content = inner.content !== undefined ? inner.content : message.content;
    if (typeof content === "string" && content.trim()) return content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block) => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join(" ")
      .trim();
    if (text) return text;
  }
  return "";
}

function getActiveAskUserQuestion(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index];
    if (!entry) continue;
    if (entry.type === "question_pending" && entry.data?.waitingForUserQuestion && Array.isArray(entry.data?.input?.questions)) {
      return {
        id: entry.id,
        data: entry.data.input,
        toolUseId: entry.data.toolUseId
      };
    }
    const tool = findAskUserQuestionTool(entry.data);
    if (tool?.input) {
      return {
        id: entry.id,
        data: tool.input,
        toolUseId: tool.id
      };
    }
    if (closesAskUserQuestion(entry)) return null;
  }
  return null;
}

function closesAskUserQuestion(entry) {
  if (!entry) return false;
  if (entry.type === "prompt" || entry.type === "result") return true;
  if (entry.type === "done") return !entry.data?.waitingForUserQuestion;
  if (entry.type !== "history" && entry.type !== "message") return false;

  const record = entry.data && typeof entry.data === "object" ? entry.data : {};
  const message = record.message && typeof record.message === "object" ? record.message : record;
  const role = normalizeRole(message.role || record.type);
  const content = message.content !== undefined ? message.content : record.content;
  const blocks = Array.isArray(content) ? content : [];

  if (role !== "user") return false;
  if (record.parent_tool_use_id || message.parent_tool_use_id) return false;
  if (!Array.isArray(content)) return Boolean(extractTextContent(content));
  const toolResults = blocks.filter((block) => block && typeof block === "object" && block.type === "tool_result");
  if (toolResults.length > 0) {
    const allErrored = toolResults.every((block) => block.is_error === true);
    if (allErrored) return false;
    return true;
  }
  return blocks.some((block) => block && typeof block === "object" && block.type === "text" && String(block.text || "").trim());
}

function findAskUserQuestionTool(value) {
  if (!value || typeof value !== "object") return null;
  const record = value;
  const message = record.message && typeof record.message === "object" ? record.message : record;
  if (message.stop_reason !== "tool_use") return null;
  const blocks = Array.isArray(message.content) ? message.content : [];
  return (
    blocks.find(
      (block) =>
        block &&
        typeof block === "object" &&
        block.type === "tool_use" &&
        block.name === "AskUserQuestion" &&
        block.input &&
        Array.isArray(block.input.questions)
    ) || null
  );
}

function toProtocolItems(value, meta, keyBase) {
  if (!value || typeof value !== "object") return [];
  const record = value;
  const messageRecord = record.message && typeof record.message === "object" ? record.message : record;
  const rawRole = normalizeRole(messageRecord.role || record.type);
  if (!rawRole) return [];
  const isAgentToolEcho =
    rawRole === "user" &&
    (record.parent_tool_use_id || messageRecord.parent_tool_use_id);
  const role = isAgentToolEcho ? "assistant" : rawRole;

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
      items.push(createToolActivity(`${keyBase}:tool_use:${index}`, "Tool use" + (block.name ? ": " + block.name : ""), formatToolUseBlock(block), "tool"));
      return;
    }
    if (block.type === "tool_result") {
      flushText(index);
      items.push(createToolActivity(`${keyBase}:tool_result:${index}`, "Tool result", formatToolResultBlock(block), "tool"));
      return;
    }
    if (block.type === "thinking") {
      flushText(index);
      items.push(createToolActivity(`${keyBase}:thinking:${index}`, "Assistant thinking", formatThinkingBlock(block), "muted"));
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

function createToolActivity(key, label, details, tone = "tool") {
  return {
    key,
    role: ACTIVITY_ROLE,
    tone,
    collapsible: true,
    label,
    details: details || ""
  };
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
    block.id ? "Tool use id: `" + block.id + "`" : "",
    block.input ? "```json\n" + JSON.stringify(redactImageData(block.input), null, 2) + "\n```" : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatThinkingBlock(block) {
  const value = block.thinking ?? block.text ?? block.content;
  const text = extractTextContent(value);
  if (text) return formatMaybeJsonMarkdown(text);
  if (value && typeof value === "object") return formatJsonMarkdown(value);
  return formatJsonMarkdown(block);
}

function formatMaybeJsonMarkdown(value) {
  const text = String(value ?? "");
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("```") || !/^[\[{]/.test(trimmed)) return text;

  try {
    return formatJsonMarkdown(JSON.parse(trimmed));
  } catch {
    return text;
  }
}

function formatJsonMarkdown(value) {
  return "```json\n" + JSON.stringify(redactImageData(value), null, 2) + "\n```";
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

function initialChatFrame() {
  const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2);
  const availableHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2);
  const width = Math.min(DEFAULT_CHAT_WIDTH, Math.max(Math.min(MIN_CHAT_WIDTH, availableWidth), window.innerWidth - 48));
  const height = Math.min(DEFAULT_CHAT_HEIGHT, Math.max(Math.min(MIN_CHAT_HEIGHT, availableHeight), window.innerHeight - 48));
  return clampChatFrame({
    x: Math.max(16, window.innerWidth - width - 28),
    y: 28,
    width,
    height
  });
}

function clampChatFrame(frame) {
  const maxWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2);
  const maxHeight = Math.max(0, window.innerHeight - VIEWPORT_PADDING * 2);
  const minWidth = Math.min(MIN_CHAT_WIDTH, maxWidth);
  const minHeight = Math.min(MIN_CHAT_HEIGHT, maxHeight);
  const width = clampNumber(frame.width, minWidth, maxWidth);
  const height = clampNumber(frame.height, minHeight, maxHeight);
  return {
    x: clampNumber(frame.x, VIEWPORT_PADDING, Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING)),
    y: clampNumber(frame.y, VIEWPORT_PADDING, Math.max(VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING)),
    width,
    height
  };
}

function clampSidebarWidth(width, container) {
  const containerWidth = container?.getBoundingClientRect().width || DEFAULT_CHAT_WIDTH;
  const maxWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, containerWidth - MIN_MAIN_COLUMN_WIDTH));
  return Math.round(clampNumber(width, MIN_SIDEBAR_WIDTH, maxWidth));
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function beginResizeInteraction(cursor) {
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  document.body.classList.add("ai-chat-resizing");
  document.body.style.cursor = cursor;
  document.body.style.userSelect = "none";
  return () => {
    document.body.classList.remove("ai-chat-resizing");
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
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

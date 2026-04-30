import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "./styles.css";
import {
  CopyOutlined,
  SendOutlined
} from "@ant-design/icons";
import {
  Button,
  Drawer,
  Space
} from "antd";
import AgentChatMessageList from "./agent-chat/agent-chat-message-list.jsx";
import { ChatIdentityOnboarding } from "./agent-chat/chat-identity-onboarding.jsx";
import ChatFooter from "./agent-chat/chat-footer.jsx";
import ChatHeader from "./agent-chat/chat-header.jsx";
import { LegacyEventsList } from "./agent-chat/legacy-events-list.jsx";
import { SettingsPanel, SidebarSettingsButton } from "./agent-chat/chat-settings-panel.jsx";
import SessionSidebar from "./agent-chat/session-sidebar.jsx";
import {
  derivePromptTitle,
  getDisplayLabel,
  getUserAccentStyle,
  normalizeUserLabel
} from "./agent-chat/chat-ui-utils.js";
import {
  createEventEntry,
  createHistoryEntries,
  mergeEventEntries
} from "./agent-chat/event-state-utils.js";
import {
  buildSessionExportFilename,
  buildSessionExportPayload,
  downloadJsonFile,
  serializeHistoryEvents
} from "./agent-chat/export-utils.js";
import {
  eventsToBubbleItems,
  findFirstUserPrompt,
  getActiveAskUserQuestion,
  getActiveExitPlanApproval,
  shouldSkipDisplayEntry
} from "./agent-chat/message-event-utils.jsx";
import { estimateBase64Bytes, formatBytes, imageSrc } from "./agent-chat/media-utils.js";
import {
  DEFAULT_SIDEBAR_WIDTH,
  beginDragInteraction,
  beginResizeInteraction,
  clampChatFrame,
  clampSidebarWidth,
  initialChatFrame
} from "./agent-chat/window-frame-utils.js";

const storageKey = "claude-test-client:last-session";
const identityStorageKey = "claude-test-client:user-identity";
const chatFrameStorageKey = "claude-test-client:chat-frame:v1";
const sidebarWidthStorageKey = "claude-test-client:sidebar-width:v1";
const imageMediaTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const maxImages = 5;
const maxImageBytes = 5 * 1024 * 1024;
const USER_LABEL_MAX_LENGTH = 40;
const GUEST_USER_NAME = "Guest";
const SESSION_PAGE_SIZE = 30;
const MESSAGE_PAGE_SIZE = 200;
const NARROW_VIEWPORT_MAX_WIDTH = 768;

const modeLabel = {
  plan: "Plan",
  edit: "Edit",
  bypass: "Bypass"
};

function App() {
  const [status, setStatus] = useState("Idle");
  const [userName, setUserName] = useState(() => readSavedIdentity());
  const [identityInput, setIdentityInput] = useState(() => readSavedIdentity());
  const [sessionId, setSessionId] = useState("");
  const [sessions, setSessions] = useState([]);
  const [sessionsHasMore, setSessionsHasMore] = useState(false);
  const [isSessionsLoading, setIsSessionsLoading] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [creatorFilter, setCreatorFilter] = useState("");
  const [activePanelView, setActivePanelView] = useState("chat");
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => !isNarrowViewport());
  const [isClosed, setIsClosed] = useState(false);
  const [mode, setMode] = useState("bypass");
  const [maxTurns, setMaxTurns] = useState(30);
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [selectedImages, setSelectedImages] = useState([]);
  const [events, setEvents] = useState([]);
  const [historyPageInfo, setHistoryPageInfo] = useState(() => createEmptyHistoryPageInfo());
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [commands, setCommands] = useState([]);
  const [selectedCommandPath, setSelectedCommandPath] = useState("");
  const [commandPath, setCommandPath] = useState("");
  const [commandContent, setCommandContent] = useState("");
  const [commandsHint, setCommandsHint] = useState("Manage project root slash commands");
  const [rootInfo, setRootInfo] = useState(null);
  const [fileMentionSuggestions, setFileMentionSuggestions] = useState([]);
  const [fileMentionStatus, setFileMentionStatus] = useState("idle");
  const [isSending, setIsSending] = useState(false);
  const [isObservedRunning, setIsObservedRunning] = useState(false);
  const [historyCopyLabel, setHistoryCopyLabel] = useState("Copy JSON");
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [chatFrame, setChatFrame] = useState(readSavedChatFrame);
  const [sidebarWidth, setSidebarWidth] = useState(readSavedSidebarWidth);
  const [hasGrabContext, setHasGrabContext] = useState(false);
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [latestAnnotation, setLatestAnnotation] = useState(null);
  const [hasChipAnswer, setHasChipAnswer] = useState(false);
  const controllerRef = useRef();
  const observeControllerRef = useRef();
  const streamingSessionIdRef = useRef();
  const observingSessionIdRef = useRef();
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
  const sessionsNextOffsetRef = useRef(0);
  const sessionsLoadingRef = useRef(false);
  const historyLoadingRef = useRef(false);
  const streamQueueRef = useRef([]);
  const streamFrameRef = useRef(null);
  const streamTimeoutRef = useRef(null);
  const dragFrameRef = useRef(null);
  const wasNarrowViewportRef = useRef(isNarrowViewport());

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
    loadClaudeCommands();
    getJson("/v1/root")
      .then((result) => setRootInfo(result))
      .catch(() => {});
    getJson("/v1/settings")
      .then((result) => {
        if (Number.isInteger(result?.maxConcurrentRuns)) setMaxConcurrentRuns(result.maxConcurrentRuns);
        if (Number.isInteger(result?.maxTurns)) setMaxTurns(result.maxTurns);
      })
      .catch(() => {});
    return () => {
      stopObserving();
      if (historyCopyTimeoutRef.current) window.clearTimeout(historyCopyTimeoutRef.current);
      cancelQueuedStreamFlush();
      if (dragFrameRef.current) window.cancelAnimationFrame(dragFrameRef.current);
      if (controllerRef.current) controllerRef.current.abort();
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      const isNarrow = isNarrowViewport();
      if (isNarrow !== wasNarrowViewportRef.current) {
        wasNarrowViewportRef.current = isNarrow;
        setIsSidebarOpen(!isNarrow);
        if (!isNarrow) {
          const restoredFrame = readSavedChatFrame();
          const restoredSidebarWidth = readSavedSidebarWidth();
          chatFrameRef.current = restoredFrame;
          sidebarWidthRef.current = restoredSidebarWidth;
          setChatFrame(restoredFrame);
          setSidebarWidth(restoredSidebarWidth);
        }
        return;
      }
      if (isNarrow) return;
      updateChatFrame(chatFrameRef.current, { persist: true });
      updateSidebarWidth(sidebarWidthRef.current, { persist: true });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const busy = isSending || isObservedRunning;
  // Show pause/send based on whether the currently-viewed session is the one streaming,
  // not whether any session is streaming globally.
  const isStreamingActiveSession =
    (isSending && streamingSessionIdRef.current === sessionId) ||
    (isObservedRunning && observingSessionIdRef.current === sessionId);
  const activeSession = sessions.find((session) => getSessionId(session) === sessionId);
  const isActiveSessionOwner = activeSession
    ? normalizeUserLabel(getSessionUserName(activeSession)).toLowerCase() ===
      normalizeUserLabel(userName || GUEST_USER_NAME).toLowerCase()
    : true;
  const deferredSessionSearchQuery = useDeferredValue(sessionSearchQuery);
  const deferredCreatorFilter = useDeferredValue(creatorFilter);
  const creatorFilterOptions = useMemo(() => {
    const creators = new Map();
    sessions.forEach((session) => {
      const label = getDisplayLabel(session.userName || GUEST_USER_NAME);
      const key = normalizeUserLabel(label).toLowerCase();
      if (key && !creators.has(key)) creators.set(key, label);
    });
    return Array.from(creators.values())
      .sort((left, right) => left.localeCompare(right))
      .map((label) => ({ value: label, label }));
  }, [sessions]);
  const filteredSessions = useMemo(() => {
    const query = deferredSessionSearchQuery.trim().toLowerCase();
    const normalizedCreatorFilter = normalizeUserLabel(deferredCreatorFilter).toLowerCase();
    return sessions
      .filter((session) => {
        if (normalizedCreatorFilter) {
          const sessionUserName = normalizeUserLabel(session.userName || GUEST_USER_NAME).toLowerCase();
          if (sessionUserName !== normalizedCreatorFilter) return false;
        }
        if (!query) return true;
        const id = getSessionId(session);
        return [session.title, session.userName || GUEST_USER_NAME, id, session.mode]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(query);
      });
  }, [deferredCreatorFilter, deferredSessionSearchQuery, sessions]);
  const hasActiveSessionFilter =
    Boolean(deferredSessionSearchQuery.trim()) || Boolean(normalizeUserLabel(deferredCreatorFilter));
  const hasVisibleMoreSessions =
    sessionsHasMore && (!hasActiveSessionFilter || filteredSessions.length >= SESSION_PAGE_SIZE);

  const commandOptions = commands.map((command) => ({ value: command.path, label: command.path }));

  const slashCommands = useMemo(() => {
    return commands.map((command) => ({
      id: command.path,
      name: command.path.replace(/^\.?claude\/commands\//, "").replace(/\.md$/, ""),
      description: command.content ? firstLine(command.content) : command.path
    }));
  }, [commands]);

  const displayUserName = activeSession
    ? getSessionUserName(activeSession)
    : getDisplayLabel(userName || GUEST_USER_NAME);
  const accentStyle = useMemo(() => getUserAccentStyle(getDisplayLabel(userName || GUEST_USER_NAME)), [userName]);
  const bubbleItems = useMemo(() => eventsToBubbleItems(events, displayUserName), [displayUserName, events]);
  const bubbleRoles = useMemo(
    () => ({
      user: {
        placement: "end",
        styles: {
          content: {
            background: "var(--ai-chat-color-bubble-user-bg)",
            backgroundColor: "var(--ai-chat-color-bubble-user-bg)",
            borderColor: "var(--ai-chat-user-accent-border)",
            color: "var(--ai-chat-color-bubble-user-text)"
          }
        }
      },
      assistant: { placement: "start" },
      assistant_stream: { placement: "start", classNames: { content: "ai-chat-stream-content" } }
    }),
    []
  );
  const activeAskUserQuestion = useMemo(() => getActiveAskUserQuestion(events), [events]);
  const activeExitPlanApproval = useMemo(() => getActiveExitPlanApproval(events), [events]);

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

  function setMergedEvents(updater) {
    setEvents((current) => {
      const next = updater(current);
      return next;
    });
  }

  function replaceEvents(nextEvents) {
    setEvents(nextEvents);
  }

  function appendEntry(type, data, options = {}) {
    appendEntries([createEventEntry(type, data, options)], options);
  }

  function appendEntries(entries, options = {}) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    setMergedEvents((current) => mergeEventEntries(current, entries, { prepend: options.prepend }));
  }

  function queueStreamEntry(type, data) {
    streamQueueRef.current.push(createEventEntry(type, data));
    scheduleQueuedStreamFlush();
  }

  function scheduleQueuedStreamFlush() {
    if (streamFrameRef.current === null) {
      streamFrameRef.current = window.requestAnimationFrame(() => {
        streamFrameRef.current = null;
        flushQueuedStreamEvents();
      });
    }
    if (streamTimeoutRef.current === null) {
      streamTimeoutRef.current = window.setTimeout(() => {
        streamTimeoutRef.current = null;
        flushQueuedStreamEvents();
      }, 50);
    }
  }

  function flushQueuedStreamEvents() {
    if (streamFrameRef.current !== null) {
      window.cancelAnimationFrame(streamFrameRef.current);
      streamFrameRef.current = null;
    }
    if (streamTimeoutRef.current !== null) {
      window.clearTimeout(streamTimeoutRef.current);
      streamTimeoutRef.current = null;
    }
    const queued = streamQueueRef.current;
    if (queued.length === 0) return;
    streamQueueRef.current = [];
    appendEntries(queued);
  }

  function cancelQueuedStreamFlush() {
    if (streamFrameRef.current !== null) {
      window.cancelAnimationFrame(streamFrameRef.current);
      streamFrameRef.current = null;
    }
    if (streamTimeoutRef.current !== null) {
      window.clearTimeout(streamTimeoutRef.current);
      streamTimeoutRef.current = null;
    }
    streamQueueRef.current = [];
  }

  function resetSessionEvents() {
    cancelQueuedStreamFlush();
    replaceEvents([]);
    setHistoryPageInfo(createEmptyHistoryPageInfo());
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

  async function fetchSessionsPage(offset) {
    return getJson("/v1/sessions?limit=" + SESSION_PAGE_SIZE + "&offset=" + Math.max(offset || 0, 0));
  }

  async function fetchSessionMessagesPage(id, options = {}) {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    if (options.tail !== undefined) params.set("tail", String(options.tail));
    const query = params.toString();
    return getJson("/v1/sessions/" + encodeURIComponent(id) + "/messages" + (query ? "?" + query : ""));
  }

  async function loadSessions(options = {}) {
    const saved = readSavedSession();
    const append = Boolean(options.append);
    if (sessionsLoadingRef.current) return;
    sessionsLoadingRef.current = true;
    setIsSessionsLoading(true);
    try {
      const initialOffset = append ? sessionsNextOffsetRef.current : 0;
      const result = await fetchSessionsPage(initialOffset);
      const nextSessions = Array.isArray(result.sessions) ? result.sessions : [];
      let accumulated = append ? mergeSessionsById(sessions, nextSessions) : nextSessions;
      setSessions(accumulated);
      sessionsNextOffsetRef.current = Number.isInteger(result.nextOffset)
        ? result.nextOffset
        : initialOffset + nextSessions.length;
      setSessionsHasMore(Boolean(result.hasMore));

      if (!options.restoreSaved || !saved) return;

      let restored = accumulated.find((session) => getSessionId(session) === saved.sessionId);
      if (!restored) {
        try {
          restored = await getJson("/v1/sessions/" + encodeURIComponent(saved.sessionId));
          accumulated = mergeSessionsById(accumulated, [restored]);
          setSessions(accumulated);
        } catch {
          restored = null;
        }
      }
      if (!restored) {
        forgetSession();
        appendEntry("client", { restored: false, reason: "Last session was not found on the server" });
        return;
      }

      selectSession(restored, "session_restored");
    } catch (error) {
      appendEntry("client_error", "Could not load sessions: " + errorMessage(error));
    } finally {
      sessionsLoadingRef.current = false;
      setIsSessionsLoading(false);
    }
  }

  function loadMoreSessions() {
    if (!sessionsHasMore || sessionsLoadingRef.current) return;
    loadSessions({ append: true, restoreSaved: false });
  }

  function createSession() {
    setActivePanelView("chat");
    forgetSession();
    setStatus("Idle");
  }

  async function loadSessionView(id, eventName, session) {
    stopObserving();
    setIsObservedRunning(false);
    observingSessionIdRef.current = null;
    resetSessionEvents();
    setFileMentionSuggestions([]);
    setFileMentionStatus("idle");

    if (session) appendEntry(eventName, session);

    try {
      const result = await fetchSessionMessagesPage(id, { limit: MESSAGE_PAGE_SIZE, tail: true });
      const messages = Array.isArray(result.messages) ? result.messages : [];
      if (messages.length === 0) {
        appendEntry("history", { empty: true });
      } else {
        appendEntries(createHistoryEntries(messages, { sessionId: id, offset: result.offset || 0 }));
      }
      setHistoryPageInfo(createHistoryPageInfo(result));
      await backfillSessionTitle(id, session, messages);
    } catch (error) {
      appendEntry("client_error", "Could not load session history: " + errorMessage(error));
    }

    observeSession(id);
  }

  async function loadOlderMessages() {
    const id = sessionIdRef.current;
    if (!id || historyLoadingRef.current || !historyPageInfo.hasMoreBefore) return;
    const offset = historyPageInfo.previousOffset ?? 0;
    historyLoadingRef.current = true;
    setIsHistoryLoading(true);

    try {
      const result = await fetchSessionMessagesPage(id, { limit: MESSAGE_PAGE_SIZE, offset });
      const messages = Array.isArray(result.messages) ? result.messages : [];
      appendEntries(createHistoryEntries(messages, { sessionId: id, offset: result.offset || 0 }), { prepend: true });
      setHistoryPageInfo(createHistoryPageInfo(result));
    } catch (error) {
      appendEntry("client_error", "Could not load older messages: " + errorMessage(error));
    } finally {
      historyLoadingRef.current = false;
      setIsHistoryLoading(false);
    }
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
    if (!isActiveSessionOwner) {
      appendEntry("client_error", "You can only interact with sessions created by your login.");
      return;
    }

    const promptTimestamp = new Date().toISOString();
    setIsSending(true);
    setStatus("Generating");
    const controller = new AbortController();
    controllerRef.current = controller;
    let activeSessionId = sessionIdRef.current;
    streamingSessionIdRef.current = activeSessionId || undefined;

    const derivedTitle = derivePromptTitle(nextPrompt);
    let shouldPatchTitle = false;

    try {
      if (!activeSessionId) {
        const normalizedUserName = normalizeUserLabel(userName);
        const created = await postJson("/v1/sessions", {
          mode,
          title: derivedTitle,
          ...(normalizedUserName ? { userName: normalizedUserName } : {})
        });
        activeSessionId = created.sessionId || created.id;
        setSessionId(activeSessionId);
        streamingSessionIdRef.current = activeSessionId;
        rememberSession({ sessionId: activeSessionId });
        await loadSessions({ restoreSaved: false });
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
      const requestMode = options.mode || mode;
      if (options.mode && options.mode !== mode) setMode(options.mode);
      const images = options.toolResult ? [] : selectedImages.map((image) => ({
        name: image.name,
        mediaType: image.mediaType,
        dataBase64: image.dataBase64
      }));
      appendEntry("prompt", { prompt: nextPrompt, mode: requestMode, images, toolResult: options.toolResult }, { timestamp: promptTimestamp });
      setPrompt("");

      const response = await fetch(apiPath("/v1/sessions/" + encodeURIComponent(activeSessionId) + "/messages:stream"), {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: nextPrompt,
          images: images.length > 0 ? images : undefined,
          toolResult: options.toolResult,
          mode: requestMode,
          maxTurns: Number(maxTurns || 30)
        })
      });

      if (!response.ok || !response.body) throw new Error(await response.text());

      const streamOutcome = await readSse(response.body);
      if (streamOutcome.waitingForUserQuestion) {
        setStatus("Waiting for user");
      } else if (streamOutcome.waitingForApproval) {
        setStatus("Waiting for approval");
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
      streamingSessionIdRef.current = undefined;
    }
  }

  async function interrupt() {
    if (!isActiveSessionOwner) return;
    // If messages:stream is running, abort it for immediate UI feedback.
    // Use the streaming session ID (not the currently selected session)
    // so the interrupt hits the correct session after a session switch.
    const streamingController = controllerRef.current;
    if (streamingController) streamingController.abort();

    const id = streamingSessionIdRef.current || sessionIdRef.current;
    if (!id) return;
    try {
      await fetch(apiPath("/v1/sessions/" + encodeURIComponent(id) + "/interrupt"), { method: "POST" });
    } catch {}
    appendEntry("client", { interrupted: true });
  }

  async function loadClaudeCommands() {
    setSelectedCommandPath("");
    setCommandsHint("Loading commands from project root .claude/commands");
    try {
      const result = await getJson("/v1/claude-commands");
      const nextCommands = Array.isArray(result.commands) ? result.commands : [];
      setCommands(nextCommands);
      setCommandsHint(
        nextCommands.length > 0
          ? "Commands live in project root .claude/commands"
          : "No commands saved in project root .claude/commands"
      );
    } catch (error) {
      setCommands([]);
      setCommandsHint("Could not load commands");
      appendEntry("client_error", "Could not load Claude commands: " + errorMessage(error));
    }
  }

  async function loadClaudeCommand(path) {
    if (!path) return;

    const existing = commandsRef.current.find((command) => command.path === path);
    if (existing) {
      showCommand(existing);
      return;
    }

    try {
      const result = await getJson("/v1/claude-commands?path=" + encodeURIComponent(path));
      if (result && result.command) {
        mergeCommand(result.command);
        showCommand(result.command);
      }
    } catch (error) {
      appendEntry("client_error", "Could not load Claude command: " + errorMessage(error));
    }
  }

  async function saveCommand() {
    const path = String(commandPath || "").trim();
    if (!path) {
      appendEntry("client_error", "Command path is required");
      return;
    }

    try {
      const result = await postJson("/v1/claude-commands", {
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
    const path = String(commandPath || selectedCommandPath || "").trim();
    if (!path) {
      appendEntry("client_error", "Choose a command to delete");
      return;
    }

    try {
      const response = await fetch(apiPath("/v1/claude-commands"), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path })
      });
      if (!response.ok) throw new Error(await response.text());
      const nextCommands = commandsRef.current.filter((command) => command.path !== path);
      setCommands(nextCommands);
      clearCommandEditor();
      appendEntry("command_deleted", { path });
      setCommandsHint(
        nextCommands.length > 0
          ? "Commands live in project root .claude/commands"
          : "No commands saved in project root .claude/commands"
      );
    } catch (error) {
      appendEntry("client_error", "Could not delete Claude command: " + errorMessage(error));
    }
  }

  async function observeSession(id) {
    stopObserving();
    // Don't start events:stream if messages:stream is still running for this session.
    // runPrompt will call observeSession when the stream completes.
    if (controllerRef.current) return;
    const controller = new AbortController();
    observeControllerRef.current = controller;
    observingSessionIdRef.current = id;

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
        observingSessionIdRef.current = null;
        setIsObservedRunning(false);
      }
    }
  }

  function stopObserving() {
    if (observeControllerRef.current) {
      observeControllerRef.current.abort();
      observeControllerRef.current = undefined;
      observingSessionIdRef.current = null;
    }
  }

  async function readSse(body, source) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const outcome = { ok: true, waitingForUserQuestion: false, waitingForApproval: false };

    try {
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
    } finally {
      flushQueuedStreamEvents();
    }
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
    const normalizedEvent = normalizeSseEventType(event, parsed);
    if (normalizedEvent === "status" && parsed && typeof parsed.running === "boolean") {
      setIsObservedRunning(parsed.running);
      return { event: normalizedEvent, data: parsed, consumed: true };
    }
    if (normalizedEvent === "done" && source === "observer" && parsed && parsed.observing === false) {
      setIsObservedRunning(false);
      return { event: normalizedEvent, data: parsed, consumed: true };
    }
    if (!shouldSkipDisplayEntry(normalizedEvent, parsed)) queueStreamEntry(normalizedEvent, parsed);
    return { event: normalizedEvent, data: parsed, consumed: false };
  }

  function normalizeSseEventType(event, data) {
    if (event !== "message" || !data || typeof data !== "object" || typeof data.type !== "string") return event;
    if (data.type === "result" || data.type === "system") return data.type;
    return event;
  }

  function updateStreamOutcome(outcome, emitted, source) {
    if (!emitted || source === "observer") return;
    if (emitted.event === "question_pending") {
      outcome.waitingForUserQuestion = true;
      outcome.ok = true;
    }
    if (emitted.event === "approval_pending") {
      outcome.waitingForApproval = true;
      outcome.ok = true;
    }
    if (emitted.event === "done") {
      outcome.waitingForUserQuestion = Boolean(emitted.data?.waitingForUserQuestion);
      outcome.waitingForApproval = Boolean(emitted.data?.waitingForApproval);
      outcome.ok = emitted.data?.ok !== false;
    }
    if (emitted.event === "error") {
      outcome.ok = false;
    }
  }

  async function onFilesSelected(files) {
    if (!isActiveSessionOwner) return;
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
    setActivePanelView("chat");
    setSessionId(id);
    setMode(session?.mode === "plan" || session?.mode === "edit" || session?.mode === "bypass" ? session.mode : "bypass");
    rememberSession({ sessionId: id });
    loadSessionView(id, eventName, session);
  }

  function changeMode(nextMode) {
    if (!isActiveSessionOwner) return;
    setMode(nextMode);
    const id = sessionIdRef.current;
    if (!id) return;
    patchJson("/v1/sessions/" + encodeURIComponent(id), { mode: nextMode })
      .then(() => loadSessions({ restoreSaved: false }))
      .catch(() => {});
  }

  function saveSettings(nextSettings) {
    return patchJson("/v1/settings", nextSettings)
      .then((result) => {
        if (Number.isInteger(result?.maxTurns)) setMaxTurns(result.maxTurns);
        if (Number.isInteger(result?.maxConcurrentRuns)) setMaxConcurrentRuns(result.maxConcurrentRuns);
      })
      .catch((error) => {
        appendEntry("client_error", "Could not update settings: " + errorMessage(error));
        throw error;
      });
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
    observingSessionIdRef.current = null;
    setSessionId("");
    sessionIdRef.current = "";
    setFileMentionSuggestions([]);
    setFileMentionStatus("idle");
    localStorage.removeItem(storageKey);
    resetSessionEvents();
    clearCommandEditor();
  }

  function saveIdentity(value) {
    const normalized = normalizeUserLabel(value).slice(0, USER_LABEL_MAX_LENGTH);
    if (!normalized) return;
    setUserName(normalized);
    setIdentityInput(normalized);
    localStorage.setItem(identityStorageKey, normalized);
  }

  function logoutIdentity() {
    localStorage.removeItem(identityStorageKey);
    setActivePanelView("chat");
    setUserName("");
    setIdentityInput("");
    forgetSession();
    setStatus("Idle");
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
    const payload = serializeHistoryEvents(events);

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

  async function exportSessionHistoryJson() {
    const id = sessionIdRef.current;
    const session = activeSession || (id ? { id } : null);
    let messages = [];

    if (id) {
      try {
        const result = await fetchSessionMessagesPage(id);
        messages = Array.isArray(result.messages) ? result.messages : [];
      } catch (error) {
        appendEntry("client_error", "Could not export session JSON: " + errorMessage(error));
        return;
      }
    }

    try {
      const exportedAt = new Date().toISOString();
      const payload = buildSessionExportPayload({ session, events, messages, exportedAt });
      downloadJsonFile(buildSessionExportFilename(session, exportedAt), payload);
    } catch (error) {
      appendEntry("client_error", "Could not export session JSON: " + errorMessage(error));
    }
  }

  function activateInspect() {
    if (!isActiveSessionOwner) return;
    setHasGrabContext(true);
    appendEntry("client", { inspectContext: "workspace", active: true });
  }

  function clearInspectContext() {
    if (!isActiveSessionOwner) return;
    setHasGrabContext(false);
    appendEntry("client", { inspectContext: "workspace", active: false });
  }

  function toggleAnnotating() {
    if (!isActiveSessionOwner) return;
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
    if (!isActiveSessionOwner) return;
    setIsAnnotating(false);
    setLatestAnnotation(null);
    appendEntry("client", { annotation: null });
  }

  function beginPointerInteraction(event, restoreVisualState) {
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    let restored = false;

    if (target && typeof target.setPointerCapture === "function" && typeof pointerId === "number") {
      try {
        target.setPointerCapture(pointerId);
      } catch {
        /* Pointer capture can fail if the pointer is already released. */
      }
    }

    return () => {
      if (restored) return;
      restored = true;
      if (target && typeof target.releasePointerCapture === "function" && typeof pointerId === "number") {
        try {
          if (typeof target.hasPointerCapture !== "function" || target.hasPointerCapture(pointerId)) {
            target.releasePointerCapture(pointerId);
          }
        } catch {
          /* Ignore release failures from already-cancelled pointers. */
        }
      }
      restoreVisualState();
    };
  }

  function bindPointerInteractionEnd(target, stop) {
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    window.addEventListener("blur", stop, { once: true });
    target?.addEventListener?.("lostpointercapture", stop, { once: true });

    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      target?.removeEventListener?.("lostpointercapture", stop);
    };
  }

  function updateChatFrame(frame, options = {}) {
    const nextFrame = clampChatFrame(frame);
    chatFrameRef.current = nextFrame;
    setChatFrame(nextFrame);
    if (options.persist && !isNarrowViewport()) writeSavedChatFrame(nextFrame);
    return nextFrame;
  }

  function updateSidebarWidth(width, options = {}) {
    const nextWidth = clampSidebarWidth(width, chatRef.current);
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
    if (options.persist && !isNarrowViewport()) writeSavedSidebarWidth(nextWidth);
    return nextWidth;
  }

  function startDrag(event) {
    if (event.button !== undefined && event.button !== 0) return;
    if (window.innerWidth <= 768) return;
    if (event.target.closest("button, input, textarea, select, a, .ant-dropdown, .ant-drawer")) return;
    event.preventDefault();
    const origin = chatFrameRef.current;
    const dragNode = chatRef.current;
    const dragStart = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      originX: origin.x,
      originY: origin.y
    };
    let nextFrame = origin;
    let pendingOffset = { x: 0, y: 0 };
    const restoreInteraction = beginPointerInteraction(event, beginDragInteraction());
    let stopped = false;
    let removeEndListeners = () => {};

    function applyPendingOffset() {
      dragFrameRef.current = null;
      if (!dragNode) return;
      dragNode.style.transform = `translate3d(${pendingOffset.x}px, ${pendingOffset.y}px, 0)`;
    }

    function move(pointerEvent) {
      if (pointerEvent.buttons === 0) {
        stop();
        return;
      }
      nextFrame = clampChatFrame({
        ...origin,
        x: dragStart.originX + pointerEvent.clientX - dragStart.pointerX,
        y: dragStart.originY + pointerEvent.clientY - dragStart.pointerY
      });
      pendingOffset = {
        x: nextFrame.x - dragStart.originX,
        y: nextFrame.y - dragStart.originY
      };
      if (!dragFrameRef.current) {
        dragFrameRef.current = window.requestAnimationFrame(applyPendingOffset);
      }
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      if (dragFrameRef.current) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
      if (dragNode) {
        dragNode.style.left = nextFrame.x + "px";
        dragNode.style.top = nextFrame.y + "px";
        dragNode.style.transform = "";
      }
      restoreInteraction();
      updateChatFrame(nextFrame, { persist: true });
      window.removeEventListener("pointermove", move);
      removeEndListeners();
    }

    window.addEventListener("pointermove", move);
    removeEndListeners = bindPointerInteractionEnd(event.currentTarget, stop);
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
    const restoreInteraction = beginPointerInteraction(event, beginResizeInteraction(cursor));
    let nextFrame = origin;
    let stopped = false;
    let removeEndListeners = () => {};

    function move(pointerEvent) {
      if (pointerEvent.buttons === 0) {
        stop();
        return;
      }
      const deltaX = pointerEvent.clientX - resizeStart.pointerX;
      const deltaY = pointerEvent.clientY - resizeStart.pointerY;
      nextFrame = updateChatFrame({
        ...origin,
        width: direction === "south" ? resizeStart.width : resizeStart.width + deltaX,
        height: direction === "east" ? resizeStart.height : resizeStart.height + deltaY
      });
      updateSidebarWidth(sidebarWidthRef.current);
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      writeSavedChatFrame(nextFrame);
      writeSavedSidebarWidth(sidebarWidthRef.current);
      restoreInteraction();
      window.removeEventListener("pointermove", move);
      removeEndListeners();
    }

    window.addEventListener("pointermove", move);
    removeEndListeners = bindPointerInteractionEnd(event.currentTarget, stop);
  }

  function startSidebarResize(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const resizeStart = {
      pointerX: event.clientX,
      width: sidebarWidthRef.current
    };
    const restoreInteraction = beginPointerInteraction(event, beginResizeInteraction("col-resize"));
    let nextWidth = resizeStart.width;
    let stopped = false;
    let removeEndListeners = () => {};

    function move(pointerEvent) {
      if (pointerEvent.buttons === 0) {
        stop();
        return;
      }
      nextWidth = updateSidebarWidth(resizeStart.width + pointerEvent.clientX - resizeStart.pointerX);
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      writeSavedSidebarWidth(nextWidth);
      restoreInteraction();
      window.removeEventListener("pointermove", move);
      removeEndListeners();
    }

    window.addEventListener("pointermove", move);
    removeEndListeners = bindPointerInteractionEnd(event.currentTarget, stop);
  }

  const chatHeader = (
    <ChatHeader
      title={activePanelView === "settings" ? "Settings" : "AI Assistant"}
      showBackButton={activePanelView === "settings"}
      hideSidebarToggle={activePanelView === "settings"}
      hideStatusDot={activePanelView === "settings"}
      isSidebarOpen={isSidebarOpen}
      onToggleSidebar={() => setIsSidebarOpen((value) => !value)}
      onBack={() => setActivePanelView("chat")}
      hasStreamingSessions={busy}
      hasCurrentUserIdentity={Boolean(userName)}
      currentUserDisplayLabel={getDisplayLabel(userName || GUEST_USER_NAME)}
      onLogout={logoutIdentity}
      onClose={() => setIsClosed(true)}
      onExportSession={exportSessionHistoryJson}
      onOpenHistory={() => setIsHistoryOpen(true)}
      canExportSession={events.length > 0 || Boolean(sessionId)}
      dragHandleProps={{ onPointerDown: startDrag }}
      status={busy ? "Generating" : status}
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
        className="ai-chat-floating"
        style={{
          left: chatFrame.x,
          top: chatFrame.y,
          width: chatFrame.width,
          height: chatFrame.height
        }}
      >
        <div className="ai-chat-card" style={accentStyle}>
          {!userName ? (
            <main className="ai-chat-main-column">
              {chatHeader}
              <ChatIdentityOnboarding
                value={identityInput}
                onChange={setIdentityInput}
                onSubmit={() => saveIdentity(identityInput)}
                maxLength={USER_LABEL_MAX_LENGTH}
              />
            </main>
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
                      creatorFilter={creatorFilter}
                      setCreatorFilter={setCreatorFilter}
                      creatorFilterOptions={creatorFilterOptions}
                      onCreateNewSession={createSession}
                      onSessionSelect={onSessionSelect}
                      onRefreshSessions={() => loadSessions({ restoreSaved: false })}
                      onLoadMoreSessions={loadMoreSessions}
                      hasMoreSessions={hasVisibleMoreSessions}
                      isLoadingSessions={isSessionsLoading}
                    />
                    <SidebarSettingsButton
                      isActive={activePanelView === "settings"}
                      onClick={() => setActivePanelView("settings")}
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
                {activePanelView === "settings" ? (
                  <SettingsPanel
                    maxTurns={maxTurns}
                    maxConcurrentRuns={maxConcurrentRuns}
                    onSubmitSettings={saveSettings}
                    commandsHint={commandsHint}
                    rootInfo={rootInfo}
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
                  />
                ) : (
                  <>
                    <AgentChatMessageList
                      bubbleItems={bubbleItems}
                      bubbleRoles={bubbleRoles}
                      isStreaming={isStreamingActiveSession}
                      open={!isClosed}
                      scrollResetKey={sessionId || "new"}
                      hasMoreBefore={historyPageInfo.hasMoreBefore}
                      isLoadingBefore={isHistoryLoading}
                      onLoadBefore={loadOlderMessages}
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
                      activeExitPlanApproval={activeExitPlanApproval}
                      hasGrabContext={hasGrabContext}
                      isAnnotating={isAnnotating}
                      latestAnnotation={latestAnnotation}
                      isStreamingActiveSession={isStreamingActiveSession}
                      isSessionOwner={isActiveSessionOwner}
                      hasChipAnswer={hasChipAnswer}
                      setHasChipAnswer={setHasChipAnswer}
                      askQuestionFooterRef={askQuestionFooterRef}
                      accentStyle={accentStyle}
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
                  </>
                )}
              </main>
            </div>
          )}
        </div>
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
            <Button size="small" onClick={() => replaceEvents([])}>
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

const LEGACY_GENERIC_TITLES = new Set(["AI chat panel", "Untitled chat", "New chat"]);

function isGenericSessionTitle(title) {
  if (typeof title !== "string") return true;
  const trimmed = title.trim();
  if (!trimmed) return true;
  return LEGACY_GENERIC_TITLES.has(trimmed);
}

function getSessionId(session) {
  return session.sessionId || session.id || "";
}

function mergeSessionsById(existing, incoming) {
  const byId = new Map();
  existing.concat(incoming).forEach((session) => {
    const id = getSessionId(session);
    if (!id) return;
    byId.set(id, { ...byId.get(id), ...session });
  });
  return Array.from(byId.values()).sort((left, right) =>
    String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
  );
}

function createEmptyHistoryPageInfo() {
  return {
    offset: 0,
    total: 0,
    previousOffset: undefined,
    hasMoreBefore: false,
    hasMoreAfter: false
  };
}

function createHistoryPageInfo(result) {
  if (!result || typeof result !== "object") return createEmptyHistoryPageInfo();
  return {
    offset: Number.isInteger(result.offset) ? result.offset : 0,
    total: Number.isInteger(result.total) ? result.total : 0,
    previousOffset: Number.isInteger(result.previousOffset) ? result.previousOffset : undefined,
    hasMoreBefore: Boolean(result.hasMoreBefore),
    hasMoreAfter: Boolean(result.hasMoreAfter)
  };
}

function getSessionUserName(session) {
  return getDisplayLabel(session?.userName || GUEST_USER_NAME);
}

function isNarrowViewport() {
  return typeof window !== "undefined" && window.innerWidth <= NARROW_VIEWPORT_MAX_WIDTH;
}

function readSavedChatFrame() {
  const savedFrame = readStorageJson(chatFrameStorageKey);
  if (!isChatFrame(savedFrame)) return initialChatFrame();
  return clampChatFrame(savedFrame);
}

function writeSavedChatFrame(frame) {
  if (!isChatFrame(frame)) return;
  writeStorageJson(chatFrameStorageKey, {
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    width: Math.round(frame.width),
    height: Math.round(frame.height)
  });
}

function readSavedSidebarWidth() {
  const saved = readStorageJson(sidebarWidthStorageKey);
  const width = typeof saved === "number" ? saved : saved?.width;
  return Number.isFinite(width) ? clampSidebarWidth(width) : DEFAULT_SIDEBAR_WIDTH;
}

function writeSavedSidebarWidth(width) {
  if (!Number.isFinite(width)) return;
  writeStorageJson(sidebarWidthStorageKey, { width: Math.round(width) });
}

function isChatFrame(value) {
  return (
    value &&
    typeof value === "object" &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height)
  );
}

function readStorageJson(key) {
  try {
    const raw = window.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStorageJson(key, value) {
  try {
    window.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    /* Storage can be unavailable or full; layout persistence is best effort. */
  }
}

function readSavedIdentity() {
  try {
    return normalizeUserLabel(localStorage.getItem(identityStorageKey) || "").slice(0, USER_LABEL_MAX_LENGTH);
  } catch {
    return "";
  }
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/).find((line) => line.trim())?.trim() || "";
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

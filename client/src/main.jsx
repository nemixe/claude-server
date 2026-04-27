import React from "react";
import { createRoot } from "react-dom/client";
import "antd/dist/reset.css";
import "./styles.css";
import {
  Alert,
  Button,
  Card,
  Col,
  Flex,
  Form,
  Input,
  InputNumber,
  Layout,
  List,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  Upload
} from "antd";

const h = React.createElement;
  const { Text, Title } = Typography;
  const { Header, Content } = Layout;
  const TextArea = Input.TextArea;

  const storageKey = "claude-test-client:last-session";
  const imageMediaTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
  const maxImages = 5;
  const maxImageBytes = 5 * 1024 * 1024;
  const defaultPrompt = "Inspect the current workspace and summarize what you can do.";

  function App() {
    const [baseUrl, setBaseUrl] = React.useState(window.location.origin);
    const [status, setStatus] = React.useState("Idle");
    const [sessionId, setSessionId] = React.useState("");
    const [sessions, setSessions] = React.useState([]);
    const [mode, setMode] = React.useState("plan");
    const [maxTurns, setMaxTurns] = React.useState(30);
    const [prompt, setPrompt] = React.useState(defaultPrompt);
    const [selectedImages, setSelectedImages] = React.useState([]);
    const [events, setEvents] = React.useState([]);
    const [commands, setCommands] = React.useState([]);
    const [selectedCommandPath, setSelectedCommandPath] = React.useState("");
    const [commandPath, setCommandPath] = React.useState("");
    const [commandContent, setCommandContent] = React.useState("");
    const [commandsHint, setCommandsHint] = React.useState("Pick a session to manage slash commands");
    const [searchQuery, setSearchQuery] = React.useState("");
    const [searchLimit, setSearchLimit] = React.useState(20);
    const [searchResults, setSearchResults] = React.useState([]);
    const [searchHint, setSearchHint] = React.useState("Pick a session to search files and folders");
    const [isSending, setIsSending] = React.useState(false);
    const [isObservedRunning, setIsObservedRunning] = React.useState(false);
    const [historyCopyLabel, setHistoryCopyLabel] = React.useState("Copy JSON");
    const controllerRef = React.useRef();
    const observeControllerRef = React.useRef();
    const eventsRef = React.useRef(null);
    const sessionIdRef = React.useRef("");
    const baseUrlRef = React.useRef(baseUrl);
    const commandsRef = React.useRef([]);
    const historyCopyTimeoutRef = React.useRef();

    React.useEffect(function () {
      sessionIdRef.current = sessionId;
    }, [sessionId]);

    React.useEffect(function () {
      baseUrlRef.current = baseUrl;
    }, [baseUrl]);

    React.useEffect(function () {
      commandsRef.current = commands;
    }, [commands]);

    React.useEffect(function () {
      loadSessions({ restoreSaved: true });
      return function () {
        stopObserving();
        if (historyCopyTimeoutRef.current) window.clearTimeout(historyCopyTimeoutRef.current);
        if (controllerRef.current) controllerRef.current.abort();
      };
    }, []);

    React.useEffect(function () {
      if (eventsRef.current) {
        eventsRef.current.scrollTop = eventsRef.current.scrollHeight;
      }
    }, [events]);

    const busy = isSending || isObservedRunning;
    const sessionOptions = [{ value: "", label: "New session" }].concat(
      sessions.map(function (session) {
        const id = getSessionId(session);
        const label = [session.title || "Session", id].filter(Boolean).join(" - ");
        return { value: id, label: label };
      })
    );
    const commandOptions = [{ value: "", label: commands.length > 0 ? "Choose a command" : "No command selected" }].concat(
      commands.map(function (command) {
        return { value: command.path, label: command.path };
      })
    );

    function apiPath(path) {
      return String(baseUrlRef.current || "").replace(/\/$/, "") + path;
    }

    function appendEntry(type, data) {
      setEvents(function (current) {
        return current.concat([{ id: Date.now() + ":" + Math.random(), time: new Date().toLocaleTimeString(), type: type, data: data }]);
      });
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

    async function loadSessions(options) {
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

        const restored = nextSessions.find(function (session) {
          return getSessionId(session) === saved.sessionId;
        });

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
          messages.forEach(function (message) {
            appendEntry("history", message);
          });
        }
      } catch (error) {
        appendEntry("client_error", "Could not load session history: " + errorMessage(error));
      }

      observeSession(id);
    }

    async function runPrompt() {
      setIsSending(true);
      setStatus("Generating");
      const controller = new AbortController();
      controllerRef.current = controller;
      let activeSessionId = sessionIdRef.current;

      try {
        if (!activeSessionId) {
          const created = await postJson("/v1/sessions", {
            mode: mode,
            title: "AI chat panel"
          });
          activeSessionId = created.sessionId || created.id;
          setSessionId(activeSessionId);
          rememberSession({ sessionId: activeSessionId });
          await loadSessions({ restoreSaved: false });
          await loadClaudeCommands(activeSessionId);
        }

        stopObserving();
        const images = selectedImages.map(function (image) {
          return { name: image.name, mediaType: image.mediaType, dataBase64: image.dataBase64 };
        });
        appendEntry("prompt", { prompt: prompt, mode: mode, images: images });

        const response = await fetch(apiPath("/v1/sessions/" + encodeURIComponent(activeSessionId) + "/messages:stream"), {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt: prompt,
            images: images.length > 0 ? images : undefined,
            mode: mode,
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

      const existing = commandsRef.current.find(function (command) {
        return command.path === path;
      });
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
          path: path,
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
          body: JSON.stringify({ path: path })
        });
        if (!response.ok) throw new Error(await response.text());
        const nextCommands = commandsRef.current.filter(function (command) {
          return command.path !== path;
        });
        setCommands(nextCommands);
        clearCommandEditor();
        appendEntry("command_deleted", { path: path });
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
        parts.forEach(function (part) {
          emitSse(part, source);
        });
      }

      buffer += decoder.decode();
      if (buffer.trim()) emitSse(buffer, source);
    }

    function emitSse(raw, source) {
      let event = "message";
      const data = [];

      raw.split(/\r?\n/).forEach(function (line) {
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

    async function onImagesSelected(info) {
      const files = info.fileList.map(function (item) {
        return item.originFileObj || item;
      }).filter(Boolean);

      try {
        setSelectedImages(await readPromptImages(files));
      } catch (error) {
        setSelectedImages([]);
        appendEntry("client_error", errorMessage(error));
      }
    }

    async function readPromptImages(files) {
      if (files.length > maxImages) throw new Error("Choose " + maxImages + " images or fewer");
      return Promise.all(
        files.map(async function (file) {
          if (!imageMediaTypes.has(file.type)) throw new Error(file.name + " is not a supported image type");
          if (file.size > maxImageBytes) throw new Error(file.name + " is larger than 5 MB");
          const dataUrl = await readAsDataUrl(file);
          const commaIndex = dataUrl.indexOf(",");
          return {
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
      return new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.addEventListener("load", function () {
          resolve(String(reader.result || ""));
        });
        reader.addEventListener("error", function () {
          reject(reader.error || new Error("Could not read image"));
        });
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

    function onSessionChange(value) {
      const selected = sessions.find(function (session) {
        return getSessionId(session) === value;
      });
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
      const nextCommands = commandsRef.current.filter(function (item) {
        return item.path !== command.path;
      });
      nextCommands.push(command);
      nextCommands.sort(function (left, right) {
        return String(left.path).localeCompare(String(right.path));
      });
      setCommands(nextCommands);
    }

    function getSessionId(session) {
      return session.sessionId || session.id || "";
    }

    async function copySessionHistoryJson() {
      const payload = events.map(function (entry) {
        return {
          time: entry.time,
          type: entry.type,
          data: entry.data
        };
      });

      try {
        await writeClipboard(JSON.stringify(payload, null, 2));
        setHistoryCopyLabel("Copied");
      } catch {
        setHistoryCopyLabel("Copy failed");
      }

      if (historyCopyTimeoutRef.current) window.clearTimeout(historyCopyTimeoutRef.current);
      historyCopyTimeoutRef.current = window.setTimeout(function () {
        setHistoryCopyLabel("Copy JSON");
      }, 1600);
    }

    return h(
      Layout,
      { className: "client-shell" },
      h(
        Header,
        { className: "client-header" },
        h(
          "div",
          { className: "client-title-block" },
          h(Title, { level: 2, className: "client-title" }, "Claude AI Chat"),
          h(Text, { className: "client-subtitle" }, "Session controls, workspace tools, and live agent conversation in one panel.")
        ),
        h(
          "div",
          { className: "session-state" },
          h(Spin, { id: "loader", size: "small", spinning: busy }),
          h(Text, { type: "secondary" }, busy ? "Generating" : status),
          h(Tag, { color: sessionId ? "blue" : "default" }, sessionId ? "Session " + sessionId : "No session")
        )
      ),
      h(
        Content,
        { className: "client-content" },
        h(
          Flex,
          { className: "client-main", gap: 16, align: "flex-start", wrap: "wrap" },
          h(
            "div",
            { className: "client-sidebar" },
            h(
              Card,
              { className: "tool-card", title: "Prompt Controls" },
              h(
                Form,
                { layout: "vertical", onFinish: runPrompt },
                h(Form.Item, { label: "API base URL" }, h(Input, { id: "baseUrl", value: baseUrl, placeholder: "http://localhost:3000", onChange: function (event) { setBaseUrl(event.target.value); } })),
                h(
                  Row,
                  { gutter: 8 },
                  h(
                    Col,
                    { flex: "auto" },
                    h(Form.Item, { label: "Sessions" }, h(Select, { id: "sessionList", value: sessionId, options: sessionOptions, onChange: onSessionChange }))
                  ),
                  h(
                    Col,
                    { flex: "96px" },
                    h(Form.Item, { label: " " }, h(Button, { block: true, onClick: function () { loadSessions({ restoreSaved: false }); } }, "Refresh"))
                  )
                ),
                h(
                  Row,
                  { gutter: 8 },
                  h(Col, { span: 12 }, h(Form.Item, { label: "Mode" }, h(Select, { id: "mode", value: mode, onChange: setMode, options: ["plan", "edit", "bypass"].map(function (value) { return { value: value, label: value }; }) }))),
                  h(Col, { span: 12 }, h(Form.Item, { label: "Max turns" }, h(InputNumber, { id: "maxTurns", min: 1, value: maxTurns, onChange: function (value) { setMaxTurns(value || 30); }, style: { width: "100%" } })))
                ),
                h(Form.Item, { label: "Prompt" }, h(TextArea, { id: "prompt", rows: 7, value: prompt, onChange: function (event) { setPrompt(event.target.value); } })),
                h(
                  Form.Item,
                  { label: "Images" },
                  h(
                    Upload,
                    {
                      id: "images",
                      accept: "image/png,image/jpeg,image/gif,image/webp",
                      multiple: true,
                      beforeUpload: function () { return false; },
                      maxCount: maxImages,
                      onChange: onImagesSelected,
                      showUploadList: false
                    },
                    h(Button, null, "Choose images")
                  ),
                  h(ImageGrid, { images: selectedImages })
                ),
                h(
                  Space,
                  { wrap: true },
                  h(Button, { type: "primary", htmlType: "submit", loading: isSending, disabled: isSending }, "Send"),
                  h(Button, { danger: true, disabled: !sessionId, onClick: interrupt }, "Interrupt"),
                  h(Button, { onClick: function () { setEvents([]); } }, "Clear")
                )
              )
            ),
            h(
              Card,
              { className: "tool-card", title: "Claude Commands", extra: h(Text, { type: "secondary" }, commandsHint) },
              h(
                Form,
                { layout: "vertical", onFinish: saveCommand },
                h(
                  Row,
                  { gutter: 8 },
                  h(
                    Col,
                    { flex: "auto" },
                    h(Form.Item, { label: "Commands" }, h(Select, { id: "commandList", value: selectedCommandPath, disabled: !sessionId, options: commandOptions, onChange: function (value) { setSelectedCommandPath(value); value ? loadClaudeCommand(value) : clearCommandEditor(); } }))
                  ),
                  h(
                    Col,
                    { flex: "96px" },
                    h(Form.Item, { label: " " }, h(Button, { block: true, disabled: !sessionId, onClick: function () { loadClaudeCommands(); } }, "Refresh"))
                  )
                ),
                h(Form.Item, { label: "Command path" }, h(Input, { id: "commandPath", disabled: !sessionId, value: commandPath, placeholder: "review/fix.md", onChange: function (event) { setCommandPath(event.target.value); } })),
                h(Form.Item, { label: "Command content" }, h(TextArea, { id: "commandContent", disabled: !sessionId, rows: 6, value: commandContent, placeholder: "Write the Claude slash command markdown here.", onChange: function (event) { setCommandContent(event.target.value); } })),
                h(
                  Space,
                  { wrap: true },
                  h(Button, { type: "primary", htmlType: "submit", disabled: !sessionId }, "Save command"),
                  h(Button, { disabled: !sessionId, onClick: clearCommandEditor }, "New"),
                  h(Button, { danger: true, disabled: !sessionId, onClick: deleteCommand }, "Delete")
                )
              )
            ),
            h(
              Card,
              { className: "tool-card", title: "Workspace Search", extra: h(Text, { type: "secondary" }, searchHint) },
              h(
                Form,
                { layout: "vertical", onFinish: runWorkspaceSearch },
                h(
                  Row,
                  { gutter: 8 },
                  h(Col, { span: 16 }, h(Form.Item, { label: "Query" }, h(Input, { id: "searchQuery", disabled: !sessionId, value: searchQuery, placeholder: "cmpbtn", onChange: function (event) { setSearchQuery(event.target.value); } }))),
                  h(Col, { span: 8 }, h(Form.Item, { label: "Limit" }, h(InputNumber, { id: "searchLimit", disabled: !sessionId, min: 1, max: 200, value: searchLimit, onChange: function (value) { setSearchLimit(value || 20); }, style: { width: "100%" } })))
                ),
                h(
                  Space,
                  { wrap: true, style: { marginBottom: 12 } },
                  h(Button, { id: "runSearch", type: "primary", htmlType: "submit", disabled: !sessionId }, "Search"),
                  h(Button, { disabled: !sessionId, onClick: function () { setSearchQuery(""); setSearchResults([]); } }, "Clear")
                ),
                h(SearchResults, { results: searchResults, query: searchQuery })
              )
            )
          ),
          h(
            "div",
            { className: "history-column" },
            h(
              Card,
              {
                className: "events-panel chat-panel",
                title: h(
                  "div",
                  { className: "chat-panel-title" },
                  h("span", null, "AI Chat Panel"),
                  h("small", null, busy ? "Streaming live events" : "Session transcript")
                ),
                extra: h(Text, { type: "secondary" }, sessionId ? "Session " + sessionId : "No session")
              },
              h(EventsList, { events: events, eventsRef: eventsRef })
            ),
            h(
              Card,
              {
                className: "legacy-events-panel",
                title: "Session History",
                extra: h(
                  Space,
                  { size: 8, wrap: true },
                  h(Text, { type: "secondary" }, "Raw event view for comparison"),
                  h(Button, { size: "small", disabled: events.length === 0, onClick: copySessionHistoryJson }, historyCopyLabel)
                )
              },
              h(LegacyEventsList, { events: events })
            )
          )
        )
      )
    );
  }

  function EventsList(props) {
    const items = props.events.map(toTranscriptItem).filter(Boolean);
    if (items.length === 0) {
      return h(
        "div",
        { id: "events", className: "events-list chat-transcript is-empty", ref: props.eventsRef },
        h(Alert, { type: "info", message: "Session history and streaming events will appear here." })
      );
    }
    return h(
      "div",
      { id: "events", className: "events-list chat-transcript", ref: props.eventsRef, role: "log", "aria-label": "AI chat session history" },
      items.map(function (item) {
        return item.kind === "message"
          ? h(ChatMessage, { key: item.id, item: item })
          : h(ActivityItem, { key: item.id, item: item });
      })
    );
  }

  function LegacyEventsList(props) {
    if (props.events.length === 0) {
      return h(
        "div",
        { id: "legacyEvents", className: "legacy-events-list" },
        h(Alert, { type: "info", message: "Session history and streaming events will appear here." })
      );
    }
    return h(
      "div",
      { id: "legacyEvents", className: "legacy-events-list" },
      props.events.map(function (entry) {
        const images = extractImageBlocks(entry.data);
        return h(
          "article",
          { key: entry.id, className: "legacy-event-entry" },
          h("div", { className: "legacy-event-title" }, "[" + entry.time + "] " + entry.type),
          h("pre", null, JSON.stringify(redactImageData(entry.data), null, 2)),
          h(ImageGrid, { images: images })
        );
      })
    );
  }

  function ChatMessage(props) {
    const item = props.item;
    const isUser = item.role === "user";
    return h(
      "article",
      { className: "chat-message " + (isUser ? "is-user" : "is-assistant") },
      !isUser ? h("div", { className: "chat-avatar" }, item.avatar || "AI") : null,
      h(
        "div",
        { className: "chat-bubble" },
        h(
          "div",
          { className: "chat-bubble-header" },
          h("span", null, item.label),
          h("small", null, item.meta)
        ),
        item.text ? h("div", { className: "chat-message-text" }, item.text) : null,
        h(ImageGrid, { images: item.images })
      ),
      isUser ? h("div", { className: "chat-avatar" }, "You") : null
    );
  }

  function ActivityItem(props) {
    const item = props.item;
    return h(
      "article",
      { className: "chat-activity " + (item.tone ? "is-" + item.tone : "") },
      h("span", { className: "chat-activity-dot" }),
      h(
        "div",
        { className: "chat-activity-body" },
        h(
          "div",
          { className: "chat-activity-header" },
          h("span", null, item.label),
          h("small", null, item.meta)
        ),
        item.text ? h("pre", null, item.text) : null
      )
    );
  }

  function toTranscriptItem(entry) {
    if (!entry) return null;
    const data = entry.data;
    const meta = [entry.time, entry.type === "history" ? "history" : ""].filter(Boolean).join(" - ");

    if (entry.type === "prompt") {
      return {
        id: entry.id,
        kind: "message",
        role: "user",
        label: "You",
        meta: [entry.time, data && data.mode ? data.mode : ""].filter(Boolean).join(" - "),
        text: data && data.prompt ? String(data.prompt) : "",
        images: Array.isArray(data && data.images) ? data.images : []
      };
    }

    if (entry.type === "history") {
      if (data && data.empty) {
        return {
          id: entry.id,
          kind: "activity",
          tone: "muted",
          label: "History",
          meta: entry.time,
          text: "No saved messages yet for this session."
        };
      }
      const message = toChatMessage(data, meta);
      return message ? { ...message, id: entry.id } : toActivityItem(entry, "History");
    }

    if (entry.type === "message") {
      const message = toChatMessage(data, entry.time);
      return message ? { ...message, id: entry.id } : toActivityItem(entry);
    }

    if (entry.type === "client_error" || entry.type === "error") {
      return toActivityItem(entry, "Error", "error");
    }

    return toActivityItem(entry);
  }

  function toChatMessage(value, meta) {
    if (!value || typeof value !== "object") return null;
    const record = value;
    const messageRecord = record.message && typeof record.message === "object" ? record.message : record;
    const role = normalizeRole(messageRecord.role || record.type);
    if (!role) return null;

    const content = messageRecord.content !== undefined ? messageRecord.content : record.content !== undefined ? record.content : record.message;
    const blocks = Array.isArray(content) ? content : [];
    const protocolKind = classifyMessageContent(role, content);
    if (protocolKind === "tool_result" || protocolKind === "assistant_tool_use" || protocolKind === "assistant_thinking" || role === "tool") {
      return {
        kind: "activity",
        tone: protocolKind === "assistant_thinking" ? "muted" : "tool",
        label: protocolActivityLabel(protocolKind, blocks),
        meta: meta,
        text: protocolActivityText(protocolKind, content)
      };
    }
    if (role === "system") {
      return {
        kind: "activity",
        tone: "tool",
        label: "System",
        meta: meta,
        text: extractTextContent(content) || JSON.stringify(redactImageData(content), null, 2)
      };
    }

    const text = extractTextContent(content);
    const images = extractImageBlocks(content);
    if (!text && images.length === 0) return null;
    if (role === "user" && protocolKind !== "human_user") return null;

    return {
      kind: "message",
      role: role,
      label: role === "user" ? "You" : role === "assistant" ? "Claude" : role === "tool" ? "Tool" : "System",
      avatar: role === "assistant" ? "AI" : role === "system" ? "SYS" : "Tool",
      meta: meta,
      text: text,
      images: images
    };
  }

  function toActivityItem(entry, label, tone) {
    return {
      id: entry.id,
      kind: "activity",
      tone: tone || activityTone(entry.type),
      label: label || activityLabel(entry.type, entry.data),
      meta: entry.time,
      text: activityText(entry.type, entry.data)
    };
  }

  function normalizeRole(value) {
    if (value === "user" || value === "assistant" || value === "system") return value;
    if (value === "tool" || value === "tool_use" || value === "tool_result") return "tool";
    return null;
  }

  function classifyMessageContent(role, content) {
    const blocks = Array.isArray(content) ? content : [];
    if (blocks.some(hasBlockType("tool_result"))) return "tool_result";
    if (blocks.some(hasBlockType("tool_use"))) return "assistant_tool_use";
    if (blocks.some(hasBlockType("thinking"))) return "assistant_thinking";
    if (role === "user" && (typeof content === "string" || blocks.some(hasBlockType("text")) || blocks.some(hasBlockType("image")))) {
      return "human_user";
    }
    if (role === "assistant") return "assistant";
    if (role === "system") return "system";
    if (role === "tool") return "tool_result";
    return role;
  }

  function hasBlockType(type) {
    return function (block) {
      return block && typeof block === "object" && block.type === type;
    };
  }

  function protocolActivityLabel(kind, blocks) {
    if (kind === "tool_result") return "Tool result";
    if (kind === "assistant_thinking") return "Assistant thinking";
    if (kind === "assistant_tool_use") {
      const tool = blocks.find(hasBlockType("tool_use"));
      return "Tool use" + (tool && tool.name ? ": " + tool.name : "");
    }
    return "Tool";
  }

  function protocolActivityText(kind, content) {
    const blocks = Array.isArray(content) ? content : [];
    if (kind === "tool_result") {
      return blocks.filter(hasBlockType("tool_result")).map(formatToolResultBlock).filter(Boolean).join("\n\n");
    }
    if (kind === "assistant_tool_use") {
      return blocks.filter(hasBlockType("tool_use")).map(formatToolUseBlock).filter(Boolean).join("\n\n");
    }
    if (kind === "assistant_thinking") {
      return blocks.filter(hasBlockType("thinking")).map(formatThinkingBlock).filter(Boolean).join("\n\n");
    }
    return extractTextContent(content) || JSON.stringify(redactImageData(content), null, 2);
  }

  function formatToolResultBlock(block) {
    const body = extractTextContent(block.content) || (typeof block.content === "string" ? block.content : JSON.stringify(redactImageData(block.content), null, 2));
    return [block.tool_use_id ? "Tool use id: " + block.tool_use_id : "", body].filter(Boolean).join("\n");
  }

  function formatToolUseBlock(block) {
    return [
      block.name ? "Name: " + block.name : "",
      block.id ? "Tool use id: " + block.id : "",
      block.input ? JSON.stringify(redactImageData(block.input), null, 2) : ""
    ]
      .filter(Boolean)
      .join("\n");
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
        .map(function (block) {
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

  function titleFromEventType(value) {
    return String(value || "event")
      .replace(/[_:]+/g, " ")
      .replace(/\b\w/g, function (letter) {
        return letter.toUpperCase();
      });
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

  function ImageGrid(props) {
    const images = props.images || [];
    if (images.length === 0) return null;
    return h(
      "div",
      { className: "image-previews" },
      images.map(function (image, index) {
        return h(
          "figure",
          { key: String(index) + ":" + (image.name || image.mediaType || ""), className: "image-preview" },
          image.dataBase64 && image.mediaType
            ? h("img", { alt: image.name || image.mediaType, src: "data:" + image.mediaType + ";base64," + image.dataBase64 })
            : null,
          h("figcaption", null, [image.name || image.mediaType, formatBytes(image.size)].filter(Boolean).join(" - "))
        );
      })
    );
  }

  function SearchResults(props) {
    if (!props.results || props.results.length === 0) {
      return h(Alert, { id: "searchResults", type: "info", message: String(props.query || "").trim() ? "No matching files or folders" : "Search results will appear here" });
    }
    return h(
      List,
      {
        id: "searchResults",
        bordered: true,
        dataSource: props.results,
        renderItem: function (result) {
          return h(
            List.Item,
            null,
            h(
              "div",
              null,
              h("strong", null, result.name || result.path || "Untitled"),
              h("code", { className: "search-result-path" }, result.path || ""),
              h(
                "div",
                { className: "search-result-meta" },
                [result.type || "file", Number.isFinite(result.score) ? "score " + result.score : "", result.size ? formatBytes(result.size) : "", result.updatedAt ? new Date(result.updatedAt).toLocaleString() : ""]
                  .filter(Boolean)
                  .join(" - ")
              )
            )
          );
        }
      }
    );
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
    Object.entries(value).forEach(function (entry) {
      const key = entry[0];
      const item = entry[1];
      if ((key === "data" || key === "dataBase64") && typeof item === "string" && item.length > 80) {
        copy[key] = "[base64 image data redacted, " + formatBytes(estimateBase64Bytes(item)) + "]";
      } else {
        copy[key] = redactImageData(item);
      }
    });
    return copy;
  }

  function estimateBase64Bytes(value) {
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

  createRoot(document.getElementById("root")).render(h(App));

export function renderTestClient(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Claude API Test Client</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f2ea;
        --panel: #fffdf8;
        --ink: #1e1b18;
        --muted: #70685f;
        --line: #d8cfc2;
        --accent: #0f6b5f;
        --accent-dark: #09483f;
        --danger: #9f3228;
        --event: #eef7f2;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: ui-monospace, "SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace;
        color: var(--ink);
        background:
          linear-gradient(135deg, rgba(15, 107, 95, 0.14), transparent 32rem),
          radial-gradient(circle at 80% 10%, rgba(210, 122, 57, 0.18), transparent 24rem),
          var(--bg);
      }

      main {
        width: min(1120px, calc(100vw - 32px));
        margin: 0 auto;
        padding: 32px 0;
      }

      header {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 24px;
        margin-bottom: 20px;
      }

      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.1;
      }

      .status {
        min-width: 180px;
        color: var(--muted);
        text-align: right;
      }

      .grid {
        display: grid;
        grid-template-columns: minmax(320px, 420px) 1fr;
        gap: 16px;
        align-items: start;
      }

      .stack {
        display: grid;
        gap: 16px;
      }

      section {
        background: color-mix(in srgb, var(--panel) 94%, white);
        border: 1px solid var(--line);
        border-radius: 8px;
        box-shadow: 0 16px 40px rgba(36, 25, 10, 0.08);
      }

      form,
      .output {
        padding: 16px;
      }

      label {
        display: block;
        margin: 0 0 12px;
        color: var(--muted);
        font-size: 12px;
      }

      .session-picker {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        align-items: end;
        margin-bottom: 12px;
      }

      .session-picker label {
        margin: 0;
      }

      input,
      select,
      textarea {
        width: 100%;
        margin-top: 6px;
        padding: 10px 11px;
        border: 1px solid var(--line);
        border-radius: 6px;
        font: inherit;
        color: var(--ink);
        background: #fff;
      }

      textarea {
        min-height: 160px;
        resize: vertical;
      }

      .row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }

      .row.single {
        grid-template-columns: 1fr;
      }

      .actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }

      button {
        border: 0;
        border-radius: 6px;
        padding: 10px 14px;
        font: inherit;
        cursor: pointer;
        color: #fff;
        background: var(--accent);
      }

      button.secondary {
        color: var(--accent-dark);
        background: #e4f1ed;
      }

      button.danger {
        background: var(--danger);
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }

      .events {
        min-height: 520px;
        max-height: 72vh;
        padding: 16px;
        overflow: auto;
        border-top: 1px solid var(--line);
        background: var(--event);
      }

      .event-entry {
        margin: 0 0 12px;
        padding: 12px;
        border: 1px solid rgba(15, 107, 95, 0.16);
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.62);
      }

      .event-entry:last-child {
        margin-bottom: 0;
      }

      .event-title {
        margin-bottom: 8px;
        color: var(--accent-dark);
        font-size: 12px;
      }

      .event-entry pre {
        margin: 0;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        font: inherit;
      }

      .image-picker {
        display: grid;
        gap: 8px;
        margin-bottom: 12px;
      }

      .image-previews {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
        gap: 8px;
      }

      .image-preview {
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: #fff;
      }

      .image-preview img {
        display: block;
        width: 100%;
        aspect-ratio: 4 / 3;
        object-fit: cover;
        background: #f1eee7;
      }

      .image-preview span {
        display: block;
        padding: 7px 8px;
        overflow: hidden;
        color: var(--muted);
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 16px;
      }

      .panel-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 16px 16px 0;
      }

      .panel-heading strong {
        font-size: 14px;
      }

      .helper {
        color: var(--muted);
        font-size: 12px;
      }

      .search-results {
        display: grid;
        gap: 8px;
        margin-top: 6px;
      }

      .search-empty {
        padding: 10px 12px;
        border: 1px dashed var(--line);
        border-radius: 6px;
        color: var(--muted);
        background: rgba(255, 255, 255, 0.6);
        font-size: 12px;
      }

      .search-result {
        padding: 10px 12px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.78);
      }

      .search-result strong {
        display: block;
        margin-bottom: 4px;
        font-size: 13px;
      }

      .search-result code {
        display: block;
        color: var(--accent-dark);
        font-size: 12px;
        word-break: break-word;
      }

      .search-meta {
        margin-top: 6px;
        color: var(--muted);
        font-size: 11px;
      }

      .session {
        color: var(--muted);
        font-size: 12px;
      }

      .session-state {
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        min-width: 190px;
      }

      .loader {
        display: none;
        width: 12px;
        height: 12px;
        border: 2px solid rgba(15, 107, 95, 0.2);
        border-top-color: var(--accent);
        border-radius: 999px;
        animation: spin 0.8s linear infinite;
      }

      .loader.active {
        display: inline-block;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      @media (max-width: 820px) {
        header,
        .grid {
          display: block;
        }

        .status {
          margin-top: 8px;
          text-align: left;
        }

        section + section {
          margin-top: 16px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Claude API Test Client</h1>
        </div>
        <div class="status" id="status">Idle</div>
      </header>

      <div class="grid">
        <div class="stack">
          <section>
            <form id="form">
              <label>
                API base URL
                <input id="baseUrl" value="" placeholder="http://localhost:3000" />
              </label>

              <div class="session-picker">
                <label>
                  Sessions
                  <select id="sessionList">
                    <option value="">New session</option>
                  </select>
                </label>
                <button id="refreshSessions" class="secondary" type="button">Refresh</button>
              </div>

              <div class="row">
                <label>
                  Mode
                  <select id="mode">
                    <option value="plan">plan</option>
                    <option value="edit">edit</option>
                    <option value="bypass">bypass</option>
                  </select>
                </label>

                <label>
                  Max turns
                  <input id="maxTurns" type="number" min="1" value="30" />
                </label>
              </div>

              <label>
                Prompt
                <textarea id="prompt">Inspect the current workspace and summarize what you can do.</textarea>
              </label>

              <label class="image-picker">
                Images
                <input id="images" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple />
                <div class="image-previews" id="selectedImages"></div>
              </label>

              <div class="actions">
                <button id="send" type="submit">Send</button>
                <button id="interrupt" class="danger" type="button" disabled>Interrupt</button>
                <button id="clear" class="secondary" type="button">Clear</button>
              </div>
            </form>
          </section>

          <section>
            <div class="panel-heading">
              <strong>Claude Commands</strong>
              <span class="helper" id="commandsHint">Pick a session to manage slash commands</span>
            </div>
            <form id="commandForm">
              <div class="session-picker">
                <label>
                  Commands
                  <select id="commandList">
                    <option value="">No command selected</option>
                  </select>
                </label>
                <button id="refreshCommands" class="secondary" type="button">Refresh</button>
              </div>

              <div class="row single">
                <label>
                  Command path
                  <input id="commandPath" placeholder="review/fix.md" />
                </label>
              </div>

              <label>
                Command content
                <textarea id="commandContent" placeholder="Write the Claude slash command markdown here."></textarea>
              </label>

              <div class="actions">
                <button id="saveCommand" type="submit">Save command</button>
                <button id="newCommand" class="secondary" type="button">New</button>
                <button id="deleteCommand" class="danger" type="button">Delete</button>
              </div>
            </form>
          </section>

          <section>
            <div class="panel-heading">
              <strong>Workspace Search</strong>
              <span class="helper" id="searchHint">Pick a session to search files and folders</span>
            </div>
            <form id="searchForm">
              <div class="row">
                <label>
                  Query
                  <input id="searchQuery" placeholder="cmpbtn" />
                </label>

                <label>
                  Limit
                  <input id="searchLimit" type="number" min="1" max="200" value="20" />
                </label>
              </div>

              <div class="actions">
                <button id="runSearch" type="submit">Search</button>
                <button id="clearSearch" class="secondary" type="button">Clear</button>
              </div>

              <div class="search-results" id="searchResults"></div>
            </form>
          </section>
        </div>

        <section>
          <div class="toolbar">
            <strong>Session History</strong>
            <span class="session-state">
              <span class="loader" id="loader" aria-hidden="true"></span>
              <span class="session" id="session">No session</span>
            </span>
          </div>
          <div id="events" class="events"></div>
        </section>
      </div>
    </main>

    <script>
      const form = document.querySelector("#form");
      const statusEl = document.querySelector("#status");
      const sessionEl = document.querySelector("#session");
      const loaderEl = document.querySelector("#loader");
      const eventsEl = document.querySelector("#events");
      const sendButton = document.querySelector("#send");
      const interruptButton = document.querySelector("#interrupt");
      const clearButton = document.querySelector("#clear");
      const baseUrlInput = document.querySelector("#baseUrl");
      const sessionListInput = document.querySelector("#sessionList");
      const refreshSessionsButton = document.querySelector("#refreshSessions");
      const modeInput = document.querySelector("#mode");
      const maxTurnsInput = document.querySelector("#maxTurns");
      const promptInput = document.querySelector("#prompt");
      const imagesInput = document.querySelector("#images");
      const selectedImagesEl = document.querySelector("#selectedImages");
      const commandForm = document.querySelector("#commandForm");
      const commandsHintEl = document.querySelector("#commandsHint");
      const commandListInput = document.querySelector("#commandList");
      const refreshCommandsButton = document.querySelector("#refreshCommands");
      const commandPathInput = document.querySelector("#commandPath");
      const commandContentInput = document.querySelector("#commandContent");
      const saveCommandButton = document.querySelector("#saveCommand");
      const newCommandButton = document.querySelector("#newCommand");
      const deleteCommandButton = document.querySelector("#deleteCommand");
      const searchForm = document.querySelector("#searchForm");
      const searchHintEl = document.querySelector("#searchHint");
      const searchQueryInput = document.querySelector("#searchQuery");
      const searchLimitInput = document.querySelector("#searchLimit");
      const runSearchButton = document.querySelector("#runSearch");
      const clearSearchButton = document.querySelector("#clearSearch");
      const searchResultsEl = document.querySelector("#searchResults");

      const storageKey = "claude-test-client:last-session";
      const imageMediaTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
      const maxImages = 5;
      const maxImageBytes = 5 * 1024 * 1024;
      let sessionId = "";
      let sessions = [];
      let commands = [];
      let searchResults = [];
      let selectedImages = [];
      let controller;
      let observeController;
      let isSending = false;
      let isObservedRunning = false;

      baseUrlInput.value = window.location.origin;
      loadSessions({ restoreSaved: true });

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        await runPrompt();
      });

      imagesInput.addEventListener("change", async () => {
        selectedImages = [];
        selectedImagesEl.textContent = "";

        try {
          selectedImages = await readPromptImages(imagesInput.files || []);
          renderSelectedImages();
        } catch (error) {
          imagesInput.value = "";
          appendEntry("client_error", String(error && error.message ? error.message : error));
        }
      });

      interruptButton.addEventListener("click", async () => {
        if (!sessionId) return;
        await fetch(apiPath("/v1/sessions/" + encodeURIComponent(sessionId) + "/interrupt"), { method: "POST" });
        appendEntry("client", { interrupted: true });
      });

      clearButton.addEventListener("click", () => {
        eventsEl.textContent = "";
      });

      refreshSessionsButton.addEventListener("click", async () => {
        await loadSessions({ restoreSaved: false });
      });

      commandForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        await saveCommand();
      });

      refreshCommandsButton.addEventListener("click", async () => {
        await loadClaudeCommands();
      });

      commandListInput.addEventListener("change", async () => {
        if (!sessionId) return;
        const path = commandListInput.value;
        if (!path) {
          clearCommandEditor();
          return;
        }

        const existing = commands.find((command) => command.path === path);
        if (existing) {
          showCommand(existing);
          return;
        }

        await loadClaudeCommand(path);
      });

      newCommandButton.addEventListener("click", () => {
        clearCommandEditor();
      });

      deleteCommandButton.addEventListener("click", async () => {
        await deleteCommand();
      });

      searchForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        await runWorkspaceSearch();
      });

      clearSearchButton.addEventListener("click", () => {
        searchQueryInput.value = "";
        searchResults = [];
        renderSearchResults();
      });

      sessionListInput.addEventListener("change", () => {
        const selected = sessions.find((session) => getSessionId(session) === sessionListInput.value);

        if (!selected) {
          forgetSession();
          appendEntry("session", { active: false });
          return;
        }

        selectSession(selected, "session_selected");
      });

      async function runPrompt() {
        isSending = true;
        setBusy();
        controller = new AbortController();

        try {
          if (!sessionId) {
            const created = await postJson("/v1/sessions", {
              mode: modeInput.value,
              title: "Browser test client"
            });
            sessionId = created.sessionId;
            rememberSession(created);
            showSession(created);
            await loadSessions({ restoreSaved: false });
            await loadClaudeCommands();
          }

          stopObserving();
          const images = selectedImages.map((image) => ({
            name: image.name,
            mediaType: image.mediaType,
            dataBase64: image.dataBase64
          }));
          appendEntry("prompt", { prompt: promptInput.value, mode: modeInput.value, images });

          const response = await fetch(apiPath("/v1/sessions/" + encodeURIComponent(sessionId) + "/messages:stream"), {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              prompt: promptInput.value,
              ...(images.length > 0 ? { images } : {}),
              mode: modeInput.value,
              maxTurns: Number(maxTurnsInput.value || 30)
            })
          });

          if (!response.ok || !response.body) {
            throw new Error(await response.text());
          }

          await readSse(response.body);
          statusEl.textContent = "Complete";
          clearSelectedImages();
          await loadSessions({ restoreSaved: false });
          observeSession(sessionId);
        } catch (error) {
          statusEl.textContent = "Error";
          appendEntry("client_error", String(error && error.message ? error.message : error));
          if (sessionId) {
            observeSession(sessionId);
          }
        } finally {
          isSending = false;
          setBusy();
        }
      }

      async function postJson(path, body) {
        const response = await fetch(apiPath(path), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });

        if (!response.ok) {
          throw new Error(await response.text());
        }

        return response.json();
      }

      async function getJson(path) {
        const response = await fetch(apiPath(path));

        if (!response.ok) {
          throw new Error(await response.text());
        }

        return response.json();
      }

      async function loadSessions(options) {
        const saved = readSavedSession();
        if (options.restoreSaved && saved && saved.baseUrl) {
          baseUrlInput.value = saved.baseUrl;
        }

        try {
          const result = await getJson("/v1/sessions");
          sessions = Array.isArray(result.sessions) ? result.sessions : [];
          renderSessionList();

          if (!options.restoreSaved || !saved) return;

          const restored = sessions.find((session) => getSessionId(session) === saved.sessionId);

          if (!restored) {
            forgetSession();
            appendEntry("client", { restored: false, reason: "Last session was not found on the server" });
            return;
          }

          selectSession(restored, "session_restored");
        } catch (error) {
          appendEntry("client_error", "Could not load sessions: " + String(error && error.message ? error.message : error));
        }
      }

      async function loadSessionView(id, eventName, session) {
        stopObserving();
        eventsEl.textContent = "";
        searchResults = [];
        renderSearchResults();
        setWorkspaceSearchEnabled(true);
        searchHintEl.textContent = "Enter a query to search this session workspace";

        if (session) {
          appendEntry(eventName, session);
        }

        await loadClaudeCommands();

        try {
          const result = await getJson("/v1/sessions/" + encodeURIComponent(id) + "/messages");
          const messages = Array.isArray(result.messages) ? result.messages : [];

          if (messages.length === 0) {
            appendEntry("history", { empty: true });
          } else {
            for (const message of messages) {
              appendEntry("history", message);
            }
          }
        } catch (error) {
          appendEntry("client_error", "Could not load session history: " + String(error && error.message ? error.message : error));
        }

        observeSession(id);
      }

      async function runWorkspaceSearch() {
        if (!sessionId) {
          appendEntry("client_error", "Select or create a session before searching the workspace");
          return;
        }

        const query = String(searchQueryInput.value || "").trim();
        if (!query) {
          searchResults = [];
          renderSearchResults();
          searchHintEl.textContent = "Enter a query to search this session workspace";
          return;
        }

        searchHintEl.textContent = "Searching workspace paths";
        runSearchButton.disabled = true;

        try {
          const limit = Number(searchLimitInput.value || 20);
          const result = await getJson(
            "/v1/sessions/" +
              encodeURIComponent(sessionId) +
              "/files:search?q=" +
              encodeURIComponent(query) +
              "&limit=" +
              encodeURIComponent(String(limit))
          );
          searchResults = Array.isArray(result.results) ? result.results : [];
          renderSearchResults();
          searchHintEl.textContent =
            searchResults.length > 0
              ? "Search results from the selected session workspace"
              : "No matching files or folders in this session workspace";
        } catch (error) {
          searchHintEl.textContent = "Could not search workspace";
          appendEntry("client_error", "Could not search workspace: " + String(error && error.message ? error.message : error));
        } finally {
          runSearchButton.disabled = false;
        }
      }

      async function loadClaudeCommands() {
        commands = [];
        renderCommandList();

        if (!sessionId) {
          clearCommandEditor();
          commandsHintEl.textContent = "Pick a session to manage slash commands";
          setCommandEditorEnabled(false);
          return;
        }

        commandsHintEl.textContent = "Loading commands from .claude/commands";
        setCommandEditorEnabled(true);

        try {
          const result = await getJson("/v1/sessions/" + encodeURIComponent(sessionId) + "/claude-commands");
          commands = Array.isArray(result.commands) ? result.commands : [];
          renderCommandList();
          commandsHintEl.textContent =
            commands.length > 0
              ? "Commands live in this session workspace under .claude/commands"
              : "No commands saved yet for this session";
        } catch (error) {
          commandsHintEl.textContent = "Could not load commands";
          appendEntry("client_error", "Could not load Claude commands: " + String(error && error.message ? error.message : error));
        }
      }

      async function loadClaudeCommand(path) {
        if (!sessionId) return;

        try {
          const result = await getJson(
            "/v1/sessions/" + encodeURIComponent(sessionId) + "/claude-commands?path=" + encodeURIComponent(path)
          );
          if (result && result.command) {
            mergeCommand(result.command);
            showCommand(result.command);
          }
        } catch (error) {
          appendEntry("client_error", "Could not load Claude command: " + String(error && error.message ? error.message : error));
        }
      }

      async function saveCommand() {
        if (!sessionId) {
          appendEntry("client_error", "Select or create a session before saving commands");
          return;
        }

        const path = String(commandPathInput.value || "").trim();
        const content = String(commandContentInput.value || "");
        if (!path) {
          appendEntry("client_error", "Command path is required");
          return;
        }

        try {
          const result = await postJson("/v1/sessions/" + encodeURIComponent(sessionId) + "/claude-commands", {
            path,
            content
          });
          if (result && result.command) {
            mergeCommand(result.command);
            renderCommandList(result.command.path);
            showCommand(result.command);
            appendEntry("command_saved", { path: result.command.path, updatedAt: result.command.updatedAt });
          }
        } catch (error) {
          appendEntry("client_error", "Could not save Claude command: " + String(error && error.message ? error.message : error));
        }
      }

      async function deleteCommand() {
        if (!sessionId) {
          appendEntry("client_error", "Select or create a session before deleting commands");
          return;
        }

        const path = String(commandPathInput.value || commandListInput.value || "").trim();
        if (!path) {
          appendEntry("client_error", "Choose a command to delete");
          return;
        }

        try {
          const response = await fetch(apiPath("/v1/sessions/" + encodeURIComponent(sessionId) + "/claude-commands"), {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path })
          });
          if (!response.ok) throw new Error(await response.text());

          commands = commands.filter((command) => command.path !== path);
          renderCommandList();
          clearCommandEditor();
          appendEntry("command_deleted", { path });
          commandsHintEl.textContent =
            commands.length > 0
              ? "Commands live in this session workspace under .claude/commands"
              : "No commands saved yet for this session";
        } catch (error) {
          appendEntry("client_error", "Could not delete Claude command: " + String(error && error.message ? error.message : error));
        }
      }

      async function observeSession(id) {
        stopObserving();
        const controller = new AbortController();
        observeController = controller;

        try {
          const response = await fetch(apiPath("/v1/sessions/" + encodeURIComponent(id) + "/events:stream"), {
            signal: controller.signal
          });

          if (!response.ok || !response.body) {
            throw new Error(await response.text());
          }

          await readSse(response.body, "observer");
        } catch (error) {
          if (controller.signal.aborted) return;
          appendEntry("client_error", "Could not observe session events: " + String(error && error.message ? error.message : error));
        } finally {
          if (observeController === controller) {
            observeController = undefined;
            isObservedRunning = false;
            setBusy();
          }
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
          const parts = buffer.split(/\\r?\\n\\r?\\n/);
          buffer = parts.pop() || "";
          for (const part of parts) emitSse(part, source);
        }

        buffer += decoder.decode();
        if (buffer.trim()) emitSse(buffer, source);
      }

      function emitSse(raw, source) {
        let event = "message";
        const data = [];

        for (const line of raw.split(/\\r?\\n/)) {
          if (!line || line.startsWith(":")) continue;
          const index = line.indexOf(":");
          const field = index === -1 ? line : line.slice(0, index);
          const value = index === -1 ? "" : line.slice(index + 1).replace(/^ /, "");
          if (field === "event") event = value;
          if (field === "data") data.push(value);
        }

        const parsed = parse(data.join("\\n"));
        if (event === "status" && parsed && typeof parsed.running === "boolean") {
          isObservedRunning = parsed.running;
          setBusy();
          return;
        }
        if (event === "done" && source === "observer") {
          if (parsed && parsed.observing === false) {
            isObservedRunning = false;
            setBusy();
            return;
          }
        }
        if (event === "done" && source !== "observer") {
          setBusy();
        }
        appendEntry(event, parsed);
      }

      function parse(value) {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }

      function appendEntry(type, data) {
        const now = new Date().toLocaleTimeString();
        const entry = document.createElement("article");
        entry.className = "event-entry";

        const title = document.createElement("div");
        title.className = "event-title";
        title.textContent = "[" + now + "] " + type;
        entry.append(title);

        const pre = document.createElement("pre");
        pre.textContent = JSON.stringify(redactImageData(data), null, 2);
        entry.append(pre);

        const images = extractImageBlocks(data);
        if (images.length > 0) {
          entry.append(renderImageGrid(images));
        }

        eventsEl.append(entry);
        eventsEl.scrollTop = eventsEl.scrollHeight;
      }

      async function readPromptImages(fileList) {
        const files = Array.from(fileList);
        if (files.length > maxImages) throw new Error("Choose " + maxImages + " images or fewer");

        return Promise.all(
          files.map(async (file) => {
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
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.addEventListener("load", () => resolve(String(reader.result || "")));
          reader.addEventListener("error", () => reject(reader.error || new Error("Could not read image")));
          reader.readAsDataURL(file);
        });
      }

      function renderSelectedImages() {
        selectedImagesEl.textContent = "";
        if (selectedImages.length === 0) return;
        const grid = renderImageGrid(
          selectedImages.map((image) => ({
            name: image.name,
            mediaType: image.mediaType,
            size: image.size,
            dataBase64: image.dataBase64
          }))
        );
        selectedImagesEl.replaceChildren(...Array.from(grid.children));
      }

      function clearSelectedImages() {
        selectedImages = [];
        imagesInput.value = "";
        selectedImagesEl.textContent = "";
      }

      function showCommand(command) {
        commandPathInput.value = command.path || "";
        commandContentInput.value = command.content || "";
        commandListInput.value = command.path || "";
      }

      function clearCommandEditor() {
        commandPathInput.value = "";
        commandContentInput.value = "";
        commandListInput.value = "";
      }

      function setWorkspaceSearchEnabled(enabled) {
        searchQueryInput.disabled = !enabled;
        searchLimitInput.disabled = !enabled;
        runSearchButton.disabled = !enabled;
        clearSearchButton.disabled = !enabled;
      }

      function setCommandEditorEnabled(enabled) {
        commandListInput.disabled = !enabled;
        refreshCommandsButton.disabled = !enabled;
        commandPathInput.disabled = !enabled;
        commandContentInput.disabled = !enabled;
        saveCommandButton.disabled = !enabled;
        newCommandButton.disabled = !enabled;
        deleteCommandButton.disabled = !enabled;
      }

      function renderCommandList(selectedPath) {
        const current = selectedPath !== undefined ? selectedPath : commandListInput.value;
        commandListInput.replaceChildren(new Option(commands.length > 0 ? "Choose a command" : "No command selected", ""));

        for (const command of commands) {
          commandListInput.add(new Option(command.path, command.path));
        }

        if (current && commands.some((command) => command.path === current)) {
          commandListInput.value = current;
        }
      }

      function mergeCommand(command) {
        const next = commands.filter((item) => item.path !== command.path);
        next.push(command);
        commands = next.sort((left, right) => String(left.path).localeCompare(String(right.path)));
      }

      function renderSearchResults() {
        searchResultsEl.textContent = "";

        if (searchResults.length === 0) {
          const empty = document.createElement("div");
          empty.className = "search-empty";
          empty.textContent = searchQueryInput.value.trim()
            ? "No matching files or folders"
            : "Search results will appear here";
          searchResultsEl.append(empty);
          return;
        }

        for (const result of searchResults) {
          const item = document.createElement("article");
          item.className = "search-result";

          const title = document.createElement("strong");
          title.textContent = result.name || result.path || "Untitled";
          item.append(title);

          const path = document.createElement("code");
          path.textContent = result.path || "";
          item.append(path);

          const meta = document.createElement("div");
          meta.className = "search-meta";
          meta.textContent = [
            result.type || "file",
            Number.isFinite(result.score) ? "score " + result.score : "",
            result.size ? formatBytes(result.size) : "",
            result.updatedAt ? new Date(result.updatedAt).toLocaleString() : ""
          ]
            .filter(Boolean)
            .join(" - ");
          item.append(meta);

          searchResultsEl.append(item);
        }
      }

      function renderImageGrid(images) {
        const grid = document.createElement("div");
        grid.className = "image-previews";

        for (const image of images) {
          const item = document.createElement("figure");
          item.className = "image-preview";

          if (image.dataBase64 && image.mediaType) {
            const img = document.createElement("img");
            img.alt = image.name || image.mediaType;
            img.src = "data:" + image.mediaType + ";base64," + image.dataBase64;
            item.append(img);
          }

          const caption = document.createElement("span");
          caption.textContent = [image.name || image.mediaType, formatBytes(image.size)].filter(Boolean).join(" - ");
          item.append(caption);
          grid.append(item);
        }

        return grid;
      }

      function extractImageBlocks(value) {
        const images = [];
        const seen = new Set();

        function visit(node) {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) {
            for (const item of node) visit(item);
            return;
          }

          if (node.type === "image" && node.source && node.source.type === "base64" && node.source.data && node.source.media_type) {
            const key = node.source.media_type + ":" + node.source.data.slice(0, 40);
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
            const key = node.mediaType + ":" + node.dataBase64.slice(0, 40);
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

          for (const item of Object.values(node)) visit(item);
        }

        visit(value);
        return images;
      }

      function redactImageData(value) {
        if (!value || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map(redactImageData);

        const copy = {};
        for (const [key, item] of Object.entries(value)) {
          if ((key === "data" || key === "dataBase64") && typeof item === "string" && item.length > 80) {
            copy[key] = "[base64 image data redacted, " + formatBytes(estimateBase64Bytes(item)) + "]";
          } else {
            copy[key] = redactImageData(item);
          }
        }
        return copy;
      }

      function estimateBase64Bytes(value) {
        const clean = String(value).replace(/^data:image\\/[^;]+;base64,/i, "").replace(/\\s/g, "");
        const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
        return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
      }

      function formatBytes(value) {
        if (!Number.isFinite(value)) return "";
        if (value < 1024) return value + " B";
        if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
        return (value / (1024 * 1024)).toFixed(1) + " MB";
      }

      function apiPath(path) {
        return baseUrlInput.value.replace(/\\/$/, "") + path;
      }

      function rememberSession(session) {
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            sessionId: session.sessionId,
            baseUrl: baseUrlInput.value.replace(/\\/$/, "")
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

      function forgetSession() {
        stopObserving();
        isObservedRunning = false;
        sessionId = "";
        commands = [];
        searchResults = [];
        localStorage.removeItem(storageKey);
        sessionEl.textContent = "No session";
        sessionListInput.value = "";
        eventsEl.textContent = "";
        clearCommandEditor();
        renderCommandList();
        renderSearchResults();
        commandsHintEl.textContent = "Pick a session to manage slash commands";
        searchHintEl.textContent = "Pick a session to search files and folders";
        setCommandEditorEnabled(false);
        setWorkspaceSearchEnabled(false);
      }

      function selectSession(session, eventName) {
        sessionId = getSessionId(session);
        modeInput.value = session.mode || modeInput.value;
        rememberSession({ sessionId });
        showSession({ sessionId });
        sessionListInput.value = sessionId;
        loadSessionView(sessionId, eventName, session);
      }

      function showSession(session) {
        sessionEl.textContent = "Session " + session.sessionId;
      }

      function renderSessionList() {
        sessionListInput.replaceChildren(new Option("New session", ""));

        for (const session of sessions) {
          const label = formatSessionOption(session);
          sessionListInput.add(new Option(label, getSessionId(session)));
        }

        if (sessionId && sessions.some((session) => getSessionId(session) === sessionId)) {
          sessionListInput.value = sessionId;
        }
      }

      function formatSessionOption(session) {
        const title = session.title || "Untitled";
        const time = session.updatedAt ? new Date(session.updatedAt).toLocaleString() : "unknown time";
        return title + " [" + session.mode + "] - " + time;
      }

      function getSessionId(session) {
        return session.sessionId || session.id;
      }

      function stopObserving() {
        if (observeController) {
          observeController.abort();
          observeController = undefined;
        }
        isObservedRunning = false;
        setBusy();
      }

      function setBusy() {
        const isBusy = isSending || isObservedRunning;
        sendButton.disabled = isSending;
        interruptButton.disabled = !isBusy || !sessionId;
        loaderEl.classList.toggle("active", isBusy);
        statusEl.textContent = isBusy ? "Generating" : "Idle";
      }

      setCommandEditorEnabled(false);
      setWorkspaceSearchEnabled(false);
      renderSearchResults();
    </script>
  </body>
</html>`;
}

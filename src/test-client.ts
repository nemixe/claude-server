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

      pre {
        min-height: 520px;
        max-height: 72vh;
        margin: 0;
        padding: 16px;
        overflow: auto;
        border-top: 1px solid var(--line);
        background: var(--event);
        white-space: pre-wrap;
        word-break: break-word;
      }

      .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 16px;
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

            <div class="actions">
              <button id="send" type="submit">Send</button>
              <button id="interrupt" class="danger" type="button" disabled>Interrupt</button>
              <button id="clear" class="secondary" type="button">Clear</button>
            </div>
          </form>
        </section>

        <section>
          <div class="toolbar">
            <strong>Session History</strong>
            <span class="session-state">
              <span class="loader" id="loader" aria-hidden="true"></span>
              <span class="session" id="session">No session</span>
            </span>
          </div>
          <pre id="events"></pre>
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

      const storageKey = "claude-test-client:last-session";
      let sessionId = "";
      let sessions = [];
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
          }

          stopObserving();
          appendEntry("prompt", { prompt: promptInput.value, mode: modeInput.value });

          const response = await fetch(apiPath("/v1/sessions/" + encodeURIComponent(sessionId) + "/messages:stream"), {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              prompt: promptInput.value,
              mode: modeInput.value,
              maxTurns: Number(maxTurnsInput.value || 30)
            })
          });

          if (!response.ok || !response.body) {
            throw new Error(await response.text());
          }

          await readSse(response.body);
          statusEl.textContent = "Complete";
          await loadSessionView(sessionId, "history_refreshed");
        } catch (error) {
          statusEl.textContent = "Error";
          appendEntry("client_error", String(error && error.message ? error.message : error));
          if (sessionId) {
            await loadSessionView(sessionId, "history_refreshed");
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

        if (session) {
          appendEntry(eventName, session);
        }

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

      async function observeSession(id) {
        observeController = new AbortController();

        try {
          const response = await fetch(apiPath("/v1/sessions/" + encodeURIComponent(id) + "/events:stream"), {
            signal: observeController.signal
          });

          if (!response.ok || !response.body) {
            throw new Error(await response.text());
          }

          await readSse(response.body);
        } catch (error) {
          if (!observeController || observeController.signal.aborted) return;
          appendEntry("client_error", "Could not observe session events: " + String(error && error.message ? error.message : error));
        }
      }

      async function readSse(body) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const parts = buffer.split(/\\r?\\n\\r?\\n/);
          buffer = parts.pop() || "";
          for (const part of parts) emitSse(part);
        }

        buffer += decoder.decode();
        if (buffer.trim()) emitSse(buffer);
      }

      function emitSse(raw) {
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
        if (event === "done" && parsed && parsed.observing === false) return;
        if (event === "done") {
          isObservedRunning = false;
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
        eventsEl.textContent += "[" + now + "] " + type + "\\n" + JSON.stringify(data, null, 2) + "\\n\\n";
        eventsEl.scrollTop = eventsEl.scrollHeight;
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
        localStorage.removeItem(storageKey);
        sessionEl.textContent = "No session";
        sessionListInput.value = "";
        eventsEl.textContent = "";
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
    </script>
  </body>
</html>`;
}

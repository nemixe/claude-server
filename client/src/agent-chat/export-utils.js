export function serializeHistoryEvents(events) {
  return (Array.isArray(events) ? events : []).map((entry) => ({
    time: entry.time,
    timestamp: entry.timestamp || "",
    type: entry.type,
    data: entry.data
  }));
}

export function buildSessionExportPayload({ session, events, messages, exportedAt = new Date().toISOString() }) {
  const sessionId = getSessionId(session);
  return {
    exportedAt,
    session: session
      ? {
          id: sessionId,
          title: session.title || "",
          userName: session.userName || "",
          mode: session.mode || "",
          status: session.status || "",
          createdAt: session.createdAt || "",
          updatedAt: session.updatedAt || "",
          hasRun: Boolean(session.hasRun),
          costUsd: session.costUsd
        }
      : null,
    messages: Array.isArray(messages) ? messages : [],
    events: serializeHistoryEvents(events)
  };
}

export function buildSessionExportFilename(session, exportedAt = new Date().toISOString()) {
  const sessionId = getSessionId(session);
  const title = session?.title || sessionId || "session";
  const safeTitle = sanitizeFilenamePart(title, "session");
  const safeTimestamp = sanitizeFilenamePart(exportedAt.replace(/\.\d{3}Z$/, "Z"), "export");
  return `${safeTitle}-${safeTimestamp}.json`;
}

export function downloadJsonFile(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], {
    type: "application/json;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function getSessionId(session) {
  return session?.sessionId || session?.id || "";
}

function sanitizeFilenamePart(value, fallback) {
  const safe = String(value || "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return safe || fallback;
}

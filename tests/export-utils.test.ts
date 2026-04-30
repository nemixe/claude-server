import { describe, expect, it } from "vitest";
import {
  buildSessionExportFilename,
  buildSessionExportPayload,
  serializeHistoryEvents
} from "../client/src/agent-chat/export-utils.js";

describe("session JSON export helpers", () => {
  it("serializes raw history events without leaking transient fields", () => {
    expect(
      serializeHistoryEvents([
        {
          id: "runtime-1",
          time: "10:15 AM",
          timestamp: "2026-04-30T03:15:00.000Z",
          type: "message",
          data: { content: "hello" }
        }
      ])
    ).toEqual([
      {
        time: "10:15 AM",
        timestamp: "2026-04-30T03:15:00.000Z",
        type: "message",
        data: { content: "hello" }
      }
    ]);
  });

  it("builds an export payload with session metadata, messages, and events", () => {
    const payload = buildSessionExportPayload({
      exportedAt: "2026-04-30T03:20:00.000Z",
      session: {
        id: "session-1",
        sessionId: "session-1",
        title: "Investigate export",
        userName: "Ada",
        mode: "bypass",
        createdAt: "2026-04-30T03:00:00.000Z",
        updatedAt: "2026-04-30T03:10:00.000Z",
        hasRun: true
      },
      messages: [{ type: "user", message: "export this" }],
      events: [{ type: "prompt", data: { prompt: "export this" } }]
    });

    expect(payload).toMatchObject({
      exportedAt: "2026-04-30T03:20:00.000Z",
      session: {
        id: "session-1",
        title: "Investigate export",
        userName: "Ada",
        mode: "bypass",
        hasRun: true
      },
      messages: [{ type: "user", message: "export this" }],
      events: [{ timestamp: "", type: "prompt", data: { prompt: "export this" } }]
    });
  });

  it("creates a safe JSON filename from the session title and export time", () => {
    expect(
      buildSessionExportFilename(
        { sessionId: "session-1", title: "Fix export JSON / browser?" },
        "2026-04-30T03:20:00.000Z"
      )
    ).toBe("Fix-export-JSON-browser-2026-04-30T03-20-00Z.json");
  });
});

import { describe, expect, it } from "vitest";
import {
  createEventEntry,
  createHistoryEntries,
  groupActivityItemsForVirtualRows,
  mergeEventEntries
} from "../client/src/agent-chat/event-state-utils.js";

describe("chat event state helpers", () => {
  it("creates stable history entries for paginated messages", () => {
    const timestamp = new Date(2026, 3, 28, 10, 15).toISOString();
    const entries = createHistoryEntries(
      [
        { uuid: "m1", type: "user", timestamp, message: "first" },
        { uuid: "m2", type: "assistant", timestamp, message: "second" }
      ],
      { sessionId: "s1", offset: 200 }
    );

    expect(entries.map((entry) => entry.id)).toEqual(["history:s1:m1", "history:s1:m2"]);
    expect(entries[0]).toMatchObject({ type: "history", timestamp });
  });

  it("prepends and appends entries without duplicating ids", () => {
    const first = createEventEntry("history", "first", { id: "1" });
    const second = createEventEntry("history", "second", { id: "2" });
    const duplicate = createEventEntry("history", "duplicate", { id: "1" });

    expect(mergeEventEntries([first], [second, duplicate]).map((entry) => entry.id)).toEqual(["1", "2"]);
    expect(mergeEventEntries([second], [first], { prepend: true }).map((entry) => entry.id)).toEqual(["1", "2"]);
  });

  it("chunks consecutive activity rows for bounded virtual rendering", () => {
    const activities = Array.from({ length: 10_000 }, (_, index) => ({
      key: "activity-" + index,
      role: "assistant_activity"
    }));
    const rows = groupActivityItemsForVirtualRows(activities, { groupSize: 25 });

    expect(rows).toHaveLength(400);
    expect(rows[0]).toMatchObject({ role: "assistant_activity_group" });
    expect(rows[0].items).toHaveLength(25);
    expect(rows.at(-1)?.items).toHaveLength(25);
  });
});

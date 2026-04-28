import { formatMessageTimestamp, getMessageTimestamp } from "./chat-ui-utils.js";

export function createEventEntry(type, data, options = {}) {
  const timestamp = getMessageTimestamp({ timestamp: options.timestamp }) || getMessageTimestamp(data);
  const time = formatMessageTimestamp(timestamp);

  return {
    id: options.id || createRuntimeEventId(),
    time,
    timestamp: timestamp || undefined,
    type,
    data
  };
}

export function createHistoryEntries(messages, options = {}) {
  const offset = Math.max(options.offset || 0, 0);
  const sessionId = options.sessionId || "session";
  return (Array.isArray(messages) ? messages : []).map((message, index) =>
    createEventEntry("history", message, {
      id: "history:" + sessionId + ":" + messageStableKey(message, offset + index)
    })
  );
}

export function mergeEventEntries(current, incoming, options = {}) {
  const existingIds = new Set(current.map((entry) => entry.id));
  const uniqueIncoming = incoming.filter((entry) => entry && !existingIds.has(entry.id));

  if (uniqueIncoming.length === 0) return current;
  return options.prepend ? uniqueIncoming.concat(current) : current.concat(uniqueIncoming);
}

export function chunkItems(items, size) {
  const chunkSize = Math.max(Number(size) || 0, 1);
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

export function groupActivityItemsForVirtualRows(items, options = {}) {
  const activityRole = options.activityRole || "assistant_activity";
  const groupRole = options.groupRole || "assistant_activity_group";
  const groupSize = options.groupSize || 25;
  const result = [];
  let index = 0;

  while (index < items.length) {
    if (items[index].role !== activityRole) {
      result.push(items[index]);
      index += 1;
      continue;
    }

    const children = [];
    const groupKey = items[index].key;
    while (index < items.length && items[index].role === activityRole) {
      children.push(items[index]);
      index += 1;
    }

    chunkItems(children, groupSize).forEach((chunk, chunkIndex) => {
      result.push({ key: groupKey + ":activity-group:" + chunkIndex, role: groupRole, items: chunk });
    });
  }

  return result;
}

export function createRuntimeEventId() {
  return Date.now() + ":" + Math.random().toString(36).slice(2);
}

function messageStableKey(message, fallbackIndex) {
  const record = message && typeof message === "object" ? message : {};
  const inner = record.message && typeof record.message === "object" ? record.message : {};
  return (
    record.uuid ||
    inner.uuid ||
    record.id ||
    inner.id ||
    [record.type || inner.role || "message", fallbackIndex].join(":")
  );
}

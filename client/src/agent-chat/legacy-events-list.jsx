import { useRef } from "react";
import { Alert } from "antd";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ImageAttachmentGrid } from "./message-content.jsx";
import { extractImageBlocks, redactImageData } from "./media-utils.js";

export function LegacyEventsList({ events }) {
  const parentRef = useRef(null);
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 180,
    overscan: 4
  });

  if (events.length === 0) {
    return <Alert type="info" message="Session history and streaming events will appear here." />;
  }

  return (
    <div ref={parentRef} className="legacy-events-list">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const entry = events[virtualRow.index];
          const images = extractImageBlocks(entry.data);
          const title = [entry.time ? `[${entry.time}]` : "", entry.type].filter(Boolean).join(" ");
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
                paddingBottom: 12
              }}
            >
              <article className="legacy-event-entry">
                <div className="legacy-event-title">{title}</div>
                <pre>{JSON.stringify(redactImageData(entry.data), null, 2)}</pre>
                <ImageAttachmentGrid images={images} />
              </article>
            </div>
          );
        })}
      </div>
    </div>
  );
}

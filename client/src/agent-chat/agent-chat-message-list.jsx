import { useVirtualizer } from "@tanstack/react-virtual";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef
} from "react";
import ActivityTimeline from "./activity-timeline.jsx";
import MessageBubble from "./message-bubble.jsx";

const MESSAGE_LIST_BOTTOM_THRESHOLD_PX = 24;
const ESTIMATE_SIZE = 86;
const OVERSCAN = 10;
const BUBBLE_GAP = 4;
const ACTIVITY_ROLE = "assistant_activity";
const GROUP_ROLE = "assistant_activity_group";

function groupBubbleItems(items) {
  const result = [];
  let i = 0;

  while (i < items.length) {
    if (items[i].role === ACTIVITY_ROLE) {
      const children = [];
      const groupKey = items[i].key;
      while (i < items.length && items[i].role === ACTIVITY_ROLE) {
        children.push(items[i]);
        i += 1;
      }
      result.push({ key: groupKey, role: GROUP_ROLE, items: children });
    } else {
      result.push(items[i]);
      i += 1;
    }
  }

  return result;
}

const AgentChatMessageList = forwardRef(
  ({ bubbleItems, bubbleRoles, isStreaming, open, writeClipboard }, ref) => {
    const scrollElementRef = useRef(null);
    const isPinnedToBottomRef = useRef(true);
    const processedItems = useMemo(() => groupBubbleItems(bubbleItems), [bubbleItems]);

    const virtualizer = useVirtualizer({
      count: processedItems.length,
      getScrollElement: () => scrollElementRef.current,
      estimateSize: () => ESTIMATE_SIZE,
      overscan: OVERSCAN
    });

    useEffect(() => {
      if (!open || !isStreaming || processedItems.length === 0) return;
      const el = scrollElementRef.current;
      if (!el) return;

      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (distanceFromBottom > MESSAGE_LIST_BOTTOM_THRESHOLD_PX) {
        isPinnedToBottomRef.current = false;
        return;
      }

      virtualizer.scrollToIndex(processedItems.length - 1, { align: "end" });
    }, [open, isStreaming, processedItems, virtualizer]);

    useEffect(() => {
      if (!open || processedItems.length === 0 || !isPinnedToBottomRef.current) return;
      virtualizer.scrollToIndex(processedItems.length - 1, { align: "end" });
    }, [open, processedItems.length, virtualizer]);

    useImperativeHandle(
      ref,
      () => ({
        scrollToMessage: (messageId) => {
          const index = processedItems.findIndex((item) => {
            if (item.role === GROUP_ROLE) {
              return item.items.some((child) => child.key === messageId);
            }
            return item.key === messageId;
          });
          if (index < 0) return false;
          virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
          return true;
        },
        scrollToBottom: () => {
          if (processedItems.length === 0) return;
          virtualizer.scrollToIndex(processedItems.length - 1, { align: "end" });
        }
      }),
      [processedItems, virtualizer]
    );

    const handleScroll = useCallback(() => {
      const el = scrollElementRef.current;
      if (!el) return;
      isPinnedToBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <= MESSAGE_LIST_BOTTOM_THRESHOLD_PX;
    }, []);

    const virtualItems = virtualizer.getVirtualItems();

    if (processedItems.length === 0) {
      return (
        <div
          ref={scrollElementRef}
          className="ai-chat-messages ai-chat-empty-state"
          role="log"
          aria-label="Chat messages"
        >
          <div>
            <h1>Claude AI Chat</h1>
            <p>Choose or create a session, then ask about this workspace.</p>
          </div>
        </div>
      );
    }

    return (
      <div
        ref={scrollElementRef}
        className="ai-chat-messages"
        role="log"
        aria-label="Chat messages"
        aria-live="polite"
        aria-busy={isStreaming}
        onScroll={handleScroll}
      >
        <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
          {virtualItems.map((virtualRow) => {
            const item = processedItems[virtualRow.index];
            const isGroup = item.role === GROUP_ROLE;

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
                  paddingBottom: BUBBLE_GAP
                }}
              >
                {isGroup ? (
                  <ActivityTimeline
                    items={item.items}
                    isLastGroup={(() => {
                      if (!isStreaming) return false;
                      const next = processedItems[virtualRow.index + 1];
                      return !next || next.loading === true;
                    })()}
                  />
                ) : (
                  <MessageBubble
                    roleConfig={bubbleRoles[item.role] || {}}
                    item={item}
                    writeClipboard={writeClipboard}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }
);

AgentChatMessageList.displayName = "AgentChatMessageList";

export default AgentChatMessageList;

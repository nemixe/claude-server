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

function isScrolledNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= MESSAGE_LIST_BOTTOM_THRESHOLD_PX;
}

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
  ({ bubbleItems, bubbleRoles, isStreaming, open, scrollResetKey, writeClipboard }, ref) => {
    const scrollElementRef = useRef(null);
    const isPinnedToBottomRef = useRef(true);
    const pendingInitialScrollRef = useRef(true);
    const previousScrollResetKeyRef = useRef(scrollResetKey);
    const scrollFrameRef = useRef(null);
    const processedItems = useMemo(() => groupBubbleItems(bubbleItems), [bubbleItems]);

    const virtualizer = useVirtualizer({
      count: processedItems.length,
      getScrollElement: () => scrollElementRef.current,
      estimateSize: () => ESTIMATE_SIZE,
      overscan: OVERSCAN
    });

    const scrollToBottom = useCallback(
      ({ force = false } = {}) => {
        if (processedItems.length === 0) return;
        if (scrollFrameRef.current !== null) {
          window.cancelAnimationFrame(scrollFrameRef.current);
        }

        scrollFrameRef.current = window.requestAnimationFrame(() => {
          scrollFrameRef.current = null;
          if (!force && !isPinnedToBottomRef.current) return;

          virtualizer.scrollToIndex(processedItems.length - 1, { align: "end" });
          isPinnedToBottomRef.current = true;
          pendingInitialScrollRef.current = false;
        });
      },
      [processedItems.length, virtualizer]
    );

    useEffect(() => {
      return () => {
        if (scrollFrameRef.current !== null) {
          window.cancelAnimationFrame(scrollFrameRef.current);
        }
      };
    }, []);

    useEffect(() => {
      if (previousScrollResetKeyRef.current === scrollResetKey) return;
      previousScrollResetKeyRef.current = scrollResetKey;
      isPinnedToBottomRef.current = true;
      pendingInitialScrollRef.current = true;
    }, [scrollResetKey]);

    useEffect(() => {
      if (processedItems.length !== 0) return;
      isPinnedToBottomRef.current = true;
      pendingInitialScrollRef.current = true;
    }, [processedItems.length]);

    useEffect(() => {
      if (!open || processedItems.length === 0) return;

      if (pendingInitialScrollRef.current) {
        scrollToBottom({ force: true });
        return;
      }

      if (isPinnedToBottomRef.current) {
        scrollToBottom();
      }
    }, [open, processedItems.length, scrollToBottom]);

    useEffect(() => {
      if (!open || !isStreaming || processedItems.length === 0) return;
      if (!isPinnedToBottomRef.current) return;
      scrollToBottom();
    }, [open, isStreaming, processedItems, scrollToBottom]);

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
          scrollToBottom({ force: true });
        }
      }),
      [processedItems, scrollToBottom, virtualizer]
    );

    const handleScroll = useCallback(() => {
      const el = scrollElementRef.current;
      if (!el) return;
      isPinnedToBottomRef.current = isScrolledNearBottom(el);
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

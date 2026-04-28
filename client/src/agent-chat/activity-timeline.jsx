import { LoadingOutlined } from "@ant-design/icons";
import { Collapse, Timeline } from "antd";
import { memo, useCallback, useMemo, useState } from "react";
import MarkdownText from "./markdown-text.jsx";

const ActivityTimeline = memo(({ items, isLastGroup }) => {
  const [expandedKeys, setExpandedKeys] = useState(() => new Set());
  const updateExpanded = useCallback((key, keys) => {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (keys.includes(key)) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const timelineItems = useMemo(() => items.map((item, index) => {
    const isLast = index === items.length - 1;
    const isCollapsible = item.collapsible && item.details;
    const isExpanded = expandedKeys.has(item.key);
    return {
      color: item.tone === "error" ? "red" : "gray",
      dot: isLast && isLastGroup ? <LoadingOutlined style={{ fontSize: 12 }} /> : undefined,
      children: isCollapsible ? (
        <Collapse
          ghost
          size="small"
          expandIconPosition="end"
          className="ai-chat-timeline-collapse"
          onChange={(keys) => updateExpanded(item.key, Array.isArray(keys) ? keys : [keys])}
          items={[
            {
              key: item.key,
              label: <span className="ai-chat-timeline-collapse-label">{item.label}</span>,
              children: isExpanded ? (
                <>
                  <MarkdownText
                    text={String(item.details ?? "")}
                    className="ai-chat-timeline-item-content"
                  />
                  {item.toolResult ? (
                    <Collapse
                      ghost
                      size="small"
                      expandIconPosition="end"
                      className="ai-chat-timeline-collapse ai-chat-timeline-result-collapse"
                      items={[
                        {
                          key: item.key + "-result",
                          label: <span className="ai-chat-timeline-collapse-label">Tool result</span>,
                          children: (
                            <MarkdownText
                              text={String(item.toolResult)}
                              className="ai-chat-timeline-item-content"
                            />
                          )
                        }
                      ]}
                    />
                  ) : null}
                </>
              ) : null
            }
          ]}
        />
      ) : (
        <MarkdownText
          text={String(item.content ?? "")}
          className="ai-chat-timeline-item-content"
        />
      )
    };
  }), [expandedKeys, isLastGroup, items, updateExpanded]);

  return (
    <div className="ai-chat-activity-timeline">
      <Timeline items={timelineItems} />
    </div>
  );
});

ActivityTimeline.displayName = "ActivityTimeline";

export default ActivityTimeline;

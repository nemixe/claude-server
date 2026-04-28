import { LoadingOutlined } from "@ant-design/icons";
import { Collapse, Timeline } from "antd";
import { memo } from "react";
import MarkdownText from "./markdown-text.jsx";

const ActivityTimeline = memo(({ items, isLastGroup }) => {
  const timelineItems = items.map((item, index) => {
    const isLast = index === items.length - 1;
    const isCollapsible = item.collapsible && item.details;
    return {
      color: item.tone === "error" ? "red" : "gray",
      dot: isLast && isLastGroup ? <LoadingOutlined style={{ fontSize: 12 }} /> : undefined,
      children: isCollapsible ? (
        <Collapse
          ghost
          size="small"
          expandIconPosition="end"
          className="ai-chat-timeline-collapse"
          items={[
            {
              key: item.key,
              label: <span className="ai-chat-timeline-collapse-label">{item.label}</span>,
              children: (
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
              )
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
  });

  return (
    <div className="ai-chat-activity-timeline">
      <Timeline items={timelineItems} />
    </div>
  );
});

ActivityTimeline.displayName = "ActivityTimeline";

export default ActivityTimeline;
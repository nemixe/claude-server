import { LoadingOutlined } from "@ant-design/icons";
import { Timeline } from "antd";
import { memo } from "react";
import MarkdownText from "./markdown-text.jsx";

const ActivityTimeline = memo(({ items, isLastGroup }) => {
  const timelineItems = items.map((item, index) => {
    const isLast = index === items.length - 1;
    return {
      color: item.tone === "error" ? "red" : "gray",
      dot: isLast && isLastGroup ? <LoadingOutlined style={{ fontSize: 12 }} /> : undefined,
      children: (
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

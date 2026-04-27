import { LoadingOutlined } from "@ant-design/icons";
import { Timeline } from "antd";
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const renderContent = (content) => {
    const text = typeof content === "string" ? content : String(content ?? "");
    return (
        <div className="ai-chat-timeline-item-content">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    a: ({ node, ...props }) => {
                        void node;
                        return <a {...props} target="_blank" rel="noreferrer noopener" />;
                    },
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );
};

const ActivityTimeline = memo(({ items, isLastGroup }) => {
    const timelineItems = items.map((item, index) => {
        const isLast = index === items.length - 1;
        return {
            color: "gray",
            dot: isLast && isLastGroup ? <LoadingOutlined style={{ fontSize: 12 }} /> : undefined,
            children: renderContent(item.content),
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

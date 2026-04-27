import { Bubble } from "@ant-design/x";
import { memo, useMemo } from "react";
import CopyButton from "./copy-button";

const extractTextContent = (content) => {
    if (typeof content === "string") return content;
    if (content?.props?.children) {
        const extractText = (node) => {
            if (typeof node === "string") return node;
            if (Array.isArray(node)) return node.map(extractText).join("");
            if (node?.props?.children) return extractText(node.props.children);
            return "";
        };
        return extractText(content.props.children);
    }
    return "";
};

const MessageBubble = memo(({ roleConfig, item }) => {
    const textContent = useMemo(
        () => (item.loading ? "" : extractTextContent(item.content)),
        [item.content, item.loading]
    );

    return (
        <Bubble
            placement={roleConfig.placement}
            styles={roleConfig.styles}
            classNames={roleConfig.classNames}
            messageRender={roleConfig.messageRender}
            content={item.content}
            loading={item.loading}
            className={item.className}
            header={item.header}
            avatar={item.avatar}
            footer={
                textContent
                    ? () => (
                          <div className="ai-chat-bubble-footer">
                              <CopyButton text={textContent} />
                          </div>
                      )
                    : undefined
            }
        />
    );
});

MessageBubble.displayName = "MessageBubble";

export default MessageBubble;

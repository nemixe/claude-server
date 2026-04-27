import { Bubble } from "@ant-design/x";
import { memo, useMemo } from "react";
import CopyButton from "./copy-button.jsx";

function extractTextFromReact(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractTextFromReact).join("");
  if (content?.props?.children) return extractTextFromReact(content.props.children);
  return "";
}

const MessageBubble = memo(({ roleConfig, item, writeClipboard }) => {
  const textContent = useMemo(
    () => (item.loading ? "" : item.copyText || extractTextFromReact(item.content)),
    [item.content, item.copyText, item.loading]
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
                <CopyButton text={textContent} writeClipboard={writeClipboard} />
              </div>
            )
          : undefined
      }
    />
  );
});

MessageBubble.displayName = "MessageBubble";

export default MessageBubble;

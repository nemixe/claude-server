import { Bubble } from "@ant-design/x";
import { memo, useMemo } from "react";
import CopyButton from "./copy-button.jsx";

function extractTextFromReact(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(extractTextFromReact).join("");
  if (content?.props?.children) return extractTextFromReact(content.props.children);
  return "";
}

function mergeBubbleStyles(baseStyles = {}, itemStyles = {}) {
  return Object.fromEntries(
    Array.from(new Set(Object.keys(baseStyles).concat(Object.keys(itemStyles)))).map((key) => [
      key,
      { ...(baseStyles[key] || {}), ...(itemStyles[key] || {}) }
    ])
  );
}

const MessageBubble = memo(({ roleConfig, item, writeClipboard }) => {
  const textContent = useMemo(
    () => (item.loading ? "" : item.copyText || extractTextFromReact(item.content)),
    [item.content, item.copyText, item.loading]
  );
  const styles = useMemo(
    () => mergeBubbleStyles(roleConfig.styles, item.styles),
    [item.styles, roleConfig.styles]
  );

  return (
    <Bubble
      placement={roleConfig.placement}
      styles={styles}
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

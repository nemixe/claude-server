import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const MarkdownText = memo(function MarkdownText({ text, className = "" }) {
  return (
    <div className={["ai-chat-markdown", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => {
            void node;
            return <a {...props} target="_blank" rel="noreferrer noopener" />;
          }
        }}
      >
        {String(text || "")}
      </ReactMarkdown>
    </div>
  );
});

export default MarkdownText;

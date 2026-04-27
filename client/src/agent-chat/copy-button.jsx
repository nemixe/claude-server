import { CheckOutlined, CopyOutlined } from "@ant-design/icons";
import { useCallback, useState } from "react";

export default function CopyButton({ text, writeClipboard }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!text || copied) return;
    try {
      await writeClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [copied, text, writeClipboard]);

  if (!text) return null;

  return (
    <button
      type="button"
      className="ai-chat-copy-button"
      onClick={handleCopy}
      title={copied ? "Copied!" : "Copy message"}
    >
      {copied ? <CheckOutlined /> : <CopyOutlined />}
    </button>
  );
}

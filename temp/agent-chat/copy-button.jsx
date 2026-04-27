import { CopyOutlined, CheckOutlined } from "@ant-design/icons";
import { useState, useCallback } from "react";

const CopyButton = ({ text }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = useCallback(async () => {
        if (!text || copied) return;

        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard API not available - silently fail
        }
    }, [text, copied]);

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
};

export default CopyButton;

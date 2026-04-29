import MarkdownText from "./markdown-text.jsx";
import { getAvatarThemeFromLabel, getDisplayLabel } from "./chat-ui-utils.js";
import { estimateBase64Bytes, formatBytes, imageSrc } from "./media-utils.js";

const GUEST_USER_NAME = "Guest";

export function MessageContent({ text, images }) {
  return (
    <div className="ai-chat-message-content">
      {text ? <MarkdownText text={text} /> : null}
      <ImageAttachmentGrid images={images} />
    </div>
  );
}

export function ImageAttachmentGrid({ images }) {
  if (!images || images.length === 0) return null;
  return (
    <div className="ai-chat-attachment-body">
      {images.map((image, index) => (
        <figure className="ai-chat-attachment-row" key={String(index) + ":" + (image.name || image.mediaType || "")}>
          <div className="ai-chat-attachment-thumb">
            <img src={imageSrc(image)} alt={image.name || image.mediaType || "Image attachment"} />
          </div>
          <figcaption className="ai-chat-attachment-note">
            {[image.name || image.mediaType, formatBytes(image.size || image.sizeBytes || estimateBase64Bytes(image.dataBase64))].filter(Boolean).join(" · ")}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

export function BubbleHeader({ label, meta, timeFirst }) {
  const labelEl = <span key="label">{label}</span>;
  const metaEl = meta ? <small key="meta">{meta}</small> : null;
  return (
    <div className="ai-chat-bubble-header-inline">
      {timeFirst ? <>{metaEl}{labelEl}</> : <>{labelEl}{metaEl}</>}
    </div>
  );
}

export function AssistantAvatar() {
  return <div className="ai-chat-avatar">🤖</div>;
}

export function UserAvatar({ label }) {
  const display = getDisplayLabel(label || GUEST_USER_NAME);
  const theme = getAvatarThemeFromLabel(display);
  return (
    <div className="ai-chat-avatar ai-chat-avatar-user" style={{ background: theme.bg, color: theme.fg }}>
      {initialsFromName(display)}
    </div>
  );
}

function initialsFromName(value) {
  const words = getDisplayLabel(value)
    .split(/\s+/)
    .filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0] || GUEST_USER_NAME];
  return letters
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

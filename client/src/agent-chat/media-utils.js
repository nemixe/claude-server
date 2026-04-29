export function extractImageBlocks(value) {
  const images = [];
  const seen = new Set();

  function visit(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    if (node.type === "image" && node.source && node.source.type === "base64" && node.source.data && node.source.media_type) {
      const key = node.source.media_type + ":" + String(node.source.data).slice(0, 40);
      if (!seen.has(key)) {
        seen.add(key);
        images.push({
          mediaType: node.source.media_type,
          dataBase64: node.source.data,
          size: estimateBase64Bytes(node.source.data)
        });
      }
    }

    if (node.mediaType && node.dataBase64) {
      const key = node.mediaType + ":" + String(node.dataBase64).slice(0, 40);
      if (!seen.has(key)) {
        seen.add(key);
        images.push({
          name: node.name,
          mediaType: node.mediaType,
          dataBase64: node.dataBase64,
          size: node.size || estimateBase64Bytes(node.dataBase64)
        });
      }
    }

    Object.values(node).forEach(visit);
  }

  visit(value);
  return images;
}

export function redactImageData(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactImageData);

  const copy = {};
  Object.entries(value).forEach(([key, item]) => {
    if ((key === "data" || key === "dataBase64") && typeof item === "string" && item.length > 80) {
      copy[key] = "[base64 image data redacted, " + formatBytes(estimateBase64Bytes(item)) + "]";
    } else {
      copy[key] = redactImageData(item);
    }
  });
  return copy;
}

export function imageSrc(image) {
  if (image.previewUrl) return image.previewUrl;
  if (image.url) return image.url;
  if (image.dataBase64 && image.mediaType) return "data:" + image.mediaType + ";base64," + image.dataBase64;
  return "";
}

export function estimateBase64Bytes(value) {
  if (!value) return 0;
  const clean = String(value).replace(/^data:image\/[^;]+;base64,/i, "").replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

export function formatBytes(value) {
  if (!Number.isFinite(value)) return "";
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  return (value / (1024 * 1024)).toFixed(1) + " MB";
}

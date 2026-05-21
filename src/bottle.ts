import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AppConfig } from "./config.js";
import { AGENT_PROVIDERS, BOTTLE_PROTOCOL_VERSION, type BottleInfoResponse } from "./types.js";

export const BOTTLE_BASE_PATH = "/__bottle";
export const BOTTLE_API_PATH = `${BOTTLE_BASE_PATH}/v1`;
export const BRIDGE_PATH = `${BOTTLE_BASE_PATH}/bottle-bridge.js`;
export const IFRAME_PATH = `${BOTTLE_BASE_PATH}/iframe`;
const BOTTLE_BRIDGE_SCRIPT = `<script src="${BRIDGE_PATH}" data-bottle-bridge></script>`;
const IFRAME_ROUTE_BOOTSTRAP_MARKER = "data-bottle-iframe-route-bootstrap";
const IFRAME_ROUTE_BOOTSTRAP_SCRIPT = `<script ${IFRAME_ROUTE_BOOTSTRAP_MARKER}>(() => {
  const iframePath = ${JSON.stringify(IFRAME_PATH)};
  function createMemoryStorage() {
    const values = new Map();
    return {
      get length() {
        return values.size;
      },
      clear() {
        values.clear();
      },
      getItem(key) {
        const normalizedKey = String(key);
        return values.has(normalizedKey) ? values.get(normalizedKey) : null;
      },
      key(index) {
        return Array.from(values.keys())[Number(index)] ?? null;
      },
      removeItem(key) {
        values.delete(String(key));
      },
      setItem(key, value) {
        values.set(String(key), String(value));
      }
    };
  }
  function storageAvailable(name) {
    try {
      const storage = window[name];
      const probeKey = "__bottle_storage_probe__";
      storage.setItem(probeKey, "1");
      storage.removeItem(probeKey);
      return true;
    } catch {
      return false;
    }
  }
  function installStorageFallback(name) {
    if (storageAvailable(name)) return;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        value: createMemoryStorage()
      });
    } catch {
      // Some browsers expose an unconfigurable Storage getter. Keep booting; the Host App may still avoid storage access.
    }
  }
  installStorageFallback("localStorage");
  installStorageFallback("sessionStorage");
  const currentPath = window.location.pathname;
  let routePath = currentPath || "/";
  if (currentPath === iframePath) {
    routePath = "/";
  } else if (currentPath.startsWith(iframePath + "/")) {
    routePath = currentPath.slice(iframePath.length) || "/";
  }
  const route = routePath + window.location.search + window.location.hash;
  window.__bottleIframeRoute = route;
  if (route !== window.location.pathname + window.location.search + window.location.hash) {
    window.history.replaceState(window.history.state, "", route);
  }
})();</script>`;
const PINGGY_NO_SCREEN_HEADER = "x-pinggy-no-screen";
const FORWARDED_IFRAME_REQUEST_HEADERS = ["accept", "accept-language", "cookie", "user-agent"] as const;

export function createClientAccessMiddleware(config: AppConfig): MiddlewareHandler {
  return async (c, next) => {
    if (isBottleApiRequest(c.req.url)) {
      c.header("Vary", "Origin");
      c.header("Cache-Control", "no-store");
    }

    const origin = c.req.header("origin");
    if (origin && isAllowedClientOrigin(origin, config.clientOrigins)) {
      c.header("Access-Control-Allow-Origin", new URL(origin).origin);
      c.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      c.header("Access-Control-Allow-Headers", "content-type, authorization, x-bottle-api-token, x-pinggy-no-screen");
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Access-Control-Max-Age", "86400");
      c.header("Vary", "Origin");
    }

    c.header("Content-Security-Policy", frameAncestorsPolicy(config.clientOrigins));

    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }

    await next();
  };
}

function isBottleApiRequest(requestUrl: string): boolean {
  try {
    const { pathname } = new URL(requestUrl);
    return pathname === BOTTLE_API_PATH || pathname.startsWith(`${BOTTLE_API_PATH}/`);
  } catch {
    return false;
  }
}

export function createBottleAuthMiddleware(config: AppConfig): MiddlewareHandler {
  return async (c, next) => {
    if (!config.bottleApiToken) {
      await next();
      return;
    }

    const authorization = c.req.header("authorization") ?? "";
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    const headerToken = c.req.header("x-bottle-api-token");
    if (bearer === config.bottleApiToken || headerToken === config.bottleApiToken) {
      await next();
      return;
    }

    return c.json({ error: { code: "unauthorized", message: "Bottle API token is required" } }, 401);
  };
}

export function bottleInfoForRequest(config: AppConfig, requestUrl: string, headers?: Headers): BottleInfoResponse {
  const hostAppOrigin = requestOrigin(requestUrl, headers);

  return {
    protocolVersion: BOTTLE_PROTOCOL_VERSION,
    name: config.bottleName,
    hostAppOrigin,
    defaultAgentProvider: config.defaultAgentProvider,
    availableAgentProviders: [...AGENT_PROVIDERS],
    features: {
      iframeBridge: true,
      sessions: true,
      streaming: true,
      settings: true,
      agents: true,
      commands: true,
      rules: true,
      skills: true,
      workspaceSearch: true,
      authToken: Boolean(config.bottleApiToken)
    }
  };
}

export function registerBottleRoutes(app: Hono, _config: AppConfig): void {
  app.get(BRIDGE_PATH, (c) => {
    return c.body(renderBottleBridgeScript(), 200, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store"
    });
  });

  const serveIframe = (c: Context) => serveIframeApp(c);
  app.get(IFRAME_PATH, serveIframe);
  app.get(`${IFRAME_PATH}/*`, serveIframe);
}

function isAllowedClientOrigin(origin: string, allowedOrigins: string[]): boolean {
  try {
    return allowedOrigins.includes(new URL(origin).origin);
  } catch {
    return false;
  }
}

function frameAncestorsPolicy(clientOrigins: string[]): string {
  const ancestors = ["'self'", ...clientOrigins].join(" ");
  return `frame-ancestors ${ancestors}`;
}

async function serveIframeApp(c: Context): Promise<Response> {
  const targetUrl = iframeTargetUrl(c.req.url, c.req.raw.headers);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(targetUrl.href, {
      headers: forwardedIframeHeaders(c.req.raw.headers)
    });
  } catch {
    return c.json(
      {
        error: {
          code: "main_app_fetch_failed",
          message: "Failed to fetch the detected Host App URL."
        }
      },
      502
    );
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? "";
  const responseText = await upstreamResponse.text();
  if (!contentType.toLowerCase().includes("text/html")) {
    return new Response(responseText, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: passthroughIframeHeaders(upstreamResponse.headers)
    });
  }

  return new Response(injectBottleBridge(injectIframeRouteBootstrap(responseText)), {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: {
      "content-type": contentType || "text/html; charset=utf-8",
      "cache-control": "no-cache"
    }
  });
}

function iframeTargetUrl(requestUrl: string, requestHeaders: Headers): URL {
  const request = new URL(requestUrl);
  const target = new URL(requestOrigin(requestUrl, requestHeaders));
  const iframePath = request.pathname === IFRAME_PATH ? "/" : request.pathname.slice(IFRAME_PATH.length) || "/";

  target.pathname = joinPaths(target.pathname, iframePath);
  target.search = request.search;
  target.hash = "";
  return target;
}

function requestOrigin(requestUrl: string, requestHeaders?: Headers): string {
  const request = new URL(requestUrl);
  const forwardedHost = firstHeaderValue(requestHeaders?.get("x-forwarded-host"));
  const host = forwardedHost ?? firstHeaderValue(requestHeaders?.get("host")) ?? request.host;
  const forwardedProto = firstHeaderValue(requestHeaders?.get("x-forwarded-proto"));
  const protocol = forwardedProto ?? request.protocol.replace(/:$/, "");
  return `${protocol}://${host}`;
}

function firstHeaderValue(value: string | null | undefined): string | undefined {
  return value
    ?.split(",")
    .map((entry) => entry.trim())
    .find(Boolean);
}

function joinPaths(basePath: string, requestPath: string): string {
  const normalizedBase = basePath.replace(/\/+$/, "");
  const normalizedRequest = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  if (!normalizedBase || normalizedBase === "/") return normalizedRequest;
  return `${normalizedBase}${normalizedRequest}`;
}

function forwardedIframeHeaders(requestHeaders: Headers): Headers {
  const headers = new Headers();
  for (const headerName of FORWARDED_IFRAME_REQUEST_HEADERS) {
    const value = requestHeaders.get(headerName);
    if (value) headers.set(headerName, value);
  }
  headers.set(PINGGY_NO_SCREEN_HEADER, requestHeaders.get(PINGGY_NO_SCREEN_HEADER) || "1");
  return headers;
}

function passthroughIframeHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers();
  for (const headerName of ["content-type", "location"] as const) {
    const value = upstreamHeaders.get(headerName);
    if (value) headers.set(headerName, value);
  }
  headers.set("cache-control", "no-cache");
  return headers;
}

function injectIframeRouteBootstrap(html: string): string {
  if (html.includes(IFRAME_ROUTE_BOOTSTRAP_MARKER)) {
    return html;
  }
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (match) => `${match}${IFRAME_ROUTE_BOOTSTRAP_SCRIPT}`);
  }
  if (/<body\b[^>]*>/i.test(html)) {
    return html.replace(/<body\b[^>]*>/i, (match) => `${match}${IFRAME_ROUTE_BOOTSTRAP_SCRIPT}`);
  }
  return `${IFRAME_ROUTE_BOOTSTRAP_SCRIPT}${html}`;
}

function injectBottleBridge(html: string): string {
  if (html.includes("data-bottle-bridge") || html.includes(BRIDGE_PATH)) {
    return html;
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${BOTTLE_BRIDGE_SCRIPT}</head>`);
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${BOTTLE_BRIDGE_SCRIPT}</body>`);
  }
  return `${html}${BOTTLE_BRIDGE_SCRIPT}`;
}

function renderBottleBridgeScript(): string {
  return `(() => {
  const protocolVersion = ${BOTTLE_PROTOCOL_VERSION};
  const source = "bottle";

  function post(message) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ source, ...message }, "*");
    }
  }

  function selectedElementHint() {
    const selection = window.getSelection && window.getSelection();
    if (!selection || selection.rangeCount === 0) return undefined;
    const node = selection.anchorNode && (selection.anchorNode.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode
      : selection.anchorNode.parentElement);
    if (!node) return undefined;
    const element = node.closest("[data-ai-label], [aria-label], button, a, input, textarea, select, [role]");
    if (!element) return undefined;
    return element.getAttribute("data-ai-label") ||
      element.getAttribute("aria-label") ||
      element.getAttribute("role") ||
      element.tagName.toLowerCase();
  }

  function currentContext() {
    const selection = window.getSelection && window.getSelection();
    const selectedText = selection ? String(selection).trim().slice(0, 4000) : "";
    const currentUrl = new URL(window.location.href);
    return {
      url: currentUrl.href,
      route: currentUrl.pathname + currentUrl.search + currentUrl.hash,
      title: document.title,
      selectedText: selectedText || undefined,
      selectedElement: selectedElementHint(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      }
    };
  }

  function ready() {
    post({ type: "bottle:ready", protocolVersion, appName: document.title || undefined });
  }

  function navigation() {
    post({ type: "bottle:navigation", url: window.location.href, title: document.title || undefined });
  }

  function screenshotErrorMessage(error) {
    if (error && typeof error.message === "string" && error.message) return error.message;
    return "Screenshot capture failed";
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Screenshot image failed to load"));
      image.src = src;
    });
  }

  async function svgToPngDataUrl(svg, width, height) {
    const blobUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    try {
      const image = await loadImage(blobUrl);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not create screenshot canvas");
      context.drawImage(image, 0, 0, width, height);
      return canvas.toDataURL("image/png");
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  function visibleArea(element) {
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    return Math.max(0, right - left) * Math.max(0, bottom - top);
  }

  function isScrolledElement(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element === document.documentElement || element === document.body) return false;
    if (element.scrollTop <= 0 && element.scrollLeft <= 0) return false;

    const style = window.getComputedStyle(element);
    const canScrollY =
      element.scrollHeight > element.clientHeight + 1 &&
      /auto|scroll|overlay/i.test(style.overflowY || style.overflow);
    const canScrollX =
      element.scrollWidth > element.clientWidth + 1 &&
      /auto|scroll|overlay/i.test(style.overflowX || style.overflow);

    return (canScrollY || canScrollX) && visibleArea(element) > 0;
  }

  function scrolledElements(root) {
    const originalElements = Array.from(root.querySelectorAll("*"));
    return originalElements
      .map((element, index) => ({
        element,
        index,
        area: visibleArea(element),
        scrollLeft: Math.max(0, Math.round(element.scrollLeft || 0)),
        scrollTop: Math.max(0, Math.round(element.scrollTop || 0))
      }))
      .filter((entry) => isScrolledElement(entry.element))
      .sort((a, b) => b.area - a.area);
  }

  function applyScrolledElementOffsets(clone, scrollContainers) {
    const clonedElements = Array.from(clone.querySelectorAll("*"));

    scrollContainers.forEach(({ element, index, scrollLeft, scrollTop }) => {
      const clonedElement = clonedElements[index];
      if (!clonedElement || !clonedElement.style) return;

      const clonedChildren = Array.from(clonedElement.children).filter((child) => child instanceof HTMLElement);
      if (!clonedChildren.length) return;

      clonedElement.style.overflow = "hidden";
      clonedElement.style.overflowX = "hidden";
      clonedElement.style.overflowY = "hidden";

      clonedChildren.forEach((child, childIndex) => {
        const originalChild = element.children[childIndex];
        const computedTransform = originalChild ? window.getComputedStyle(originalChild).transform : "";
        const existingTransform =
          originalChild?.style?.transform || (computedTransform && computedTransform !== "none" ? computedTransform : "");
        child.style.transform = ["translate(" + -scrollLeft + "px, " + -scrollTop + "px)", existingTransform]
          .filter(Boolean)
          .join(" ");
        child.style.transformOrigin = "top left";
      });
    });
  }

  function freezeScrolledElement({ element, scrollLeft, scrollTop }) {
    const children = Array.from(element.children).filter((child) => child instanceof HTMLElement);
    if (!children.length) return () => {};

    const elementStyle = {
      overflow: element.style.overflow,
      overflowX: element.style.overflowX,
      overflowY: element.style.overflowY
    };
    const childStyles = children.map((child) => ({
      child,
      transform: child.style.transform,
      transformOrigin: child.style.transformOrigin
    }));
    const offsetTransform = "translate(" + -scrollLeft + "px, " + -scrollTop + "px)";

    element.style.overflow = "hidden";
    element.style.overflowX = "hidden";
    element.style.overflowY = "hidden";

    children.forEach((child) => {
      const computedTransform = window.getComputedStyle(child).transform;
      const existingTransform =
        child.style.transform || (computedTransform && computedTransform !== "none" ? computedTransform : "");
      child.style.transform = [offsetTransform, existingTransform].filter(Boolean).join(" ");
      child.style.transformOrigin = "top left";
    });

    return () => {
      element.style.overflow = elementStyle.overflow;
      element.style.overflowX = elementStyle.overflowX;
      element.style.overflowY = elementStyle.overflowY;
      childStyles.forEach(({ child, transform, transformOrigin }) => {
        child.style.transform = transform;
        child.style.transformOrigin = transformOrigin;
      });
    };
  }

  function freezeScrolledElements(scrollContainers) {
    const restoreFns = scrollContainers.map(freezeScrolledElement);
    return () => {
      restoreFns.reverse().forEach((restore) => restore());
    };
  }

  async function loadHtmlToImageRenderer() {
    if (window.htmlToImage && typeof window.htmlToImage.toPng === "function") {
      return window.htmlToImage;
    }

    const candidates = [
      "/node_modules/.vite/deps/html-to-image.js",
      "/node_modules/html-to-image/es/index.js"
    ];

    for (const candidate of candidates) {
      try {
        const module = await import(candidate);
        if (module && typeof module.toPng === "function") return module;
      } catch {
        // Try the next known development-server path.
      }
    }

    return null;
  }

  async function captureWithHtmlToImage(root, body, metrics, scrollContainers) {
    const renderer = await loadHtmlToImageRenderer();
    if (!renderer) return null;

    const restoreScrolledElements = freezeScrolledElements(scrollContainers);
    try {
      const dataUrl = await renderer.toPng(root, {
        cacheBust: true,
        skipAutoScale: true,
        width: metrics.width,
        height: metrics.height,
        style: {
          transform: "translate(" + -metrics.scrollX + "px, " + -metrics.scrollY + "px)",
          transformOrigin: "top left",
          width: Math.max(metrics.width + metrics.scrollX, root.scrollWidth || 0, body?.scrollWidth || 0) + "px",
          minHeight: Math.max(metrics.height + metrics.scrollY, root.scrollHeight || 0, body?.scrollHeight || 0) + "px"
        }
      });

      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return null;
      return {
        dataUrl,
        viewport: { width: metrics.width, height: metrics.height },
        scroll: {
          x: scrollContainers[0]?.scrollLeft ?? metrics.scrollX,
          y: scrollContainers[0]?.scrollTop ?? metrics.scrollY
        }
      };
    } catch {
      return null;
    } finally {
      restoreScrolledElements();
    }
  }

  async function captureScreenshot() {
    const root = document.documentElement;
    const body = document.body;
    const width = Math.max(1, Math.round(window.innerWidth || root.clientWidth || 1));
    const height = Math.max(1, Math.round(window.innerHeight || root.clientHeight || 1));
    const scrollX = Math.max(0, Math.round(window.scrollX || root.scrollLeft || body?.scrollLeft || 0));
    const scrollY = Math.max(0, Math.round(window.scrollY || root.scrollTop || body?.scrollTop || 0));

    if (typeof window.__bottleCaptureScreenshot === "function") {
      try {
        const hostScreenshot = await window.__bottleCaptureScreenshot({ width, height, scrollX, scrollY });
        if (typeof hostScreenshot === "string" && hostScreenshot.startsWith("data:image/")) {
          return { dataUrl: hostScreenshot, viewport: { width, height }, scroll: { x: scrollX, y: scrollY } };
        }
        if (hostScreenshot && typeof hostScreenshot.dataUrl === "string" && hostScreenshot.dataUrl.startsWith("data:image/")) {
          return {
            dataUrl: hostScreenshot.dataUrl,
            viewport: hostScreenshot.viewport || { width, height },
            scroll: hostScreenshot.scroll || { x: scrollX, y: scrollY }
          };
        }
      } catch {
        // Fall through to the generic DOM clone renderer.
      }
    }

    const scrollContainers = scrolledElements(root);
    const htmlToImageScreenshot = await captureWithHtmlToImage(root, body, { width, height, scrollX, scrollY }, scrollContainers);
    if (htmlToImageScreenshot) return htmlToImageScreenshot;

    const clone = root.cloneNode(true);
    applyScrolledElementOffsets(clone, scrollContainers);

    clone.querySelectorAll("script,noscript,[data-bottle-bridge]").forEach((node) => node.remove());

    const head = clone.querySelector("head");
    if (head) {
      const base = document.createElement("base");
      base.href = window.location.href;
      head.prepend(base);
    }

    const clonedBody = clone.querySelector("body");
    if (clonedBody) {
      clonedBody.style.transform = "translate(" + -scrollX + "px, " + -scrollY + "px)";
      clonedBody.style.transformOrigin = "top left";
      clonedBody.style.width = Math.max(width + scrollX, root.scrollWidth || 0, body?.scrollWidth || 0) + "px";
      clonedBody.style.minHeight = Math.max(height + scrollY, root.scrollHeight || 0, body?.scrollHeight || 0) + "px";
    }

    const serializedHtml = new XMLSerializer().serializeToString(clone);
    const svg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + " " + height + '">',
      '<foreignObject width="100%" height="100%" x="0" y="0">',
      serializedHtml,
      "</foreignObject>",
      "</svg>"
    ].join("");

    return {
      dataUrl: await svgToPngDataUrl(svg, width, height),
      viewport: { width, height },
      scroll: {
        x: scrollContainers[0]?.scrollLeft ?? scrollX,
        y: scrollContainers[0]?.scrollTop ?? scrollY
      }
    };
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.protocolVersion && message.protocolVersion !== protocolVersion) return;
    if (message.type === "ai-client:hello") ready();
    if (message.type === "ai-client:request-context") {
      post({ type: "bottle:context", requestId: message.requestId, context: currentContext() });
    }
    if (message.type === "ai-client:request-screenshot") {
      captureScreenshot()
        .then((screenshot) => {
          post({ type: "bottle:screenshot", protocolVersion, requestId: message.requestId, ...screenshot });
        })
        .catch((error) => {
          post({ type: "bottle:screenshot", protocolVersion, requestId: message.requestId, error: screenshotErrorMessage(error) });
        });
    }
  });

  for (const eventName of ["hashchange", "popstate"]) {
    window.addEventListener(eventName, navigation);
  }

  for (const methodName of ["pushState", "replaceState"]) {
    const original = window.history[methodName];
    window.history[methodName] = function patchedHistoryMethod() {
      const result = original.apply(this, arguments);
      window.setTimeout(navigation, 0);
      return result;
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ready, { once: true });
  } else {
    ready();
  }
})();`;
}

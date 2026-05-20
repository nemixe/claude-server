import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AppConfig } from "./config.js";
import { AGENT_PROVIDERS, BOTTLE_PROTOCOL_VERSION, type BottleInfoResponse } from "./types.js";

export const BOTTLE_BASE_PATH = "/__bottle";
export const BOTTLE_API_PATH = `${BOTTLE_BASE_PATH}/v1`;
export const BRIDGE_PATH = `${BOTTLE_BASE_PATH}/bottle-bridge.js`;
export const IFRAME_PATH = `${BOTTLE_BASE_PATH}/iframe`;
const BOTTLE_BRIDGE_SCRIPT = `<script src="${BRIDGE_PATH}" data-bottle-bridge></script>`;
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

  return new Response(injectBottleBridge(responseText), {
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

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.protocolVersion && message.protocolVersion !== protocolVersion) return;
    if (message.type === "ai-client:hello") ready();
    if (message.type === "ai-client:request-context") {
      post({ type: "bottle:context", requestId: message.requestId, context: currentContext() });
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

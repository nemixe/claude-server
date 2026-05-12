import type { Hono, MiddlewareHandler } from "hono";
import type { AppConfig } from "./config.js";
import { APP_PROXY_PATH, hasTargetAppUrlCookie, isDirectMainAppGateway } from "./gateway.js";
import { AGENT_PROVIDERS, BOTTLE_PROTOCOL_VERSION, type BottleInfoResponse } from "./types.js";

const BRIDGE_PATH = "/bottle-bridge.js";

export function createClientAccessMiddleware(config: AppConfig): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && isAllowedClientOrigin(origin, config.clientOrigins)) {
      c.header("Access-Control-Allow-Origin", new URL(origin).origin);
      c.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      c.header("Access-Control-Allow-Headers", "content-type, authorization, x-bottle-api-token");
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
  const origin = new URL(requestUrl).origin;
  const isGatewayProxyEnabled = Boolean(config.mainAppProxy && config.mainAppUrl);
  const isDirectMainApp = isDirectMainAppGateway(config);
  const isConditionalRootClient = isDirectMainApp && !hasTargetAppUrlCookie(headers);
  const isClientAtRoot = isGatewayProxyEnabled && (!isDirectMainApp || isConditionalRootClient);
  const publicMainAppUrl = isDirectMainApp ? origin : config.mainAppUrl;
  const appUrl = isDirectMainApp
    ? isConditionalRootClient
      ? undefined
      : `${origin}/`
    : isClientAtRoot
    ? undefined
    : isGatewayProxyEnabled
      ? `${origin}/`
      : config.mainAppUrl;
  const appProxyUrl = isGatewayProxyEnabled && !isDirectMainApp ? `${origin}${APP_PROXY_PATH}/` : undefined;

  return {
    protocolVersion: BOTTLE_PROTOCOL_VERSION,
    name: config.bottleName,
    apiBaseUrl: origin,
    ...(appUrl ? { appUrl } : {}),
    ...(publicMainAppUrl ? { mainAppUrl: publicMainAppUrl } : {}),
    ...(appProxyUrl ? { appProxyUrl } : {}),
    defaultAgentProvider: config.defaultAgentProvider,
    availableAgentProviders: [...AGENT_PROVIDERS],
    features: {
      mainApp: Boolean(config.mainAppUrl),
      mainAppProxy: isGatewayProxyEnabled,
      mainAppDirect: isDirectMainApp,
      clientAtRoot: isClientAtRoot,
      iframeBridge: true,
      sessions: true,
      streaming: true,
      settings: true,
      claudeCommands: true,
      agents: true,
      commands: true,
      rules: true,
      skills: true,
      workspaceSearch: true,
      authToken: Boolean(config.bottleApiToken)
    }
  };
}

export function registerBottleRoutes(app: Hono): void {
  app.get(BRIDGE_PATH, (c) => {
    return c.body(renderBottleBridgeScript(), 200, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store"
    });
  });
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

function renderBottleBridgeScript(): string {
  return `(() => {
  const protocolVersion = ${BOTTLE_PROTOCOL_VERSION};
  const source = "bottle";
  const config = window.__BOTTLE_BRIDGE_CONFIG__ || {};

  function post(message) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ source, ...message }, "*");
    }
  }

  function normalizeUrl(value) {
    try {
      return new URL(value, window.location.href);
    } catch {
      return null;
    }
  }

  function normalizePathPrefix(value) {
    const raw = String(value || "").replace(/\\/+$/, "");
    return raw && raw !== "/" ? raw : "";
  }

  function joinPath(basePath, requestPath) {
    const base = normalizePathPrefix(basePath);
    const path = String(requestPath || "/").startsWith("/") ? String(requestPath || "/") : "/" + requestPath;
    return (base + path) || "/";
  }

  function pathWithoutBase(pathname, basePath) {
    const base = normalizePathPrefix(basePath);
    if (!base) return pathname || "/";
    if (pathname === base) return "/";
    if (pathname.startsWith(base + "/")) return pathname.slice(base.length) || "/";
    return pathname || "/";
  }

  function isInsideProxy(url) {
    const proxyPath = normalizePathPrefix(config.appProxyPath || "/__app");
    return Boolean(proxyPath && (url.pathname === proxyPath || url.pathname.startsWith(proxyPath + "/")));
  }

  function canonicalUrl(value) {
    const url = normalizeUrl(value || window.location.href);
    if (!url) return String(value || "");
    const mainAppUrl = normalizeUrl(config.mainAppUrl || "");
    if (!mainAppUrl || !isInsideProxy(url)) return url.href;
    const next = new URL(mainAppUrl.href);
    next.pathname = joinPath(mainAppUrl.pathname, pathWithoutBase(url.pathname, config.appProxyPath || "/__app"));
    next.search = url.search;
    next.hash = url.hash;
    return next.href;
  }

  function proxiedHistoryUrl(value) {
    if (value === undefined || value === null || !config.appProxyPath || !isInsideProxy(window.location)) return value;
    const url = normalizeUrl(value);
    if (!url) return value;
    if (isInsideProxy(url)) return url.pathname + url.search + url.hash;
    if (url.origin === window.location.origin) {
      return joinPath(config.appProxyPath, url.pathname) + url.search + url.hash;
    }
    const mainAppUrl = normalizeUrl(config.mainAppUrl || "");
    if (mainAppUrl && url.origin === mainAppUrl.origin) {
      return joinPath(config.appProxyPath, pathWithoutBase(url.pathname, mainAppUrl.pathname)) + url.search + url.hash;
    }
    return value;
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
    const currentUrl = new URL(canonicalUrl());
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
    post({ type: "bottle:navigation", url: canonicalUrl(), title: document.title || undefined });
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
      const args = Array.prototype.slice.call(arguments);
      if (args.length >= 3) args[2] = proxiedHistoryUrl(args[2]);
      const result = original.apply(this, args);
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

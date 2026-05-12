import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import type { Hono } from "hono";
import type { AppConfig } from "./config.js";

export const APP_PROXY_PATH = "/__app";
const LEGACY_AI_CLIENT_PATH = "/__ai_client";
export const TARGET_APP_URL_COOKIE_NAME = "bottle_target_app_url";

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
];

const RESPONSE_HEADERS_TO_DROP = [
  "content-length",
  "content-encoding",
  "content-security-policy",
  "x-frame-options"
];

type GatewayProxyKind = "client" | "mainApp";

type GatewayProxyTarget = {
  kind: GatewayProxyKind;
  url: URL;
  isAppProxy?: boolean;
};

type UpgradeServer = {
  on(event: "upgrade", listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown;
};

export function registerGatewayRoutes(app: Hono, config: AppConfig): void {
  app.all("*", async (c) => {
    const target = resolveGatewayProxyTarget(config, c.req.url, c.req.raw.headers);
    if (!target) return c.notFound();
    return proxyHttpRequest(c.req.raw, target, new URL(c.req.url).origin, config);
  });
}

export function installGatewayUpgradeProxy(server: UpgradeServer, config: AppConfig): void {
  if (!isGatewayEnabled(config)) return;

  server.on("upgrade", (request, socket, head) => {
    const requestUrl = absoluteRequestUrl(request);
    const target = requestUrl ? resolveGatewayProxyTarget(config, requestUrl, request.headers) : null;
    if (!target) {
      socket.destroy();
      return;
    }

    proxyUpgradeRequest(request, socket, head, target.url);
  });
}

export function resolveGatewayProxyTarget(
  config: AppConfig,
  requestUrl: string,
  headers?: Headers | IncomingHttpHeaders
): GatewayProxyTarget | null {
  if (!isGatewayEnabled(config)) return null;

  const incoming = new URL(requestUrl);
  if (isReservedPath(incoming.pathname)) return null;
  if (isPathWithinPrefix(incoming.pathname, LEGACY_AI_CLIENT_PATH)) return null;

  if (isDirectMainAppGateway(config)) {
    if (!hasTargetAppUrlCookie(headers)) {
      if (!config.clientAppUrl) return null;
      return {
        kind: "client",
        url: buildTargetUrl(config.clientAppUrl, incoming.pathname, incoming.search)
      };
    }

    if (isPathWithinPrefix(incoming.pathname, APP_PROXY_PATH)) {
      if (!config.mainAppUrl) return null;
      return {
        kind: "mainApp",
        url: buildTargetUrl(config.mainAppUrl, stripPathPrefix(incoming.pathname, APP_PROXY_PATH), incoming.search),
        isAppProxy: true
      };
    }

    if (!config.mainAppUrl) return null;
    return {
      kind: "mainApp",
      url: buildTargetUrl(config.mainAppUrl, incoming.pathname, incoming.search)
    };
  }

  if (isPathWithinPrefix(incoming.pathname, APP_PROXY_PATH)) {
    if (!config.mainAppUrl) return null;
    return {
      kind: "mainApp",
      url: buildTargetUrl(config.mainAppUrl, stripPathPrefix(incoming.pathname, APP_PROXY_PATH), incoming.search),
      isAppProxy: true
    };
  }

  if (shouldProxyRootAbsoluteAppRequest(headers) && config.mainAppUrl) {
    return {
      kind: "mainApp",
      url: buildTargetUrl(config.mainAppUrl, incoming.pathname, incoming.search),
      isAppProxy: true
    };
  }

  if (!config.clientAppUrl) return null;
  return {
    kind: "client",
    url: buildTargetUrl(config.clientAppUrl, incoming.pathname, incoming.search)
  };
}

function isGatewayEnabled(config: AppConfig): boolean {
  return Boolean(config.mainAppProxy && config.mainAppUrl);
}

export function isDirectMainAppGateway(config: AppConfig): boolean {
  return Boolean(config.mainAppProxy && config.mainAppUrl && config.mainAppDirect);
}

export function hasTargetAppUrlCookie(headers?: Headers | IncomingHttpHeaders): boolean {
  const cookieHeader = getHeader(headers, "cookie") ?? "";
  const encodedName = encodeURIComponent(TARGET_APP_URL_COOKIE_NAME);
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .some((part) => part.startsWith(`${encodedName}=`) && part.slice(encodedName.length + 1).trim().length > 0);
}

function isReservedPath(pathname: string): boolean {
  return (
    pathname === "/health" ||
    pathname === "/bottle-bridge.js" ||
    pathname === "/v1" ||
    pathname.startsWith("/v1/")
  );
}

function isPathWithinPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/") return true;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function stripPathPrefix(pathname: string, prefix: string): string {
  if (pathname === prefix) return "/";
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length) || "/";
  return pathname || "/";
}

function shouldProxyRootAbsoluteAppRequest(headers?: Headers | IncomingHttpHeaders): boolean {
  const referer = getHeader(headers, "referer") ?? getHeader(headers, "referrer");
  if (!referer) return false;
  try {
    const pathname = new URL(referer).pathname;
    if (!isPathWithinPrefix(pathname, APP_PROXY_PATH)) return false;
    const destination = getHeader(headers, "sec-fetch-dest") ?? "";
    const accept = getHeader(headers, "accept") ?? "";
    return destination !== "document" && !accept.toLowerCase().includes("text/html");
  } catch {
    return false;
  }
}

function getHeader(headers: Headers | IncomingHttpHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function buildTargetUrl(baseUrl: string, pathname: string, search: string): URL {
  const target = new URL(baseUrl);
  target.pathname = joinUrlPath(target.pathname, pathname);
  target.search = search;
  return target;
}

function joinUrlPath(basePath: string, requestPath: string): string {
  const normalizedBase = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  const normalizedRequest = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
  return `${normalizedBase}${normalizedRequest}` || "/";
}

async function proxyHttpRequest(
  request: Request,
  target: GatewayProxyTarget,
  publicOrigin: string,
  config: AppConfig
): Promise<Response> {
  const headers = proxyRequestHeaders(request.headers, target.url);
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual"
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  const upstream = await fetch(target.url, init);
  const responseHeaders = proxyResponseHeaders(upstream.headers, target, publicOrigin, config);
  const contentType = upstream.headers.get("content-type") ?? "";

  if (target.kind === "mainApp" && contentType.toLowerCase().includes("text/html")) {
    const html = transformMainAppHtml(await upstream.text(), publicOrigin, config);
    responseHeaders.set("content-type", contentType || "text/html; charset=utf-8");
    return new Response(html, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}

function proxyRequestHeaders(headers: Headers, targetUrl: URL): Headers {
  const nextHeaders = new Headers(headers);
  for (const headerName of HOP_BY_HOP_HEADERS) {
    nextHeaders.delete(headerName);
  }
  nextHeaders.set("host", targetUrl.host);
  return nextHeaders;
}

function proxyResponseHeaders(
  headers: Headers,
  target: GatewayProxyTarget,
  publicOrigin: string,
  config: AppConfig
): Headers {
  const nextHeaders = new Headers(headers);
  for (const headerName of RESPONSE_HEADERS_TO_DROP) {
    nextHeaders.delete(headerName);
  }

  const location = nextHeaders.get("location");
  if (location) {
    nextHeaders.set("location", rewriteLocationHeader(location, target, publicOrigin, config));
  }

  return nextHeaders;
}

function rewriteLocationHeader(
  location: string,
  target: GatewayProxyTarget,
  publicOrigin: string,
  config: AppConfig
): string {
  try {
    const resolved = new URL(location, target.url);
    if (resolved.origin !== target.url.origin) return location;
    const publicUrl = new URL(publicOrigin);
    const relativePath = pathWithoutBase(resolved.pathname, new URL(target.kind === "client" ? config.clientAppUrl ?? target.url.origin : config.mainAppUrl ?? target.url.origin).pathname);
    publicUrl.pathname = target.kind === "client"
      ? resolved.pathname
      : target.isAppProxy
        ? joinUrlPath(APP_PROXY_PATH, relativePath)
        : relativePath;
    publicUrl.search = resolved.search;
    publicUrl.hash = resolved.hash;
    return publicUrl.href;
  } catch {
    return location;
  }
}

function pathWithoutBase(pathname: string, basePath: string): string {
  const normalizedBase = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  if (!normalizedBase) return pathname;
  if (pathname === normalizedBase) return "/";
  if (pathname.startsWith(`${normalizedBase}/`)) return pathname.slice(normalizedBase.length);
  return pathname;
}

function transformMainAppHtml(html: string, publicOrigin: string, config: AppConfig): string {
  const transformedHtml = isDirectMainAppGateway(config) ? html : rewriteRootAbsoluteHtmlUrls(html);
  return injectBottleBridge(transformedHtml, publicOrigin, config);
}

function rewriteRootAbsoluteHtmlUrls(html: string): string {
  const attributePattern = /(\s(?:src|href|action|poster)=)(["'])(\/(?!\/)[^"']*)\2/gi;
  const rewrittenAttributes = html.replace(attributePattern, (match, prefix: string, quote: string, value: string) => {
    if (!shouldRewriteRootAbsolutePath(value)) return match;
    return `${prefix}${quote}${APP_PROXY_PATH}${value}${quote}`;
  });

  const srcsetPattern = /(\ssrcset=)(["'])([^"']*)\2/gi;
  return rewrittenAttributes.replace(srcsetPattern, (_match, prefix: string, quote: string, value: string) => {
    const rewritten = value
      .split(",")
      .map((entry) => {
        const trimmed = entry.trim();
        const [url, ...descriptors] = trimmed.split(/\s+/);
        if (!shouldRewriteRootAbsolutePath(url)) return entry;
        const suffix = descriptors.length > 0 ? ` ${descriptors.join(" ")}` : "";
        return entry.replace(trimmed, `${APP_PROXY_PATH}${url}${suffix}`);
      })
      .join(",");
    return `${prefix}${quote}${rewritten}${quote}`;
  });
}

function shouldRewriteRootAbsolutePath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  return !(
    isPathWithinPrefix(value, APP_PROXY_PATH) ||
    isPathWithinPrefix(value, "/v1") ||
    value === "/health" ||
    value.startsWith("/health?") ||
    value === "/bottle-bridge.js" ||
    value.startsWith("/bottle-bridge.js?")
  );
}

function injectBottleBridge(html: string, publicOrigin: string, config: AppConfig): string {
  if (html.includes("data-bottle-bridge") || html.includes("/bottle-bridge.js")) return html;
  const bridgeConfig = isDirectMainAppGateway(config)
    ? {
        mainAppUrl: publicOrigin
      }
    : {
        appProxyPath: APP_PROXY_PATH,
        appProxyUrl: `${publicOrigin}${APP_PROXY_PATH}/`,
        mainAppUrl: config.mainAppUrl
      };
  const bridgeConfigScript = `<script>window.__BOTTLE_BRIDGE_CONFIG__=${JSON.stringify(bridgeConfig).replace(/</g, "\\u003c")};</script>`;
  const scriptTag = `${bridgeConfigScript}<script src="/bottle-bridge.js" data-bottle-bridge></script>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${scriptTag}</head>`);
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${scriptTag}</body>`);
  return `${html}${scriptTag}`;
}

function absoluteRequestUrl(request: IncomingMessage): string | null {
  const host = request.headers.host;
  if (!host || !request.url) return null;
  return `http://${host}${request.url}`;
}

function proxyUpgradeRequest(request: IncomingMessage, socket: Duplex, head: Buffer, targetUrl: URL): void {
  const proxyRequest = (targetUrl.protocol === "https:" ? https : http).request({
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port,
    method: request.method,
    path: `${targetUrl.pathname}${targetUrl.search}`,
    headers: {
      ...request.headers,
      host: targetUrl.host
    }
  });

  proxyRequest.on("upgrade", (proxyResponse, proxySocket, proxyHead) => {
    socket.write(`HTTP/${request.httpVersion} ${proxyResponse.statusCode} ${proxyResponse.statusMessage}\r\n`);
    for (let index = 0; index < proxyResponse.rawHeaders.length; index += 2) {
      socket.write(`${proxyResponse.rawHeaders[index]}: ${proxyResponse.rawHeaders[index + 1]}\r\n`);
    }
    socket.write("\r\n");

    if (proxyHead.length > 0) socket.write(proxyHead);
    if (head.length > 0) proxySocket.write(head);
    proxySocket.pipe(socket).pipe(proxySocket);
  });

  proxyRequest.on("response", (proxyResponse) => {
    socket.write(`HTTP/${request.httpVersion} ${proxyResponse.statusCode} ${proxyResponse.statusMessage}\r\n`);
    for (let index = 0; index < proxyResponse.rawHeaders.length; index += 2) {
      socket.write(`${proxyResponse.rawHeaders[index]}: ${proxyResponse.rawHeaders[index + 1]}\r\n`);
    }
    socket.write("\r\n");
    proxyResponse.pipe(socket);
  });

  proxyRequest.on("error", () => {
    socket.destroy();
  });

  socket.on("error", () => {
    proxyRequest.destroy();
  });

  proxyRequest.end();
}

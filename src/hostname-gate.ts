import type { Context, MiddlewareHandler } from "hono";
import type { AppConfig } from "./config.js";
import { getEffectiveHost, isAllowedHost, parseHostLike, parseOrigin } from "./hostname.js";

export function createHostnameGate(config: AppConfig): MiddlewareHandler {
  return async (c, next) => {
    const host = parseHostLike(getEffectiveHost(c.req.raw.headers, config.trustProxy));
    if (!isAllowedHost(host, config.allowedHosts)) {
      return c.json({ error: { code: "host_not_allowed", message: "Request host is not allowed" } }, 403);
    }

    const originHeader = c.req.header("origin");
    if (originHeader) {
      const origin = parseOrigin(originHeader);
      if (!isAllowedHost(origin, config.allowedHosts)) {
        return c.json({ error: { code: "origin_not_allowed", message: "Request origin is not allowed" } }, 403);
      }

      setCorsHeaders(c, originHeader);
    }

    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }

    await next();
  };
}

function setCorsHeaders(c: Context, origin: string): void {
  c.header("Access-Control-Allow-Origin", origin);
  c.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  c.header("Access-Control-Allow-Headers", "content-type,authorization");
  c.header("Access-Control-Max-Age", "86400");
  c.header("Vary", "Origin");
}

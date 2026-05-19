export type ParsedHost = {
  hostname: string;
  port?: string;
};

export type AllowedHostRule = ParsedHost;

export function parseAllowedHostList(value: string): AllowedHostRule[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parsed = parseHostLike(entry);
      if (!parsed) {
        throw new Error(`Invalid allowed hostname: ${entry}`);
      }
      return parsed;
    });
}

export function parseHostLike(value: string | undefined | null): ParsedHost | undefined {
  if (!value) return undefined;
  const firstValue = value.split(",")[0]?.trim();
  if (!firstValue) return undefined;

  try {
    const url = firstValue.includes("://") ? new URL(firstValue) : new URL(`http://${firstValue}`);
    return {
      hostname: normalizeHostname(url.hostname),
      port: url.port || undefined
    };
  } catch {
    return undefined;
  }
}

export function parseOrigin(value: string | undefined | null): ParsedHost | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    return {
      hostname: normalizeHostname(url.hostname),
      port: url.port || undefined
    };
  } catch {
    return undefined;
  }
}

export function isAllowedHost(parsed: ParsedHost | undefined, rules: AllowedHostRule[]): boolean {
  if (!parsed) return false;

  return rules.some((rule) => {
    if (rule.hostname !== parsed.hostname) return false;
    return rule.port ? rule.port === parsed.port : true;
  });
}

export function getEffectiveHost(headers: Headers): string | undefined {
  const forwardedHost = headers.get("x-forwarded-host");
  if (forwardedHost) return forwardedHost;
  return headers.get("host") ?? undefined;
}

export function getEffectiveOrigin(
  requestUrl: string,
  headers: Headers | undefined,
  publicOriginHint?: string
): string {
  const fallbackUrl = new URL(requestUrl);
  if (!headers) return coerceToPublicOriginHint(fallbackUrl.origin, publicOriginHint);

  const forwarded = parseForwardedHeader(headers.get("forwarded"));
  const forwardedHost = firstHeaderValue(headers.get("x-forwarded-host")) ?? forwarded.host;
  const host = forwardedHost ?? firstHeaderValue(headers.get("host")) ?? fallbackUrl.host;
  const forwardedProto = firstHeaderValue(headers.get("x-forwarded-proto")) ?? forwarded.proto;
  const protocol = normalizeProtocol(forwardedProto) ?? fallbackUrl.protocol.replace(/:$/, "");

  try {
    return coerceToPublicOriginHint(new URL(`${protocol}://${host}`).origin, publicOriginHint);
  } catch {
    return coerceToPublicOriginHint(fallbackUrl.origin, publicOriginHint);
  }
}

function coerceToPublicOriginHint(origin: string, publicOriginHint: string | undefined): string {
  if (!publicOriginHint) return origin;

  try {
    const parsedOrigin = new URL(origin);
    const parsedHint = new URL(publicOriginHint);
    if (parsedOrigin.host === parsedHint.host && parsedOrigin.protocol !== parsedHint.protocol) {
      return parsedHint.origin;
    }
  } catch {
    return origin;
  }

  return origin;
}

function parseForwardedHeader(value: string | undefined | null): { host?: string; proto?: string } {
  const firstValue = firstHeaderValue(value);
  if (!firstValue) return {};

  const result: { host?: string; proto?: string } = {};
  for (const part of firstValue.split(";")) {
    const [rawKey, ...rawValueParts] = part.split("=");
    const key = rawKey?.trim().toLowerCase();
    const valuePart = rawValueParts.join("=").trim();
    const unquotedValue = valuePart.replace(/^"|"$/g, "");
    if (key === "host" && unquotedValue) result.host = unquotedValue;
    if (key === "proto" && unquotedValue) result.proto = unquotedValue;
  }
  return result;
}

function firstHeaderValue(value: string | undefined | null): string | undefined {
  return value
    ?.split(",")[0]
    ?.trim() || undefined;
}

function normalizeProtocol(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/:$/, "");
  if (normalized === "http" || normalized === "https") return normalized;
  return undefined;
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

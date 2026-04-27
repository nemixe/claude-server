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

export function getEffectiveHost(headers: Headers, trustProxy: boolean): string | undefined {
  if (trustProxy) {
    const forwardedHost = headers.get("x-forwarded-host");
    if (forwardedHost) return forwardedHost;
  }

  return headers.get("host") ?? undefined;
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

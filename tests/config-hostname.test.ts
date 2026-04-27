import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { isAllowedHost, parseAllowedHostList, parseHostLike, parseOrigin } from "../src/hostname.js";

describe("config and hostname parsing", () => {
  it("loads .env style configuration with normalized allowed hosts", () => {
    const config = loadConfig({
      ALLOWED_HOSTNAMES: "LOCALHOST,example.com,app.example.com:8443",
      TRUST_PROXY: "true",
      MAX_CONCURRENT_RUNS: "7"
    });

    expect(config.trustProxy).toBe(true);
    expect(config.maxConcurrentRuns).toBe(7);
    expect(config.allowedHosts).toEqual([
      { hostname: "localhost" },
      { hostname: "example.com" },
      { hostname: "app.example.com", port: "8443" }
    ]);
  });

  it("ignores ports for hostname-only entries and requires exact ports for port-specific entries", () => {
    const rules = parseAllowedHostList("example.com,app.example.com:8443");

    expect(isAllowedHost(parseHostLike("example.com:3000"), rules)).toBe(true);
    expect(isAllowedHost(parseOrigin("https://example.com"), rules)).toBe(true);
    expect(isAllowedHost(parseHostLike("app.example.com:8443"), rules)).toBe(true);
    expect(isAllowedHost(parseHostLike("app.example.com:3000"), rules)).toBe(false);
  });
});

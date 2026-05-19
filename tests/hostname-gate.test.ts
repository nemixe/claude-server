import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createHostnameGate } from "../src/hostname-gate.js";
import { createTempConfig } from "./helpers.js";

describe("hostname gate middleware", () => {
  it("allows configured hosts and origins", async () => {
    const config = await createTempConfig();
    const app = new Hono();
    app.use("*", createHostnameGate(config));
    app.get("/", (c) => c.json({ ok: true }));

    const response = await app.request("http://localhost/", {
      headers: {
        host: "localhost:3000",
        origin: "https://example.com"
      }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://example.com");
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("rejects unlisted hosts before route handlers", async () => {
    const config = await createTempConfig();
    const app = new Hono();
    app.use("*", createHostnameGate(config));
    app.get("/", (c) => c.json({ ok: true }));

    const response = await app.request("http://evil.test/", {
      headers: { host: "evil.test" }
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "host_not_allowed" } });
  });

  it("uses X-Forwarded-Host by default", async () => {
    const config = await createTempConfig();
    const app = new Hono();
    app.use("*", createHostnameGate(config));
    app.get("/", (c) => c.json({ ok: true }));

    const response = await app.request("http://internal/", {
      headers: {
        host: "internal",
        "x-forwarded-host": "example.com"
      }
    });

    expect(response.status).toBe(200);
  });

  it("rejects unlisted browser origins", async () => {
    const config = await createTempConfig();
    const app = new Hono();
    app.use("*", createHostnameGate(config));
    app.get("/", (c) => c.json({ ok: true }));

    const response = await app.request("http://localhost/", {
      headers: {
        host: "localhost",
        origin: "https://evil.test"
      }
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "origin_not_allowed" } });
  });
});

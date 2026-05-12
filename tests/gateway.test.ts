import http from "node:http";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { startClaudeServer } from "../src/server.js";
import { createTempConfig } from "./helpers.js";

describe("Bottle gateway", () => {
  it("proxies WebSocket upgrades to AI Client while the target URL cookie is absent", async () => {
    const upstream = http.createServer();
    let upgradedPath = "";
    upstream.on("upgrade", (request, socket) => {
      upgradedPath = request.url ?? "";
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "X-Upstream-Gateway-Test: ok\r\n" +
          "\r\n"
      );
      socket.end();
    });
    await listen(upstream);

    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("Upstream test server did not bind");

    const config = await createTempConfig({
      PORT: "0",
      MAIN_APP_URL: "http://localhost:3000",
      CLIENT_APP_URL: `http://127.0.0.1:${upstreamAddress.port}`
    });

    let bottlePort = 0;
    let resolveListening!: () => void;
    const listening = new Promise<void>((resolve) => {
      resolveListening = resolve;
    });
    const running = await startClaudeServer(config, {
      onListen: (info) => {
        bottlePort = info.port;
        resolveListening();
      }
    });
    await listening;

    try {
      const response = await websocketHandshake(bottlePort, "/@vite/client?token=test");

      expect(response).toContain("101 Switching Protocols");
      expect(response).toContain("X-Upstream-Gateway-Test: ok");
      expect(upgradedPath).toBe("/@vite/client?token=test");
    } finally {
      await running.stop();
      await close(upstream);
    }
  });

  it("proxies WebSocket upgrades for the fixed app proxy", async () => {
    const upstream = http.createServer();
    let upgradedPath = "";
    upstream.on("upgrade", (request, socket) => {
      upgradedPath = request.url ?? "";
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "X-Upstream-Gateway-Test: app-ok\r\n" +
          "\r\n"
      );
      socket.end();
    });
    await listen(upstream);

    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("Upstream test server did not bind");

    const config = await createTempConfig({
      PORT: "0",
      MAIN_APP_URL: `http://127.0.0.1:${upstreamAddress.port}`,
      CLIENT_APP_URL: "http://localhost:5173",
      MAIN_APP_DIRECT: "false"
    });

    let bottlePort = 0;
    let resolveListening!: () => void;
    const listening = new Promise<void>((resolve) => {
      resolveListening = resolve;
    });
    const running = await startClaudeServer(config, {
      onListen: (info) => {
        bottlePort = info.port;
        resolveListening();
      }
    });
    await listening;

    try {
      const response = await websocketHandshake(bottlePort, "/__app/@vite/client?token=test");

      expect(response).toContain("101 Switching Protocols");
      expect(response).toContain("X-Upstream-Gateway-Test: app-ok");
      expect(upgradedPath).toBe("/@vite/client?token=test");
    } finally {
      await running.stop();
      await close(upstream);
    }
  });

  it("proxies WebSocket upgrades for direct root main-app paths", async () => {
    const upstream = http.createServer();
    let upgradedPath = "";
    upstream.on("upgrade", (request, socket) => {
      upgradedPath = request.url ?? "";
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "X-Upstream-Gateway-Test: direct-app-ok\r\n" +
          "\r\n"
      );
      socket.end();
    });
    await listen(upstream);

    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("Upstream test server did not bind");

    const config = await createTempConfig({
      PORT: "0",
      MAIN_APP_URL: `http://127.0.0.1:${upstreamAddress.port}`,
      CLIENT_APP_URL: "http://localhost:5173"
    });

    let bottlePort = 0;
    let resolveListening!: () => void;
    const listening = new Promise<void>((resolve) => {
      resolveListening = resolve;
    });
    const running = await startClaudeServer(config, {
      onListen: (info) => {
        bottlePort = info.port;
        resolveListening();
      }
    });
    await listening;

    try {
      const response = await websocketHandshake(bottlePort, "/@vite/client?token=test", {
        cookie: "bottle_target_app_url=http%3A%2F%2Flocalhost%2F"
      });

      expect(response).toContain("101 Switching Protocols");
      expect(response).toContain("X-Upstream-Gateway-Test: direct-app-ok");
      expect(upgradedPath).toBe("/@vite/client?token=test");
    } finally {
      await running.stop();
      await close(upstream);
    }
  });
});

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function websocketHandshake(port: number, path: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.setTimeout(5_000);
    socket.on("connect", () => {
      const extraHeaders = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: localhost:${port}\r\n` +
          extraHeaders +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "\r\n"
      );
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("end", () => resolve(data));
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("Timed out waiting for WebSocket handshake"));
    });
    socket.on("error", reject);
  });
}

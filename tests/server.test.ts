import net from "node:net";
import { describe, expect, it } from "vitest";
import { startBottleServer } from "../src/server.js";
import { createTempConfig } from "./helpers.js";

function reservePort(): Promise<{ port: number; server: net.Server }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to reserve a test port"));
        return;
      }
      resolve({ port: address.port, server });
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe("Bottle startup binding", () => {
  it("fails fast when PORT is already in use", async () => {
    const reserved = await reservePort();

    const config = await createTempConfig({
      BIND_HOST: "127.0.0.1",
      PORT: String(reserved.port)
    });

    try {
      await expect(startBottleServer(config)).rejects.toThrow(
        `Port ${reserved.port} is already in use. Stop the old Bottle process or change PORT before restarting.`
      );
    } finally {
      await closeServer(reserved.server);
    }
  });

  it("starts and stops normally on an available port", async () => {
    const config = await createTempConfig({ PORT: "0", BIND_HOST: "127.0.0.1" });
    let listenedPort = 0;

    const running = await startBottleServer(config, {
      onListen(info) {
        listenedPort = info.port;
      }
    });

    expect(listenedPort).toBeGreaterThan(0);
    expect(running.server.listening).toBe(true);
    await running.stop();
    expect(running.server.listening).toBe(false);
  });
});

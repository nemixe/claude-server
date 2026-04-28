import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../src/settings-store.js";
import { createTempConfig } from "./helpers.js";

describe("SettingsStore", () => {
  it("returns defaults when no file exists", async () => {
    const config = await createTempConfig();
    const store = new SettingsStore(config);

    const settings = await store.load();
    expect(settings.maxConcurrentRuns).toBe(2);
    expect(settings.maxTurns).toBe(5);
  });

  it("persists and reloads settings from disk", async () => {
    const config = await createTempConfig();
    const store = new SettingsStore(config);

    await store.save({ maxConcurrentRuns: 8, maxTurns: 50 });

    const freshStore = new SettingsStore(config);
    const loaded = await freshStore.load();
    expect(loaded.maxConcurrentRuns).toBe(8);
    expect(loaded.maxTurns).toBe(50);
  });

  it("preserves unpatched fields on partial save", async () => {
    const config = await createTempConfig();
    const store = new SettingsStore(config);

    await store.save({ maxConcurrentRuns: 8 });
    const freshStore = new SettingsStore(config);
    const loaded = await freshStore.load();
    expect(loaded.maxConcurrentRuns).toBe(8);
    expect(loaded.maxTurns).toBe(5);
  });

  it("ignores invalid values in the file and falls back to defaults", async () => {
    const config = await createTempConfig();
    const filePath = path.join(config.sessionDir, "settings.json");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ maxConcurrentRuns: -1, maxTurns: "bad" }), "utf8");

    const store = new SettingsStore(config);
    const settings = await store.load();
    expect(settings.maxConcurrentRuns).toBe(2);
    expect(settings.maxTurns).toBe(5);
  });
});
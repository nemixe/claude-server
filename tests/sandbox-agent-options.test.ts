import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAgentOptions } from "../src/agent-service.js";
import { buildSandboxSettings } from "../src/sandbox.js";
import type { SessionMetadata } from "../src/types.js";
import { createTempConfig } from "./helpers.js";

describe("sandbox and agent options", () => {
  it("blocks credential paths, unix sockets, and unsandboxed commands", async () => {
    const config = await createTempConfig();
    const workspacePath = path.join(config.workspaceDir, "session-id");
    const sandbox = buildSandboxSettings(config, workspacePath);

    expect(sandbox.enabled).toBe(true);
    expect(sandbox.allowUnsandboxedCommands).toBe(false);
    expect(sandbox.network.allowUnixSockets).toEqual([]);
    expect(sandbox.network.allowAllUnixSockets).toBe(false);
    expect(sandbox.filesystem.allowWrite).toEqual([workspacePath]);
    expect(sandbox.filesystem.denyRead).toContain(path.join(os.homedir(), ".claude"));
  });

  it("maps modes to Claude Agent SDK permission options", async () => {
    const config = await createTempConfig();
    const session: SessionMetadata = {
      id: "00000000-0000-4000-8000-000000000000",
      mode: "plan",
      workspacePath: path.join(config.workspaceDir, "session"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      hasRun: true
    };

    const planOptions = buildAgentOptions(config, session, { prompt: "inspect", mode: "plan" }, new AbortController());
    const editOptions = buildAgentOptions(config, session, { prompt: "edit", mode: "edit" }, new AbortController());
    const bypassOptions = buildAgentOptions(config, session, { prompt: "run", mode: "bypass" }, new AbortController());

    expect(planOptions.permissionMode).toBe("plan");
    expect(planOptions.enableFileCheckpointing).toBe(false);
    expect(planOptions.disallowedTools).toContain("Bash");
    expect(editOptions.permissionMode).toBe("acceptEdits");
    expect(editOptions.enableFileCheckpointing).toBe(true);
    expect(bypassOptions.permissionMode).toBe("bypassPermissions");
    expect(bypassOptions.allowDangerouslySkipPermissions).toBe(true);
    expect(bypassOptions.resume).toBe(session.id);
    expect(bypassOptions.sessionId).toBeUndefined();
  });
});

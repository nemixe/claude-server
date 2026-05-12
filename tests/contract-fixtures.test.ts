import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BOTTLE_PROTOCOL_VERSION } from "../src/types.js";

const fixturePath = path.resolve(import.meta.dirname, "..", "contract", "fixtures", "bottle-v1.json");

describe("Bottle contract fixture", () => {
  it("pins the public v1 API and bridge context examples", () => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

    expect(fixture.protocolVersion).toBe(BOTTLE_PROTOCOL_VERSION);
    expect(fixture.bottleInfo.protocolVersion).toBe(BOTTLE_PROTOCOL_VERSION);
    expect(fixture.settingsResponse.availableAgentProviders).toEqual(["claude", "codex"]);
    expect(fixture.createSessionResponse).toMatchObject({ sessionId: "session-1", mode: "plan" });
    expect(fixture.listSessionsResponse.sessions[0]).not.toHaveProperty("workspacePath");
    expect(fixture.streamEvents.map((event: { event: string }) => event.event)).toEqual(["message", "result", "done"]);
    expect(fixture.pendingUserInputEvent.event).toBe("question_pending");
    expect(fixture.pendingApprovalEvent.event).toBe("approval_pending");
    expect(fixture.streamMessageRequestWithContext.context.viewport).toEqual({ width: 1440, height: 900 });
  });
});

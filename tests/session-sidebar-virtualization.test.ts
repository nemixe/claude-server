import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function cssBlock(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start === -1) {
    return "";
  }

  const end = source.indexOf("\n}", start);
  return end === -1 ? source.slice(start) : source.slice(start, end + 2);
}

describe("session sidebar virtualization", () => {
  it("uses stable row sizes so the native scrollbar thumb does not resize while scrolling", () => {
    const source = readRepoFile("client/src/agent-chat/session-sidebar.jsx");
    const styles = readRepoFile("client/src/styles.css");
    const sessionsListStyles = cssBlock(styles, ".ai-chat-sessions-list");

    expect(source).toContain("estimateSize: (index) => rowHeight(rows[index])");
    expect(source).toContain("getItemKey: (index) => rows[index]?.key ?? index");
    expect(source).not.toContain("virtualizer.measureElement");
    expect(sessionsListStyles).toContain("min-height: 0;");
    expect(sessionsListStyles).toContain("position: relative;");
    expect(sessionsListStyles).not.toContain("display: flex;");
    expect(sessionsListStyles).not.toContain("flex-direction: column;");
    expect(sessionsListStyles).not.toContain("gap: 4px;");
  });
});

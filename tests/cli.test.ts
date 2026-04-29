import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

function createBufferedStream() {
  let text = "";
  return {
    stream: {
      write(chunk: string) {
        text += chunk;
        return true;
      }
    },
    get text() {
      return text;
    }
  };
}

describe("CLI", () => {
  it("generates plug-and-play integration files for a custom instance", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "claude-server-cli-"));
    const projectRoot = path.join(cwd, "prototype-a");
    await fs.mkdir(projectRoot);
    const stdout = createBufferedStream();
    const stderr = createBufferedStream();

    const code = await runCli(
      ["init", "--name", "prototype-a", "--port", "3001", "--project-root", projectRoot],
      { cwd, stdout: stdout.stream, stderr: stderr.stream }
    );

    expect(code).toBe(0);
    expect(stderr.text).toBe("");
    await expect(fs.readFile(path.join(cwd, "claude-server.config.mjs"), "utf8")).resolves.toContain('"port": 3001');
    await expect(fs.readFile(path.join(cwd, ".env.claude-server.prototype-a"), "utf8")).resolves.toContain("PORT=3001");
    await expect(fs.readFile(path.join(cwd, "scripts", "start-claude-server-prototype-a.mjs"), "utf8")).resolves.toContain(
      "claude-server/server"
    );
    await expect(fs.readFile(path.join(cwd, "CLAUDE_SERVER_INTEGRATION.md"), "utf8")).resolves.toContain(
      "/v1/* -> http://127.0.0.1:3001/v1/*"
    );
    expect(stdout.text).toContain("Created Claude server integration for prototype-a");
  });

  it("does not overwrite generated files unless forced", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "claude-server-cli-overwrite-"));
    const stdout = createBufferedStream();
    const stderr = createBufferedStream();

    await expect(runCli(["init", "--name", "prototype-a", "--port", "3001"], { cwd, stdout: stdout.stream, stderr: stderr.stream })).resolves.toBe(0);
    await expect(runCli(["init", "--name", "prototype-a", "--port", "3001"], { cwd, stdout: stdout.stream, stderr: stderr.stream })).resolves.toBe(1);
    expect(stderr.text).toContain("Refusing to overwrite existing files");
  });
});

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
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-cli-"));
    const stdout = createBufferedStream();
    const stderr = createBufferedStream();

    const code = await runCli(
      ["init", "--name", "prototype-a", "--port", "3001"],
      { cwd, stdout: stdout.stream, stderr: stderr.stream }
    );

    expect(code).toBe(0);
    expect(stderr.text).toBe("");
    await expect(fs.stat(path.join(cwd, "app"))).resolves.toMatchObject({});
    const configFile = await fs.readFile(path.join(cwd, ".bottle", "bottle.config.mjs"), "utf8");
    const envFile = await fs.readFile(path.join(cwd, ".bottle", "bottle.env"), "utf8");
    expect(configFile).toContain('"projectRoot": "../app"');
    expect(configFile).not.toContain("agentProvider");
    expect(configFile).toContain('"sessionDir": "../.bottle/sessions"');
    expect(configFile).not.toContain("workspaceDir");
    expect(envFile).toContain("PROJECT_ROOT=../app");
    expect(envFile).not.toContain("AGENT_PROVIDER");
    expect(envFile).toContain("MAIN_APP_URL=http://localhost:3000");
    expect(envFile).toContain("CODEX_SKIP_GIT_REPO_CHECK=true");
    expect(envFile).not.toContain("WORKSPACE_DIR");
    await expect(fs.readFile(path.join(cwd, ".bottle", "app.env"), "utf8")).resolves.toContain("APP_PORT=3000");
    const startScript = await fs.readFile(path.join(cwd, ".bottle", "scripts", "start-bottle.mjs"), "utf8");
    expect(startScript).toContain('spawn("bottle"');
    expect(startScript).toContain('["SIGINT", "SIGTERM", "SIGHUP"]');
    expect(startScript).toContain("child.kill(signal)");
    await expect(fs.readFile(path.join(cwd, ".bottle", "README.md"), "utf8")).resolves.toContain(
      "/v1/* -> http://127.0.0.1:3001/v1/*"
    );
    expect(stdout.text).toContain("Created Bottle integration for prototype-a");
    expect(stdout.text).toContain(".bottle/bottle.env");
  });

  it("copies an existing project into app while skipping generated folders", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-cli-copy-"));
    const source = path.join(cwd, "source");
    await fs.mkdir(path.join(source, "node_modules", "pkg"), { recursive: true });
    await fs.mkdir(path.join(source, "src"), { recursive: true });
    await fs.writeFile(path.join(source, "src", "index.js"), "console.log('hi')", "utf8");
    await fs.writeFile(path.join(source, "node_modules", "pkg", "ignored.js"), "ignored", "utf8");
    const bundle = path.join(cwd, "bundle");
    const stdout = createBufferedStream();
    const stderr = createBufferedStream();

    const code = await runCli(
      ["init", "--name", "copied", "--output-dir", bundle, "--copy-from", source],
      { cwd, stdout: stdout.stream, stderr: stderr.stream }
    );

    expect(code).toBe(0);
    await expect(fs.readFile(path.join(bundle, "app", "src", "index.js"), "utf8")).resolves.toContain("console.log");
    await expect(fs.stat(path.join(bundle, "app", "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(bundle, ".bottle", "bottle.env"), "utf8")).resolves.toContain("PROJECT_ROOT=../app");
    expect(stderr.text).toBe("");
  });

  it("does not overwrite generated files unless forced", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-cli-overwrite-"));
    const stdout = createBufferedStream();
    const stderr = createBufferedStream();

    await expect(runCli(["init", "--name", "prototype-a", "--port", "3001"], { cwd, stdout: stdout.stream, stderr: stderr.stream })).resolves.toBe(0);
    await expect(runCli(["init", "--name", "prototype-a", "--port", "3001"], { cwd, stdout: stdout.stream, stderr: stderr.stream })).resolves.toBe(1);
    expect(stderr.text).toContain("Refusing to overwrite existing files");
  });
});

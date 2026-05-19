import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
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
    const runtimeSource = await createFakeBottleRuntime(cwd);
    const stdout = createBufferedStream();
    const stderr = createBufferedStream();

    const code = await runCli(
      ["init", "--name", "prototype-a", "--port", "3001"],
      {
        cwd,
        env: { ...process.env, BOTTLE_RUNTIME_SOURCE_DIR: runtimeSource },
        stdout: stdout.stream,
        stderr: stderr.stream
      }
    );

    expect(code).toBe(0);
    expect(stderr.text).toBe("");
    await expect(fs.stat(path.join(cwd, "app"))).resolves.toMatchObject({});
    const configFile = await fs.readFile(path.join(cwd, ".bottle", "bottle.config.mjs"), "utf8");
    expect(configFile).toContain('"projectRoot": "../app"');
    expect(configFile).toContain('"bottleDir": "."');
    expect(configFile).toContain('"bindHost": "0.0.0.0"');
    expect(configFile).toContain('"allowedHostnames"');
    expect(configFile).toContain('"localhost"');
    expect(configFile).not.toContain("trustProxy");
    expect(configFile).toContain('"clientOrigins"');
    expect(configFile).toContain('"http://localhost:5173"');
    expect(configFile).not.toContain("mainAppProxy");
    expect(configFile).not.toContain("mainAppDirect");
    expect(configFile).not.toContain("agentProvider");
    expect(configFile).toContain('"sessionDir": "../.bottle/sessions"');
    expect(configFile).not.toContain("workspaceDir");
    expect(configFile).not.toContain("maxConcurrentRuns");
    await expect(fs.stat(path.join(cwd, ".bottle", "bottle.env"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(cwd, ".bottle", "app.env"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(cwd, ".bottle", "agents"))).resolves.toMatchObject({});
    await expect(fs.stat(path.join(cwd, ".bottle", "commands"))).resolves.toMatchObject({});
    await expect(fs.stat(path.join(cwd, ".bottle", "rules"))).resolves.toMatchObject({});
    await expect(fs.stat(path.join(cwd, ".bottle", "skills"))).resolves.toMatchObject({});
    await expect(fs.readFile(path.join(cwd, ".bottle", ".codex-plugin", "plugin.json"), "utf8")).resolves.toContain('"commands": "./commands/"');
    await expect(fs.stat(path.join(cwd, ".bottle", "runtime", "dist", "cli.js"))).resolves.toMatchObject({});
    await expect(fs.readFile(path.join(cwd, ".bottle", "runtime", "package.json"), "utf8")).resolves.toContain('"name": "bottle"');
    await expect(fs.readFile(path.join(cwd, ".bottle", "runtime", "package-lock.json"), "utf8")).resolves.toContain('"lockfileVersion"');
    const startScript = await fs.readFile(path.join(cwd, ".bottle", "scripts", "start-bottle.mjs"), "utf8");
    expect(startScript).toContain("process.execPath");
    expect(startScript).toContain("runtime/dist/cli.js");
    expect(startScript).not.toContain('spawn("bottle"');
    expect(startScript).toContain('["SIGINT", "SIGTERM", "SIGHUP"]');
    expect(startScript).toContain("child.kill(signal)");
    await expect(fs.stat(path.join(cwd, ".bottle", "runtime", ".env.example"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(cwd, ".bottle", "README.md"), "utf8")).resolves.toContain(
      "/__bottle/* -> http://127.0.0.1:3001/__bottle/*"
    );
    await expect(fs.readFile(path.join(cwd, ".bottle", "README.md"), "utf8")).resolves.not.toContain("/v1/* ->");
    await expect(fs.readFile(path.join(cwd, ".bottle", "README.md"), "utf8")).resolves.not.toContain("/iframe/* ->");
    await expect(fs.readFile(path.join(cwd, ".bottle", "README.md"), "utf8")).resolves.not.toContain("appProxyUrl");
    await expect(fs.readFile(path.join(cwd, ".bottle", "README.md"), "utf8")).resolves.not.toContain("/__app/* ->");
    expect(stdout.text).toContain("Created Bottle integration for prototype-a");
    expect(stdout.text).not.toContain(".bottle/bottle.env");
    expect(stdout.text).not.toContain(".bottle/app.env");
    expect(stdout.text).toContain(".bottle/runtime");
  });

  it("writes public host settings into generated config", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-cli-public-host-"));
    const runtimeSource = await createFakeBottleRuntime(cwd);
    const stdout = createBufferedStream();
    const stderr = createBufferedStream();

    const code = await runCli(
      [
        "init",
        "--name",
        "deployed",
        "--allowed-hostnames",
        "ai-proto-dev-1.devnstg.com,localhost",
        "--client-origins",
        "https://ai-proto-dev-1.devnstg.com"
      ],
      {
        cwd,
        env: { ...process.env, BOTTLE_RUNTIME_SOURCE_DIR: runtimeSource },
        stdout: stdout.stream,
        stderr: stderr.stream
      }
    );

    expect(code).toBe(0);
    expect(stderr.text).toBe("");

    const configFile = await fs.readFile(path.join(cwd, ".bottle", "bottle.config.mjs"), "utf8");
    expect(configFile).toContain('"allowedHostnames"');
    expect(configFile).toContain('"ai-proto-dev-1.devnstg.com"');
    expect(configFile).not.toContain("trustProxy");
    expect(configFile).toContain('"clientOrigins"');
    expect(configFile).toContain('"https://ai-proto-dev-1.devnstg.com"');
    expect(configFile).not.toContain("mainAppProxy");
    expect(configFile).not.toContain("mainAppDirect");
  });

  it("writes API-only host app settings into generated config", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-cli-api-only-"));
    const runtimeSource = await createFakeBottleRuntime(cwd);
    const stdout = createBufferedStream();
    const stderr = createBufferedStream();

    const code = await runCli(
      [
        "init",
        "--name",
        "api-only",
        "--allowed-hostnames",
        "ai-proto-dev-1.devnstg.com,localhost",
        "--client-origins",
        "https://ai-wrapper.devnstg.com"
      ],
      {
        cwd,
        env: { ...process.env, BOTTLE_RUNTIME_SOURCE_DIR: runtimeSource },
        stdout: stdout.stream,
        stderr: stderr.stream
      }
    );

    expect(code).toBe(0);
    expect(stderr.text).toBe("");

    const configFile = await fs.readFile(path.join(cwd, ".bottle", "bottle.config.mjs"), "utf8");
    expect(configFile).not.toContain("mainAppUrl");
    expect(configFile).not.toContain("mainAppProxy");
    expect(configFile).not.toContain("mainAppDirect");
    expect(configFile).toContain('"ai-proto-dev-1.devnstg.com"');
    expect(configFile).toContain('"https://ai-wrapper.devnstg.com"');

    const docs = await fs.readFile(path.join(cwd, ".bottle", "README.md"), "utf8");
    expect(docs).toContain("Proxy only `/__bottle/*` to Bottle");
    expect(docs).toContain("injecting `/__bottle/bottle-bridge.js` server-side");
    expect(docs).not.toContain("/__app/* ->");
  });

  it("can run the generated start script through the vendored runtime", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-cli-runtime-"));
    const runtimeSource = await createFakeBottleRuntime(cwd);
    const stdout = createBufferedStream();
    const stderr = createBufferedStream();

    const code = await runCli(
      ["init", "--name", "runtime-a", "--port", "3001"],
      {
        cwd,
        env: { ...process.env, BOTTLE_RUNTIME_SOURCE_DIR: runtimeSource },
        stdout: stdout.stream,
        stderr: stderr.stream
      }
    );
    expect(code).toBe(0);

    const child = spawn(process.execPath, [path.join(cwd, ".bottle", "scripts", "start-bottle.mjs")], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    try {
      const url = await waitForListeningUrl(child);
      await expect(fetch(`${url}/health`).then((response) => response.json())).resolves.toMatchObject({
        ok: true,
        service: "fake-bottle"
      });
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  });

  it("repairs missing vendored runtime dependencies before starting", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-cli-runtime-install-"));
    const runtimeSource = await createFakeBottleRuntime(cwd, { dependencies: { "fake-dep": "1.0.0" } });
    const fakeBinDir = await createFakeNpm(cwd);
    const stdout = createBufferedStream();
    const stderr = createBufferedStream();

    const code = await runCli(
      ["init", "--name", "runtime-install", "--port", "3001"],
      {
        cwd,
        env: { ...process.env, BOTTLE_RUNTIME_SOURCE_DIR: runtimeSource },
        stdout: stdout.stream,
        stderr: stderr.stream
      }
    );
    expect(code).toBe(0);

    await fs.rm(path.join(cwd, ".bottle", "runtime", "node_modules"), { recursive: true, force: true });

    const child = spawn(process.execPath, [path.join(cwd, ".bottle", "scripts", "start-bottle.mjs")], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}` }
    });

    try {
      const url = await waitForListeningUrl(child);
      await expect(fetch(`${url}/health`).then((response) => response.json())).resolves.toMatchObject({
        ok: true,
        service: "fake-bottle"
      });
      await expect(fs.readFile(path.join(cwd, ".bottle", "runtime", "node_modules", "fake-dep", "package.json"), "utf8")).resolves.toContain(
        '"fake-dep"'
      );
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child);
    }
  });

  it("can generate a legacy start script without a vendored runtime", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-cli-no-runtime-"));
    const stdout = createBufferedStream();
    const stderr = createBufferedStream();

    const code = await runCli(
      ["init", "--name", "prototype-a", "--port", "3001", "--no-vendor-runtime"],
      { cwd, stdout: stdout.stream, stderr: stderr.stream }
    );

    expect(code).toBe(0);
    await expect(fs.stat(path.join(cwd, ".bottle", "runtime"))).rejects.toMatchObject({ code: "ENOENT" });
    const startScript = await fs.readFile(path.join(cwd, ".bottle", "scripts", "start-bottle.mjs"), "utf8");
    expect(startScript).toContain('spawn("bottle"');
    expect(startScript).not.toContain("runtime/dist/cli.js");
  });

  it("copies an existing project into app while skipping generated folders", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-cli-copy-"));
    const runtimeSource = await createFakeBottleRuntime(cwd);
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
      {
        cwd,
        env: { ...process.env, BOTTLE_RUNTIME_SOURCE_DIR: runtimeSource },
        stdout: stdout.stream,
        stderr: stderr.stream
      }
    );

    expect(code).toBe(0);
    await expect(fs.readFile(path.join(bundle, "app", "src", "index.js"), "utf8")).resolves.toContain("console.log");
    await expect(fs.stat(path.join(bundle, "app", "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(bundle, ".bottle", "bottle.config.mjs"), "utf8")).resolves.toContain('"projectRoot": "../app"');
    expect(stderr.text).toBe("");
  });

  it("does not overwrite generated files unless forced", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bottle-cli-overwrite-"));
    const runtimeSource = await createFakeBottleRuntime(cwd);
    const stdout = createBufferedStream();
    const stderr = createBufferedStream();

    await expect(
      runCli(["init", "--name", "prototype-a", "--port", "3001"], {
        cwd,
        env: { ...process.env, BOTTLE_RUNTIME_SOURCE_DIR: runtimeSource },
        stdout: stdout.stream,
        stderr: stderr.stream
      })
    ).resolves.toBe(0);
    await expect(
      runCli(["init", "--name", "prototype-a", "--port", "3001"], {
        cwd,
        env: { ...process.env, BOTTLE_RUNTIME_SOURCE_DIR: runtimeSource },
        stdout: stdout.stream,
        stderr: stderr.stream
      })
    ).resolves.toBe(1);
    expect(stderr.text).toContain("Refusing to overwrite existing files");
  });
});

async function createFakeBottleRuntime(root: string, options: { dependencies?: Record<string, string> } = {}): Promise<string> {
  const runtimeRoot = path.join(root, "fake-runtime");
  const dependencies = options.dependencies ?? {};
  await fs.mkdir(path.join(runtimeRoot, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(runtimeRoot, "package.json"),
    JSON.stringify(
      { name: "bottle", version: "0.0.0-test", type: "module", bin: { bottle: "./dist/cli.js" }, dependencies },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(
    path.join(runtimeRoot, "package-lock.json"),
    JSON.stringify(
      {
        name: "bottle",
        version: "0.0.0-test",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "bottle",
            version: "0.0.0-test",
            dependencies
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );
  for (const [dependencyName, version] of Object.entries(dependencies)) {
    const dependencyDir = path.join(runtimeRoot, "node_modules", ...dependencyName.split("/"));
    await fs.mkdir(dependencyDir, { recursive: true });
    await fs.writeFile(path.join(dependencyDir, "package.json"), JSON.stringify({ name: dependencyName, version }, null, 2), "utf8");
  }
  await fs.writeFile(path.join(runtimeRoot, ".env.example"), "SHOULD_NOT_BE_VENDORED=true\n", "utf8");
  await fs.writeFile(
    path.join(runtimeRoot, "dist", "cli.js"),
    [
      "#!/usr/bin/env node",
      'import http from "node:http";',
      "",
      'if (process.argv[2] !== "start") process.exit(1);',
      "const server = http.createServer((request, response) => {",
      '  if (request.url === "/health") {',
      '    response.setHeader("content-type", "application/json");',
      '    response.end(JSON.stringify({ ok: true, service: "fake-bottle" }));',
      "    return;",
      "  }",
      "  response.statusCode = 404;",
      "  response.end();",
      "});",
      'server.listen(0, "127.0.0.1", () => {',
      "  const address = server.address();",
      '  console.log(`Bottle listening on http://127.0.0.1:${address.port}`);',
      "});",
      'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
      'process.on("SIGINT", () => server.close(() => process.exit(0)));',
      ""
    ].join("\n"),
    "utf8"
  );
  return runtimeRoot;
}

async function createFakeNpm(root: string): Promise<string> {
  const binDir = path.join(root, "fake-bin");
  const npmPath = path.join(binDir, process.platform === "win32" ? "npm.cmd" : "npm");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(
    npmPath,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const dependencyDir = path.join(process.cwd(), "node_modules", "fake-dep");',
      "fs.mkdirSync(dependencyDir, { recursive: true });",
      'fs.writeFileSync(path.join(dependencyDir, "package.json"), JSON.stringify({ name: "fake-dep", version: "1.0.0" }, null, 2));',
      ""
    ].join("\n"),
    "utf8"
  );
  await fs.chmod(npmPath, 0o755);
  return binDir;
}

function waitForListeningUrl(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for fake Bottle runtime")), 5_000);
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
      const match = output.match(/Bottle listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Fake Bottle runtime exited before listening: ${code}\n${output}`));
      }
    });
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
}

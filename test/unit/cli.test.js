import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { describe, it, expect } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = resolve(ROOT, "bin", "localshare.js");

async function freePort() {
  const probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

/** Resolve once the child prints `needle`, or reject after `timeoutMs`. */
function waitForOutput(child, needle, timeoutMs) {
  return new Promise((done, fail) => {
    let seen = "";
    const timer = setTimeout(() => {
      cleanup();
      fail(new Error(`Timed out waiting for "${needle}" in:\n${seen}`));
    }, timeoutMs);
    const onData = (chunk) => {
      seen += chunk.toString();
      if (seen.includes(needle)) {
        cleanup();
        done(seen);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
  });
}

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, ...args], {
      cwd: ROOT,
      timeout: 10000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("CLI", () => {
  it("--version prints the package version", async () => {
    const { code, stdout } = await runCli(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("--help exits 0 and documents the main flags", async () => {
    const { code, stdout, stderr } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: localshare [options]");
    expect(stdout).toContain("--port");
    expect(stdout).toContain("--pin");
    expect(stdout).toContain("--dir");
    expect(stdout).toContain("--max-file-size");
    expect(stdout).toContain("--max-storage");
    expect(stdout).toContain("--no-cleanup");
    expect(stdout).toContain("--no-qr");
    expect(stdout).toContain("--no-color");
    expect(stdout).toContain("--log-level");
    expect(stdout).toContain("--config");
    // defaults are shown but must NOT be stamped into argv, or they would
    // outrank the environment and config file
    expect(stdout).toContain("[default: 3000]");
    expect(stdout).not.toContain("[default: false]");
    expect(stdout).toContain("Examples:");
    expect(stdout).toContain("Start on default port 3000");
    // yargs must not warn about reserved option names
    expect(stderr).not.toContain("reserved word");
  });

  it("lets environment variables beat built-in defaults", async () => {
    const port = await freePort();
    const dir = await mkdtemp(join(tmpdir(), "localshare-env-"));
    const child = spawn(process.execPath, [BIN, "--no-qr"], {
      cwd: ROOT,
      env: {
        ...process.env,
        LOCALSHARE_PORT: String(port),
        LOCALSHARE_DIR: dir,
        LOCALSHARE_HOST: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      // The Storage dir line is last in the banner, so everything is flushed by then
      const banner = await waitForOutput(child, `Storage dir:    ${dir}`, 12000);
      // yargs must not inject its own defaults ahead of the environment
      expect(banner).toContain(`http://localhost:${port}`);
      expect(banner).toContain(dir);
    } finally {
      child.kill("SIGTERM");
      await new Promise((done) => child.once("exit", done));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("-h is an alias for --help", async () => {
    const { code, stdout } = await runCli(["-h"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  it("rejects an unknown flag with a non-zero exit", async () => {
    const { code, stderr } = await runCli(["--definitely-not-a-flag"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("Unknown argument");
  });
});

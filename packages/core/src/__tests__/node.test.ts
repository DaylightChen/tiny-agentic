import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";

import { NodePlatform } from "../platform/node.js";

/**
 * Integration tests for NodePlatform.exec.
 *
 * These tests spawn real child processes. All commands are chosen to be
 * portable across CI environments (macOS, Linux):
 *   - `echo` is available on all POSIX systems.
 *   - `node` is guaranteed in a Node >=22 environment (our engines constraint).
 *   - No Windows-specific paths or PowerShell syntax.
 *
 * Tests are kept fast: the long-running subprocess is capped at 5 s but the
 * timeout option kills it after 100 ms, so the wall-clock cost is minimal.
 */
const platform = new NodePlatform();

describe("NodePlatform.exec — shell: true path", () => {
  it("returns stdout/stderr/exitCode 0 for a simple echo command", async () => {
    const result = await platform.exec("echo hello", { shell: true });

    expect(result).toEqual({ stdout: "hello\n", stderr: "", exitCode: 0 });
  });

  it("supports shell pipe operators (confirms full shell expansion)", async () => {
    // Pipes require a shell to interpret them. If NodePlatform passed the
    // command through split/execFile without shell: true, the pipe character
    // would be treated as a literal argument and the command would fail.
    const result = await platform.exec("echo a | cat", { shell: true });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a\n");
    expect(result.stderr).toBe("");
  });

  it("captures a non-zero exit code without throwing", async () => {
    // process.exit(2) should be caught and returned as exitCode: 2, not thrown.
    const result = await platform.exec("node -e 'process.exit(2)'", { shell: true });

    expect(result.exitCode).toBe(2);
  });
});

describe("NodePlatform.exec — default (no shell) path", () => {
  it("runs node --version and returns exitCode 0 with stdout starting with 'v'", async () => {
    // This exercises the split-based code path: command.split(" ") → [program, ...args].
    // If the shell-mode refactor accidentally broke the non-shell path this would fail.
    const result = await platform.exec("node --version", {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^v\d+\.\d+\.\d+/);
  });
});

describe("NodePlatform.exec — AbortSignal forwarding", () => {
  it("returns an error result (not throws) when given an already-aborted signal", async () => {
    // AbortController.abort() before exec starts means execFile will throw an
    // AbortError synchronously or on the first tick. The catch block must convert
    // it to an error result rather than letting it escape as an unhandled rejection.
    const ctrl = new AbortController();
    ctrl.abort();

    // Must resolve (not reject).
    const result = await platform.exec("echo hi", { signal: ctrl.signal });

    // AbortError carries a string `code` of 'ABORT_ERR', not a numeric exit code.
    // The `typeof execErr.code === "number"` guard in the catch block maps any
    // non-numeric code (including 'ABORT_ERR') to 1, so exitCode must be exactly 1.
    expect(result.exitCode).toBe(1);
    // stdout and stderr may be empty — we don't assert their exact values
    // because AbortError fires before the child process produces output.
  });
});

describe("NodePlatform.exec — timeout", () => {
  it("returns a non-zero exitCode (not throws) when the subprocess times out", async () => {
    // The subprocess sleeps for 5 s; the 100 ms timeout kills it first.
    // execFile converts the kill into an error; our catch must return it,
    // not re-throw, so the result is an error result rather than a rejection.
    const result = await platform.exec(
      "node -e 'setTimeout(()=>{},5000)'",
      { shell: true, timeout: 100 },
    );

    expect(result.exitCode).not.toBe(0);
  });
});

/**
 * NodePlatform.listDir / stat — real filesystem behavior (task-01).
 *
 * Fixtures are built through `platform.exec` (mktemp/mkdir) and
 * `platform.writeFile` — the Platform's own primitives — rather than a direct
 * `node:fs` import, which the core lint boundary forbids in this package.
 */
async function makeTempDir(): Promise<string> {
  const { stdout, exitCode } = await platform.exec("mktemp -d", { shell: true });
  if (exitCode !== 0) throw new Error("failed to create temp dir");
  return stdout.trim();
}

async function removeDir(dir: string): Promise<void> {
  await platform.exec(`rm -rf ${dir}`, { shell: true });
}

describe("NodePlatform.listDir", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it("resolves to a DirEntry[] with correct type/size/mtimeMs shape", async () => {
    const fileContent = "hello world"; // 11 bytes
    await platform.writeFile(join(dir, "a.txt"), fileContent);
    await platform.exec(`mkdir ${join(dir, "sub")}`, { shell: true });

    const entries = await platform.listDir(dir);

    expect(entries).toHaveLength(2);

    const byName = new Map(entries.map((e) => [e.name, e]));
    const file = byName.get("a.txt");
    const sub = byName.get("sub");

    // File entry: correct type, real byte size, numeric mtime.
    expect(file).toBeDefined();
    expect(file!.type).toBe("file");
    expect(file!.size).toBe(Buffer.byteLength(fileContent));
    expect(typeof file!.mtimeMs).toBe("number");
    expect(file!.mtimeMs).toBeGreaterThan(0);

    // Directory entry: type "directory", size forced to 0.
    expect(sub).toBeDefined();
    expect(sub!.type).toBe("directory");
    expect(sub!.size).toBe(0);
    expect(typeof sub!.mtimeMs).toBe("number");

    // Every entry exposes exactly the DirEntry keys (basename only, no path).
    for (const e of entries) {
      expect(Object.keys(e).sort()).toEqual(["mtimeMs", "name", "size", "type"]);
      expect(e.name).not.toContain("/");
    }
  });

  it("resolves to an empty array for an empty directory", async () => {
    const entries = await platform.listDir(dir);
    expect(entries).toEqual([]);
  });

  it("rejects with 'ls: path does not exist: <path>' for a missing path", async () => {
    const missing = join(dir, "does-not-exist");
    await expect(platform.listDir(missing)).rejects.toThrow(
      `ls: path does not exist: ${missing}`,
    );
  });

  it("rejects with 'ls: not a directory: <path>' when the path is a file", async () => {
    const file = join(dir, "a.txt");
    await platform.writeFile(file, "x");
    await expect(platform.listDir(file)).rejects.toThrow(
      `ls: not a directory: ${file}`,
    );
  });
});

describe("NodePlatform.stat", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir();
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it("resolves to a DirEntry for a file with correct type and size", async () => {
    const file = join(dir, "f.txt");
    await platform.writeFile(file, "abcd"); // 4 bytes

    const entry = await platform.stat(file);

    expect(entry.type).toBe("file");
    expect(entry.size).toBe(4);
    expect(typeof entry.mtimeMs).toBe("number");
    expect(entry.mtimeMs).toBeGreaterThan(0);
  });

  it("resolves to a DirEntry with type 'directory' and size 0 for a directory", async () => {
    const entry = await platform.stat(dir);
    expect(entry.type).toBe("directory");
    expect(entry.size).toBe(0);
  });

  it("rejects with 'ls: path does not exist: <path>' for a missing path", async () => {
    const missing = join(dir, "nope");
    await expect(platform.stat(missing)).rejects.toThrow(
      `ls: path does not exist: ${missing}`,
    );
  });
});

describe("NodePlatform.glob / grep — task-01 throwing stubs", () => {
  it("glob rejects with the 'landed in task-02' message", async () => {
    await expect(platform.glob("*")).rejects.toThrow(
      "NodePlatform.glob not implemented — landed in task-02",
    );
  });

  it("grep rejects with the 'landed in task-02' message", async () => {
    await expect(platform.grep("x", "")).rejects.toThrow(
      "NodePlatform.grep not implemented — landed in task-02",
    );
  });
});

import { describe, it, expect } from "vitest";

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

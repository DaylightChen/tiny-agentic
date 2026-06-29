import { describe, it, expect } from "vitest";

import { bashTool } from "../tools/builtin/bash.js";
import type { Platform, ExecResult, ExecOptions } from "../types/platform.js";
import type { ToolCallContext } from "../types/tool.js";

/**
 * Minimal Platform stub with a configurable `exec` spy.
 * All non-exec methods are implemented as no-ops or fixed returns.
 * `cwd()` always returns "/work" so tests can assert the default cwd.
 */
class MockPlatform implements Platform {
  exec: (command: string, options?: ExecOptions) => Promise<ExecResult>;

  constructor(
    execImpl: (command: string, options?: ExecOptions) => Promise<ExecResult> = () =>
      Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  ) {
    this.exec = execImpl;
  }

  cwd(): string {
    return "/work";
  }

  readFile(): Promise<string> {
    return Promise.reject(new Error("readFile not configured in bash MockPlatform"));
  }

  writeFile(): Promise<void> {
    return Promise.reject(new Error("writeFile not configured in bash MockPlatform"));
  }
}

describe("bashTool", () => {
  it('has name "bash"', () => {
    expect(bashTool.name).toBe("bash");
  });

  it("always forwards shell: true in ExecOptions", async () => {
    let capturedOptions: ExecOptions | undefined;

    const platform = new MockPlatform((_cmd, opts) => {
      capturedOptions = opts;
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    });

    await bashTool.call({ command: "echo hi" }, platform, {});

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.shell).toBe(true);
  });

  it("defaults cwd to platform.cwd() ('/work')", async () => {
    let capturedOptions: ExecOptions | undefined;

    const platform = new MockPlatform((_cmd, opts) => {
      capturedOptions = opts;
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    });

    await bashTool.call({ command: "pwd" }, platform, {});

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.cwd).toBe("/work");
  });

  it("uses default timeout of 120_000ms when no timeout is provided", async () => {
    let capturedOptions: ExecOptions | undefined;

    const platform = new MockPlatform((_cmd, opts) => {
      capturedOptions = opts;
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    });

    await bashTool.call({ command: "echo default" }, platform, {});

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.timeout).toBe(120_000);
  });

  it("clamps timeout > 600_000ms to 600_000ms in exec call", async () => {
    let capturedOptions: ExecOptions | undefined;

    const platform = new MockPlatform((_cmd, opts) => {
      capturedOptions = opts;
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    });

    await bashTool.call({ command: "sleep 999", timeout: 700_000 }, platform, {});

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.timeout).toBe(600_000);
  });

  it("appends '[timeout clamped to 600000ms]' to returned stderr when timeout is clamped (stderr was empty)", async () => {
    const platform = new MockPlatform(() =>
      Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    );

    const result = await bashTool.call({ command: "sleep 999", timeout: 700_000 }, platform, {});

    expect(result).toMatchObject({ stdout: "", exitCode: 0 });
    expect((result as { stderr: string }).stderr).toContain("[timeout clamped to 600000ms]");
  });

  it("appends '[timeout clamped to 600000ms]' after existing stderr content when both are non-empty", async () => {
    const platform = new MockPlatform(() =>
      Promise.resolve({ stdout: "", stderr: "some warning", exitCode: 0 }),
    );

    const result = await bashTool.call({ command: "sleep 999", timeout: 700_000 }, platform, {});

    const stderr = (result as { stderr: string }).stderr;
    expect(stderr).toContain("some warning");
    expect(stderr).toContain("[timeout clamped to 600000ms]");
  });

  it("does NOT add clamp note to stderr when timeout is within 600_000ms", async () => {
    const platform = new MockPlatform(() =>
      Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    );

    const result = await bashTool.call({ command: "ls", timeout: 30_000 }, platform, {});

    expect((result as { stderr: string }).stderr).not.toContain("[timeout clamped to 600000ms]");
  });

  it("returns non-zero exitCode as data without throwing", async () => {
    const platform = new MockPlatform(() =>
      Promise.resolve({ stdout: "", stderr: "fail", exitCode: 2 }),
    );

    const ctx: ToolCallContext = {};
    // Must not throw — non-zero exit code is data
    const result = await bashTool.call({ command: "false" }, platform, ctx);

    expect(result).toEqual({ exitCode: 2, stdout: "", stderr: "fail" });
  });

  it("forwards context.signal when present in ExecOptions", async () => {
    let capturedOptions: ExecOptions | undefined;

    const platform = new MockPlatform((_cmd, opts) => {
      capturedOptions = opts;
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    });

    const controller = new AbortController();
    const ctx: ToolCallContext = { signal: controller.signal };

    await bashTool.call({ command: "echo signal" }, platform, ctx);

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.signal).toBe(controller.signal);
  });

  it("omits 'signal' key entirely from ExecOptions when context.signal is absent (exactOptionalPropertyTypes)", async () => {
    let capturedOptions: ExecOptions | undefined;

    const platform = new MockPlatform((_cmd, opts) => {
      capturedOptions = opts;
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    });

    // context has no signal property at all
    const ctx: ToolCallContext = {};

    await bashTool.call({ command: "echo no signal" }, platform, ctx);

    expect(capturedOptions).toBeDefined();
    // Must be absent from the object, not merely undefined — exactOptionalPropertyTypes contract
    expect("signal" in (capturedOptions as object)).toBe(false);
  });

  it("returns the full result object for a successful command", async () => {
    const platform = new MockPlatform(() =>
      Promise.resolve({ stdout: "hello\n", stderr: "", exitCode: 0 }),
    );

    const result = await bashTool.call({ command: "echo hello" }, platform, {});

    expect(result).toEqual({ stdout: "hello\n", stderr: "", exitCode: 0 });
  });

  describe("input schema validation", () => {
    it("accepts a command-only input", () => {
      const parsed = bashTool.inputSchema.safeParse({ command: "ls" });
      expect(parsed.success).toBe(true);
    });

    it("accepts command with optional timeout and description", () => {
      const parsed = bashTool.inputSchema.safeParse({
        command: "ls",
        timeout: 5000,
        description: "list files",
      });
      expect(parsed.success).toBe(true);
    });

    it("rejects missing command", () => {
      const parsed = bashTool.inputSchema.safeParse({});
      expect(parsed.success).toBe(false);
    });

    it("rejects non-positive timeout (zero)", () => {
      const parsed = bashTool.inputSchema.safeParse({ command: "ls", timeout: 0 });
      expect(parsed.success).toBe(false);
    });

    it("rejects negative timeout", () => {
      const parsed = bashTool.inputSchema.safeParse({ command: "ls", timeout: -1 });
      expect(parsed.success).toBe(false);
    });

    it("rejects non-integer timeout (float)", () => {
      const parsed = bashTool.inputSchema.safeParse({ command: "ls", timeout: 1.5 });
      expect(parsed.success).toBe(false);
    });
  });
});

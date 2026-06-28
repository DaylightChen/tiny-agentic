import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Platform, ExecOptions, ExecResult } from "../types/platform.js";

const execFileAsync = promisify(execFile);

/**
 * Node.js implementation of the Platform interface.
 * The ONLY module in the core package that imports Node built-ins or references
 * `process`. Any use of `process`, `fs`, or `child_process` outside this file
 * is a lint error.
 * Exported from tiny-agentic/platform/node (separate entry point).
 */
export class NodePlatform implements Platform {
  /** Returns the current working directory. Only place process.cwd() is called. */
  cwd(): string {
    return process.cwd();
  }

  async readFile(path: string): Promise<string> {
    return readFile(path, "utf-8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await writeFile(path, content, "utf-8");
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    // Split command into program + args. Simple split; no shell expansion.
    // For shell commands with pipes/redirects, use /bin/sh -c.
    const [program, ...args] = command.split(" ");
    // AbortSignal note (engineering spec §10.1): ExecOptions has a `timeout`
    // field but no `signal` field. In M1, exec does not accept an AbortSignal —
    // it relies on `timeout` only. To thread an AbortSignal in M2, add a
    // `signal?: AbortSignal` field to ExecOptions and forward it here.
    //
    // exactOptionalPropertyTypes is ON: forward cwd/timeout/env with conditional
    // spread so an absent option is an absent key, not an explicit `undefined`
    // (execFileAsync treats those differently).
    try {
      const { stdout, stderr } = await execFileAsync(program!, args, {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options.env !== undefined
          ? { env: { ...process.env, ...options.env } }
          : {}),
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: execErr.stdout ?? "",
        stderr: execErr.stderr ?? "",
        exitCode: execErr.code ?? 1,
      };
    }
  }
}

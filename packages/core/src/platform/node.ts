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
    // exactOptionalPropertyTypes is ON: forward all options with conditional
    // spreads so absent options are absent keys, not explicit `undefined`
    // (execFileAsync treats those differently).
    const spreadOpts = {
      encoding: "utf-8" as const,
      ...(options.cwd     !== undefined ? { cwd: options.cwd }         : {}),
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
      ...(options.env     !== undefined ? { env: { ...process.env, ...options.env } } : {}),
      ...(options.shell   !== undefined ? { shell: options.shell }     : {}),
      ...(options.signal  !== undefined ? { signal: options.signal }   : {}),
    };
    try {
      // shell: true — pass the full command string (enables pipes, redirects, globs).
      // shell: false/absent — split into program + args (no shell expansion).
      let stdout: string;
      let stderr: string;
      if (options.shell) {
        ({ stdout, stderr } = await execFileAsync(command, spreadOpts));
      } else {
        const [program, ...args] = command.split(" ");
        ({ stdout, stderr } = await execFileAsync(program!, args, spreadOpts));
      }
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      // Catches process errors (non-zero exit), timeout errors, and AbortErrors.
      // AbortErrors must be caught here and returned as an error result — never thrown.
      const execErr = err as { stdout?: string; stderr?: string; code?: unknown };
      return {
        stdout: execErr.stdout ?? "",
        stderr: execErr.stderr ?? "",
        exitCode: typeof execErr.code === "number" ? execErr.code : 1,
      };
    }
  }
}

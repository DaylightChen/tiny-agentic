import { readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Dirent, Stats } from "node:fs";
import type {
  Platform,
  ExecOptions,
  ExecResult,
  DirEntry,
  GlobOptions,
  GlobResult,
  GrepOptions,
  GrepPlatformResult,
} from "../types/platform.js";

const execFileAsync = promisify(execFile);

function direntType(entry: Dirent | Stats): DirEntry["type"] {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "other";
}

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

  async listDir(path: string): Promise<DirEntry[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") throw new Error(`ls: path does not exist: ${path}`);
      if (code === "ENOTDIR") throw new Error(`ls: not a directory: ${path}`);
      throw err;
    }
    return Promise.all(
      entries.map(async (entry): Promise<DirEntry> => {
        const full = join(path, entry.name);
        const stats = await lstat(full);
        return {
          name: entry.name,
          type: direntType(entry),
          size: entry.isDirectory() ? 0 : stats.size,
          mtimeMs: stats.mtimeMs,
        };
      }),
    );
  }

  async stat(path: string): Promise<DirEntry> {
    let stats: Stats;
    try {
      stats = await lstat(path);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT") throw new Error(`ls: path does not exist: ${path}`);
      throw err;
    }
    const type = direntType(stats);
    return {
      name: path,
      type,
      size: type === "directory" ? 0 : stats.size,
      mtimeMs: stats.mtimeMs,
    };
  }

  async glob(_pattern: string, _options?: GlobOptions): Promise<GlobResult> {
    throw new Error("NodePlatform.glob not implemented — landed in task-02");
  }

  async grep(_pattern: string, _flags: string, _options?: GrepOptions): Promise<GrepPlatformResult> {
    throw new Error("NodePlatform.grep not implemented — landed in task-02");
  }
}

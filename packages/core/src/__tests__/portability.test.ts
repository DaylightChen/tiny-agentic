import { describe, expect, it } from "vitest";

import { globTool } from "../tools/builtin/glob.js";
import { grepTool } from "../tools/builtin/grep.js";
import { lsTool } from "../tools/builtin/ls.js";
import type {
  DirEntry,
  ExecOptions,
  ExecResult,
  GlobOptions,
  GlobResult,
  GrepOptions,
  GrepPlatformResult,
  Platform,
} from "../types/platform.js";
import type { ToolCallContext } from "../types/tool.js";

const DIRECTORY_INPUT = "model::directory";
const GLOB_INPUT = "model::glob-base";
const GREP_INPUT = "model::grep-base";

const DIRECTORY_PATH = "vfs::root→directory⟦leaf⟧";
const GLOB_PATH = "vfs::root→glob⟦base⟧";
const GREP_PATH = "vfs::root→grep⟦base⟧";
const ZETA_PATH = "vfs::root→files⟦zeta⟧";
const ALPHA_PATH = "vfs::root→files⟦alpha⟧";

const ZETA_DISPLAY = "display::zeta⟦sentinel⟧";
const ALPHA_DISPLAY = "display::alpha⟦sentinel⟧";

const reverseEntries: DirEntry[] = [
  { name: "zeta", type: "file", size: 2, mtimeMs: 20 },
  { name: "alpha", type: "file", size: 1, mtimeMs: 10 },
];

/**
 * A complete non-host Platform with an explicit path grammar. It intentionally
 * cannot derive paths by splitting or joining strings: only the maps below are
 * valid. Calls are recorded so tests can prove resolution happens before I/O.
 */
class SentinelPlatform implements Platform {
  readonly events: string[] = [];
  globInvocation?: { pattern: string; options: GlobOptions | undefined };
  grepInvocation?: { pattern: string; flags: string; options: GrepOptions | undefined };

  private readonly resolvedPaths = new Map([
    [DIRECTORY_INPUT, DIRECTORY_PATH],
    [GLOB_INPUT, GLOB_PATH],
    [GREP_INPUT, GREP_PATH],
  ]);

  private readonly displayPaths = new Map([
    [ZETA_PATH, ZETA_DISPLAY],
    [ALPHA_PATH, ALPHA_DISPLAY],
  ]);

  resolvePath(path: string): string {
    this.events.push(`resolve:${path}`);
    const resolved = this.resolvedPaths.get(path);
    if (resolved === undefined) throw new Error(`sentinel: unknown model path: ${path}`);
    return resolved;
  }

  formatPath(path: string): string {
    this.events.push(`format:${path}`);
    const display = this.displayPaths.get(path);
    if (display === undefined) throw new Error(`sentinel: unknown canonical path: ${path}`);
    return display;
  }

  cwd(): string {
    return "vfs::root";
  }

  readFile(_path: string): Promise<string> {
    return Promise.reject(new Error("sentinel: readFile not configured"));
  }

  writeFile(_path: string, _content: string): Promise<void> {
    return Promise.reject(new Error("sentinel: writeFile not configured"));
  }

  exec(_command: string, _options?: ExecOptions): Promise<ExecResult> {
    return Promise.reject(new Error("sentinel: exec not configured"));
  }

  listDir(path: string): Promise<DirEntry[]> {
    this.events.push(`listDir:${path}`);
    if (path !== DIRECTORY_PATH) throw new Error(`sentinel: unexpected list path: ${path}`);
    return Promise.resolve(reverseEntries);
  }

  stat(_path: string): Promise<DirEntry> {
    return Promise.reject(new Error("sentinel: stat not configured"));
  }

  glob(pattern: string, options?: GlobOptions): Promise<GlobResult> {
    this.events.push(`glob:${options?.cwd ?? "<no-cwd>"}`);
    this.globInvocation = { pattern, options };
    return Promise.resolve({ paths: [ZETA_PATH, ALPHA_PATH], truncated: false });
  }

  grep(pattern: string, flags: string, options?: GrepOptions): Promise<GrepPlatformResult> {
    this.events.push(`grep:${options?.path ?? "<no-path>"}`);
    this.grepInvocation = { pattern, flags, options };
    return Promise.resolve({
      files: [ZETA_PATH, ALPHA_PATH],
      matches: [
        { file: ZETA_PATH, line: 9, text: "zeta hit", kind: "match" },
        { file: ALPHA_PATH, line: 1, text: "alpha hit", kind: "match" },
      ],
      truncated: false,
    });
  }
}

const context: ToolCallContext = {};

describe("model-facing discovery tool portability", () => {
  it("PT-1/PT-2/PT-4/PT-5: ls resolves sentinel grammar before I/O and preserves Platform order", async () => {
    const platform = new SentinelPlatform();

    const result = await lsTool.call({ path: DIRECTORY_INPUT }, platform, context);

    expect(result).toEqual({ entries: reverseEntries, truncated: false });
    expect(platform.events).toEqual([
      `resolve:${DIRECTORY_INPUT}`,
      `listDir:${DIRECTORY_PATH}`,
    ]);
  });

  it("PT-1/PT-2/PT-4/PT-5: glob delegates base resolution and display formatting without reordering", async () => {
    const platform = new SentinelPlatform();
    const controller = new AbortController();

    const result = await globTool.call(
      {
        pattern: "grammar::*⟦ts⟧",
        path: GLOB_INPUT,
        respect_gitignore: false,
        include_hidden: true,
        limit: 7,
      },
      platform,
      { signal: controller.signal },
    );

    expect(result).toEqual({ files: [ZETA_DISPLAY, ALPHA_DISPLAY], truncated: false });
    expect(platform.globInvocation).toEqual({
      pattern: "grammar::*⟦ts⟧",
      options: {
        cwd: GLOB_PATH,
        respectGitignore: false,
        includeHidden: true,
        limit: 7,
        signal: controller.signal,
      },
    });
    expect(platform.events).toEqual([
      `resolve:${GLOB_INPUT}`,
      `glob:${GLOB_PATH}`,
      `format:${ZETA_PATH}`,
      `format:${ALPHA_PATH}`,
    ]);
  });

  it("PT-1/PT-2/PT-4/PT-5: grep resolves its path and formats every content match in Platform order", async () => {
    const platform = new SentinelPlatform();

    const result = await grepTool.call(
      {
        pattern: "hit",
        path: GREP_INPUT,
        glob: "grammar::*⟦txt⟧",
        output_mode: "content",
        case_insensitive: true,
        context: 2,
        limit: 11,
      },
      platform,
      context,
    );

    expect(result).toEqual({
      mode: "content",
      matches: [
        { file: ZETA_DISPLAY, line: 9, text: "zeta hit", kind: "match" },
        { file: ALPHA_DISPLAY, line: 1, text: "alpha hit", kind: "match" },
      ],
      truncated: false,
    });
    expect(platform.grepInvocation).toEqual({
      pattern: "hit",
      flags: "i",
      options: {
        path: GREP_PATH,
        glob: "grammar::*⟦txt⟧",
        respectGitignore: true,
        includeHidden: false,
        limit: 11,
        contentMode: true,
        maxLineLength: 500,
        before: 2,
        after: 2,
      },
    });
    expect(platform.events).toEqual([
      `resolve:${GREP_INPUT}`,
      `grep:${GREP_PATH}`,
      `format:${ZETA_PATH}`,
      `format:${ALPHA_PATH}`,
    ]);
  });

  it("formats every grep file without sorting in files-with-matches mode", async () => {
    const platform = new SentinelPlatform();

    const result = await grepTool.call({ pattern: "hit" }, platform, context);

    expect(result).toEqual({
      mode: "files_with_matches",
      files: [ZETA_DISPLAY, ALPHA_DISPLAY],
      truncated: false,
    });
    expect(platform.grepInvocation?.options).not.toHaveProperty("path");
    expect(platform.events).toEqual([
      "grep:<no-path>",
      `format:${ZETA_PATH}`,
      `format:${ALPHA_PATH}`,
    ]);
  });

  it("omits glob cwd when no model path is supplied", async () => {
    const platform = new SentinelPlatform();

    await globTool.call({ pattern: "grammar::*" }, platform, context);

    expect(platform.globInvocation?.options).not.toHaveProperty("cwd");
    expect(platform.events[0]).toBe("glob:<no-cwd>");
    expect(platform.events).not.toContainEqual(expect.stringMatching(/^resolve:/));
  });

  it("does not invoke discovery I/O when sentinel path resolution fails", async () => {
    const platform = new SentinelPlatform();

    await expect(lsTool.call({ path: "model::unknown" }, platform, context)).rejects.toThrow(
      "sentinel: unknown model path: model::unknown",
    );
    expect(platform.events).toEqual(["resolve:model::unknown"]);
  });
});

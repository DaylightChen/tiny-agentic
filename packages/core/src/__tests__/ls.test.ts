import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { NodePlatform } from "../platform/node.js";
import { lsTool } from "../tools/builtin/ls.js";
import { lsTool as lsToolFromIndex, globTool as globToolFromIndex } from "../index.js";
import type { ToolCallContext } from "../types/tool.js";
import type { DirEntry } from "../types/platform.js";

/**
 * Tests for lsTool over a real NodePlatform + temp-dir fixtures. The lint
 * boundary forbids node:fs in __tests__, so fixtures are built through the
 * platform's own primitives (exec/writeFile), mirroring fs-discovery.test.ts.
 *
 * Vitest sets NODE_ENV="test", so NodePlatform returns name-ascending order.
 */
const platform = new NodePlatform();
const ctx: ToolCallContext = {};

function join(base: string, ...parts: string[]): string {
  return [base.replace(/\/$/, ""), ...parts].join("/");
}

async function makeTempDir(): Promise<string> {
  const { stdout, exitCode } = await platform.exec("mktemp -d", { shell: true });
  if (exitCode !== 0) throw new Error("failed to create temp dir");
  return stdout.trim();
}

async function removeDir(dir: string): Promise<void> {
  await platform.exec(`rm -rf ${dir}`, { shell: true });
}

async function mkdirp(dir: string): Promise<void> {
  const { exitCode } = await platform.exec(`mkdir -p ${dir}`, { shell: true });
  if (exitCode !== 0) throw new Error(`failed to mkdir -p ${dir}`);
}

describe("ls tool — happy path", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("lists immediate entries with name(basename)/type/size/mtimeMs, non-recursively", async () => {
    await platform.writeFile(join(dir, "a.txt"), "hello");
    await mkdirp(join(dir, "subdir"));
    // A nested file must NOT be listed (ls is non-recursive).
    await platform.writeFile(join(dir, "subdir", "nested.txt"), "deep");

    const result = (await lsTool.call({ path: dir }, platform, ctx)) as {
      entries: DirEntry[];
      truncated: boolean;
    };

    expect(result.truncated).toBe(false);
    const names = result.entries.map((e) => e.name);
    // Basenames only, name-asc, and the nested file is absent.
    expect(names).toEqual(["a.txt", "subdir"]);
    expect(names).not.toContain("nested.txt");

    const file = result.entries.find((e) => e.name === "a.txt")!;
    expect(file.type).toBe("file");
    expect(file.size).toBe(5); // "hello"
    expect(typeof file.mtimeMs).toBe("number");
    expect(file.mtimeMs).toBeGreaterThan(0);

    const sub = result.entries.find((e) => e.name === "subdir")!;
    expect(sub.type).toBe("directory");
  });

  it("resolves a cwd-relative path against platform.cwd()", async () => {
    // ls of the platform cwd itself via "." should not throw and return entries.
    const result = (await lsTool.call({ path: "." }, platform, ctx)) as {
      entries: DirEntry[];
      truncated: boolean;
    };
    expect(Array.isArray(result.entries)).toBe(true);
  });
});

describe("ls tool — empty directory", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("returns { entries: [], truncated: false } for an empty dir", async () => {
    const result = await lsTool.call({ path: dir }, platform, ctx);
    expect(result).toEqual({ entries: [], truncated: false });
  });
});

describe("ls tool — errors propagate from listDir", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("throws 'ls: path does not exist: <path>' for a missing path", async () => {
    const missing = join(dir, "no-such-dir");
    await expect(lsTool.call({ path: missing }, platform, ctx)).rejects.toThrow(
      `ls: path does not exist: ${missing}`,
    );
  });

  it("throws 'ls: not a directory: <path>' for a file path", async () => {
    const file = join(dir, "afile.txt");
    await platform.writeFile(file, "x");
    await expect(lsTool.call({ path: file }, platform, ctx)).rejects.toThrow(
      `ls: not a directory: ${file}`,
    );
  });
});

describe("ls tool — cap / truncation", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("respects `limit` and sets truncated:true when the dir has more entries", async () => {
    for (const n of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
      await platform.writeFile(join(dir, n), "x");
    }
    const result = (await lsTool.call({ path: dir, limit: 2 }, platform, ctx)) as {
      entries: DirEntry[];
      truncated: boolean;
    };
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(true);
    // name-asc → first two.
    expect(result.entries.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("does not set truncated when entry count equals limit exactly", async () => {
    await platform.writeFile(join(dir, "a.txt"), "x");
    await platform.writeFile(join(dir, "b.txt"), "x");
    const result = (await lsTool.call({ path: dir, limit: 2 }, platform, ctx)) as {
      entries: DirEntry[];
      truncated: boolean;
    };
    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });
});

describe("ls tool — metadata & exports", () => {
  it("isConcurrencySafe() returns true", () => {
    expect(lsTool.isConcurrencySafe?.({ path: "." })).toBe(true);
  });

  it("is importable from the package index (same reference)", () => {
    expect(lsToolFromIndex).toBe(lsTool);
    expect(globToolFromIndex).toBeDefined();
  });

  describe("Zod input bounds", () => {
    it("rejects limit: 0", () => {
      expect(lsTool.inputSchema.safeParse({ path: ".", limit: 0 }).success).toBe(false);
    });
    it("rejects a non-integer limit", () => {
      expect(lsTool.inputSchema.safeParse({ path: ".", limit: 1.5 }).success).toBe(false);
    });
    it("accepts a valid limit", () => {
      expect(lsTool.inputSchema.safeParse({ path: ".", limit: 10 }).success).toBe(true);
    });
  });
});

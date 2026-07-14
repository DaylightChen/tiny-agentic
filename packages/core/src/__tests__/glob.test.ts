import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { NodePlatform } from "../platform/node.js";
import { globTool } from "../tools/builtin/glob.js";
import { globTool as globToolFromIndex } from "../index.js";
import type { ToolCallContext } from "../types/tool.js";

/**
 * Tests for globTool over a real NodePlatform + temp-dir fixtures. Fixtures are
 * built through platform.exec/writeFile (node:fs is lint-forbidden in
 * __tests__). NODE_ENV="test" makes ordering name-asc/deterministic.
 *
 * Note: globTool delegates display formatting to the Platform. With NodePlatform,
 * temp fixtures outside this NodePlatform's cwd stay absolute; one dedicated case
 * places a fixture under that platform-owned cwd to exercise relative formatting.
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

async function makeTempDirUnderCwd(): Promise<string> {
  const { stdout, exitCode } = await platform.exec(`mktemp -d "${platform.cwd()}/globtest.XXXXXX"`, {
    shell: true,
  });
  if (exitCode !== 0) throw new Error("failed to create temp dir under cwd");
  return stdout.trim();
}

async function removeDir(dir: string): Promise<void> {
  await platform.exec(`rm -rf ${dir}`, { shell: true });
}

async function mkdirp(dir: string): Promise<void> {
  const { exitCode } = await platform.exec(`mkdir -p ${dir}`, { shell: true });
  if (exitCode !== 0) throw new Error(`failed to mkdir -p ${dir}`);
}

function basenames(paths: string[]): string[] {
  return paths.map((p) => p.split("/").pop()!);
}

describe("glob tool — happy path", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("**/*.ts returns matching files, name-asc under test env", async () => {
    await platform.writeFile(join(dir, "a.ts"), "x");
    await mkdirp(join(dir, "sub"));
    await platform.writeFile(join(dir, "sub", "b.ts"), "x");
    await platform.writeFile(join(dir, "c.txt"), "x"); // non-match

    const result = (await globTool.call({ pattern: "**/*.ts", path: dir }, platform, ctx)) as {
      files: string[];
      truncated: boolean;
    };

    expect(result.truncated).toBe(false);
    expect(basenames(result.files)).toEqual(["a.ts", "b.ts"]);
    expect(basenames(result.files)).not.toContain("c.txt");
  });

  it("returns cwd-relative paths for matches under cwd", async () => {
    const under = await makeTempDirUnderCwd();
    try {
      await platform.writeFile(join(under, "hit.ts"), "x");
      const result = (await globTool.call(
        { pattern: "**/*.ts", path: under },
        platform,
        ctx,
      )) as { files: string[]; truncated: boolean };

      expect(result.files).toHaveLength(1);
      const p = result.files[0]!;
      // Under cwd → NodePlatform returns a relative display path.
      expect(p).not.toBe(platform.resolvePath(p));
      expect(p).toBe(platform.formatPath(join(under, "hit.ts")));
    } finally {
      await removeDir(under);
    }
  });
});

describe("glob tool — empty is not an error", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("a pattern matching nothing → { files: [], truncated: false }, no throw", async () => {
    await platform.writeFile(join(dir, "a.txt"), "x");
    const result = await globTool.call({ pattern: "**/*.nomatch", path: dir }, platform, ctx);
    expect(result).toEqual({ files: [], truncated: false });
  });
});

describe("glob tool — toggles", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("respect_gitignore: excludes a .gitignore-d file by default, includes it when false", async () => {
    await platform.writeFile(join(dir, ".gitignore"), "ignored.ts\n");
    await platform.writeFile(join(dir, "ignored.ts"), "x");
    await platform.writeFile(join(dir, "kept.ts"), "x");

    const def = (await globTool.call({ pattern: "**/*.ts", path: dir }, platform, ctx)) as {
      files: string[];
    };
    expect(basenames(def.files)).toEqual(["kept.ts"]);
    expect(basenames(def.files)).not.toContain("ignored.ts");

    const off = (await globTool.call(
      { pattern: "**/*.ts", path: dir, respect_gitignore: false },
      platform,
      ctx,
    )) as { files: string[] };
    expect(basenames(off.files).sort()).toEqual(["ignored.ts", "kept.ts"]);
  });

  it("include_hidden: excludes a dotfile by default, includes it when true", async () => {
    await platform.writeFile(join(dir, ".hidden.ts"), "x");
    await platform.writeFile(join(dir, "visible.ts"), "x");

    const def = (await globTool.call({ pattern: "**/*.ts", path: dir }, platform, ctx)) as {
      files: string[];
    };
    expect(basenames(def.files)).toEqual(["visible.ts"]);
    expect(basenames(def.files)).not.toContain(".hidden.ts");

    const withHidden = (await globTool.call(
      { pattern: "**/*.ts", path: dir, include_hidden: true },
      platform,
      ctx,
    )) as { files: string[] };
    expect(basenames(withHidden.files).sort()).toEqual([".hidden.ts", "visible.ts"]);
  });
});

describe("glob tool — cap / truncation", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("sets truncated:true and caps to `limit` when more than limit match", async () => {
    for (const n of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
      await platform.writeFile(join(dir, n), "x");
    }
    const result = (await globTool.call(
      { pattern: "**/*.ts", path: dir, limit: 2 },
      platform,
      ctx,
    )) as { files: string[]; truncated: boolean };
    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(basenames(result.files)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("glob tool — metadata & exports", () => {
  it("isConcurrencySafe() returns true", () => {
    expect(globTool.isConcurrencySafe?.({ pattern: "*" })).toBe(true);
  });

  it("is importable from the package index (same reference)", () => {
    expect(globToolFromIndex).toBe(globTool);
  });

  describe("Zod input bounds", () => {
    it("rejects limit: 0", () => {
      expect(globTool.inputSchema.safeParse({ pattern: "*", limit: 0 }).success).toBe(false);
    });
    it("accepts full valid input", () => {
      const parsed = globTool.inputSchema.safeParse({
        pattern: "**/*.ts",
        path: "src",
        respect_gitignore: false,
        include_hidden: true,
        limit: 10,
      });
      expect(parsed.success).toBe(true);
    });
  });
});

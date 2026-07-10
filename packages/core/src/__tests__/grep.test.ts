import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join, relative, isAbsolute } from "node:path";

import { NodePlatform } from "../platform/node.js";
import { grepTool } from "../tools/builtin/grep.js";
import { grepTool as grepToolFromIndex } from "../index.js";
import type { ToolCallContext } from "../types/tool.js";

/**
 * Tests for grepTool over a real NodePlatform + temp-dir fixtures. The core lint
 * boundary forbids importing node:fs in __tests__, so fixtures are built through
 * platform.exec / platform.writeFile (mirroring glob.test.ts / fs-discovery.test.ts).
 *
 * grepTool is invoked as call(input, platform, context) — the real Tool.call
 * signature; context carries `signal`. Vitest sets NODE_ENV="test" so ordering
 * is name-asc / deterministic.
 *
 * Returned file paths are relativized against platform.cwd() (the process cwd);
 * temp fixtures live outside cwd so their returned paths are absolute. One case
 * places a fixture UNDER cwd to exercise the cwd-relative branch.
 */
const platform = new NodePlatform();
const ctx: ToolCallContext = {};

// --- result type shapes (mirror §6 discriminated union) ---
type FilesResult = { mode: "files_with_matches"; files: string[]; truncated: boolean };
type CountResult = { mode: "count"; count: number; files: string[]; truncated: boolean };
type ContentEntry = { file: string; line: number; text: string; kind: "match" | "context" };
type ContentResult = { mode: "content"; matches: ContentEntry[]; truncated: boolean };

async function makeTempDir(): Promise<string> {
  const { stdout, exitCode } = await platform.exec("mktemp -d", { shell: true });
  if (exitCode !== 0) throw new Error("failed to create temp dir");
  return stdout.trim();
}

async function makeTempDirUnderCwd(): Promise<string> {
  const { stdout, exitCode } = await platform.exec(
    `mktemp -d "${platform.cwd()}/greptest.XXXXXX"`,
    { shell: true },
  );
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

describe("grep tool — three output modes", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("files_with_matches (default) returns matching files, not non-matching ones", async () => {
    await platform.writeFile(join(dir, "a.txt"), "hello needle world\n");
    await platform.writeFile(join(dir, "b.txt"), "needle again\n");
    await platform.writeFile(join(dir, "c.txt"), "nothing here\n");

    const res = (await grepTool.call({ pattern: "needle", path: dir }, platform, ctx)) as FilesResult;

    expect(res.mode).toBe("files_with_matches");
    expect(res.truncated).toBe(false);
    expect(basenames(res.files).sort()).toEqual(["a.txt", "b.txt"]);
    expect(basenames(res.files)).not.toContain("c.txt");
    // Shape: only mode/files/truncated keys.
    expect(Object.keys(res).sort()).toEqual(["files", "mode", "truncated"]);
  });

  it("content mode returns {file,line,text,kind} with 1-based line numbers", async () => {
    // line 1: alpha, line 2: has needle, line 3: beta
    await platform.writeFile(join(dir, "f.txt"), "alpha\nline with needle\nbeta\n");

    const res = (await grepTool.call(
      { pattern: "needle", path: dir, output_mode: "content" },
      platform,
      ctx,
    )) as ContentResult;

    expect(res.mode).toBe("content");
    expect(res.truncated).toBe(false);
    expect(res.matches).toHaveLength(1);
    const m = res.matches[0]!;
    expect(m.line).toBe(2); // 1-based
    expect(m.text).toBe("line with needle");
    expect(m.kind).toBe("match");
    expect(Object.keys(m).sort()).toEqual(["file", "kind", "line", "text"]);
    expect(Object.keys(res).sort()).toEqual(["matches", "mode", "truncated"]);
  });

  it("count mode returns {mode,count,files,truncated}", async () => {
    await platform.writeFile(join(dir, "a.txt"), "needle\n");
    await platform.writeFile(join(dir, "b.txt"), "needle\n");
    await platform.writeFile(join(dir, "c.txt"), "no match\n");

    const res = (await grepTool.call(
      { pattern: "needle", path: dir, output_mode: "count" },
      platform,
      ctx,
    )) as CountResult;

    expect(res.mode).toBe("count");
    expect(res.count).toBe(2);
    expect(basenames(res.files).sort()).toEqual(["a.txt", "b.txt"]);
    expect(res.truncated).toBe(false);
    expect(Object.keys(res).sort()).toEqual(["count", "files", "mode", "truncated"]);
  });

  it("relativizes returned file paths for matches under cwd (content mode)", async () => {
    const under = await makeTempDirUnderCwd();
    try {
      await platform.writeFile(join(under, "hit.txt"), "needle\n");
      const res = (await grepTool.call(
        { pattern: "needle", path: under, output_mode: "content" },
        platform,
        ctx,
      )) as ContentResult;
      expect(res.matches).toHaveLength(1);
      const f = res.matches[0]!.file;
      expect(isAbsolute(f)).toBe(false);
      expect(f).toBe(relative(platform.cwd(), join(under, "hit.txt")));
    } finally {
      await removeDir(under);
    }
  });
});

describe("grep tool — no match is not an error", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("files_with_matches → empty, truncated:false, no throw", async () => {
    await platform.writeFile(join(dir, "a.txt"), "nothing\n");
    const res = (await grepTool.call({ pattern: "zzz_no_match", path: dir }, platform, ctx)) as FilesResult;
    expect(res).toEqual({ mode: "files_with_matches", files: [], truncated: false });
  });

  it("content → empty matches, truncated:false, no throw", async () => {
    await platform.writeFile(join(dir, "a.txt"), "nothing\n");
    const res = (await grepTool.call(
      { pattern: "zzz_no_match", path: dir, output_mode: "content" },
      platform,
      ctx,
    )) as ContentResult;
    expect(res).toEqual({ mode: "content", matches: [], truncated: false });
  });

  it("count → count:0, truncated:false, no throw", async () => {
    await platform.writeFile(join(dir, "a.txt"), "nothing\n");
    const res = (await grepTool.call(
      { pattern: "zzz_no_match", path: dir, output_mode: "count" },
      platform,
      ctx,
    )) as CountResult;
    expect(res).toEqual({ mode: "count", count: 0, files: [], truncated: false });
  });
});

describe("grep tool — invalid regex", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("throws 'grep: invalid regular expression: <msg>' for an unbalanced group", async () => {
    await platform.writeFile(join(dir, "a.txt"), "x\n");
    await expect(
      grepTool.call({ pattern: "(", path: dir }, platform, ctx),
    ).rejects.toThrow(/^grep: invalid regular expression: /);
  });

  it("surfaces the regex error BEFORE walking (missing path yields regex error, not path error)", async () => {
    // Both the regex and the path are invalid; the regex must be validated first.
    const missing = join(dir, "no-such-path");
    await expect(
      grepTool.call({ pattern: "(", path: missing }, platform, ctx),
    ).rejects.toThrow(/^grep: invalid regular expression: /);
  });
});

describe("grep tool — missing path", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("throws 'grep: path does not exist: <path>' for an explicit missing path", async () => {
    const missing = join(dir, "no-such-path");
    await expect(
      grepTool.call({ pattern: "x", path: missing }, platform, ctx),
    ).rejects.toThrow(`grep: path does not exist: ${missing}`);
  });
});

describe("grep tool — context lines", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("interleaves kind:context with kind:match, ordered by (file,line), 1-based", async () => {
    // 1 alpha, 2 beta, 3 MATCH, 4 gamma, 5 delta
    await platform.writeFile(join(dir, "f.txt"), "alpha\nbeta\nMATCH\ngamma\ndelta\n");
    const res = (await grepTool.call(
      { pattern: "MATCH", path: dir, output_mode: "content", before_context: 1, after_context: 1 },
      platform,
      ctx,
    )) as ContentResult;
    expect(res.matches.map((m) => ({ line: m.line, kind: m.kind, text: m.text }))).toEqual([
      { line: 2, kind: "context", text: "beta" },
      { line: 3, kind: "match", text: "MATCH" },
      { line: 4, kind: "context", text: "gamma" },
    ]);
  });

  it("clamps at BOF (match on line 1, before_context:2 → no line 0/negative)", async () => {
    await platform.writeFile(join(dir, "f.txt"), "MATCH\nb\nc\n");
    const res = (await grepTool.call(
      { pattern: "MATCH", path: dir, output_mode: "content", before_context: 2 },
      platform,
      ctx,
    )) as ContentResult;
    expect(Math.min(...res.matches.map((m) => m.line))).toBeGreaterThanOrEqual(1);
    expect(res.matches.find((m) => m.kind === "match")!.line).toBe(1);
  });

  it("clamps at EOF (match on last line, after_context:2 → no past-EOF lines)", async () => {
    // 1 a, 2 b, 3 MATCH  (last real line)
    await platform.writeFile(join(dir, "f.txt"), "a\nb\nMATCH\n");
    const res = (await grepTool.call(
      { pattern: "MATCH", path: dir, output_mode: "content", after_context: 2 },
      platform,
      ctx,
    )) as ContentResult;
    // No line number beyond the last content line (3); the trailing split "" is line 4 at most.
    expect(Math.max(...res.matches.map((m) => m.line))).toBeLessThanOrEqual(4);
    // The match itself is at line 3.
    expect(res.matches.find((m) => m.kind === "match")!.line).toBe(3);
  });

  it("context overrides before_context/after_context (symmetric window)", async () => {
    // 1 a, 2 b, 3 c, 4 MATCH, 5 e, 6 f, 7 g
    await platform.writeFile(join(dir, "f.txt"), "a\nb\nc\nMATCH\ne\nf\ng\n");
    const res = (await grepTool.call(
      {
        pattern: "MATCH",
        path: dir,
        output_mode: "content",
        before_context: 1,
        after_context: 3,
        context: 2, // must win → symmetric window of 2 each
      },
      platform,
      ctx,
    )) as ContentResult;
    expect(res.matches.map((m) => m.line)).toEqual([2, 3, 4, 5, 6]);
    expect(res.matches.find((m) => m.kind === "match")!.line).toBe(4);
  });
});

describe("grep tool — window merge", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("overlapping windows emit each shared line once; a match inside another's window stays match", async () => {
    // MATCH at lines 2 and 4; before/after 1 → windows overlap on line 3.
    await platform.writeFile(join(dir, "f.txt"), "l1\nMATCH\nl3\nMATCH\nl5\n");
    const res = (await grepTool.call(
      { pattern: "MATCH", path: dir, output_mode: "content", before_context: 1, after_context: 1 },
      platform,
      ctx,
    )) as ContentResult;
    expect(res.matches.map((m) => ({ line: m.line, kind: m.kind }))).toEqual([
      { line: 1, kind: "context" },
      { line: 2, kind: "match" },
      { line: 3, kind: "context" },
      { line: 4, kind: "match" },
      { line: 5, kind: "context" },
    ]);
    // No duplicate line numbers.
    const nums = res.matches.map((m) => m.line);
    expect(new Set(nums).size).toBe(nums.length);
  });
});

describe("grep tool — cap interaction", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("limit counts match lines only — N matches with full context retained", async () => {
    // 3 matches, but limit:2 → 2 match entries; context still present.
    await platform.writeFile(join(dir, "f.txt"), "a\nMATCH\nc\nd\nMATCH\nf\ng\nMATCH\ni\n");
    const res = (await grepTool.call(
      {
        pattern: "MATCH",
        path: dir,
        output_mode: "content",
        before_context: 1,
        after_context: 1,
        limit: 2,
      },
      platform,
      ctx,
    )) as ContentResult;
    const matchCount = res.matches.filter((m) => m.kind === "match").length;
    expect(matchCount).toBe(2);
    // Context present (more than the 2 match entries) → context did not consume budget.
    expect(res.matches.length).toBeGreaterThan(2);
  });

  it("per-line text > 500 chars is truncated with a … marker", async () => {
    const longLine = "needle" + "x".repeat(600);
    await platform.writeFile(join(dir, "f.txt"), longLine + "\n");
    const res = (await grepTool.call(
      { pattern: "needle", path: dir, output_mode: "content" },
      platform,
      ctx,
    )) as ContentResult;
    expect(res.matches).toHaveLength(1);
    const text = res.matches[0]!.text;
    expect(text.length).toBeLessThan(longLine.length);
    expect(text).toContain("…");
    expect(text.length).toBeLessThanOrEqual(501); // 500 chars + marker
  });

  it("20000-char guard sets truncated:true and truncates at a match boundary", async () => {
    // Many matching lines, each long enough that the total blows past 20_000 chars.
    // Each line ~300 chars → ~100 lines to exceed the guard.
    const lines: string[] = [];
    for (let i = 0; i < 200; i++) {
      lines.push("needle_" + i + "_" + "y".repeat(280));
    }
    await platform.writeFile(join(dir, "f.txt"), lines.join("\n") + "\n");
    const res = (await grepTool.call(
      { pattern: "needle", path: dir, output_mode: "content" },
      platform,
      ctx,
    )) as ContentResult;
    expect(res.truncated).toBe(true);
    // Fewer than all 200 matches emitted.
    expect(res.matches.length).toBeLessThan(200);
    // Match boundary: the tail is not a dangling context-only entry.
    expect(res.matches[res.matches.length - 1]!.kind).toBe("match");
  });
});

describe("grep tool — binary skip", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("excludes a NUL-byte file (no garbage lines) but keeps text files", async () => {
    await platform.exec(`printf 'a\\0b' > ${join(dir, "bin.dat")}`, { shell: true });
    await platform.writeFile(join(dir, "text.txt"), "ab\n");

    const res = (await grepTool.call({ pattern: "a", path: dir }, platform, ctx)) as FilesResult;
    expect(basenames(res.files)).toContain("text.txt");
    expect(basenames(res.files)).not.toContain("bin.dat");
  });
});

describe("grep tool — toggles", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("respect_gitignore: excludes gitignored file by default, includes with false", async () => {
    await platform.writeFile(join(dir, ".gitignore"), "ignored.txt\n");
    await platform.writeFile(join(dir, "ignored.txt"), "needle\n");
    await platform.writeFile(join(dir, "kept.txt"), "needle\n");

    const def = (await grepTool.call({ pattern: "needle", path: dir }, platform, ctx)) as FilesResult;
    expect(basenames(def.files)).toEqual(["kept.txt"]);

    const off = (await grepTool.call(
      { pattern: "needle", path: dir, respect_gitignore: false },
      platform,
      ctx,
    )) as FilesResult;
    expect(basenames(off.files).sort()).toEqual(["ignored.txt", "kept.txt"]);
  });

  it("include_hidden: excludes dotfile by default, includes with true", async () => {
    await platform.writeFile(join(dir, ".hidden.txt"), "needle\n");
    await platform.writeFile(join(dir, "visible.txt"), "needle\n");

    const def = (await grepTool.call({ pattern: "needle", path: dir }, platform, ctx)) as FilesResult;
    expect(basenames(def.files)).toEqual(["visible.txt"]);

    const withHidden = (await grepTool.call(
      { pattern: "needle", path: dir, include_hidden: true },
      platform,
      ctx,
    )) as FilesResult;
    expect(basenames(withHidden.files).sort()).toEqual([".hidden.txt", "visible.txt"]);
  });

  it("a .git/ path never appears even with respect_gitignore:false and include_hidden:true", async () => {
    await mkdirp(join(dir, ".git"));
    await platform.writeFile(join(dir, ".git", "config"), "needle\n");
    await platform.writeFile(join(dir, "real.txt"), "needle\n");

    const res = (await grepTool.call(
      { pattern: "needle", path: dir, respect_gitignore: false, include_hidden: true },
      platform,
      ctx,
    )) as FilesResult;
    expect(basenames(res.files)).toContain("real.txt");
    expect(basenames(res.files)).not.toContain("config");
  });
});

describe("grep tool — case_insensitive", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("case_insensitive:true matches regardless of case; default is case-sensitive", async () => {
    await platform.writeFile(join(dir, "f.txt"), "NEEDLE\n");

    const sensitive = (await grepTool.call({ pattern: "needle", path: dir }, platform, ctx)) as FilesResult;
    expect(sensitive.files).toHaveLength(0);

    const insensitive = (await grepTool.call(
      { pattern: "needle", path: dir, case_insensitive: true },
      platform,
      ctx,
    )) as FilesResult;
    expect(basenames(insensitive.files)).toEqual(["f.txt"]);
  });
});

describe("grep tool — metadata & exports", () => {
  it("isConcurrencySafe() returns true", () => {
    expect(grepTool.isConcurrencySafe?.({ pattern: "x" })).toBe(true);
  });

  it("is importable from the package index (same reference)", () => {
    expect(grepToolFromIndex).toBe(grepTool);
  });

  describe("Zod input bounds", () => {
    it("rejects limit: 0", () => {
      expect(grepTool.inputSchema.safeParse({ pattern: "x", limit: 0 }).success).toBe(false);
    });
    it("rejects a non-enum output_mode", () => {
      expect(grepTool.inputSchema.safeParse({ pattern: "x", output_mode: "bogus" }).success).toBe(
        false,
      );
    });
    it("accepts full valid input", () => {
      const parsed = grepTool.inputSchema.safeParse({
        pattern: "needle",
        path: "src",
        glob: "*.ts",
        output_mode: "content",
        case_insensitive: true,
        respect_gitignore: false,
        include_hidden: true,
        before_context: 1,
        after_context: 2,
        context: 3,
        limit: 10,
      });
      expect(parsed.success).toBe(true);
    });
  });
});

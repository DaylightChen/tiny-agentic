import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";

import { NodePlatform } from "../platform/node.js";

/**
 * Tests for the shared recursive directory walk backing both glob and grep
 * (packages/core/src/platform/fs-discovery.ts, wired through NodePlatform).
 *
 * The core lint boundary forbids importing node:fs in this package (including
 * __tests__). Fixtures are therefore built through NodePlatform's own
 * primitives — platform.exec("mkdir -p …" / "ln -s …" / "printf …") and
 * platform.writeFile — mirroring node.test.ts (task-01).
 *
 * Vitest sets NODE_ENV="test", so fs-discovery sorts name-asc deterministically.
 */
const platform = new NodePlatform();

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

function basenames(paths: string[]): string[] {
  return paths.map((p) => p.split("/").pop()!);
}

describe("fs-discovery — single shared walk", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("glob and grep return the same file SET given equivalent options", async () => {
    await platform.writeFile(join(dir, "a.txt"), "needle here\n");
    await platform.writeFile(join(dir, "b.txt"), "needle again\n");
    await mkdirp(join(dir, "sub"));
    await platform.writeFile(join(dir, "sub", "c.txt"), "needle nested\n");

    const globRes = await platform.glob("**/*.txt", { cwd: dir });
    // "." matches any non-empty line, so grep visits the same file set that glob
    // enumerated (all files match).
    const grepRes = await platform.grep(".", "", { cwd: dir });

    expect(new Set(globRes.paths)).toEqual(new Set(grepRes.files));
    expect(basenames(globRes.paths).sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
  });
});

describe("fs-discovery — nested .gitignore (hierarchical)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("(a) a file ignored only by a subdir .gitignore is excluded", async () => {
    await mkdirp(join(dir, "sub"));
    await platform.writeFile(join(dir, "keep.txt"), "x");
    await platform.writeFile(join(dir, "sub", "keep.txt"), "x");
    await platform.writeFile(join(dir, "sub", "drop.txt"), "x");
    // Only the subdir ignores drop.txt.
    await platform.writeFile(join(dir, "sub", ".gitignore"), "drop.txt\n");

    const res = await platform.glob("**/*.txt", { cwd: dir });
    const names = res.paths.map((p) => p.slice(dir.length + 1));
    expect(names.sort()).toEqual(["keep.txt", "sub/keep.txt"]);
    expect(names).not.toContain("sub/drop.txt");
  });

  it("(b) a deeper !negation re-includes a file a shallower .gitignore ignored", async () => {
    await mkdirp(join(dir, "sub"));
    // Root ignores every .log file.
    await platform.writeFile(join(dir, ".gitignore"), "*.log\n");
    // Deeper .gitignore re-includes keep.log.
    await platform.writeFile(join(dir, "sub", ".gitignore"), "!keep.log\n");
    await platform.writeFile(join(dir, "sub", "keep.log"), "x");
    await platform.writeFile(join(dir, "sub", "other.log"), "x");
    await platform.writeFile(join(dir, "top.log"), "x");

    const res = await platform.glob("**/*.log", { cwd: dir });
    const names = res.paths.map((p) => p.slice(dir.length + 1)).sort();

    // Deepest-frame-first: sub/keep.log re-included; sub/other.log and top.log
    // stay ignored by the root *.log rule.
    expect(names).toEqual(["sub/keep.log"]);
  });

  it("(c) a .git/ path is pruned even with respectGitignore:false", async () => {
    await mkdirp(join(dir, ".git", "objects"));
    await platform.writeFile(join(dir, ".git", "config"), "x");
    await platform.writeFile(join(dir, ".git", "objects", "blob"), "x");
    await platform.writeFile(join(dir, "real.txt"), "x");

    const res = await platform.glob("**/*", {
      cwd: dir,
      respectGitignore: false,
      includeHidden: true,
    });
    const names = res.paths.map((p) => p.slice(dir.length + 1));
    expect(names).not.toContain(".git/config");
    expect(names).not.toContain(".git/objects/blob");
    expect(names).toContain("real.txt");
  });
});

describe("fs-discovery — hidden files", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("excludes dotfiles by default, includes them with includeHidden:true", async () => {
    await platform.writeFile(join(dir, "visible.txt"), "x");
    await platform.writeFile(join(dir, ".hidden.txt"), "x");
    await mkdirp(join(dir, ".hiddendir"));
    await platform.writeFile(join(dir, ".hiddendir", "inside.txt"), "x");

    const def = await platform.glob("**/*.txt", { cwd: dir });
    expect(basenames(def.paths).sort()).toEqual(["visible.txt"]);

    const hidden = await platform.glob("**/*.txt", { cwd: dir, includeHidden: true });
    expect(basenames(hidden.paths).sort()).toEqual([
      ".hidden.txt",
      "inside.txt",
      "visible.txt",
    ]);
  });
});

describe("fs-discovery — symlinks", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("does not descend a self-referential symlinked directory (no infinite loop)", async () => {
    await mkdirp(join(dir, "realdir"));
    await platform.writeFile(join(dir, "realdir", "file.txt"), "x");
    // A symlink pointing back at its own parent — a cycle if descended.
    await platform.exec(`ln -s ${dir} ${join(dir, "loop")}`, { shell: true });

    // Must terminate quickly; if the walk descended the symlink it would recurse
    // forever (test timeout / ENAMETOOLONG).
    const res = await platform.glob("**/*.txt", { cwd: dir });
    expect(basenames(res.paths)).toContain("file.txt");
  });

  it("lists a symlinked file as an entry", async () => {
    await platform.writeFile(join(dir, "target.txt"), "hello");
    await platform.exec(`ln -s ${join(dir, "target.txt")} ${join(dir, "link.txt")}`, {
      shell: true,
    });

    const res = await platform.glob("*.txt", { cwd: dir });
    expect(basenames(res.paths).sort()).toEqual(["link.txt", "target.txt"]);
  });

  it("excludes a symlink whose target is a directory from glob results", async () => {
    await mkdirp(join(dir, "target-dir"));
    await platform.exec(`ln -s ${join(dir, "target-dir")} ${join(dir, "dir-link")}`, {
      shell: true,
    });

    const res = await platform.glob("**/*", { cwd: dir });
    expect(basenames(res.paths)).not.toContain("dir-link");
  });

  it("excludes a broken symlink from glob results", async () => {
    await platform.exec(`ln -s ${join(dir, "missing-target")} ${join(dir, "broken-link")}`, {
      shell: true,
    });

    const res = await platform.glob("**/*", { cwd: dir });
    expect(basenames(res.paths)).not.toContain("broken-link");
  });
});

describe("fs-discovery — ordering", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await removeDir(dir);
  });

  it("returns test-mode glob and grep paths ascending regardless of mtime", async () => {
    for (const n of ["a-old.txt", "z-new.txt", "m-middle.txt"]) {
      await platform.writeFile(join(dir, n), "needle\n");
    }
    const { exitCode } = await platform.exec(
      `touch -t 202001010000 ${join(dir, "a-old.txt")} && ` +
        `touch -t 202201010000 ${join(dir, "m-middle.txt")} && ` +
        `touch -t 202401010000 ${join(dir, "z-new.txt")}`,
      { shell: true },
    );
    expect(exitCode).toBe(0);

    const glob = await platform.glob("*.txt", { cwd: dir });
    const grep = await platform.grep("needle", "", { cwd: dir });

    expect(basenames(glob.paths)).toEqual(["a-old.txt", "m-middle.txt", "z-new.txt"]);
    expect(basenames(grep.files)).toEqual(["a-old.txt", "m-middle.txt", "z-new.txt"]);
  });

  it("orders production glob and grep by descending mtime with an ascending full-path tie", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const relativePath of ["z-old.txt", "sub/b-tied.txt", "sub/a-tied.txt"]) {
      const slash = relativePath.lastIndexOf("/");
      if (slash !== -1) await mkdirp(join(dir, relativePath.slice(0, slash)));
      await platform.writeFile(join(dir, relativePath), "needle\n");
    }
    const { exitCode } = await platform.exec(
      `touch -t 202001010000 ${join(dir, "z-old.txt")} && ` +
        `touch -t 202401010000 ${join(dir, "sub/b-tied.txt")} ${join(dir, "sub/a-tied.txt")}`,
      { shell: true },
    );
    expect(exitCode).toBe(0);

    const glob = await platform.glob("**/*.txt", { cwd: dir });
    const grep = await platform.grep("needle", "", { cwd: dir });
    const expected = [
      join(dir, "sub/a-tied.txt"),
      join(dir, "sub/b-tied.txt"),
      join(dir, "z-old.txt"),
    ];

    expect(glob.paths).toEqual(expected);
    expect(grep.files).toEqual(expected);
  });
});

describe("fs-discovery — caps", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("respects limit and sets truncated:true when more matched than limit", async () => {
    for (const n of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
      await platform.writeFile(join(dir, n), "x");
    }
    const res = await platform.glob("*.txt", { cwd: dir, limit: 2 });
    expect(res.paths).toHaveLength(2);
    expect(res.truncated).toBe(true);
    // name-asc → first two.
    expect(basenames(res.paths)).toEqual(["a.txt", "b.txt"]);
  });

  it("empty result → truncated:false and never throws", async () => {
    const res = await platform.glob("*.nomatch", { cwd: dir });
    expect(res.paths).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  it("does not set truncated when count equals limit exactly", async () => {
    await platform.writeFile(join(dir, "a.txt"), "x");
    await platform.writeFile(join(dir, "b.txt"), "x");
    const res = await platform.glob("*.txt", { cwd: dir, limit: 2 });
    expect(res.paths).toHaveLength(2);
    expect(res.truncated).toBe(false);
  });
});

describe("fs-discovery — grep content + context", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("interleaves match/context entries with correct 1-based line numbers", async () => {
    // lines (1-based): 1 alpha, 2 beta, 3 MATCH, 4 gamma, 5 delta
    await platform.writeFile(
      join(dir, "f.txt"),
      "alpha\nbeta\nMATCH\ngamma\ndelta\n",
    );
    const res = await platform.grep("MATCH", "", {
      cwd: dir,
      contentMode: true,
      before: 1,
      after: 1,
    });
    expect(res.matches).toBeDefined();
    expect(res.matches!.map((m) => ({ line: m.line, kind: m.kind, text: m.text }))).toEqual([
      { line: 2, kind: "context", text: "beta" },
      { line: 3, kind: "match", text: "MATCH" },
      { line: 4, kind: "context", text: "gamma" },
    ]);
  });

  it("clamps context windows at BOF and EOF", async () => {
    // MATCH on line 1 and last line.
    // "MATCH\nb\nc\nMATCH\n".split("\n") → ["MATCH","b","c","MATCH",""] (5 lines).
    await platform.writeFile(join(dir, "f.txt"), "MATCH\nb\nc\nMATCH\n");
    const res = await platform.grep("MATCH", "", {
      cwd: dir,
      contentMode: true,
      before: 2,
      after: 2,
    });
    const lines = res.matches!.map((m) => m.line);
    // Clamped: no line < 1 and no line beyond total line count (5 incl trailing split).
    expect(Math.min(...lines)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...lines)).toBeLessThanOrEqual(5);
    // Matches at 1-based lines 1 and 4 present with kind "match".
    const matchLines = res.matches!.filter((m) => m.kind === "match").map((m) => m.line);
    expect(matchLines.sort((a, b) => a - b)).toEqual([1, 4]);
  });

  it("merges overlapping windows — each line once, match stays match", async () => {
    // MATCH at lines 2 and 4; with before/after 1 their windows overlap on line 3.
    await platform.writeFile(join(dir, "f.txt"), "l1\nMATCH\nl3\nMATCH\nl5\n");
    const res = await platform.grep("MATCH", "", {
      cwd: dir,
      contentMode: true,
      before: 1,
      after: 1,
    });
    const entries = res.matches!.map((m) => ({ line: m.line, kind: m.kind }));
    // Lines 1..5 each appear exactly once; 2 and 4 are matches.
    expect(entries).toEqual([
      { line: 1, kind: "context" },
      { line: 2, kind: "match" },
      { line: 3, kind: "context" },
      { line: 4, kind: "match" },
      { line: 5, kind: "context" },
    ]);
    // No duplicate line numbers.
    const nums = entries.map((e) => e.line);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it("limit counts match lines only — context does not consume the budget", async () => {
    // 2 matches, each with 1 before + 1 after context = up to 6 emitted lines,
    // but limit:2 counts only the 2 matches, so both matches + their context stay.
    await platform.writeFile(join(dir, "f.txt"), "a\nMATCH\nc\nd\nMATCH\nf\n");
    const res = await platform.grep("MATCH", "", {
      cwd: dir,
      contentMode: true,
      before: 1,
      after: 1,
      limit: 2,
    });
    const matchCount = res.matches!.filter((m) => m.kind === "match").length;
    expect(matchCount).toBe(2);
    // Context lines present (>2 total entries) proves they didn't consume budget.
    expect(res.matches!.length).toBeGreaterThan(2);
    expect(res.truncated).toBe(false);
  });
});

describe("fs-discovery — binary skip", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("excludes a file containing a NUL byte from grep results", async () => {
    // printf writes a real NUL byte between 'a' and 'b'.
    await platform.exec(`printf 'a\\0b' > ${join(dir, "bin.dat")}`, { shell: true });
    await platform.writeFile(join(dir, "text.txt"), "ab\n");

    const res = await platform.grep("a", "", { cwd: dir });
    expect(basenames(res.files)).toContain("text.txt");
    expect(basenames(res.files)).not.toContain("bin.dat");
  });
});

describe("fs-discovery — cancellation & missing base", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("glob rejects promptly with an already-aborted signal", async () => {
    await platform.writeFile(join(dir, "a.txt"), "x");
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(platform.glob("*.txt", { cwd: dir, signal: ctrl.signal })).rejects.toThrow();
  });

  it("grep rejects promptly with an already-aborted signal", async () => {
    await platform.writeFile(join(dir, "a.txt"), "x");
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(platform.grep("x", "", { cwd: dir, signal: ctrl.signal })).rejects.toThrow();
  });

  it("glob rejects with 'glob: base directory does not exist: …' for a missing base", async () => {
    const missing = join(dir, "no-such-dir");
    await expect(platform.glob("*", { cwd: missing })).rejects.toThrow(
      `glob: base directory does not exist: ${missing}`,
    );
  });

  it("glob reports when the base path exists but is not a directory", async () => {
    const file = join(dir, "file.txt");
    await platform.writeFile(file, "x");
    await expect(platform.glob("*", { cwd: file })).rejects.toThrow(
      `glob: base path is not a directory: ${file}`,
    );
  });
});

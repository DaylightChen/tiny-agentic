import { readdir, lstat, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import picomatch from "picomatch";
import type {
  GlobOptions,
  GlobResult,
  GrepOptions,
  GrepMatch,
  GrepPlatformResult,
} from "../types/platform.js";

/** Directories never descended, regardless of gitignore toggles. */
const VCS_DIRS = new Set([".git", ".svn", ".hg", ".jj", ".sl", ".bzr"]);

/** How many leading bytes of a file to sniff for a NUL byte (binary marker). */
const BINARY_SNIFF_BYTES = 8192;

type WalkedFile = {
  /** Absolute path. */
  path: string;
  mtimeMs: number;
};

type WalkOptions = {
  respectGitignore: boolean;
  includeHidden: boolean;
  signal?: AbortSignal;
};

type IgnoreFrame = {
  dir: string;
  matcher: ignore.Ignore;
};

class AbortError extends Error {
  constructor() {
    super("The operation was aborted");
    this.name = "AbortError";
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortError();
}

/** True when a path is a dotfile/dotdir (hidden by basename). */
function isHidden(name: string): boolean {
  return name.startsWith(".");
}

/**
 * Hierarchical git-style precedence: evaluate frames deepest-first. The first
 * frame that has an opinion (a rule matched — `ignored` or `unignored`) decides,
 * so a deeper `!`-negation re-includes a file a shallower `.gitignore` excluded,
 * exactly as git does. `ignore` matches relative to each frame's directory.
 */
function isIgnored(stack: IgnoreFrame[], absPath: string): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i]!;
    const rel = relative(frame.dir, absPath);
    if (!rel) continue;
    // `rel` is always inside frame.dir here (frames sit on the entry's ancestor
    // path), so no `..` prefix. Normalize separators for `ignore`.
    const result = frame.matcher.test(rel.split(sep).join("/"));
    if (result.ignored) return true;
    if (result.unignored) return false;
  }
  return false;
}

async function readGitignoreFrame(dir: string): Promise<IgnoreFrame | undefined> {
  let contents: string;
  try {
    contents = await readFile(join(dir, ".gitignore"), "utf-8");
  } catch {
    return undefined;
  }
  return { dir, matcher: ignore().add(contents) };
}

/**
 * The single shared recursive walk backing both glob and grep. Yields every
 * non-ignored regular file (and symlinked files) under `rootDir`, depth-first.
 * Symlinked directories are not descended (prevents infinite loops).
 * Permission errors on a subdirectory skip that subtree silently.
 */
async function* walk(
  rootDir: string,
  options: WalkOptions,
  stack: IgnoreFrame[] = [],
): AsyncGenerator<WalkedFile> {
  throwIfAborted(options.signal);

  const frame = options.respectGitignore ? await readGitignoreFrame(rootDir) : undefined;
  if (frame) stack.push(frame);

  try {
    let entries;
    try {
      entries = await readdir(rootDir, { withFileTypes: true });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      // Skip unreadable subtrees silently; a directly-targeted unreadable root
      // is rejected earlier by the glob/grep entry, not here.
      if (code === "EACCES" || code === "EPERM") return;
      throw err;
    }

    for (const entry of entries) {
      throwIfAborted(options.signal);
      const name = entry.name;
      const abs = join(rootDir, name);

      if (entry.isDirectory()) {
        if (VCS_DIRS.has(name)) continue;
        if (!options.includeHidden && isHidden(name)) continue;
        if (isIgnored(stack, abs)) continue;
        yield* walk(abs, options, stack);
        continue;
      }

      // Do not descend symlinked directories; symlinked files are listed as
      // regular entries. A symlink whose target is a file falls through here.
      if (entry.isSymbolicLink()) {
        let stats;
        try {
          stats = await lstat(abs);
        } catch {
          continue;
        }
        // isSymbolicLink() from lstat is always true; resolve the target type.
        if (!options.includeHidden && isHidden(name)) continue;
        if (isIgnored(stack, abs)) continue;
        yield { path: abs, mtimeMs: stats.mtimeMs };
        continue;
      }

      if (!entry.isFile()) continue;
      if (!options.includeHidden && isHidden(name)) continue;
      if (isIgnored(stack, abs)) continue;

      let stats;
      try {
        stats = await lstat(abs);
      } catch {
        continue;
      }
      yield { path: abs, mtimeMs: stats.mtimeMs };
    }
  } finally {
    if (frame) stack.pop();
  }
}

/**
 * Ordering: mtime-desc in production, name-asc under NODE_ENV==='test' for
 * deterministic snapshots. `process` is permitted inside platform/**.
 */
function sortWalked(files: WalkedFile[]): WalkedFile[] {
  if (process.env.NODE_ENV === "test") {
    return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  return [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function resolveWalkOptions(o: {
  respectGitignore?: boolean;
  includeHidden?: boolean;
  signal?: AbortSignal;
}): WalkOptions {
  return {
    respectGitignore: o.respectGitignore ?? true,
    includeHidden: o.includeHidden ?? false,
    ...(o.signal !== undefined ? { signal: o.signal } : {}),
  };
}

// --- glob -------------------------------------------------------------------

export async function globImpl(
  cwd: string,
  pattern: string,
  options: GlobOptions = {},
): Promise<GlobResult> {
  const base = resolve(options.cwd ?? cwd);

  let baseStats;
  try {
    baseStats = await lstat(base);
  } catch {
    throw new Error(`glob: base directory does not exist: ${base}`);
  }
  if (!baseStats.isDirectory()) {
    throw new Error(`glob: base directory does not exist: ${base}`);
  }

  const isMatch = picomatch(pattern, { dot: options.includeHidden ?? false });

  const matched: WalkedFile[] = [];
  for await (const file of walk(base, resolveWalkOptions(options))) {
    const rel = relative(base, file.path).split(sep).join("/");
    if (isMatch(rel)) matched.push(file);
  }

  const sorted = sortWalked(matched);
  const limit = options.limit;
  const truncated = limit !== undefined && sorted.length > limit;
  const capped = limit !== undefined ? sorted.slice(0, limit) : sorted;
  return { paths: capped.map((f) => f.path), truncated };
}

// --- grep -------------------------------------------------------------------

/** A file looks binary if a NUL byte appears in the first sniff window. */
function looksBinary(buf: string): boolean {
  const end = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (buf.charCodeAt(i) === 0) return true;
  }
  return false;
}

function capLine(text: string, maxLineLength: number | undefined): string {
  if (maxLineLength !== undefined && text.length > maxLineLength) {
    return text.slice(0, maxLineLength) + "…";
  }
  return text;
}

type ContentEntry = { line: number; kind: "match" | "context" };

export async function grepImpl(
  cwd: string,
  source: string,
  flags: string,
  options: GrepOptions = {},
): Promise<GrepPlatformResult> {
  const regex = new RegExp(source, flags);

  const rootRaw = options.path ?? options.cwd ?? cwd;
  const root = resolve(options.cwd ?? cwd, options.path ?? ".");

  let rootStats;
  try {
    rootStats = await lstat(root);
  } catch {
    throw new Error(`grep: path does not exist: ${rootRaw}`);
  }

  const nameMatch = options.glob ? picomatch(options.glob) : undefined;

  // Enumerate candidate files. A directly-targeted single file bypasses the
  // walk (its ignore/hidden status is the caller's explicit choice).
  const candidates: WalkedFile[] = [];
  if (rootStats.isFile()) {
    candidates.push({ path: root, mtimeMs: rootStats.mtimeMs });
  } else {
    for await (const file of walk(root, resolveWalkOptions(options))) {
      candidates.push(file);
    }
  }

  const contentMode = options.contentMode === true;
  const before = contentMode ? options.before ?? 0 : 0;
  const after = contentMode ? options.after ?? 0 : 0;
  const limit = options.limit;

  const sorted = sortWalked(candidates);

  const files: string[] = [];
  const matches: GrepMatch[] = [];
  let matchLineCount = 0;
  let truncated = false;

  for (const file of sorted) {
    throwIfAborted(options.signal);
    if (nameMatch && !nameMatch(relative(root, file.path).split(sep).join("/"))) continue;

    let contents: string;
    try {
      contents = await readFile(file.path, "utf-8");
    } catch {
      continue;
    }
    if (looksBinary(contents)) continue;

    const lines = contents.split("\n");

    if (!contentMode) {
      // files_with_matches / count mode: first match per file is enough.
      let hit = false;
      for (const line of lines) {
        regex.lastIndex = 0;
        if (regex.test(line)) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
      if (limit !== undefined && files.length >= limit) {
        truncated = true;
        break;
      }
      files.push(file.path);
      continue;
    }

    // content mode: collect match lines, then expand + merge context windows.
    const matchLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i]!)) matchLines.push(i);
    }
    if (matchLines.length === 0) continue;

    // limit counts MATCH lines only; stop at the file that would overflow.
    if (limit !== undefined && matchLineCount + matchLines.length > limit) {
      truncated = true;
      const remaining = limit - matchLineCount;
      if (remaining <= 0) break;
      matchLines.length = remaining;
    }

    files.push(file.path);
    matchLineCount += matchLines.length;

    const merged = mergeWindows(matchLines, before, after, lines.length);
    for (const entry of merged) {
      matches.push({
        file: file.path,
        line: entry.line + 1, // 1-based
        text: capLine(lines[entry.line]!, options.maxLineLength),
        kind: entry.kind,
      });
    }

    if (truncated) break;
  }

  const result: GrepPlatformResult = { files, truncated };
  if (contentMode) result.matches = matches;
  return result;
}

/**
 * Expand each match into its [line-before, line+after] window, clamp at
 * BOF/EOF, and merge overlapping/adjacent windows so each physical line appears
 * once. A line that is itself a match stays kind:"match" even inside another
 * match's context window. Result is ordered by line (0-based indices).
 */
function mergeWindows(
  matchLines: number[],
  before: number,
  after: number,
  totalLines: number,
): ContentEntry[] {
  const isMatch = new Set(matchLines);
  const included = new Set<number>();
  for (const m of matchLines) {
    const start = Math.max(0, m - before);
    const end = Math.min(totalLines - 1, m + after);
    for (let i = start; i <= end; i++) included.add(i);
  }
  const ordered = [...included].sort((a, b) => a - b);
  return ordered.map((line) => ({ line, kind: isMatch.has(line) ? "match" : "context" }));
}

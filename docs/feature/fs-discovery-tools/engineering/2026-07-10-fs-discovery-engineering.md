# Engineering Spec — Filesystem Discovery Tools (`ls` / `glob` / `grep`)

**Scope:** `feature/fs-discovery-tools` (Tier-1 #1, `docs/project/core-roadmap.md`)
**Phase:** engineering (combined product + engineering — standard feature pipeline)
**Date:** 2026-07-10
**Author:** feature-architect
**Upstream input:** `docs/feature/fs-discovery-tools/research/2026-07-10-fs-discovery-research.md` (evidence only; this doc makes the decisions)
**Binding for:** the `planner` (task breakdown) and the implement phase.

---

## 1. Goal

Give the headless core agent the ability to **find** things on the filesystem — not just read/write/edit paths it already knows. Three new read-only built-in tools land in `packages/core`:

- **`ls`** — list a directory's immediate entries (name, type, size, mtime).
- **`glob`** — find files by glob pattern (e.g. `src/**/*.ts`), most-recently-modified first.
- **`grep`** — search file *contents* by regular expression, returning matching files (and optionally matching lines).

They are structured, permission-gate-friendly alternatives to shelling out through `bash`, so a consumer who denies `bash` (the most common approval-policy stance) still gets full discovery. All three are read-only and declare `isConcurrencySafe() => true`, teeing up Tier-2 #5 (concurrent tool execution). The backing filesystem work enters through **new `Platform` methods** implemented in pure JS, preserving the browser-portability goal.

## 2. Motivation

The roadmap calls this "the standout gap": *"the agent can read/write/edit files whose paths it already knows, but it cannot find anything except by shelling out through `bash`."* Discovery — "grep for X, glob for Y, read the hits" — is most of what makes a coding agent useful. Today the only path is `bash`, which:

1. Is the tool consumers most often **deny** to block shell access — so denying shell today also blinds the agent to discovery.
2. Returns unstructured, uncapped text that easily floods the model's context window.
3. Requires shell availability (no browser/mock-platform story).

Dedicated structured tools fix all three. This is also the long-anticipated breaking `Platform` change the M1 decision log explicitly reserved for M2 (2026-06-27, "Platform M1 method set").

## 3. User-visible behavior

The "user" here is **the model** (tool caller) and, transitively, the consumer wiring tools into `new Agent({ tools })`. There is no human-facing UI — output is JSON-serializable structured data in the tool result (headless boundary, decision 2026-06-26).

### 3.1 Primary flow

A typical discovery loop the model performs, unattended:

1. **`grep`** `{ pattern: "class \\w+Platform", output_mode: "files_with_matches" }` → `{ mode: "files_with_matches", files: ["packages/core/src/platform/node.ts", ...], truncated: false }`.
2. Model picks a hit and **`grep`**s again with `{ pattern: "...", path: "packages/core/src", output_mode: "content", -n: true }` → `{ mode: "content", matches: [{ file, line, text }, ...], truncated }`.
3. Or **`glob`** `{ pattern: "**/*.test.ts" }` → `{ files: [...mtime-desc...], truncated }`, then `read_file` each hit.
4. **`ls`** `{ path: "packages/core/src/tools/builtin" }` → `{ entries: [{ name, type, size, mtime }, ...], truncated }` to orient in a directory.

Paths accepted on input may be **absolute or cwd-relative** (resolved against `platform.cwd()`). Paths returned are **cwd-relative** when under cwd, else absolute — to save tokens (mirrors the reference).

### 3.2 States matrix

Each tool returns a structured object; there is no loading/offline UI. The behavioral variants:

| Variant | `ls` | `glob` | `grep` |
|---|---|---|---|
| **empty** (no results) | `{ entries: [], truncated: false }` | `{ files: [], truncated: false }` | mode-appropriate empty (`files: []` / `matches: []` / `count: 0`), `truncated: false`. **No match is NOT an error.** |
| **loading** | N/A — single awaited call, no intermediate UI (headless). | N/A | N/A |
| **error** | path missing / not a directory → **throw** with an actionable message (framework returns it to the model as a tool_result error). | invalid glob syntax / base path missing → throw. | invalid regex → throw with the regex error; path missing → throw. |
| **partial** (cap hit) | `truncated: true` + results capped to the limit. | `truncated: true`. | `truncated: true` (+ `appliedLimit`). Content mode also caps line length. |
| **offline** | N/A — local filesystem, no network. | N/A | N/A |

### 3.3 Accessibility

N/A for a keyboard/screen-reader contract — there is no rendered UI (headless core). The analogous concern (machine legibility) is met by: strictly JSON-serializable results, discriminated `mode` fields on `grep`, and explicit `truncated` booleans so a caller never mistakes a capped result for a complete one.

### 3.4 Edge-case behaviors

- **Large repos / huge result sets** — every tool caps results (see §7) and sets `truncated`; `grep` content mode also caps per-line length so a minified/base64 line cannot flood output.
- **Binary files** — `grep` skips files that look binary (NUL byte in the first read chunk); they are silently excluded, not errored.
- **Concurrent use** — all three are read-only and hold no cross-call state; two may run in the same turn once Tier-2 #5 lands. Filesystem may change between calls (a file matched by `glob` is gone by `read_file`) — that is the caller's normal race to handle, same as today.
- **Symlinks / cycles** — the directory walk does **not** follow symlinked directories (avoids infinite loops); symlinked files are listed as regular entries.
- **Permission-denied subdirectories** — skipped silently during a walk (a `grep`/`glob` over a tree must not abort because one subdir is unreadable); a directly-targeted unreadable path throws.

### 3.5 Microcopy

Tool descriptions and the exact error/edge strings (the "microcopy" of a headless tool):

- `ls` desc: `"List the immediate entries of a directory (names, type, size, modification time). Not recursive — use glob for recursive file discovery."`
- `glob` desc: `"Find files by glob pattern (e.g. \"src/**/*.ts\"). Returns paths sorted by modification time, most recent first. Does not search file contents — use grep for that."`
- `grep` desc: `"Search file contents by regular expression. Returns matching files, matching lines, or a count depending on output_mode. Respects .gitignore by default."`
- Errors (thrown → returned to model verbatim by the framework):
  - `"ls: path does not exist: <path>"`
  - `"ls: not a directory: <path>"`
  - `"grep: invalid regular expression: <engine message>"`
  - `"grep: path does not exist: <path>"`
  - `"glob: base directory does not exist: <path>"`

## 4. Out of scope

- **ripgrep / any subprocess backend.** Locked to pure-JS (§Decisions). ripgrep may later be a *NodePlatform-internal* optimization but the Platform contract and tool logic must never assume a subprocess.
- **A model-facing `stat` tool.** `stat` is a `Platform` primitive only (§5.3), consumed internally by `ls`/`glob`; it is not registered as a tool.
- **Node's `fs.glob`.** Rejected in favor of a uniform hand-rolled walk + `picomatch` shared by `glob` and `grep` (§5.4) — removes the Node-22 `fs.glob` stability risk and gives both tools identical ignore/hidden/ordering/cap behavior.
- **`multiline` regex and ripgrep-style `type` filter** — no `multiline` grep and no ripgrep `type` filter in v1 (deferred). Context lines (`-A/-B/-C`) and nested-`.gitignore` composition **are** in v1 scope (final decisions 2026-07-10).
- **Writing / mutating anything.** These are strictly read-only.
- **Concurrent execution itself** — that is Tier-2 #5. This feature only *declares* the tools safe (`isConcurrencySafe`).
- **Consolidating the 11 inline `MockPlatform` doubles into a shared util** — tempting, but out of scope; this feature only makes each compile again (see §5.5, §Risks).

## 5. Architectural fit

### 5.1 Existing modules touched

- `packages/core/src/types/platform.ts` — **add four methods** (`listDir`/`stat`/`glob`/`grep`) to the `Platform` interface (§5.3). Breaking change.
- `packages/core/src/platform/node.ts` — implement the four methods in `NodePlatform` (the only module allowed to touch Node built-ins), delegating to the shared `fs-discovery.ts` helpers.
- `packages/core/src/index.ts` — export the three new tools (one line each), matching the existing pattern.
- **11 test files** carrying inline `Platform` doubles — add the four methods to each so the package compiles (§5.5).

### 5.2 New modules / files

- `packages/core/src/tools/builtin/ls.ts` — `lsTool`
- `packages/core/src/tools/builtin/glob.ts` — `globTool`
- `packages/core/src/tools/builtin/grep.ts` — `grepTool`
- `packages/core/src/platform/fs-discovery.ts` — **pure-JS helpers** used by `NodePlatform`: the single shared recursive directory walk, the `picomatch` glob-matching wrapper, and the hierarchical `.gitignore` composition (a stack of `ignore` matchers, one per directory, see §5.4/§5.6). It imports `node:fs/promises` and is therefore part of the node-platform module for the lint boundary — see R4 for the concrete recommendation (extend the lint glob to `src/platform/**`). One walk implementation feeds both `glob` and `grep`.
- Test files: `ls.test.ts`, `glob.test.ts`, `grep.test.ts` under `packages/core/src/__tests__/`, plus platform-level tests for the new methods.

### 5.3 New Platform contract (exact TypeScript signatures)

Four fine-grained primitives are added — chosen over one coarse `search`/`glob` method because (a) a browser platform can implement each straightforwardly over its own vfs, (b) `ls` and `glob` both compose over `listDir`/`stat`, and (c) fine-grained primitives leak the least implementation across the seam (research §5.2). `grep` is a `grep` primitive rather than "read every file in the tool" because the *walk + nested-ignore + binary-skip + context* logic must live behind the seam so a browser platform can supply an efficient/appropriate backend and so the tool stays environment-agnostic.

```ts
// types/platform.ts — appended to the existing file.

export type DirEntry = {
  name: string;                         // basename only
  type: "file" | "directory" | "symlink" | "other";
  size: number;                         // bytes; 0 for directories
  mtimeMs: number;                      // modification time, ms since epoch
};

export type GlobOptions = {
  cwd?: string;                         // base dir; defaults to platform.cwd()
  respectGitignore?: boolean;           // default true
  includeHidden?: boolean;              // default false (dotfiles excluded)
  limit?: number;                       // max paths returned (caller applies cap)
  signal?: AbortSignal;
};

export type GlobResult = {
  paths: string[];                      // absolute paths, mtime-desc sorted
  truncated: boolean;                   // more matched than `limit`
};

export type GrepMatch = {
  file: string;
  line: number;                         // 1-based line number
  text: string;                         // the line's text (per-line-length-capped)
  kind: "match" | "context";            // "context" = an -A/-B/-C context line, not itself a match
};

export type GrepOptions = {
  cwd?: string;                         // search root; defaults to platform.cwd()
  path?: string;                        // restrict to this file or subtree
  glob?: string;                        // file-name filter (e.g. "*.ts")
  ignoreCase?: boolean;                 // default false
  respectGitignore?: boolean;           // default true
  includeHidden?: boolean;              // default false
  limit?: number;                       // max files (or MATCH lines in content mode; context lines don't count)
  maxLineLength?: number;               // per-line cap in content mode
  contentMode?: boolean;                // collect matching lines, not just files
  before?: number;                      // -B: context lines before each match (default 0)
  after?: number;                       // -A: context lines after each match (default 0)
  signal?: AbortSignal;
};

export type GrepPlatformResult = {
  files: string[];                      // absolute paths with >=1 match
  matches?: GrepMatch[];                // present iff contentMode
  truncated: boolean;
};

export interface Platform {
  cwd(): string;
  readFile(path: string, encoding?: "utf-8"): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  // --- new in fs-discovery ---
  /** List the immediate entries of `path` (non-recursive). Rejects if `path`
   *  does not exist or is not a directory. */
  listDir(path: string): Promise<DirEntry[]>;
  /** Stat a single path. Rejects if it does not exist. */
  stat(path: string): Promise<DirEntry>;
  /** Find files matching a glob pattern. See GlobOptions for ignore/hidden/cap. */
  glob(pattern: string, options?: GlobOptions): Promise<GlobResult>;
  /** Search file contents by regex source (JS RegExp syntax). `flags` is the
   *  RegExp flags string (e.g. "i" for case-insensitive; the tool derives it).
   *  Rejects on invalid regex or a missing explicit `path`. */
  grep(pattern: string, flags: string, options?: GrepOptions): Promise<GrepPlatformResult>;
};
```

Rationale for each on Platform (vs. in the tool):
- **`listDir` / `stat`** — direct filesystem access; cannot live in an environment-agnostic tool.
- **`glob`** — needs the directory walk + `.gitignore` + hidden handling; a browser vfs implements it differently. Keeping it on Platform means `globTool` is a thin cap/format wrapper.
- **`grep`** — same reasoning; additionally the walk is performance-sensitive and platform-specific. The tool supplies regex *source + flags* (portable); the Platform owns file traversal and reading.

### 5.4 NodePlatform implementation approach (pure JS)

- **`listDir`** — `fs.promises.readdir(path, { withFileTypes: true })`; map each `Dirent` to `type`; `fs.promises.lstat` each for `size`/`mtimeMs`. Reject with the actionable message if `readdir` throws `ENOTDIR`/`ENOENT`.
- **`stat`** — `fs.promises.lstat`, mapped to `DirEntry`.
- **Shared walk (`fs-discovery.ts`) — one traversal feeds BOTH `glob` and `grep`.** A single recursive walk over `readdir(withFileTypes)` is the sole traversal implementation; `glob` and `grep` differ only in what they do with each visited file (pattern-match the path vs. read+regex the contents). It applies identical ignore/hidden/ordering/cap behavior to both. **No `fs.glob`.** Path matching uses `picomatch` (globstar `**` supported). Do **not** descend symlinked directories.
- **Hierarchical `.gitignore` composition (v1, required).** The walk maintains a **stack of `ignore` matchers**, one frame per directory level, mirroring git semantics:
  - On entering a directory `D`, if `D/.gitignore` exists, read it and `push` a new `ignore()` matcher (created from that file's patterns) onto the stack; record that a frame was pushed for `D` so it can be `pop`ped when the walk leaves `D`.
  - A candidate entry is **ignored if any matcher on the stack matches** its path *relative to that matcher's directory* (the `ignore` lib matches paths relative to the `.gitignore`'s location, so each frame tests `path.relative(frameDir, entryPath)`). Deeper `.gitignore`s therefore layer on top of shallower ones, and a deeper rule can re-include via a `!`-negation exactly as git does.
  - VCS metadata dirs (`.git`, `.svn`, `.hg`, `.jj`, `.sl`, `.bzr`) are pruned unconditionally, before the stack is consulted, and their contents are never walked.
  - When `respectGitignore` is false, the stack is simply not consulted (still prune VCS dirs). Hidden (dotfile-basename) entries are excluded unless `includeHidden`.
  - This is bounded work: matchers are read once per directory as the walk reaches them, and popped on exit, so memory is O(depth), not O(files).
- **`glob`** — run the shared walk; for each non-ignored file, test its cwd-relative path against the compiled `picomatch` pattern; collect matches. Sort by `mtimeMs` desc (name-asc under `NODE_ENV==='test'`). Apply `limit`; set `truncated` when more matched than `limit`.
- **`grep`** — run the shared walk to enumerate candidate files (honoring `path`/`glob`/nested-ignore/hidden), then for each: read via `fs.promises.readFile`, **skip if binary** (NUL byte in first ~8KB), split into lines, test each with the compiled `RegExp`. In `files_with_matches`/`count` mode, stop after the first match per file. In `content` mode with `before`/`after` set, for each matched line also collect the `before` preceding and `after` following lines as `kind: "context"` entries (see §7 for merge/cap semantics). Thread `signal` — check `signal.aborted` between files and reject with an AbortError if aborted.
- **Dependencies:** add **`ignore`** (MIT, pure-JS `.gitignore` matcher — supports per-directory matchers, which the stack relies on) and **`picomatch`** (MIT, pure-JS glob matcher). Both are zero-runtime-transitive-dep, pure-JS, browser-portable — the minimum for correct nested-`.gitignore` + globbing without a binary. Confirmed additions (final decision 2026-07-10).

### 5.5 Breaking-change ripple — every double that must update (compile-time caught)

Adding the four `Platform` methods (`listDir`/`stat`/`glob`/`grep`) breaks every implementor until updated. Full list:

**Production (implement the real behavior):**
1. `packages/core/src/platform/node.ts` — `NodePlatform`.

**Test doubles (add stub/real implementations — most can throw `"not configured"` like existing unused methods):**
2. `packages/core/src/__tests__/builtin-tools.test.ts` — `class MockPlatform` (Map-backed; give `listDir`/`stat`/`glob`/`grep` real-ish behavior over the Map so the new tools' own tests can use it, or a sibling in-memory double).
3. `packages/core/src/__tests__/loop.test.ts` — `class MockPlatform` (stub-throw).
4. `packages/core/src/__tests__/runTools.test.ts` — `class MockPlatform` (overrides pattern; add optional overrides for the new methods).
5. `packages/core/src/__tests__/task-tool.test.ts` — `class MockPlatform` (stub-throw).
6. `packages/core/src/__tests__/subagent-boundary.test.ts` — `class MockPlatform` (stub-throw).
7. `packages/core/src/__tests__/env-context.test.ts` — `class MockPlatform` (stub-throw).
8. `packages/core/src/__tests__/editFile.test.ts` — `class MockPlatform` (stub-throw).
9. `packages/core/src/__tests__/bash.test.ts` — `class MockPlatform` (stub-throw).
10. `packages/core/src/__tests__/agent.test.ts` — `class MockPlatform` (stub-throw).
11. `packages/core/src/__tests__/agent-tooling-integration.test.ts` — the **object-literal** `Platform` in `makeMockPlatform()` (add the four methods as `() => Promise.reject(...)`).

(11 files total. The stub-throw approach is fine everywhere except the file(s) that actually exercise `ls`/`glob`/`grep` — those need an in-memory backing.)

### 5.6 `.gitignore` / hidden handling (resolved fork)

**Decision: honor `.gitignore`, symmetrically across all three tools, ON by default, toggleable per-call.** Rejected the reference's asymmetry (grep respects, glob ignores). Rationale:

- The reference's asymmetry is a UI-suggestion artifact (glob feeds file-pickers that want to show generated files); for an *autonomous agent*, symmetric behavior is more predictable and avoids the agent wading into `node_modules`/`dist` on a `glob` and then being surprised `grep` skips them.
- **On by default** keeps output relevant and small (context economics) — searching `node_modules` is almost never wanted.
- **Toggleable** via each tool's `respect_gitignore` / `include_hidden` inputs (default `respect_gitignore: true`, `include_hidden: false`) provides the escape hatch (e.g. to find a file that *is* gitignored). No env-var toggles (the reference used env vars; this core routes everything through explicit inputs — decision below).
- VCS metadata dirs (`.git`, `.svn`, `.hg`, `.jj`, `.sl`, `.bzr`) are **always excluded** regardless of toggles.

Implementation: the shared walk composes `.gitignore` **hierarchically** via a per-directory stack of `ignore`-library matchers (full detail in §5.4) — every directory's `.gitignore` is honored with git-style precedence, not just the repo root, and `!`-negations in deeper files re-include as git does. Hidden = dotfile basename; excluded unless `include_hidden`.

### 5.7 Permission-gate interaction (resolved)

The approval gate in `runTools` is **keyed by tool name** (`approvalHandler(tool.name, input)`) and there is **no auto-registry** — consumers pass tools explicitly. Therefore:

- `ls`/`glob`/`grep` are **distinct tool names**, independently allow/deny-able. A consumer that denies `bash` does **not** deny them.
- They do **not** route through the `bash` tool or `platform.exec` at all (pure-JS, no shell), so they cannot inherit the shell gate.
- They remain **individually gateable** (not force-allowed) — the seam is uniform; a consumer who wants no discovery simply omits them or denies them by name. This is the least-surprising behavior and needs zero change to `runTools`.

### 5.8 Concurrency-safety declaration (resolved)

All three declare `isConcurrencySafe: () => true`. Confirmed read-only and stateless: they only read the filesystem and hold no cross-call state (statelessness decision 2026-06-26 Q1). This is exactly the read-only-safe class Tier-2 #5 will parallelize (`read_file`/`grep`/`ls` safe; `bash`/`edit_file`/`write_file` sequential). No signature rework will be needed by #5 — the hook is set now.

## 6. Data model changes

New **types only** (added to `types/platform.ts`, §5.3): `DirEntry`, `GlobOptions`, `GlobResult`, `GrepMatch` (now carrying `kind: "match" | "context"`), `GrepOptions` (now carrying `before`/`after`), `GrepPlatformResult`. Exported from `index.ts` alongside the existing `Platform`/`ExecResult` type exports so external `Platform` implementors can use them.

**No storage, no schema, no migration.** The only "migration" is source-level: existing `Platform` implementors must add the four methods (compile-time enforced, §5.5). No persisted data exists in the core (stateless).

Tool **result shapes** (JSON-serializable, returned by `call`):

```ts
// ls
{ entries: DirEntry[]; truncated: boolean }
// glob
{ files: string[]; truncated: boolean }            // cwd-relative where under cwd
// grep — discriminated by `mode`
| { mode: "files_with_matches"; files: string[]; truncated: boolean }
| { mode: "count"; count: number; files: string[]; truncated: boolean }
| { mode: "content";
    // ordered by (file, line); context lines carry kind:"context", matches kind:"match"
    matches: { file: string; line: number; text: string; kind: "match" | "context" }[];
    truncated: boolean }
```

## 7. Zod input schemas & caps

Numeric fields use `z.number().int().positive().optional()` (serializes to the numeric Draft-7 `exclusiveMinimum` both providers accept — decision 2026-06-29). Every field `.describe()`d.

```ts
// ls
z.object({
  path: z.string().describe("Absolute or cwd-relative directory to list."),
  limit: z.number().int().positive().optional()
    .describe("Max entries to return. Default 250."),
});

// glob
z.object({
  pattern: z.string().describe('Glob pattern, e.g. "src/**/*.ts".'),
  path: z.string().optional()
    .describe("Base directory to glob from. Defaults to the working directory."),
  respect_gitignore: z.boolean().optional()
    .describe("Skip .gitignore-d files. Default true."),
  include_hidden: z.boolean().optional()
    .describe("Include dotfiles/dotdirs. Default false."),
  limit: z.number().int().positive().optional()
    .describe("Max files to return. Default 250."),
});

// grep
z.object({
  pattern: z.string().describe("Regular expression (JS RegExp syntax)."),
  path: z.string().optional()
    .describe("File or directory to search. Defaults to the working directory."),
  glob: z.string().optional()
    .describe('File-name filter, e.g. "*.ts".'),
  output_mode: z.enum(["files_with_matches", "content", "count"]).optional()
    .describe("What to return. Default files_with_matches."),
  case_insensitive: z.boolean().optional()
    .describe("Case-insensitive match. Default false."),
  respect_gitignore: z.boolean().optional()
    .describe("Skip .gitignore-d files. Default true."),
  include_hidden: z.boolean().optional()
    .describe("Search dotfiles/dotdirs. Default false."),
  before_context: z.number().int().positive().optional()
    .describe("Lines of context to include BEFORE each match (like grep -B). content mode only."),
  after_context: z.number().int().positive().optional()
    .describe("Lines of context to include AFTER each match (like grep -A). content mode only."),
  context: z.number().int().positive().optional()
    .describe("Lines of context BOTH before and after each match (like grep -C). Overrides before/after if set. content mode only."),
  limit: z.number().int().positive().optional()
    .describe("Max files (or matching lines in content mode; context lines do not count toward the limit). Default 250."),
});
```

**Context-line semantics (`content` mode).** The tool resolves `context` → both `before_context`/`after_context` (a set `context` wins). It maps them to `GrepOptions.before`/`after` and passes them to `Platform.grep`. In the returned `matches` array:

- Each actual match is a `{ kind: "match" }` entry; each surrounding context line is a `{ kind: "context" }` entry, all with 1-based `line` numbers and per-line-length-capped `text`.
- Entries are ordered by `(file, line)`, so a consumer reads a match with its context in natural line order.
- **Overlapping / adjacent windows merge:** if two matches are close enough that their context windows overlap or touch, the shared lines appear **once** (a line that is both context-for-A and the match B is emitted once with `kind: "match"`; a line that is context for two matches is emitted once with `kind: "context"`). This is the standard `grep`/`rg` merge behavior and prevents duplicate lines.
- **Cap interaction:** `limit` counts **match lines only** — context lines never consume the budget, so a `limit` of N always yields up to N matches with their full context. The ~20_000-char total-result guard and the 500-char per-line cap still apply to the assembled output (context lines included in the byte total); if adding a match's context would exceed the byte guard, the result is truncated at a match boundary and `truncated: true` is set.

**Caps (resolved fork), mirroring the reference where sensible:**

| Cap | Value | Applies to |
|---|---|---|
| Default result limit | **250** entries/files/match-lines | all three (overridable via `limit`; in `grep` content mode counts **match** lines only, not context) |
| Per-line length cap (content mode) | **500** chars, then truncate + `…` marker | `grep` content mode (matches and context lines) |
| Max result size | **~20_000** chars serialized; if the assembled result would exceed, truncate at a match boundary → `truncated: true` | `grep` content mode primarily |
| Sort order | **mtime desc** (name-asc under `NODE_ENV==='test'`) | `glob`, `ls` |
| Path form returned | cwd-relative where under cwd, else absolute | `glob`, `grep`, `ls` names are basenames |

No `limit: 0` "unlimited" escape hatch in v1 (positive-int schema); unbounded output is a context hazard and the 250 default with an explicit higher `limit` covers real needs.

## 8. Edge cases

- **No matches ≠ error** — `grep`/`glob` return empty results with `truncated: false`, never throw. (The single most common reference bug class — ripgrep exit code 1.)
- **Invalid regex** — `grep` compiles the `RegExp` in the tool (or Platform) and throws the actionable `"grep: invalid regular expression: …"` before walking, so the model gets a fixable message, not a stack trace.
- **Binary files** — skipped in `grep` (NUL sniff); never returned as garbage lines.
- **Huge/mono repos** — bounded by the 250 default + `.gitignore` pruning; the walk short-circuits per-file after the cap.
- **Symlink cycles** — walk does not descend symlinked directories; no infinite loop.
- **Unreadable subdir mid-walk** — skipped silently; a directly-targeted unreadable path throws.
- **Cancellation** — `context.signal` is threaded into the Platform methods (`glob`/`grep` accept `signal`); an aborted signal rejects promptly between files. (`ls`/`stat` are single fast syscalls — signal optional.)
- **Path escaping cwd** — allowed (absolute paths permitted, matching `read_file`); no sandbox in the core (sandbox is deferred, known-issues). Return-path relativization only rewrites paths *under* cwd.
- **Nested `.gitignore`** — a subdirectory `.gitignore` is composed on top of shallower ones (per-directory matcher stack); a deeper `!`-negation can re-include a file a shallower `.gitignore` excluded. VCS-dir pruning always wins.
- **Context lines near BOF/EOF** — `before`/`after` windows clamp at file boundaries (no negative or past-EOF line numbers).
- **Adjacent/overlapping context windows** — merged so each line appears once (§7); a match line inside another match's window stays `kind: "match"`.
- **`NODE_ENV==='test'` determinism** — sort by name so snapshot tests are stable (reference precedent).

## 9. Risks

- **R1 — Two new runtime dependencies (`ignore` + `picomatch`).** The core deliberately keeps a tiny dep surface. *Resolution (final decision 2026-07-10):* both are added — they are pure-JS, MIT, effectively zero-runtime-transitive-dep, ubiquitous, and browser-portable. The "tiny dep surface" principle permits small universal libs over binaries; they are the minimum for correct nested-`.gitignore` + globbing without a subprocess. No longer an open risk.
- **R2 — RESOLVED: `fs.glob` not used.** The Node-22 `fs.glob` stability question is moot — the shared hand-rolled walk + `picomatch` backs both `glob` and `grep` uniformly (final decision 2026-07-10). No version-precision exposure remains.
- **R3 — Pure-JS `grep` is slower than ripgrep on huge repos** (accepted trade-off, locked decision). *Mitigation:* nested-`.gitignore` pruning (prunes whole subtrees like `node_modules` early) + the 250 cap + first-match short-circuit keep typical latency acceptable; ripgrep remains a future *NodePlatform-internal* optimization behind the same `Platform.grep` seam — no contract change needed.
- **R4 — Lint boundary for the pure-JS helper (`fs-discovery.ts`) importing `node:fs`.** Only `platform/node.ts` may import Node built-ins today; `fs-discovery.ts` also needs `node:fs/promises`. *Concrete recommendation for the planner:* **widen the `no-restricted-imports` / `no-restricted-globals` override glob from `**/platform/node.ts` to `**/platform/**`** (or explicitly to `platform/node.ts` + `platform/fs-discovery.ts`). Both files ARE the Node platform module — the boundary's intent (no Node built-ins in environment-agnostic code) is preserved because nothing outside `platform/` imports them, and the new tools reach the filesystem only through the `Platform` interface. Verify the exact current glob in `eslint.config.js` and adjust it as the first task-step; if the team prefers zero config change, fold `fs-discovery.ts`'s contents into `node.ts` instead (larger file, same boundary). Recommendation: widen the glob — it keeps the sizeable walk/ignore logic in its own testable module.
- **R5 — 11-file breaking-change fan-out.** Adding four methods touches 11 test files. *Mitigation:* mechanical (mostly stub-throws); compile-time caught, so nothing is silently missed. Not consolidating the mocks (out of scope) keeps the diff shallow but wide.
- **R6 — Nested-`.gitignore` composition complexity.** Hierarchical composition (per-directory matcher stack, `!`-negation, relative-path matching) is v1-required and more intricate than root-only. *Mitigation:* the `ignore` lib handles the matching semantics; the walk only manages the push/pop stack (O(depth)). Cover with targeted tests: a deep `.gitignore` that ignores a file a shallow one allowed, a deep `!`-negation re-including a root-ignored file, and VCS-dir pruning taking precedence. This is the highest-logic-density part of the feature — budget a dedicated test file.

## 10. Success criteria

**Functional:**
- A model with only `ls`/`glob`/`grep` (no `bash`) can: list a directory, find `**/*.ts`, and grep a regex across the repo — each returning structured, capped results.
- `grep` supports `files_with_matches` (default), `content` (with line numbers), and `count` modes.
- **`grep` context lines:** `after_context`/`before_context`/`context` (mapping to `-A`/`-B`/`-C`) work in `content` mode — context lines appear as `kind: "context"` entries interleaved with `kind: "match"` entries, ordered by `(file, line)`, with correct 1-based line numbers.
- **Context-window merge:** two matches whose context windows overlap or touch produce each shared line exactly once (no duplicate lines), with a line that is itself a match tagged `kind: "match"` even when it falls in another match's context window.
- **Context-line cap interaction:** `limit` counts match lines only (context lines never consume the budget); the ~20_000-char guard truncates at a match boundary and sets `truncated: true`.
- **Nested `.gitignore` (hierarchical):** a `.gitignore` in a subdirectory is honored in addition to shallower ones; a deeper `!`-negation re-includes a file ignored by a shallower `.gitignore`; VCS metadata dirs are pruned regardless. Verified with a fixture tree containing at least two `.gitignore` levels and a negation.
- Denying `bash` via `approvalHandler` leaves `ls`/`glob`/`grep` fully functional; denying any of them by name blocks only that tool.
- `.gitignore`-d and hidden files are excluded by default across all three; each tool's `respect_gitignore: false` / `include_hidden: true` includes them; VCS dirs always excluded.
- The shared directory walk is a **single implementation** feeding both `glob` and `grep` (same ignore/hidden/ordering behavior); no use of `fs.glob`.
- No-match returns empty results, never an error. Invalid regex / missing path throws an actionable message.
- All three declare `isConcurrencySafe() => true`.
- `packages/core` compiles (all 11 doubles updated with the four new methods) and `pnpm -r typecheck` + lint pass with no Node-built-in imports outside the node-platform module (`platform/node.ts` + `platform/fs-discovery.ts`).

**Non-functional:**
- Results are strictly JSON-serializable and bounded (≤250 default; `truncated` set correctly).
- A `grep` over `packages/core/src` completes well under the tool timeout on this repo (target: sub-second for a typical pattern) — verified by an example/smoke run.
- Cancellation via the run's `AbortSignal` interrupts a `grep`/`glob` between files.
- Determinism: under `NODE_ENV==='test'`, ordering is name-sorted and stable across runs.

## 11. Open questions

All four open questions raised in the initial draft were **resolved by the user on 2026-07-10** and folded into this spec:

1. **New dependencies** — RESOLVED: add both `ignore` and `picomatch` (§5.4, R1).
2. **Glob engine** — RESOLVED: uniform hand-rolled walk + `picomatch` shared by `glob` and `grep`; no `fs.glob` (§5.4, R2).
3. **Nested `.gitignore`** — RESOLVED: v1 honors nested `.gitignore` composed hierarchically (§5.4, §5.6, R6).
4. **`grep` context lines** — RESOLVED: v1 supports `-A`/`-B`/`-C` (§5.3, §7, R6-adjacent).

No open questions remain blocking the plan phase.

---

_Decisions recorded in `docs/feature/fs-discovery-tools/decisions.md`. Research basis: `docs/feature/fs-discovery-tools/research/2026-07-10-fs-discovery-research.md`._

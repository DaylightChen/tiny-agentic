# Task 02 — Shared directory walk (`fs-discovery.ts`) + wire `NodePlatform.glob`/`grep`

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Build `packages/core/src/platform/fs-discovery.ts` — the single, shared, recursive directory walk that backs **both** `glob` and `grep`, and wire `NodePlatform.glob`/`grep` to it (replacing the throwing stubs from task-01). This is the highest-logic-density module in the feature. One traversal implementation; `glob` and `grep` differ only in what they do per visited file (match the path with `picomatch` vs. read + regex the contents). It owns: the per-directory `.gitignore` matcher stack (hierarchical composition, `!`-negation, relative-path matching), unconditional VCS-dir pruning, hidden-file exclusion, symlink-no-descend, permission-skip mid-walk, mtime-desc / name-asc-under-`NODE_ENV==='test'` ordering, result caps + `truncated`, binary-file skip (NUL sniff), context-line collection + window merge, and `AbortSignal` threading.

## Context files

- `docs/feature/fs-discovery-tools/engineering/2026-07-10-fs-discovery-engineering.md` — **§5.4** (impl approach, nested-gitignore stack mechanism — the load-bearing detail), **§5.6** (gitignore/hidden rules), **§7** (caps + context-line merge semantics), **§8** (edge cases).
- `docs/feature/fs-discovery-tools/decisions.md` — the "nested `.gitignore` hierarchical" and "grep context lines" FINAL decisions (mechanism spelled out).
- `packages/core/src/platform/node.ts` — where `glob`/`grep` are currently throwing stubs; the `exactOptionalPropertyTypes`-ON conditional-spread pattern in `exec`.
- `packages/core/src/types/platform.ts` — the `GlobOptions`/`GlobResult`/`GrepOptions`/`GrepMatch`/`GrepPlatformResult` shapes to satisfy.
- `ignore` and `picomatch` package READMEs (per-directory matcher usage; globstar matching).

## Downstream dependencies

- task-03 (`globTool`) calls `platform.glob(pattern, options)` and expects `{ paths: absolute[], truncated }` mtime-desc (name-asc in test).
- task-04 (`grepTool`) calls `platform.grep(pattern, flags, options)` and expects `{ files: absolute[], matches?: GrepMatch[], truncated }`; the tool derives `flags` and pre-compiles/validates the RegExp (this module receives a valid source+flags and constructs the `RegExp`).
- Keep `glob`/`grep` behaving **identically** on ignore/hidden/ordering/cap — they must share the one walk.

## Steps

1. **Create `fs-discovery.ts`** importing `node:fs/promises` (`readdir`, `lstat`, `readFile`) — now allowed by the widened eslint glob. Import `ignore` and `picomatch`.
2. **The shared walk** — an async generator/collector over `readdir(dir, { withFileTypes: true })`, depth-first:
   - **VCS prune first:** never descend `.git`, `.svn`, `.hg`, `.jj`, `.sl`, `.bzr` (by basename), regardless of toggles.
   - **`.gitignore` stack:** on entering directory `D`, if `D/.gitignore` exists and `respectGitignore`, read it, build `ignore().add(patterns)`, push a frame `{ dir: D, matcher }`; pop on leaving `D`. A candidate `entryPath` is ignored if **any** frame's `matcher.ignores(path.relative(frame.dir, entryPath))` is true. (`ignore` matches relative to the `.gitignore`'s location; deeper `!`-negations re-include as git does.) O(depth) memory.
   - **Hidden:** exclude dotfile-basename entries unless `includeHidden`.
   - **Symlinks:** do not descend symlinked directories (check `Dirent.isSymbolicLink()`); symlinked files are listed as regular entries.
   - **Permission-skip:** wrap per-directory `readdir` in try/catch; on `EACCES`/`EPERM` skip that subtree silently (a *directly targeted* unreadable root still throws — that check lives in the glob/grep entry, not mid-walk).
   - **Abort:** check `options.signal?.aborted` between files/dirs; reject with an AbortError if set.
3. **Ordering + caps helper.** Collect visited files, sort by `mtimeMs` desc — but when `process.env.NODE_ENV === 'test'`, sort by path name asc for determinism. Apply `limit` (default 250 applied by the caller/tool; the Platform honors `options.limit`); set `truncated: true` when more matched than the limit. (Guard the single `process.env` read — this file is inside the widened boundary, so `process` is permitted here.)
4. **`glob` impl.** Run the walk from `options.cwd ?? platform.cwd()`; for each non-ignored file test its cwd-relative path against `picomatch(pattern)` (globstar on); collect absolute paths; sort + cap → `GlobResult`. Reject with `"glob: base directory does not exist: <path>"` if the base is missing.
5. **`grep` impl.** Run the walk to enumerate candidate files (honoring `path`/`glob` name-filter/nested-ignore/hidden). For each: `readFile`, **skip if binary** (NUL byte in first ~8 KB), split into lines, test each with the `RegExp` built from the passed source+flags. In files/count mode stop after first match per file. In content mode with `before`/`after`: for each match collect the window (`kind:"context"` for surrounding, `kind:"match"` for the hit), clamp at BOF/EOF, **merge overlapping/adjacent windows so each physical line appears once** (a match line inside another's window stays `kind:"match"`), order by `(file, line)`. `limit` counts **match lines only** (context never consumes budget). Thread `signal`. Return `GrepPlatformResult`.
6. **Wire `NodePlatform`.** Replace the task-01 stubs so `glob`/`grep` delegate to the `fs-discovery.ts` helpers, forwarding options via conditional spreads (exactOptionalPropertyTypes ON — no explicit `undefined`).
7. **Tests** — `src/__tests__/fs-discovery.test.ts` (or platform-level), using **temp-dir fixtures** (create a real tree in `os.tmpdir()` in `beforeEach`; test allows `node:fs`/`node:os` in test files — confirm test files aren't under the core lint restriction, they are `.test.ts` but the restriction targets `packages/core/src/**`; if lint blocks, use `NodePlatform` + a checked-in fixture dir under `__tests__/fixtures/`). Cover the criteria below with `NODE_ENV==='test'` set for deterministic ordering.

## Acceptance criteria

- [ ] `pnpm --filter @tiny-agentic/core test` passes including `fs-discovery.test.ts`.
- [ ] `pnpm -r typecheck` and `pnpm -r lint` pass (no Node-built-in import outside `platform/**`).
- [ ] **Single walk:** `glob` and `grep` produce the same file set on a fixture given equivalent ignore/hidden options (assert set-equality).
- [ ] **Nested `.gitignore` (hierarchical):** fixture with root `.gitignore` and a subdir `.gitignore` — (a) a file ignored only by the subdir's `.gitignore` is excluded; (b) a deeper `!`-negation re-includes a file ignored by a shallower `.gitignore`; (c) a VCS metadata dir (`.git/…`) is pruned even if `respectGitignore:false`.
- [ ] **Hidden:** dotfiles excluded by default, included when `includeHidden:true`.
- [ ] **Symlink:** a symlinked directory is not descended (no infinite loop on a self-referential symlink fixture); a symlinked file appears as an entry.
- [ ] **Ordering:** under `NODE_ENV==='test'` results are name-asc and stable across runs.
- [ ] **Caps:** `limit` respected; `truncated:true` when more matched than `limit`; empty result → `{ …, truncated:false }`, never throws.
- [ ] **grep content + context:** `before`/`after` produce interleaved `kind:"match"`/`kind:"context"` entries with correct 1-based line numbers, clamped at BOF/EOF; overlapping windows merge (each line once, match stays `match`); `limit` counts match lines only.
- [ ] **Binary skip:** a fixture file with a NUL byte is silently excluded from grep results.
- [ ] **Cancellation:** an already-aborted `signal` makes `glob`/`grep` reject promptly.
- [ ] **Missing base:** `glob` with a missing base dir rejects with `"glob: base directory does not exist: …"`.

## Output files

- Created: `packages/core/src/platform/fs-discovery.ts`, `packages/core/src/__tests__/fs-discovery.test.ts` (+ `__tests__/fixtures/` if used).
- Modified: `packages/core/src/platform/node.ts` (glob/grep now delegate).

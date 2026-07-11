# Task 03 — `ls` and `glob` tools

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Build the two thin tools that wrap the Platform primitives: `packages/core/src/tools/builtin/ls.ts` (`lsTool`) over `listDir`/`stat`, and `packages/core/src/tools/builtin/glob.ts` (`globTool`) over `platform.glob`. Each has a Zod schema (every field `.describe()`d), cwd-relative path formatting for returned paths, the 250-default cap + `truncated` flag, `isConcurrencySafe: () => true`, and is registered/exported from `index.ts`. These settle the path-formatting + cap-wrapping conventions that `grep` (task-04) reuses.

## Context files

- `docs/feature/fs-discovery-tools/engineering/2026-07-10-fs-discovery-engineering.md` — **§7** (ls/glob Zod schemas — copy verbatim), **§6** (result shapes), **§3.5** (ls descriptions + `ls:` error strings), **§5.6** (toggles), **§5.8** (concurrency-safe), **§7 caps table** (250 default, cwd-relative paths, mtime/name sort).
- `packages/core/src/tools/builtin/readFile.ts` — the `defineTool` pattern to mirror (schema `.describe()`, `call` signature).
- `packages/core/src/types/tool.ts` — `defineTool`, `ToolCallContext` (`signal`), `isConcurrencySafe`.
- `packages/core/src/index.ts` — export block to extend (mirror `readFileTool`/`bashTool` lines).
- `packages/core/src/types/platform.ts` — `DirEntry`/`GlobOptions`/`GlobResult`.

## Downstream dependencies

- task-04 (`grepTool`) reuses the cwd-relative path-formatting convention established here — factor it as a small shared helper (e.g. `tools/builtin/_paths.ts` or inline+copied) and note which. Keep it consistent.
- `index.ts` export ordering/pattern must stay consistent for task-04 to append `grepTool`.

## Steps

1. **`ls.ts`.** Schema per §7: `{ path: string, limit?: positive-int }`. `call`: resolve `path` against `platform.cwd()` if relative; `platform.listDir(resolved)` (which throws the `ls:` messages on missing/not-dir — let them propagate); apply `limit ?? 250` cap, set `truncated`; sort per §7 (mtime desc; name asc under `NODE_ENV==='test'`); format `entries` as `DirEntry[]` with **basename** `name` (already basename from `listDir`). Return `{ entries, truncated }`. Description verbatim from §3.5: `"List the immediate entries of a directory (names, type, size, modification time). Not recursive — use glob for recursive file discovery."` Add `isConcurrencySafe: () => true`.
2. **`glob.ts`.** Schema per §7: `{ pattern: string, path?: string, respect_gitignore?: boolean, include_hidden?: boolean, limit?: positive-int }`. `call`: map inputs → `GlobOptions` (`cwd: path`, `respectGitignore: respect_gitignore ?? true`, `includeHidden: include_hidden ?? false`, `limit: limit ?? 250`, `signal: context.signal`) with conditional spreads (exactOptionalPropertyTypes ON); call `platform.glob(pattern, options)`; convert returned **absolute** `paths` to **cwd-relative where under cwd, else absolute**; return `{ files, truncated }`. Description verbatim from §3.5. `isConcurrencySafe: () => true`.
3. **Path helper.** Implement cwd-relative formatting once (under-cwd → `path.relative(cwd, p)`, else keep absolute). This is the shared convention task-04 reuses.
4. **Register/export.** Add `export { lsTool } from "./tools/builtin/ls.js"` and `export { globTool } from "./tools/builtin/glob.js"` to `index.ts`, mirroring the existing tool exports.
5. **Tests** — `src/__tests__/ls.test.ts`, `src/__tests__/glob.test.ts`. Use **temp-dir fixtures on `NodePlatform`** (the walk needs real dirents/mtimes/nested `.gitignore`), `NODE_ENV==='test'` for deterministic ordering.

## Acceptance criteria

- [ ] `pnpm --filter @tiny-agentic/core test` passes including `ls.test.ts`, `glob.test.ts`.
- [ ] `pnpm -r typecheck` + `pnpm -r lint` pass.
- [ ] **ls happy path:** lists a fixture dir's immediate entries (name basename, type, size, mtimeMs); non-recursive.
- [ ] **ls empty:** empty dir → `{ entries: [], truncated: false }`.
- [ ] **ls errors:** missing path → throws `"ls: path does not exist: <path>"`; a file path → throws `"ls: not a directory: <path>"`.
- [ ] **ls cap:** `limit` respected; `truncated:true` when the dir has more entries than `limit`.
- [ ] **glob happy path:** `**/*.ts` over a fixture returns matching files, cwd-relative where under cwd, name-asc under test env.
- [ ] **glob empty ≠ error:** a pattern matching nothing → `{ files: [], truncated: false }`, no throw.
- [ ] **glob toggles:** a `.gitignore`-d file is excluded by default and included with `respect_gitignore:false`; a dotfile excluded by default, included with `include_hidden:true`.
- [ ] **glob cap:** `truncated:true` when more than `limit` match.
- [ ] Both tools expose `isConcurrencySafe()` returning `true`.
- [ ] `index.ts` exports `lsTool` and `globTool`.
- [ ] Manual: a `bash`-denying `approvalHandler` does not affect `ls`/`glob` (distinct names, no `platform.exec`) — asserted by construction (grep test may formalize this in task-05 smoke).

## Output files

- Created: `packages/core/src/tools/builtin/ls.ts`, `packages/core/src/tools/builtin/glob.ts`, `packages/core/src/__tests__/ls.test.ts`, `packages/core/src/__tests__/glob.test.ts` (+ optional `tools/builtin/_paths.ts`).
- Modified: `packages/core/src/index.ts`.

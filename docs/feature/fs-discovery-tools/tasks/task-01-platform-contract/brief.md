# Task 01 — Platform contract (types, 4 methods, deps, lint boundary, 11 doubles)

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Land the **compile-time breaking change** the whole feature rests on, atomically, so the package still builds and lints at the end. Add four methods (`listDir`, `stat`, `glob`, `grep`) plus six supporting types (`DirEntry`, `GlobOptions`, `GlobResult`, `GrepMatch`, `GrepOptions`, `GrepPlatformResult`) to the `Platform` interface; export the types from `index.ts`; add the `ignore` + `picomatch` runtime deps; widen the eslint node-built-in boundary from `platform/node.ts` to `platform/**` (so `fs-discovery.ts` may import `node:fs/promises` in task-02); implement **real** `listDir`/`stat` and **throwing** `glob`/`grep` stubs in `NodePlatform`; and update all **11 test doubles** so `packages/core` compiles.

No `fs-discovery.ts`, no tools, no walk logic in this task. `NodePlatform.glob`/`grep` throw `"not implemented — landed in task-02"`; task-02 replaces them.

## Context files

- `docs/feature/fs-discovery-tools/engineering/2026-07-10-fs-discovery-engineering.md` — **§5.3** (exact TS signatures — copy them), **§5.5** (the 11-file list), **§9 R4** (lint widening), **§5.4** (deps).
- `packages/core/src/types/platform.ts` — the interface to extend (currently `cwd`/`readFile`/`writeFile`/`exec`).
- `packages/core/src/platform/node.ts` — `NodePlatform`; note the `exactOptionalPropertyTypes`-ON conditional-spread pattern in `exec`.
- `packages/core/src/index.ts` — type-export block to extend (lines ~15).
- `eslint.config.js` — the core-restriction block using `ignores: ["packages/core/src/platform/node.ts"]`. **Ground truth — re-read before editing.**
- `packages/core/package.json` — `dependencies` block.
- The 11 doubles (§5.5): `src/platform/node.ts` (prod) + `src/__tests__/`: `builtin-tools.test.ts`, `loop.test.ts`, `runTools.test.ts`, `task-tool.test.ts`, `subagent-boundary.test.ts`, `env-context.test.ts`, `editFile.test.ts`, `bash.test.ts`, `agent.test.ts`, `agent-tooling-integration.test.ts` (object-literal `makeMockPlatform`).

## Downstream dependencies

- task-02 implements `NodePlatform.glob`/`grep` against these exact signatures and creates `platform/fs-discovery.ts` (which relies on the widened eslint glob to import `node:fs/promises`).
- task-03/04 build `ls`/`glob`/`grep` tools that call `platform.listDir`/`stat`/`glob`/`grep` and import the exported types.
- **Keep the §5.3 signatures byte-exact** — later tasks and external `Platform` implementors code against them.
- `stat` must stay a Platform primitive only — do **not** register a `stat` tool anywhere.

## Steps

1. **Add supporting types + methods to `types/platform.ts`.** Append `DirEntry`, `GlobOptions`, `GlobResult`, `GrepMatch` (with `kind: "match" | "context"`), `GrepOptions` (with `before`/`after`), `GrepPlatformResult` exactly as §5.3 gives them. Add the four method signatures to `interface Platform`: `listDir(path): Promise<DirEntry[]>`, `stat(path): Promise<DirEntry>`, `glob(pattern, options?): Promise<GlobResult>`, `grep(pattern, flags, options?): Promise<GrepPlatformResult>`.
2. **Export the new types from `index.ts`.** Extend the `export type { Platform, ExecOptions, ExecResult } from "./types/platform.js"` line to also export `DirEntry, GlobOptions, GlobResult, GrepMatch, GrepOptions, GrepPlatformResult`.
3. **Add deps.** `pnpm --filter @tiny-agentic/core add ignore picomatch` (confirm the exact package name in `packages/core/package.json`; use the workspace filter). If `@types/picomatch` is needed for typecheck, add it to `devDependencies`. `ignore` ships its own types.
4. **Widen the eslint boundary.** In `eslint.config.js`, in the core-restriction block, change `ignores: ["packages/core/src/platform/node.ts"]` to `ignores: ["packages/core/src/platform/**"]` (glob). Do not add a separate `files` block. Verify no other block needs the same change (the `no-restricted-globals` `process` rule is in the same block — it moves with it).
5. **Implement `listDir`/`stat` in `NodePlatform` (real).** `listDir`: `readdir(path, { withFileTypes: true })`, map each `Dirent` → `DirEntry.type` (`file`/`directory`/`symlink`/`other`), `lstat` each for `size`/`mtimeMs`; on `ENOENT`/`ENOTDIR` reject with the §3.5 messages (`"ls: path does not exist: <path>"` / `"ls: not a directory: <path>"`). `stat`: `lstat` → `DirEntry`, reject if missing. Import `readdir`/`lstat` from `node:fs/promises` alongside the existing imports.
6. **Stub `glob`/`grep` in `NodePlatform` (throwing).** Each: `async glob(): Promise<GlobResult> { throw new Error("NodePlatform.glob not implemented — landed in task-02"); }` and same for `grep`. Signatures must match the interface exactly (params present, correct return type).
7. **Update all 11 doubles.** For `node.ts` see steps 5–6. For the 10 test doubles: most add `listDir`/`stat`/`glob`/`grep` as stub-throws (`() => Promise.reject(new Error("not configured"))`), matching each file's existing unused-method style. For `agent-tooling-integration.test.ts`'s object-literal `makeMockPlatform`, add the four as `() => Promise.reject(...)`. For `builtin-tools.test.ts`'s Map-backed `MockPlatform`, stub-throw is fine here (real filesystem-backed tool tests come in task-03/04 via temp-dir fixtures on `NodePlatform`) — do **not** try to implement a walk over the Map.
8. **Typecheck + lint.** Fix any exhaustiveness/`exactOptionalPropertyTypes` fallout.

## Acceptance criteria

- [ ] `pnpm -r typecheck` passes (all 11 implementors satisfy the new interface).
- [ ] `pnpm -r lint` passes; `eslint.config.js` core-restriction block ignores `packages/core/src/platform/**`.
- [ ] `packages/core/package.json` lists `ignore` and `picomatch` under `dependencies`.
- [ ] `index.ts` exports all six new types (`grep -c` the export line covers them).
- [ ] A quick manual/unit check: `new NodePlatform().listDir(<a real dir>)` resolves to a `DirEntry[]`; `listDir(<missing>)` rejects with `"ls: path does not exist: …"`; `listDir(<a file>)` rejects with `"ls: not a directory: …"`.
- [ ] `new NodePlatform().glob("*")` and `.grep("x","")` reject with the `"… landed in task-02"` message (stubs present, interface satisfied).
- [ ] Existing test suite (`pnpm --filter @tiny-agentic/core test`) still passes (no behavior regression).

## Output files

- Modified: `packages/core/src/types/platform.ts`, `packages/core/src/index.ts`, `packages/core/src/platform/node.ts`, `eslint.config.js`, `packages/core/package.json` (+ lockfile).
- Modified (doubles): `packages/core/src/__tests__/{builtin-tools,loop,runTools,task-tool,subagent-boundary,env-context,editFile,bash,agent,agent-tooling-integration}.test.ts`.

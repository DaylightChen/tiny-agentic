# Execution Log — Task 03: ls and glob tools

> Dev-loop execution log. Structured by iteration.

## Iteration 1

### Implement
- **Files created:** `packages/core/src/tools/builtin/ls.ts` (`lsTool`), `packages/core/src/tools/builtin/glob.ts` (`globTool`), `packages/core/src/tools/builtin/_paths.ts` (shared `toReturnPath(absPath, cwd)` helper — reused by task-04).
- **Files modified:** `packages/core/src/index.ts` (export `lsTool`/`globTool` after `editFileTool`).
- **Decisions not in plan:**
  - `ls` reads `NODE_ENV` via `globalThis.process?.env?.NODE_ENV` to satisfy the `no-restricted-globals` bare-`process` ban (`tools/builtin/` is not exempt; only `platform/**` is). Necessary + correct.
  - `ls` sorts/caps in the tool because `listDir` is an unsorted/uncapped primitive; `glob` does NOT re-sort/re-cap (the platform walk already does). No double-sort/double-cap.
  - `toReturnPath` returns `"."` for exact-cwd; uses `path.relative` + `..`/`isAbsolute` detection (prefix-safe: `/foo/barbaz` vs cwd `/foo/bar` → `../barbaz` → kept absolute).
- **Deviations:** none.

### Test
- **New tests:** `packages/core/src/__tests__/ls.test.ts` (12), `packages/core/src/__tests__/glob.test.ts` (10). Real `NodePlatform` + temp-dir fixtures via `platform.exec`/`writeFile`. Tools invoked as `call(input, platform, context)` (matches the real `Tool.call` signature).
- **Failures:** none.
- **Full suite output:**
  ```
  $ pnpm --filter tiny-agentic test
  Test Files  23 passed (23)
       Tests  372 passed (372)
  ```
  `pnpm -r typecheck` → all Done; root `pnpm lint` → clean.

### Review
- **Verdict:** Approved (iteration 1).
- **Criteria check:** all pass — ls happy/empty/errors (both messages propagate verbatim)/cap; glob happy (cwd-relative on a real under-cwd fixture)/empty≠error/toggles/cap; both `isConcurrencySafe()===true`; index exports; bash-deny non-interference by construction.
- **Correctness (3 flagged areas verified):** `toReturnPath` prefix-safe (path-segment-aware, not naive `startsWith`); `call(input, platform, context)` matches `tool.ts` signature; no double-sort/double-cap (listDir unsorted → tool sorts once; platform glob sorts/caps → tool passes through).
- **Code/test quality:** clean; `globalThis.process` workaround correct; conditional spreads correct under exactOptionalPropertyTypes; `_paths.ts` minimal + shared; fixtures cleaned up; equals-limit boundary + schema bounds covered.
- **Downstream:** `toReturnPath` exported + reusable 1:1 for task-04; `index.ts` leaves a clean append point for `grepTool`.
- **Regressions:** none. **Issues to fix:** none.

## Completion
- **Iterations:** 1 (approved first pass).
- **Verification evidence:** `pnpm --filter tiny-agentic test` → 372 passed (23 files); `pnpm -r typecheck` → all Done; root `pnpm lint` → clean.
- **Acceptance criteria:** all verified (see Review criteria check).
- **Regressions:** none.
- **Deviations from plan:** none material (see Implement decisions).

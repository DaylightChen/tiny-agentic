# Execution Log — Task 01: Platform contract

> Dev-loop execution log. Structured by iteration.

## Iteration 1

### Implement
- **Files modified:**
  - `packages/core/src/types/platform.ts` — 6 supporting types (`DirEntry`, `GlobOptions`, `GlobResult`, `GrepMatch`, `GrepOptions`, `GrepPlatformResult`) + 4 `Platform` methods (`listDir`, `stat`, `glob`, `grep`), byte-exact per §5.3.
  - `packages/core/src/index.ts` — export the 6 new types.
  - `packages/core/src/platform/node.ts` — real `listDir`/`stat` (private `direntType` helper, `node:path` `join`); throwing `glob`/`grep` stubs (`"… landed in task-02"`).
  - `eslint.config.js` — widened existing `ignores` array to `packages/core/src/platform/**` (B1); `no-restricted-globals` process rule moved with it.
  - `packages/core/package.json` (+ `pnpm-lock.yaml`) — added `ignore ^7.0.5`, `picomatch ^4.0.5` to `dependencies`.
  - 10 test doubles: `builtin-tools`, `loop`, `runTools`, `task-tool`, `subagent-boundary`, `env-context`, `editFile`, `bash`, `agent`, `agent-tooling-integration` `.test.ts` — stub-throws for the 4 methods.
- **Decisions not in plan:** kept `interface Platform {…}` closing brace without trailing `;` to match file style; test-double stubs omit explicit return types (rely on `implements Platform`); `@types/picomatch` not needed (only used in task-02).
- **Deviations:** none.
- **Issues:** local Node v20 (< engine >=22) — pnpm WARNs but runs; there is no `pnpm -r lint` script — lint is the **root** script `eslint packages/*/src --max-warnings 0`. Package name is **`tiny-agentic`**, not `@tiny-agentic/core`.

### Test
- **New tests:** 9 tests in `packages/core/src/__tests__/node.test.ts` (listDir shape/empty/ENOENT/ENOTDIR; stat file/dir/missing; glob & grep throwing stubs). Temp-dir fixtures built via `platform.exec`/`writeFile` (respects the eslint `node:fs` boundary, which applies to `__tests__/` too).
- **Failures:** none.
- **Full suite output:**
  ```
  $ pnpm --filter tiny-agentic test
  Test Files  20 passed (20)
       Tests  333 passed (333)
  ```
  `pnpm -r typecheck` → core/sdk/ui all Done.

### Review
- **Verdict:** Approved (iteration 1).
- **Criteria check:** all pass — typecheck, lint (`platform/**` ignore), deps in `dependencies`, 6 types exported, listDir real behavior + error messages, glob/grep stubs, no regression (333 green).
- **Contract exactness:** §5.3 signatures byte-exact; `exactOptionalPropertyTypes` honored.
- **Correctness:** symlink typing correct (`direntType` on Dirent → `"symlink"`, `lstat` no-follow); dir `size:0` matches task-03 `ls` contract.
- **Code/test quality:** clean; `direntType` helper justified; fixtures cleaned up in `afterEach`. Symlink-typed DirEntry untested — acceptable to defer to task-02/03.
- **Regressions:** none. **Issues to fix:** none.

## Completion
- **Iterations:** 1 (approved first pass).
- **Verification evidence:** `pnpm --filter tiny-agentic test` → 333 passed; `pnpm -r typecheck` → all Done; root `pnpm lint` → clean.
- **Acceptance criteria:** all verified (see Review criteria check).
- **Regressions:** none.
- **Deviations from plan:** none material (see Implement decisions).

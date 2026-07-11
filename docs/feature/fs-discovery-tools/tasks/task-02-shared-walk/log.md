# Execution Log — Task 02: Shared directory walk

> Dev-loop execution log. Structured by iteration.

## Iteration 1

### Implement
- **Files created:** `packages/core/src/platform/fs-discovery.ts` (the single shared recursive walk + `globImpl`/`grepImpl`); `packages/core/src/platform/picomatch.d.ts` (ambient types for picomatch v4 — no bundled types, `@types/picomatch` deliberately not added, per tiny-dep-surface).
- **Files modified:** `packages/core/src/platform/node.ts` (`glob`/`grep` now delegate to the impls).
- **Key design choices:**
  - **Gitignore stack (deviation — see below):** frames evaluated **deepest-first via `matcher.test(rel)`**, first frame with an opinion wins; silent frames fall through. O(depth) memory (push on dir-enter, pop in `finally`). VCS dirs pruned by basename before the stack is consulted, unconditionally.
  - **Window merge:** collect match-line indices, expand to `[m-before, m+after]` clamped to `[0, total-1]`, union into a Set (each physical line once), tag `kind:"match"` if in match set else `"context"`, order by `(file,line)`. `limit` counts match lines only.
  - **Binary sniff:** NUL char in first 8192 chars of decoded UTF-8.
  - **Options forwarding:** whole optional `options` object passed (single optional param → no explicit-`undefined` keys); `signal` via conditional spread.
- **Deviation from plan:** the brief's literal gitignore rule ("ignored if ANY frame's `matcher.ignores()`") cannot satisfy acceptance criterion 4b (`!`-negation re-include) and contradicts the binding `decisions.md` mechanism. Implemented the git-accurate deepest-first `test()` semantics the criterion/decision require. The brief prose was the artifact that was wrong; brief is immutable, so the deviation is recorded here.

### Test
- **New tests:** `packages/core/src/__tests__/fs-discovery.test.ts` — 19 tests (single-walk set-equality, nested gitignore a/b/c, hidden, symlink no-descend, ordering, caps, grep content+context+merge+clamp, binary skip, cancellation, missing base). Fixtures via `NodePlatform.exec`/`writeFile` (eslint `node:fs` boundary applies to `__tests__/` too).
- **Failures:** 2 — but both were **pre-existing stale task-01 stub assertions** in `node.test.ts` (`glob/grep still throw "landed in task-02"`), now obsolete because glob/grep work. Not implementation bugs.

### Review
- (deferred to iteration 2 after the stale-test fix)

## Iteration 2

### Fix
- **What was fixed:** removed the obsolete `NodePlatform.glob / grep — task-01 throwing stubs` describe block from `packages/core/src/__tests__/node.test.ts` (real glob/grep coverage lives in `fs-discovery.test.ts`). listDir/stat tests untouched.
- **Files modified:** `packages/core/src/__tests__/node.test.ts`.

### Test
- **Failures:** none.
- **Full suite output:**
  ```
  $ pnpm --filter tiny-agentic test
  Test Files  21 passed (21)
       Tests  350 passed (350)
  ```
  `pnpm -r typecheck` → all Done; root `pnpm lint` → clean.

### Review
- **Verdict:** Approved (iteration 2).
- **Gitignore-stack deviation ruling:** the reviewer independently verified `ignore@5.3.2` semantics — deepest-first `test()` with first-opinion-wins is git-accurate; bare `!keep.log` registers `unignored:true` (re-include), silent frames fall through, root `*.log` with no deeper opinion stays ignored. The tester's 4b test is a true pass (would fail under the brief's literal rule — proof the deviation is necessary). **Deviation explicitly approved; brief prose was wrong.**
- **Criteria check:** all pass (single-walk, nested gitignore a/b/c, hidden, symlink safety incl. self-referential loop, ordering, caps incl. exact-limit-no-truncate, grep window-merge/clamp/limit-counts-matches-only, binary skip, abort, missing-base).
- **Correctness:** window merge correct (each line once, match stays match); single shared walk (no divergence — good for task-03/04); symlinked-dir emitted as file is a harmless nit (glob won't match, grep gets EISDIR→skip); permission-skip mid-walk vs directly-targeted-missing-base-rejects both present; abort prompt; exactOptionalPropertyTypes clean; boundary clean; hand-written `picomatch.d.ts` acceptable.
- **Non-blocking observations:** (1) symlink-to-dir emitted as a file entry (harmless); (2) `GrepOptions.ignoreCase` vestigial at platform layer (case rides in `flags`, by design — task-04 owns flag derivation). mtime-desc production ordering effectively untested (name-asc forced under NODE_ENV=test) — acceptable.
- **Regressions:** none. **Issues to fix:** none.

## Completion
- **Iterations:** 2 (iteration 2 was a stale-test cleanup, not an implementation defect).
- **Verification evidence:** `pnpm --filter tiny-agentic test` → 350 passed (21 files); `pnpm -r typecheck` → all Done; root `pnpm lint` → clean.
- **Acceptance criteria:** all verified (see Review criteria check).
- **Regressions:** none.
- **Deviations from plan:** gitignore-stack matching rule (deepest-first `test()` vs brief's literal per-frame `ignores()`) — reviewer-approved as the git-accurate, contract-mandated behavior.

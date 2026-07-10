# Execution Log — Task 04: grep tool

> Dev-loop execution log. Structured by iteration.

## Iteration 1

### Implement
- **Files created:** `packages/core/src/tools/builtin/grep.ts` (`grepTool`).
- **Files modified:** `packages/core/src/index.ts` (export `grepTool` after `globTool`).
- **Layer ownership (verified against `grepImpl`):** window-merge, per-line 500 cap, binary NUL skip, and `limit`-counts-match-lines-only are all in the PLATFORM (`fs-discovery.ts`). The 20 000-char total-result guard is in the TOOL (`grepImpl` has none). No double-application: the tool only relativizes paths + applies the total guard.
- **Decisions / reconciliations not in brief:**
  - `ignoreCase` is vestigial — `grepImpl` builds `new RegExp(source, flags)` and never reads `options.ignoreCase`; case-insensitivity rides in the `"i"` flag the tool passes. Tool does NOT set `ignoreCase` (avoids a dead field).
  - `cwd` option not passed — `grepImpl` roots at `options.path ?? options.cwd ?? platform-cwd`; tool passes `path` (the search root) directly, matching glob's mapping.
  - 20K guard counts context lines toward the total (correct per §7 — total output size, distinct from `limit`), truncates at a MATCH boundary (pops trailing context so the last entry is `kind:"match"`), and ORs into the platform's `truncated` (no clobber).
- **Deviations:** none.

### Test
- **New tests:** `packages/core/src/__tests__/grep.test.ts` — 28 tests. Real `NodePlatform` + temp-dir fixtures via `platform.exec`/`writeFile`; `call(input, platform, ctx)`.
- **Failures:** none.
- **Full suite output:**
  ```
  $ pnpm --filter tiny-agentic test
  Test Files  24 passed (24)
       Tests  400 passed (400)
  ```
  `pnpm -r typecheck` → all Done.

### Review
- **Verdict:** Approved (iteration 1).
- **Adjudication rulings:** (a) layer-ownership CORRECT — no double-application (verified `grepImpl` owns merge/500-cap/binary/limit; tool owns 20K guard); (b) 20K-guard match-boundary CORRECT — counts post-relativized text incl. context, pops trailing context → `match` tail, ORs `truncated`; (c) `count` semantics CORRECT — `count === files.length` (files-with-matches) per §6.
- **Criteria check:** all pass — three modes, no-match≠error, invalid-regex-before-walk, missing-path propagation, context+BOF/EOF clamp+`context` override, window merge (genuinely overlapping fixture), cap interaction (limit-match-only, 500-char `…`, real 20K test), binary skip, toggles + VCS-always-excluded, `isConcurrencySafe()`, index export. Schema verbatim §7; description verbatim §3.5; conditional spreads exactOptionalPropertyTypes-safe.
- **Code/test quality:** clean; reuses `toReturnPath`; consistent with glob/ls; merge + 20K tests are real (not false-passes).
- **Non-blocking nit:** 20K cost heuristic (`file.length + text.length + 16`) under-counts JSON key/quote overhead (~40 chars/entry), so serialized output can modestly exceed 20 000 — within §7's explicit "~20 000-char" approximation, biased toward emitting slightly more (never drops a window wrongly). Recorded, not fixed.
- **Regressions:** none. **Issues to fix:** none.

## Completion
- **Iterations:** 1 (approved first pass).
- **Verification evidence:** `pnpm --filter tiny-agentic test` → 400 passed (24 files); `pnpm -r typecheck` → all Done; root `pnpm lint` → clean.
- **Acceptance criteria:** all verified (see Review criteria check).
- **Regressions:** none.
- **Deviations from plan:** none material (see Implement reconciliations).

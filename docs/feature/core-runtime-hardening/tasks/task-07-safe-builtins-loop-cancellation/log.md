# Execution Log — feature/core-runtime-hardening — Task 07: Safe built-ins, loop integration, and cancellation

## Iteration 1

### Implement
- Added `isConcurrencySafe: () => true` only to `read_file`; ls/glob/grep markers retained and write/edit/bash/Task remain unmarked.
- Added abort guards before preparation, after approval, and before starts. Once observed, remaining calls receive ordered exact cancellation envelopes without lookup/classification/approval/call.
- Started safe calls share the signal through distinct contexts and all settle before yields; read/list syscalls remain honestly non-interruptible.
- Loop code required no production change; existing envelope order and stop-reason behavior retained.

### Test
- Added PT-12, CB-4, CB-11–CB-18/CB-20 integration coverage in runTools/loop tests: exact marker set, reverse completion, child/result/message/usage order, serialization failures, concurrent attribution, Task barrier, stale sinks, active/pre/approval abort, deferred read/list, and next-turn agent_error.
- Runtime tests passed (477), lint/build/boundary passed, but typecheck failed with TS2367 because TypeScript narrowed repeated mutable `signal.aborted` optional-chain comparisons across awaits.

### Review
- Not dispatched while typecheck was red.

---

## Iteration 2

### Fix
- Added module-private `isAborted(signal)` and routed every guard through it, forcing fresh mutable-state reads without changing cancellation semantics.

### Test
- Focused/full:
  ```text
  $ pnpm --filter tiny-agentic test -- <nine focused files>
  Test Files  25 passed (25)
       Tests  477 passed (477)
  $ pnpm --filter tiny-agentic test
  Test Files  25 passed (25)
       Tests  477 passed (477)
  ```
- Typecheck/lint:
  ```text
  $ pnpm --filter tiny-agentic typecheck
  $ tsc --noEmit
  $ pnpm lint
  $ eslint packages/*/src --max-warnings 0
  ```
- Build/boundary:
  ```text
  $ pnpm build && node scripts/check-core-boundaries.mjs
  PT-9 passed: 26 ESLint boundary fixtures verified.
  Boundary scanner passed: 11 parser fixtures verified.
  PT-11 passed: 8 model-facing built-in source files scanned.
  PT-10 passed: 2 JavaScript files in the dist/index.js graph scanned.
  PT-10 passed: dist/platform/node.js remains a separate allowed Node entry.
  ```
- Node 20.18.1 emitted expected >=22 warning; mandatory Node 22 gate remains Task 08.

### Review
- **Verdict:** Approved. All correctness, marker, ordering, cancellation, attribution, Task, serialization, stop-reason, portability, and regression criteria pass.

## Completion
- **Iterations:** 2.
- **Acceptance criteria:**
  - [x] PT-12, CB-4, CB-11–CB-18/CB-20 pass;
  - [x] exact four safe filesystem reads; Task sequential/unmarked;
  - [x] reverse completion preserves all event/message/usage/serialization ordering;
  - [x] one exact cancellation result per unstarted call with no preparation/execution;
  - [x] active read/list settlement claims remain honest;
  - [x] stop-reason propagation remains green;
  - [x] focused/full tests, typecheck, lint, build, boundary proof pass.
- **Regressions/deviations:** none.

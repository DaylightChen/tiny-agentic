# Execution Log — feature/core-runtime-hardening — Task 06: Lazy safe-batch scheduler and barriers

## Iteration 1

### Implement
- Added active `isConcurrencySafe` contract documentation, exact PreparedExecution, lazy model-order preparation, serial approvals, strict barriers, maximal safe batches, Promise.allSettled ordered normalization, and no concurrency cap.
- Existing error strings retained; classifier throw uses the specified exact error. No cancellation behavior, built-in markers, Task marker, or public config/API added.

### Test
- Added deterministic deferred-promise CB-1–CB-10/CB-19 coverage in `runTools.test.ts` with no sleeps.
- Focused `runTools.test.ts`: 29 tests passed. Full suite: 25 files/468 tests passed. Typecheck/lint green.

### Review
- Implementation approved; two temporal test gaps: prove unsafe approval waits until preceding batch result is yielded, and prove no following registry lookup occurs before immediate barriers yield.

---

## Iteration 2

### Fix
- Tester extended CB-7 with deferred predecessor and approval observation.
- Tester observed registry `findByName` for unknown/parse/Zod barriers in CB-5.
- Production code unchanged.

### Test
- Focused:
  ```text
  $ pnpm --filter tiny-agentic exec vitest run src/__tests__/runTools.test.ts
  Test Files  1 passed (1)
       Tests  29 passed (29)
  ```
- Full:
  ```text
  $ pnpm --filter tiny-agentic test
  Test Files  25 passed (25)
       Tests  468 passed (468)
  ```
- Typecheck/lint:
  ```text
  $ pnpm --filter tiny-agentic typecheck
  $ tsc --noEmit
  $ pnpm lint
  $ eslint packages/*/src --max-warnings 0
  ```
- Node 20.18.1 emitted expected >=22 warning; final Node 22 gate remains Task 08.

### Review
- **Verdict:** Approved. All CB-1–CB-10/CB-19 scheduler, temporal, approval, error, attribution, no-cap, and no-marker criteria pass with deterministic controls and no sleeps.

## Completion
- **Iterations:** 2.
- **Acceptance criteria:**
  - [x] CB-1–CB-10 and CB-19 pass with deferred control;
  - [x] safe overlap and ordered results/approvals;
  - [x] every barrier prevents following lookup/preparation and unsafe approval timing is preserved;
  - [x] all siblings settle and unexpected rejection is normalized with attribution/no unhandled rejection;
  - [x] task/write/edit/bash/read_file remain unmarked;
  - [x] no cap/config/API/cancellation behavior added;
  - [x] focused/full tests, typecheck, and lint pass.
- **Regressions/deviations:** none.

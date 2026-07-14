# Execution Log — feature/core-runtime-hardening — Task 05: Per-call context and attribution envelopes

## Iteration 1

### Implement
- Changed `runTools` to yield attributed `ToolExecution` envelopes with one result event, child events, and reported usage.
- Every validated call receives a fresh shallow-cloned context replacing `toolCallId`, `reportUsage`, and `emitEvent`; lookup/parse/validation errors use empty buffers.
- Execution remains strictly sequential; no safety classifier or Promise batching landed.
- `loop.ts` consumes each envelope in order: child events, result event, serialization/block, then usage fold.

### Test
- Added CB-12–CB-15 and CB-20 foundation coverage across `runTools.test.ts`, `loop.test.ts`, `task-tool.test.ts`, and `subagent-boundary.test.ts`.
- Focused:
  ```text
  $ pnpm --filter tiny-agentic exec vitest run src/__tests__/runTools.test.ts src/__tests__/loop.test.ts src/__tests__/task-tool.test.ts src/__tests__/subagent-boundary.test.ts
  Test Files  4 passed (4)
       Tests  101 passed (101)
  ```
- Full:
  ```text
  $ pnpm --filter tiny-agentic test
  Test Files  25 passed (25)
       Tests  456 passed (456)
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
- Functional verdict approved; no correctness/security/test/downstream/regression issues.
- Should-fix: stale `ToolCallContext` comments still described shared batch sinks. Corrected in iteration 2; `isConcurrencySafe` docs intentionally remain Task 06.

---

## Iteration 2

### Fix
- Updated `reportUsage`, `emitEvent`, and `toolCallId` comments to describe per-call envelope buffering/folding and context isolation. No type or behavior change.

### Test
- Full suite 25 files/456 tests passed; typecheck/lint/diff check clean.

### Review
- Comment-only fix aligns public documentation with approved implementation; no remaining issue.

## Completion
- **Iterations:** 2.
- **Acceptance criteria:**
  - [x] exact attributed envelope and atomic loop consumer;
  - [x] execution remains sequential with no classifier/Promise batching;
  - [x] base context never receives per-call ID/sinks; fresh context/buffers per executable call;
  - [x] CB-12–CB-15/CB-20 attribution, stale callback, scalar/reference, Task sequential, and usage assertions pass;
  - [x] serialization remains loop-owned and call-local;
  - [x] focused/full tests, typecheck, lint, and diff check pass.
- **Regressions/deviations:** none.

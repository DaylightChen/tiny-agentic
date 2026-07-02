# Execution Log — Task 04: boundary-guarantee

## Iteration 1

### Implement / Test
- **Files created:** `packages/core/src/__tests__/subagent-boundary.test.ts` (5 tests). Test-only task; no production change.
- **Test design:**
  - A leaky child `MockProvider` emits `text_delta`, a `tool_use` for a child tool `"leaky_child_tool"` returning `{ nested: { provider: "raw" }, marker: "CHILD_TRANSCRIPT_MARKER" }`, then `message_stop`; its terminal carries a `messages: Message[]` transcript with provider-shaped blocks.
  - Parent scripted to call `task` once; `resolveChild` returns `new Agent({ provider: childProvider, tools: [leakyChildTool], platform: new MockPlatform() })`. Driven via `collectEvents`.
  - **precondition** test proves non-vacuity: the child's own `terminal.messages` transcript genuinely contains the marker + raw payload (escaped inside serialized `tool_result.content`), so T10/T11 cannot pass by accident.
  - **T10** — every `subagent_event` has no `messages`/`content`/`role`; `tool_result` arms have no `result` but retain `toolName === "leaky_child_tool"` (allowed); `JSON.stringify` contains neither `"CHILD_TRANSCRIPT_MARKER"` nor `"nested":{"provider":"raw"}`.
  - **T11** — `task` result is `typeof === "string"`, equals `"child final answer"`, no marker/`role`/`messages`.
  - **T12** — terminal `subagent_event` keys ⊆ `{type, reason, usage, errorMessage}`; `reason` allowed value; `usage` Usage-shaped (`10/5`).
  - co-assertion — parent `terminal.usage` = `111/56` (parent 101/51 + child 10/5 folded once).
- **Decisions not in plan:** added the anti-vacuous precondition test and the usage-rollup co-assertion beyond the literal T10-T12.
- **Deviations from plan:** none. Production files untouched.
- **Issues encountered:** one intermediate precondition failure (asserted the unescaped `"nested":{"provider":"raw"}` in the transcript; it appears escaped because the child raw result is serialized as a nested JSON string) — corrected the precondition in the test only; not a boundary leak.
- **Full suite output (iteration 1):** 20 files / 314 tests pass; `tsc --noEmit` exit 0.

### Review
- **Verdict:** Issues found (1 blocking).
- **Criteria check:** T10/T11/T12 all pass; production files unchanged; precondition confirmed non-vacuous; assertions structural, not string-fragile.
- **Issues to fix:**
  1. [Blocking] `subagent-boundary.test.ts:5` — unused `type ChildSpec` import fails the project linter (`@typescript-eslint/no-unused-vars`, `--max-warnings 0`).
- **Regressions:** none.

---

## Iteration 2

### Fix
- **What was fixed:** review issue 1 — removed the unused `type ChildSpec` from the import; now `import { createTaskTool } from "../tools/builtin/task.js";`.
- **Files modified:** `packages/core/src/__tests__/subagent-boundary.test.ts`.

### Test
- **Failures:** none.
- **Full suite output:**
  ```
  $ node_modules/.bin/eslint packages/core/src/__tests__/subagent-boundary.test.ts --max-warnings 0
  LINT_OK
  $ node_modules/.bin/eslint packages/core/src --max-warnings 0
  CORE_LINT_OK
  $ packages/core/node_modules/.bin/tsc -p packages/core/tsconfig.json --noEmit
  (no output; exit 0)
  $ packages/core/node_modules/.bin/vitest run
  Test Files  20 passed (20)
  Tests  314 passed (314)
  ```

### Review
- **Verdict:** Approved (blocking lint issue resolved; re-verified clean).

---

## Completion

- **Commit:** pending
- **Iterations:** 2
- **Verification evidence:**
  ```
  $ packages/core/node_modules/.bin/vitest run
  Test Files  20 passed (20)
  Tests  314 passed (314)
  ```
  ```
  $ packages/core/node_modules/.bin/tsc -p packages/core/tsconfig.json --noEmit
  (no output; exit 0)
  ```
  ```
  $ node_modules/.bin/eslint packages/core/src --max-warnings 0
  (clean)
  ```
- **Acceptance criteria:**
  - [x] Typecheck zero errors — verified.
  - [x] Full suite green incl. T10-T12 — verified (314 tests).
  - [x] T10 sanitized events only (no `messages`/`content`, no raw `result`, marker/raw-payload absent; `toolName` allowed) — verified.
  - [x] T11 result is a string, no transcript marker — verified.
  - [x] T12 terminal reduced to `{type,reason,usage,errorMessage}` — verified.
  - [x] Production files (`task.ts`,`loop.ts`,`runTools.ts`,`events.ts`,`tool.ts`) unchanged — verified by `git status`.
- **Regressions:** none
- **Deviations from plan:** added precondition + usage co-assertion (strengthening); lint fix in iteration 2.

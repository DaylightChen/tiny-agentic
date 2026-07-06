# Execution Log — Task 03: task-tool-factory

## Iteration 1

### Implement
- **Files created:**
  - `packages/core/src/tools/builtin/task.ts` — `createTaskTool` factory, microcopy constants + `TOOL_DESCRIPTION` (includes "Sub-tasks run one at a time in this version."), Zod input schema (snake_case `subagent_type`), `ChildSpec`/`CreateTaskToolOptions` public types (mandatory `resolveChild`, optional `name`, no `maxDepth`), the three exported pure helpers (`extractResultText`, `mapChildTerminalToResult`, `sanitizeChildEvent`), and the `call` driver.
- **Files modified:**
  - `packages/core/src/index.ts` — appended `export { createTaskTool }`, `export type { CreateTaskToolOptions, ChildSpec }`, and the deferred-from-task-01 `export type { SubagentChildEvent }`.
- **Decisions not in plan:**
  - Helpers kept **inline** in `task.ts` (no `task.internal.ts`) — brief allowed either; inline keeps the single new module self-contained. Helpers are `export`ed from `task.ts` (not the `index.ts` barrel) for direct unit testing.
  - `sanitizeChildEvent`'s `switch (event.type)` includes `turn_complete → undefined` (brief-specified) and also `subagent_event → undefined` so the switch is exhaustive over `AgentEvent` (which gained the `subagent_event` arm in task-01). A plain child `Agent.run` never emits `subagent_event` (structural recursion bound), so this arm is dead in practice but keeps the mapping total and type-safe.
- **Deviations from plan:** none on production steps 1-6.
- **Issues encountered:** `pnpm` not on PATH; used `packages/core/node_modules/.bin/tsc -p packages/core/tsconfig.json --noEmit`.

### Test
- **New tests written:** `packages/core/src/__tests__/task-tool.test.ts` (32 tests) — tool surface + microcopy (3), T1-T9 brief plan (12, incl. T6b absent-not-undefined and T8b child-error isolation), boundary invariants (2, pre-covering task-04), pure-helper unit tests (15). Driven via `MockProvider`/`MockPlatform`; `resolveChild` returns `new Agent({ provider: childMockProvider, tools, platform: new MockPlatform() })`.
- **Failures:** none.
- **Full suite output:**
  ```
  $ packages/core/node_modules/.bin/vitest run
   ✓ src/__tests__/task-tool.test.ts (32 tests)
   Test Files  19 passed (19)
        Tests  309 passed (309)
  ```
  ```
  $ packages/core/node_modules/.bin/tsc -p packages/core/tsconfig.json --noEmit
  (no output; exit 0) — T7 @ts-expect-error verified load-bearing (removing it yields TS2345)
  ```

### Review
- **Verdict:** Approved (with two non-code nits: fill this log; and the pre-existing, out-of-scope `examples/openai-run.ts` hardcoded credential must NOT be committed with this task — excluded).
- **Criteria check:**
  - Typecheck zero errors incl. satisfied T7 — pass
  - Full suite + T1-T9 green — pass (309 tests)
  - `createTaskTool`/`CreateTaskToolOptions`/`ChildSpec`/`SubagentChildEvent` exported — pass
  - String result in every branch (done/empty/turn-cap/error/config-error) — pass
  - T3 usage folds exactly once on child error + parent continues — pass (`reportUsage` before throw; loop folds post-batch)
  - T5 zero child tokens + no `reportUsage` on config error — pass (throw precedes drive loop)
  - T6 opaque hints reach `resolveChild` verbatim camelCase, absent-not-undefined — pass (conditional spread)
  - T9 recursion bound via omitted `task` tool — pass
  - Microcopy verbatim as named constants — pass
  - `Agent.run`/`agent.ts`/`loop.ts`/`runTools.ts` unchanged — pass
- **Code quality findings:** clean; mirrors `bash.ts`/`defineTool` style; comments explain the throw-vs-return contract, linked-signal isolation, report-then-throw ordering.
- **Test quality findings:** strong; behavior-named, structural boundary assertions, exact usage arithmetic guards.
- **Regressions:** none.
- **Issues to fix:** log fill (done here); excluded the unrelated `examples/openai-run.ts` from the commit.

---

## Completion

- **Commit:** pending
- **Iterations:** 1
- **Verification evidence:**
  ```
  $ packages/core/node_modules/.bin/vitest run
  Test Files  19 passed (19)
  Tests  309 passed (309)
  ```
  ```
  $ packages/core/node_modules/.bin/tsc -p packages/core/tsconfig.json --noEmit
  (no output; exit 0)
  ```
- **Acceptance criteria:**
  - [x] Typecheck zero errors (T7 satisfied) — verified.
  - [x] Full suite + T1-T9 green — verified (309 tests).
  - [x] `createTaskTool` + option/child/`SubagentChildEvent` types exported from `index.ts` — verified.
  - [x] String result in every case — verified by T1-T5.
  - [x] Config error: zero child tokens, no `reportUsage` — verified by T5.
  - [x] Opaque hints reach `resolveChild` unchanged camelCase — verified by T6.
  - [x] Recursion bound — verified by T9.
  - [x] Microcopy constants verbatim — verified.
  - [x] `Agent.run`/`agent.ts`/`loop.ts`/`runTools.ts` unmodified — verified by `git status`.
- **Regressions:** none
- **Deviations from plan:** helpers inlined (brief-sanctioned); `sanitizeChildEvent` switch made exhaustive over the full `AgentEvent` union.

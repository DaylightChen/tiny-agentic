# Task 05 — Per-call context and attribution envelopes

> Written in the plan phase. Immutable during implement-phase execution.

## Goal

Remove the shared mutable attribution design before enabling any overlap. Change internal `runTools` output to an attributed `ToolExecution` envelope containing one call's `tool_result`, child events, and reported usage; create a fresh shallow-cloned `ToolCallContext` and fresh buffers for every executable call; and update `loop.ts` to consume each envelope in order. Execution remains deliberately sequential in this task.

This atomic producer/consumer refactor proves that IDs, events, usage, declaration-merged scalar fields, and stale callbacks are isolated while preserving all existing validation, approval, error, Task, serialization, and event ordering. Task 06 can then add concurrency without passing through an intermediate leakage state.

## Context files

- Engineering spec §5.3.1 and test IDs CB-12–CB-15, CB-20; §8 risk 11.
- `packages/core/src/loop/runTools.ts` — current `AsyncGenerator<AgentEvent>` and shared `context.toolCallId` mutation.
- `packages/core/src/loop/loop.ts` — current batch-wide child/usage sinks and serialization order.
- `packages/core/src/types/tool.ts` — open declaration-merged context and core-owned fields.
- `packages/core/src/__tests__/runTools.test.ts`, `loop.test.ts`, `task-tool.test.ts`, `subagent-boundary.test.ts` — attribution and sequential Task baselines.
- `packages/core/src/utils/serialize.ts`, `types/usage.ts` — keep serialization in loop and accumulate usage there.

## Downstream dependencies

- Task 06 adds `PreparedExecution` and safe batches on top of these exact envelope/context mechanics.
- Task 07 relies on loop consumption order: envelope child events, then event yield, then result serialization/block append, then only that envelope's usage fold.
- Core-owned fields must be replaced on each clone: `toolCallId`, `reportUsage`, `emitEvent`. All other enumerable fields (including `signal`, `depth`, and declaration-merged scalars/services) are shallow copied.
- Referenced merged objects are intentionally not deep-cloned; do not add generic deep-copy logic.
- `runTools` is internal, so its yield type may change, but its parameters remain `(toolUses, registry, platform, baseContext, approvalHandler?)`.

## Steps

1. **Define internal contracts in `runTools.ts`** — exact `ToolUseEntry`, `ToolResultEvent`, and `ToolExecution` shapes from engineering §5.3.1. `runTools` returns `AsyncGenerator<ToolExecution>`. `PreparedExecution` may be introduced now only if needed for a clean sequential helper, but no classifier/batching behavior lands yet.
2. **Create one isolated context per executable call** — after lookup/parse/Zod succeeds and before approval/call, allocate fresh `childEvents` and `reportedUsage`, then `{ ...baseContext, toolCallId: tu.id, reportUsage: push, emitEvent: push }`. Approval still receives only name/input and remains serial. Unknown/parse/validation errors return envelopes with empty buffers and require no tool context.
3. **Extract total sequential execution helper** — call `tool.call(validatedInput, platform, isolatedContext)` in try/catch and return `ToolExecution`; ordinary throws become the same raw error message as today. No Promise batch/allSettled/classification in this task.
4. **Update loop consumer atomically** — remove mutable installation/deletion of `baseContext.reportUsage`, `emitEvent`, and `toolCallId`. For each envelope yielded in model order: yield each child event as `subagent_event` using `execution.event.toolCallId`; yield `execution.event`; serialize it and append its matching tool-result block; fold exactly that envelope's `reportedUsage` into cumulative usage. Preserve existing `turn_complete.stopReason` and serialization-failure behavior.
5. **Keep sequential behavior explicit** — process one call fully before preparing the next. `isConcurrencySafe` remains unused until task 06. Update comments only enough to describe isolated sequential envelopes and the next scheduler task; do not claim batching is active.
6. **Tester: migrate runTools helpers** — update the local collector type from `AgentEvent[]` to `ToolExecution[]`, and narrow through `.event`. Preserve all existing error-string assertions.
7. **Tester: attribution foundation tests**:
   - **CB-12:** two calls each read the correct ID from distinct context objects; one mutates/deletes its local property and cannot affect sibling/base context.
   - **CB-13 (sequential foundation):** each call's emitted events are in its own envelope and loop flushes them before that call's result with correct `taskId`.
   - **CB-14 (sequential foundation):** distinct reported usage stays in matching envelopes and terminal cumulative usage is exact.
   - **CB-15 baseline:** two Task-like unmarked calls remain sequential; existing Task/boundary tests stay green.
   - **CB-20 foundation:** a retained callback/context from a prior call cannot write into a later call/turn's live buffer; an added declaration-merged scalar field survives shallow clone. Use module augmentation in the test file for the scalar.

## Acceptance criteria

- [ ] `runTools` yields exact attributed envelopes; `loop.ts` consumes the new shape in the same commit.
- [ ] Calls still execute strictly sequentially; no call uses `isConcurrencySafe`, `Promise.all`, or `Promise.allSettled` yet.
- [ ] Base context is never mutated with per-call ID/sinks; each executable call receives a distinct object and arrays.
- [ ] CB-12–CB-15 and CB-20 foundation assertions pass; all existing Task sanitation/usage behavior stays green.
- [ ] Result serialization remains in `loop.ts` and serialization errors remain call-local.
- [ ] `pnpm --filter tiny-agentic test -- src/__tests__/runTools.test.ts src/__tests__/loop.test.ts src/__tests__/task-tool.test.ts src/__tests__/subagent-boundary.test.ts` passes.
- [ ] `pnpm --filter tiny-agentic typecheck`, root `pnpm lint`, and full core test pass.

## Output files

**Implementer-owned production files:**
- Modified: `packages/core/src/loop/runTools.ts`
- Modified: `packages/core/src/loop/loop.ts`

**Tester-owned test files:**
- Modified: `packages/core/src/__tests__/runTools.test.ts`
- Modified: `packages/core/src/__tests__/loop.test.ts`
- Modified as needed for explicit sequential proof: `packages/core/src/__tests__/task-tool.test.ts`
- Modified as needed for regression: `packages/core/src/__tests__/subagent-boundary.test.ts`

# Task 06 — Lazy safe-batch scheduler and barriers

> Written in the plan phase. Immutable during implement-phase execution.

## Goal

Implement the high-risk scheduler in isolation on top of task 05's leak-proof envelopes. `runTools` must lazily prepare calls in exact model order, invoke classifiers synchronously after successful Zod validation and before approval, invoke approvals serially, form maximal contiguous batches of approved safe calls, start every call in a batch before awaiting, await all started calls with `Promise.allSettled`, and yield total envelopes in input order. Every unknown/malformed/invalid/classifier-failed/denied/approval-failed/unmarked/false call is a temporal barrier.

This task uses custom marked tools and controllable deferred promises. It does not add `read_file`'s marker or final loop/cancellation integration—that is task 07. At completion, overlap and barrier semantics are proven without any shared attribution state or hidden concurrency cap.

## Context files

- Engineering spec §§5.3.2–5.3.7; exact test IDs CB-1–CB-10 and CB-19.
- Feature decisions: lazy serial preparation, envelopes/allSettled, no cap.
- `packages/core/src/loop/runTools.ts` as committed after task 05.
- `packages/core/src/types/tool.ts` — update active hook documentation.
- `packages/core/src/__tests__/runTools.test.ts` — existing errors/approvals and task-05 envelope collector.
- `packages/core/src/tools/builtin/task.ts` — inspect to ensure no marker is added.

## Downstream dependencies

- Task 07 adds built-in markers/cancellation and loop integration tests; scheduler semantics must stay exact.
- Preparation order is lookup → provider parse check → Zod safeParse → classifier → approval. Abort guards are operational and added/finalized in task 07.
- Do not prepare past a known barrier. In particular, unsafe approval occurs only after preceding safe batch settles; following calls are untouched until barrier is yielded.
- Classifier throw exact string: `Tool '<name>': concurrency safety check failed — <error message>`; skip approval and call.
- No concurrency cap or new Agent/config option.

## Steps

1. **Document active hook contract** — update `Tool.isConcurrencySafe` comments: synchronous after validation/before approval; pure/deterministic/side-effect-free; true certifies overlap including Platform and referenced merged context state; absence/false is a barrier; throw is an error barrier and skips approval/call.
2. **Add exact `PreparedExecution`** — include tool use, tool, validated input, `concurrencySafe`, isolated context and buffers. Reuse task-05 context factory mechanics; do not create shared sinks.
3. **Implement lazy preparation** — one index at a time. Produce a total immediate error envelope for lookup/parse/Zod/classifier failure. Classification occurs exactly once. Safe approval runs serially during preparation; denial/throw becomes a barrier. An unsafe call causes prior safe batch flush **before** its approval.
4. **Implement barrier flow** — maintain `safeBatch`. On immediate/error/denial barrier, execute/yield prior batch first, then yield barrier envelope. For unmarked/false, flush prior batch, then approve and execute alone or yield approval error/denial; do not inspect following call until yielded.
5. **Implement batch execution** — create all `executePrepared(...)` promises in input order without awaiting between starts; `await Promise.allSettled`. Convert fulfilled values and unexpected rejections to total `ToolExecution` envelopes using exact engineering §5.3.4 shape, retaining that call's buffers. Yield settlement-derived envelopes in input order only after every sibling settles.
6. **No cap** — start every prepared member of the maximal batch. No semaphore, pool, chunking, option, or implicit limit.
7. **Tester: deterministic scheduler matrix** — use deferred promises, no wall-clock sleeps:
   - **CB-1:** two safe calls both started before either resolves.
   - **CB-2:** resolve second then first; envelope IDs/results remain first then second.
   - **CB-3:** safe→unsafe→safe temporal barriers.
   - **CB-5:** unknown, parse-invalid, and Zod-invalid barriers; no look-ahead.
   - **CB-6:** approvals serial/model order; denial and approval throw barrier; denied work never starts.
   - **CB-7:** unmarked approved call executes alone with no overlap.
   - **CB-8:** classifier false is unmarked; throw exact string and skips approval/call.
   - **CB-9:** ordinary safe tool throw does not suppress sibling; ordered success/error.
   - **CB-10:** exercise defensive unexpected-helper rejection through a narrow test seam/spied helper if necessary; assert normalized per-call error, retained buffers, and no `unhandledRejection`. Do not make the helper public from package index.
   - **CB-19:** more than eight safe deferred calls all report started before any resolve.
8. **Preserve existing strings** — existing unknown/parse/Zod/approval/denial/tool-call strings remain exact in migrated tests.

## Acceptance criteria

- [ ] CB-1–CB-10 and CB-19 pass using deferred control, not timing sleeps.
- [ ] Safe calls overlap; yielded envelopes and approvals remain model ordered.
- [ ] Every barrier class matches engineering §5.3.5 and no following call is prepared early.
- [ ] All started siblings settle before first batch yield; unexpected rejection is normalized with attribution retained and no unhandled rejection.
- [ ] `task`, write/edit/bash remain unmarked; `read_file` is still unmarked until task 07.
- [ ] No cap/config/API surface is added.
- [ ] `pnpm --filter tiny-agentic test -- src/__tests__/runTools.test.ts` passes.
- [ ] `pnpm --filter tiny-agentic typecheck`, root `pnpm lint`, and full core test pass.

## Output files

**Implementer-owned production files:**
- Modified: `packages/core/src/loop/runTools.ts`
- Modified: `packages/core/src/types/tool.ts`

**Tester-owned test files:**
- Modified: `packages/core/src/__tests__/runTools.test.ts`

# Task 07 — Safe built-ins, loop integration, and cancellation

> Written in the plan phase. Immutable during implement-phase execution.

## Goal

Finish the runtime behavior by enabling the exact initial safe built-in set, integrating concurrent envelopes through the full agent loop, and implementing deterministic cancellation-before-start semantics. Add `read_file`'s safe marker; retain `ls`/`glob`/`grep`; keep write/edit/bash/Task unmarked. The loop must flush each envelope's child events, tool result, serialization, and usage in model order even when completion is reversed. Cancellation must start no new work after observation, synthesize one ordered result per unstarted provider tool use, deliver the shared signal to active calls through isolated contexts, and honestly allow in-flight `readFile`/`listDir` promises to settle.

This task is the cross-cutting proof that scheduler, portability, stop reasons, Task sanitation, usage attribution, serialization, approvals, and cancellation coexist correctly.

## Context files

- Engineering spec §§5.2.5, 5.3.1, 5.3.2, 5.3.6; PT-12; CB-4 and CB-11–CB-18/CB-20.
- `packages/core/src/loop/runTools.ts`, `loop.ts` after tasks 05–06.
- `packages/core/src/tools/builtin/readFile.ts`, `ls.ts`, `glob.ts`, `grep.ts`, `writeFile.ts`, `editFile.ts`, `bash.ts`, `task.ts`.
- Tests: `runTools.test.ts`, `loop.test.ts`, `agent.test.ts`, `builtin-tools.test.ts`, `ls.test.ts`, `glob.test.ts`, `grep.test.ts`, `task-tool.test.ts`, `subagent-boundary.test.ts`, `scripts/check-core-boundaries.mjs`.
- `packages/core/src/utils/serialize.ts` — call-local failure behavior.

## Downstream dependencies

- Task 08 documents this exact final behavior and test output; do not leave provisional wording.
- Exact cancellation string: `Tool '<name>': call cancelled before start`.
- Cancellation results must not perform lookup/classification/approval/call for unstarted entries and must preserve one result per provider call.
- Active calls all settle before ordered yields. No signal parameters are added to `Platform.readFile` or `listDir`.
- `task` remains sequential with batched child events before its result; no concurrent Task design enters this task.

## Steps

1. **Mark only read_file** — add `isConcurrencySafe: () => true` to `readFileTool`. Do not alter its schema/path delegation or add signal-aware Platform calls. Verify existing markers on ls/glob/grep remain and no marker exists on write/edit/bash/any Task factory output.
2. **Add scheduler abort guards** — before preparing each call, after serial approval, and immediately before starting an unsafe call/safe batch, check `baseContext.signal?.aborted`. Once observed, flush/await any already-active batch, then produce ordered synthetic cancellation envelopes for every remaining unstarted entry without registry lookup/classifier/approval/tool call. Approved-but-not-started safe entries get cancellations.
3. **Maintain active-call honesty** — all active contexts carry the same `AbortSignal` value but are distinct objects. Await all started settlements. `glob`/`grep` may reject cooperatively; `read_file`/`ls` may resolve only after deferred Platform promises are manually settled.
4. **Confirm loop consumption order** — for each yielded envelope in model order: child `subagent_event`s with matching task ID, then `tool_result`, then serialization/result block append, then fold only that envelope's usage. Keep `turn_complete.stopReason` and final stop reason unchanged. A serialization failure changes only the corresponding message block/error flag and does not reorder siblings.
5. **Prevent stale attribution** — no retained callback from a completed call/turn can report into a later live buffer. Isolated context callbacks close over only that call's arrays; loop holds no batch-wide mutable sinks.
6. **Tester: marker and loop tests**:
   - **CB-4:** exact positives read_file/ls/glob/grep; exact negatives write/edit/bash/task.
   - **CB-11:** two reverse-completed safe values produce ordered yielded results and ordered tool-result blocks in the next provider request; a circular/BigInt result's serialization failure is call-local.
   - **CB-12–CB-14 final:** truly concurrent custom safe tools observe distinct IDs, emit isolated child events before their own ordered result, and report exact non-duplicated usage.
   - **CB-15 final:** two Task-like/factory outputs never overlap; existing Task child/usage/boundary tests remain green.
   - **CB-20 final:** retained sinks cannot affect later call/turn; declaration-merged scalar survives concurrent clones.
7. **Tester: cancellation tests**:
   - **CB-16:** abort during active safe batch; active calls see same aborted signal, all settle, following barrier never starts, remaining exact cancellations ordered.
   - **CB-17:** pre-aborted runTools performs no lookup/classifier/approval/call and emits one cancellation per entry.
   - **CB-18:** abort during serial approval prevents approved-but-unstarted work and cancels remainder deterministically.
   - **PT-12:** pre-aborted read/list do not invoke custom Platform methods; active deferred read/list contexts see aborted signal but no result yields until each Platform promise is explicitly resolved/rejected.
8. **Agent-loop cancellation continuation** — verify that after tool results pair correctly, a next provider turn receives the already-aborted signal and existing behavior becomes `agent_error`; add no new terminal reason.
9. **Re-run bundle proof** — after build, ensure scheduler/built-in edits did not reintroduce a Node/process edge.

## Acceptance criteria

- [ ] PT-12, CB-4, and CB-11–CB-18/CB-20 pass.
- [ ] Exact initial safe set is four filesystem reads; Task remains sequential and unmarked.
- [ ] Reverse completion never changes event, child-event, usage, serialization, message-block, or result order.
- [ ] Cancellation yields one exact result per unstarted call and performs none of lookup/classifier/approval/call for those calls.
- [ ] Active read/list tests do not claim prompt syscall interruption; they settle only when their deferred Platform promises settle.
- [ ] Stop-reason propagation from tasks 01–02 remains green through tool turns.
- [ ] `pnpm --filter tiny-agentic test -- src/__tests__/runTools.test.ts src/__tests__/loop.test.ts src/__tests__/agent.test.ts src/__tests__/builtin-tools.test.ts src/__tests__/ls.test.ts src/__tests__/glob.test.ts src/__tests__/grep.test.ts src/__tests__/task-tool.test.ts src/__tests__/subagent-boundary.test.ts` passes.
- [ ] `pnpm --filter tiny-agentic typecheck`, root `pnpm lint`, `pnpm build`, and full `pnpm --filter tiny-agentic test` pass.
- [ ] `pnpm build && node scripts/check-core-boundaries.mjs` passes.

## Output files

**Implementer-owned production files:**
- Modified: `packages/core/src/tools/builtin/readFile.ts`
- Modified: `packages/core/src/loop/runTools.ts`
- Modified if final integration adjustment is needed: `packages/core/src/loop/loop.ts`

**Tester-owned test files:**
- Modified: `packages/core/src/__tests__/runTools.test.ts`
- Modified: `packages/core/src/__tests__/loop.test.ts`
- Modified: `packages/core/src/__tests__/agent.test.ts`
- Modified: `packages/core/src/__tests__/builtin-tools.test.ts`
- Modified as marker regressions require: `ls.test.ts`, `glob.test.ts`, `grep.test.ts`
- Modified: `packages/core/src/__tests__/task-tool.test.ts`
- Modified: `packages/core/src/__tests__/subagent-boundary.test.ts`

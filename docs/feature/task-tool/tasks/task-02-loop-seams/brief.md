# Task 02 — Loop seams: usage write-back, child-event forwarding, tool-call id

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Wire the **three context seams** into the agent loop so a tool can (a) report out-of-band token usage that folds into the run's cumulative total, (b) emit sanitized child events that surface on the parent stream, and (c) learn the tool-use id of its own call. This is the **load-bearing, novel change** (engineering-spec R1) — `loop/loop.ts` today mutates `cumulativeUsage` in exactly one place (from `message_stop`, `loop.ts:75-77`); this task adds a *second* accumulation source without introducing double-counting, loss-on-error, or ordering bugs.

The mechanism is the spec's **collect-then-flush** model (no async queue, no concurrency), because `Tool.call` is awaited and `runTools` cannot `yield` mid-`call`:

1. Before each `runTools` batch, create a per-batch `reportedUsage: Usage[]`; wire `context.reportUsage` to push into it.
2. For **each tool-use**, set `context.toolCallId = tu.id` and wire `context.emitEvent` to push into a per-call `childEvents: SubagentChildEvent[]`.
3. When a tool's `call` resolves, yield its buffered `childEvents` as `subagent_event`s (`{ type: "subagent_event", taskId: tu.id, event }`) **immediately before** yielding that tool's `tool_result`.
4. After the whole batch, `accumulateUsage` each `reportedUsage` entry into `cumulativeUsage`.

Crucially this task is tested with **stub tools** that call `context.reportUsage`/`emitEvent` and read `context.toolCallId` directly — **no `task` tool and no child `Agent`** — isolating the loop mechanics from the tool mechanics (R1: "implement and test this seam first, in isolation, before any real child run"). At the end, the loop's new machinery is proven correct and is a no-op for runs that report nothing.

## Context files

- `docs/feature/task-tool/engineering/2026-07-01-task-tool-engineering.md` — binding spec. Focus on: **Architectural fit → Existing modules touched** (`loop/loop.ts`, `loop/runTools.ts` bullets, with line numbers), **Architectural fit → Usage/event collection mechanism (the loop-side detail, v1)** (the four-step collect-then-flush), **Risks R1 and R3**, and **Test plan → `loop.test.ts` (extend)** rows T13-T17.
- `docs/feature/task-tool/plan/implementation-plan.md` — Dependency rationale (why this is risk-first) and the Coverage rows for R1/R3/E5.
- `packages/core/src/loop/loop.ts` — **the file that changes most.** The tool-execution block is `loop.ts:100-137`; the single existing usage-accumulation point is `loop.ts:75-77`. The `context` is constructed once at `loop.ts:25` (`const context: ToolCallContext = { signal }`).
- `packages/core/src/loop/runTools.ts` — **minor change:** it must set `context.toolCallId = tu.id` before each `tool.call` (and the loop must reset/clear the per-call `emitEvent` sink per tool-use). Read its whole body — the per-tool loop is `runTools.ts:21-107`, the `tool.call` site is `runTools.ts:89-90`.
- `packages/core/src/types/tool.ts` — the `ToolCallContext` fields added in task-01 (`reportUsage?`, `emitEvent?`, `toolCallId?`). **Must be committed before this task starts.**
- `packages/core/src/types/events.ts` — `SubagentChildEvent` and the `subagent_event` arm (from task-01). The loop imports `SubagentChildEvent` to type the per-call buffer.
- `packages/core/src/types/usage.ts` — `accumulateUsage(total, turn)` (pure, field-wise sum) and `EMPTY_USAGE`. Reuse `accumulateUsage` for the write-back; do not hand-roll summation.
- `packages/core/src/__tests__/loop.test.ts` — **the test harness and the file to extend.** Study `MockProvider` (scripts `ProviderEvent[][]`, one inner array per `stream()` call), `MockPlatform`, `makeParams`, `okTool`, and `collectEvents` (drains a run into `{ events, terminal }`). The existing "usage accumulation" describe block (`loop.test.ts:289-486`) is the pattern for the new usage tests.
- `packages/core/src/utils/collect.ts` — `collectEvents` semantics (returns both `events[]` and the `Terminal`).

## Downstream dependencies

- **task-03**'s `createTaskTool` calls `context.reportUsage(child.terminal.usage)` exactly once, calls `context.emitEvent(sanitized)` for each child lifecycle event, and reads `context.toolCallId` as its `taskId`. The behavior this task establishes — *report accumulates once after the batch*, *emitted events are yielded before the `tool_result` correlated by `taskId === tu.id`*, *`toolCallId` equals the current `tu.id`* — is exactly what task-03 relies on. Preserve these three behaviors precisely.
- **task-04** asserts the ordering (child `subagent_event`s appear after the spawning `tool_use_start` and before its `tool_result`) end-to-end. That ordering contract is implemented here.
- The **no-op guarantee** (T17): a run whose tools call none of the new sinks must behave byte-identically to today. Every existing `loop.test.ts`/`agent.test.ts` assertion must still pass unchanged. Do not reorder or rename any existing yielded event.

## Steps

1. **Type the per-batch and per-call buffers.** In `loop/loop.ts`, import `SubagentChildEvent` (`import type { SubagentChildEvent } from "../types/events.js";`). Inside the tool-execution block (`loop.ts:101+`, when `pendingToolUses.length > 0`), before the `runTools` loop, create the per-batch usage buffer:

   ```ts
   const reportedUsage: Usage[] = [];
   context.reportUsage = (u) => { reportedUsage.push(u); };
   ```

   `context` is the same object constructed at `loop.ts:25`; you are assigning its optional fields now that a batch is running. (Assigning to an optional field is fine; existing tools that never read it are unaffected.)

2. **Wire per-tool-use `toolCallId` + `emitEvent`.** The correlation id and the event sink must be **per tool-use**, not per batch (decision 2026-07-01: "`toolCallId` must be populated per tool-use by `runTools`, from `tu.id`"). Choose one of the two spec-sanctioned shapes; **prefer shape B** for a smaller `runTools` blast radius:

   - **Shape A (loop owns per-call context):** the loop sets `context.toolCallId` and re-wires `context.emitEvent` to a fresh `childEvents` buffer *before each* `runTools` iteration. This requires the loop to interleave with `runTools` per tool-use, which `runTools` currently does not expose.
   - **Shape B (recommended):** `runTools` sets `context.toolCallId = tu.id` at the top of its per-tool loop body (before Zod/approval/`call`) and clears it (`delete context.toolCallId` or set back to the batch default) after each iteration — this is the "minor change to `runTools`" the spec calls for. The **loop** owns the `emitEvent` buffering by wrapping: because the loop drives `runTools` via `for await`, and `runTools` yields one `tool_result` per tool-use, the loop can associate the buffer with each `tool_result` as it arrives. Concretely:

     - In `runTools.ts`: at the start of the `for (const tu of toolUses)` body, wrap the per-tool-use work in `try/finally`: set `context.toolCallId = tu.id;` before parse/approval/call handling, and clear it in the `finally` so early `continue` branches (unknown tool, parse failure, validation failure) cannot leak the id to a later call. Keep `runTools`'s external signature identical (still `(toolUses, registry, platform, context, approvalHandler)`).
     - In `loop.ts`: maintain a single mutable `let childEvents: SubagentChildEvent[] = []` and set `context.emitEvent = (e) => { childEvents.push(e); }` **once** before the `runTools` loop. Before the loop processes each `tool_result`, the accumulated `childEvents` are exactly the events the just-finished tool emitted (because tools run sequentially and each `tool_result` is yielded synchronously after its `call` resolves). When you receive a `tool_result` from `runTools`, **first** yield each buffered `childEvents` as `subagent_event`, **then** yield the `tool_result`, then reset `childEvents = []`.

     > Why this works with the current `runTools`: `runTools` is sequential and yields a tool's `tool_result` immediately after its `call` resolves, before starting the next tool. So at the moment the loop sees `tool_result` for `tu`, `childEvents` holds precisely `tu`'s emitted events and nothing from a later tool. The `taskId` for those events is `toolEvent.toolCallId` (which equals `tu.id`). This is the batch-before-`tool_result` ordering contract (R3).

   Pick shape B unless a discovered constraint (e.g. `runTools` refactor already in flight) makes shape A cheaper — record the choice in the log.

3. **Emit the buffered child events before each `tool_result`.** Modify the `for await (const toolEvent of runTools(...))` block in `loop.ts` (currently `loop.ts:104-131`). Inside, when `toolEvent.type === "tool_result"`:

   ```ts
   // BEFORE yielding the tool_result, flush this call's buffered child events:
   for (const childEvent of childEvents) {
     yield { type: "subagent_event", taskId: toolEvent.toolCallId, event: childEvent };
   }
   childEvents = [];
   // ...then the existing serialize-and-yield of the tool_result (unchanged logic)
   yield toolEvent;
   // ...existing serializeToolResult / toolResultBlocks.push code unchanged...
   ```

   **Ordering care:** today the code does `yield toolEvent;` at the top of the loop body (`loop.ts:105`) *before* the serialize block. Restructure so the `subagent_event` flush happens **before** that `yield toolEvent;`. Keep the existing `serializeToolResult` try/catch and `toolResultBlocks.push` exactly as-is — you are only inserting the flush ahead of the `tool_result` yield, not changing result serialization. Do not flush for non-`tool_result` events (there are none from `runTools` today, but guard on `toolEvent.type === "tool_result"` anyway).

4. **Fold reported usage after the batch.** After the `for await (const toolEvent of runTools(...))` loop completes and `workingMessages.push({ role: "user", content: toolResultBlocks })` runs (`loop.ts:133`), accumulate the reported usage into `cumulativeUsage` **once**:

   ```ts
   for (const u of reportedUsage) {
     cumulativeUsage = accumulateUsage(cumulativeUsage, u);
   }
   ```

   Place this **before** the `yield { type: "turn_complete", ... }` for that turn so a consumer reading the turn boundary sees a consistent state, and well before the natural-completion / next-iteration branch. `accumulateUsage` is already imported (`loop.ts:6`). **Do not** also re-derive usage from the emitted `subagent_event`s — that is the E5 double-count trap. Usage rolls up from `reportUsage` *only*; `emitEvent` is for observation, never for accounting.

5. **Clean up the sinks per batch (avoid stale closures).** After the batch's usage fold (or in the branch structure), it is fine to leave `context.reportUsage`/`emitEvent` assigned — the next batch reassigns them to fresh buffers. But **`context.toolCallId` must not leak** across batches or across early per-call branches: shape B must clear it in a `finally` inside each `for (const tu of toolUses)` iteration. A stub tool that reads `context.toolCallId` outside a `runTools`-driven call must see it absent — but since tools only run inside `runTools`, this is naturally satisfied; just do not set `toolCallId` at loop construction (`loop.ts:25` stays `{ signal }`).

6. **Confirm the no-subagent path is untouched.** Trace the branch where `pendingToolUses.length === 0` (natural completion, `loop.ts:138-144`) and where tools run but call no sinks: `reportedUsage` stays `[]` (fold loop is a zero-iteration no-op), `childEvents` stays `[]` (flush loop is a zero-iteration no-op). No new event is yielded, no usage changes. This is the T17 guarantee — verify by re-running the existing suite unchanged.

7. **Extend `loop.test.ts` with T13-T17.** Add a new `describe("agentLoop — subagent seams", ...)` block. Use `MockProvider` for the model turns and define **stub tools** that exercise the sinks (no child `Agent`). Example stub-tool shapes:

   ```ts
   // a tool that reports usage
   const reportingTool = defineTool({
     name: "report_tool",
     description: "reports usage",
     inputSchema: z.object({}).passthrough(),
     call: async (_input, _platform, context) => {
       context.reportUsage?.({ inputTokens: 5, outputTokens: 7, cacheReadTokens: 0 });
       return "reported";
     },
   });
   // a tool that emits two child events then returns
   const emittingTool = defineTool({
     name: "emit_tool",
     description: "emits child events",
     inputSchema: z.object({}).passthrough(),
     call: async (_input, _platform, context) => {
       context.emitEvent?.({ type: "text_delta", text: "child-a" });
       context.emitEvent?.({ type: "text_delta", text: "child-b" });
       return "emitted";
     },
   });
   // a tool that echoes its own toolCallId
   const idEchoTool = defineTool({
     name: "id_tool",
     description: "echoes toolCallId",
     inputSchema: z.object({}).passthrough(),
     call: async (_input, _platform, context) => context.toolCallId ?? "MISSING",
   });
   ```

   - **T13 — Usage write-back (R1, SC6):** parent turn 1 uses `report_tool` (message_stop usage `{in:10,out:5}`), turn 2 completes naturally (message_stop usage `{in:3,out:2}`). Assert `terminal.usage` equals the parent's own tokens **plus** the reported `{in:5,out:7}` — i.e. `inputTokens: 10+3+5 = 18`, `outputTokens: 5+2+7 = 14`, `cacheReadTokens: 0`. Field-wise exact. (Cross-check against the existing `accumulateUsage` semantics.)
   - **T14 — No double-count / no loss on error (E5, SC6):** a tool that calls `context.reportUsage(...)` **and then throws** (so its `tool_result` is `isError:true`). Assert the reported usage is still accumulated **exactly once** into `terminal.usage` (report happens before the throw; the loop's post-batch fold runs regardless of per-tool error). Drive a second turn to natural completion so the run terminates `agent_done`.
   - **T15 — Event batch ordering (R3, SC7):** parent turn 1 calls `emit_tool` (which emits `child-a` then `child-b`), turn 2 completes. Collect events; assert the subsequence for that call is: `tool_use_start` (emit_tool), then `subagent_event`(text_delta "child-a"), then `subagent_event`(text_delta "child-b"), then `tool_result`(emit_tool) — **in that order**. Assert each `subagent_event.taskId` equals the tool-use id from the script (e.g. `"e1"`).
   - **T16 — `toolCallId` correlation:** parent turn 1 calls `id_tool` with tool-use id `"x1"`; assert the `tool_result.result` for that call is `"x1"` (the tool echoed `context.toolCallId`), proving it equals `tu.id`. If the tool also emits an event, assert the emitted `subagent_event.taskId` equals `"x1"` too.
   - **T17 — No-subagent no-op (NF overhead):** a run with `okTool` (the existing stub that reports/emits nothing) yields exactly the event sequence the existing "runs a tool then completes" test asserts — no `subagent_event`, usage unchanged from the message_stop-only path. (You can assert `events.every(e => e.type !== "subagent_event")` and reuse the existing expected sequence.)

8. **Typecheck and run the full suite.** All existing tests plus T13-T17 must be green.

## Acceptance criteria

- [ ] `pnpm -C packages/core typecheck` reports **zero errors**.
- [ ] `pnpm -C packages/core test` passes — **every pre-existing test green** (byte-identical behavior for non-subagent runs) plus new T13-T17.
- [ ] T13: a run where a tool reports `{in:5,out:7}` yields a terminal `usage` equal to the message-stop total **plus** `{in:5,out:7}`, field-wise exact (no double-count, no loss).
- [ ] T14: reported usage on a turn whose tool also errors is accumulated **exactly once**.
- [ ] T15: for a `task`-style call, the yielded order is `tool_use_start` → `subagent_event`(s) → `tool_result`, with each `subagent_event.taskId` equal to that call's tool-use id.
- [ ] T16: a tool reading `context.toolCallId` sees the current `tu.id`; an emitted `subagent_event.taskId` matches it.
- [ ] T17: a run with tools that touch no new sink emits **no** `subagent_event` and has usage identical to today.
- [ ] `runTools`'s exported signature is unchanged (`git diff` shows no change to its parameter list); its only new behavior is setting `context.toolCallId = tu.id` per tool-use and clearing it in a `finally` so parse/validation/unknown-tool branches cannot leak it.
- [ ] `Agent.run`'s signature and `agent.ts` are **unchanged** by this task.

## Output files

- Modified: `packages/core/src/loop/loop.ts` (buffer wiring, subagent_event flush before each tool_result, post-batch usage fold, `SubagentChildEvent` import)
- Modified: `packages/core/src/loop/runTools.ts` (set/clear `context.toolCallId = tu.id` per tool-use; signature unchanged)
- Modified: `packages/core/src/__tests__/loop.test.ts` (new `describe` block: T13-T17)

# Task 03 — `createTaskTool` factory, child-run driver, and helpers

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Build the feature's single new production module — `packages/core/src/tools/builtin/task.ts` — exporting **`createTaskTool(options)`**, a factory that closes over a **mandatory** host-supplied `resolveChild` and returns a `Tool` named `task`. When the model calls it, the tool: resolves a child `Agent` via `resolveChild` (host applies the model/provider/subagent_type fallback chain and returns a fully-built `Agent`); drives the child with `for await (const ev of child.run(prompt, { signal: linkedSignal }))`; forwards each child lifecycle event to the parent stream **sanitized** (via `context.emitEvent`); rolls the child's `Terminal.usage` into the parent's total (via `context.reportUsage`, **exactly once**); and returns a single **string** result mapped from the child's terminal reason.

Also build the pure, unit-testable helpers (in `task.ts` or a split-out `task.internal.ts`): `extractResultText(messages)`, `mapChildTerminalToResult(terminal)`, and `sanitizeChildEvent(event)`. Finally, export the new public surface from `packages/core/src/index.ts` (`createTaskTool`, `CreateTaskToolOptions`, `ChildSpec`, and the `SubagentChildEvent` type added in task-01).

At the end, a parent agent with a registered `task` tool can spawn a child (driven in tests by a `MockProvider` through `resolveChild`) and get back a string, with all the edge-case mappings (empty output, child error, turn cap, config error, abort cascade, recursion bound, opaque-hint passthrough) covered by `task-tool.test.ts` (T1-T9). The boundary *proof* is task-04; this task makes the boundary *hold* via `sanitizeChildEvent` and the string result.

## Context files

- `docs/feature/task-tool/engineering/2026-07-01-task-tool-engineering.md` — binding spec. Focus on: **User-visible behavior → Primary flow** (consumer/model/observation), **States matrix S1** (the exact result strings per state), **Microcopy** (the exact model-facing strings — these are load-bearing, copy them verbatim), **Edge cases E3/E4/E6/E7/E8/E9**, **Architectural fit → New modules / New interfaces** (the `ChildSpec`, `CreateTaskToolOptions`, `createTaskTool` contracts + the "`tool_result` child event carries no `result`" note), and **Test plan → `task-tool.test.ts`** (T1-T9).
- `docs/feature/task-tool/decisions.md` — the four decisions (esp. "Per-task model/provider via a host `resolveChild` fallback chain" and "Normalized parent/child boundary"). `resolveChild` returns a built `Agent`; a throw becomes a config-error result; child approval is host-owned.
- `docs/feature/task-tool/plan/implementation-plan.md` — Coverage rows for E3/E4/E6/E7/E8, Microcopy, Primary flow.
- `packages/core/src/agent.ts` — `Agent`/`AgentOptions`/`RunOptions`. The child is a plain `Agent`; `child.run(prompt, { signal })` returns `AsyncGenerator<AgentEvent, Terminal>`. Note `run`'s own `finally` aborts the child's internal controller when the driver stops iterating (relevant to E9).
- `packages/core/src/types/events.ts` — `AgentEvent`, `Terminal`, and (from task-01) `SubagentChildEvent` + the `subagent_event` arm. `sanitizeChildEvent` maps `AgentEvent` → `SubagentChildEvent`.
- `packages/core/src/types/tool.ts` — the `ToolCallContext` seams from task-01 (`reportUsage?`, `emitEvent?`, `toolCallId?`) and `Tool`/`defineTool`. **task-01 and task-02 must both be committed before this task.**
- `packages/core/src/types/messages.ts` — `Message`/`ContentBlock`/`TextBlock`. `extractResultText` walks the child's `Terminal.messages` for the last assistant text.
- `packages/core/src/types/usage.ts` — `EMPTY_USAGE` (fallback when a child terminal has no captured usage).
- `packages/core/src/tools/builtin/bash.ts` — the reference tool shape (`defineTool`, reading `context.signal`, an input `z.object`). Mirror the style. `createTaskTool` differs in that it is a **factory** (returns a `Tool`) rather than a bare exported constant.
- `packages/core/src/loop/loop.ts` — **as committed after task-02.** Confirm how `context.emitEvent`/`reportUsage`/`toolCallId` behave (emitted events are yielded before the `tool_result`; reported usage folds once after the batch; `toolCallId` equals the call's `tu.id`). The tool codes against this committed behavior.
- `packages/core/src/index.ts` — the public export list. This task appends the new exports.
- `packages/core/src/__tests__/loop.test.ts` — reuse its `MockProvider`/`MockPlatform` for the child in `task-tool.test.ts`. A child `Agent` is `new Agent({ provider: mockChildProvider, tools, platform: new MockPlatform() })`; `resolveChild` in tests returns such an `Agent`.

## Downstream dependencies

- **task-04** imports `createTaskTool` and drives a full parent→child→parent run to assert the boundary (result is a `string`; every `subagent_event` is sanitized; terminals reduced). It depends on: the tool returning a `string` in **all** cases, `sanitizeChildEvent` dropping `messages`/`content`/raw `result`, and the tool emitting a `terminal` `SubagentChildEvent` for every child run (including empty/error). Keep `sanitizeChildEvent` the single choke point for child→parent event mapping.
- **task-05** imports `createTaskTool` from the package entry (`tiny-agentic`) in an example; the export name and `CreateTaskToolOptions`/`ChildSpec` shapes must be stable and match the spec.
- The **exact result strings** (microcopy) are keyed on by tests here and are model-facing contracts — later work must not change them without a decision. Bake them as named constants at the top of `task.ts`.

## Steps

1. **Create `task.ts` skeleton with the input schema and microcopy constants.** Define the Zod input schema and the exact model-facing strings verbatim from the spec's Microcopy section:

   ```ts
   import { z } from "zod";
   import type { Agent } from "../../agent.js";
   import type { Tool, ToolCallContext } from "../../types/tool.js";
   import type { AgentEvent, Terminal, SubagentChildEvent } from "../../types/events.js";
   import type { Message } from "../../types/messages.js";
   import { EMPTY_USAGE } from "../../types/usage.js";

   const EMPTY_OUTPUT = "(sub-agent produced no output)";
   const TURN_CAP_PREFIX = "[sub-agent stopped at turn cap] ";
   const FAILED_PREFIX = "Sub-agent failed: ";
   const CONFIG_ERROR_PREFIX = "Sub-agent config error: ";

   const TOOL_DESCRIPTION =
     "Delegate a self-contained sub-task to a fresh sub-agent that runs with its own tools and turn budget, and return its final summary. Use for well-scoped work you can describe completely up front. Optionally pick a model or provider for the sub-task. Sub-tasks run one at a time in this version.";

   const taskInputSchema = z.object({
     description: z.string().describe("3-5 word summary of the sub-task, for logging."),
     prompt: z.string().describe("The full task for the sub-agent. Must be self-contained — the sub-agent does not see this conversation."),
     subagent_type: z.string().optional().describe("Optional named sub-agent profile to use, if the host registered any."),
     model: z.string().optional().describe("Optional model hint for the sub-task. Interpreted by the host; falls back to the sub-agent profile default, then the runner default."),
     provider: z.string().optional().describe("Optional provider hint for the sub-task. Interpreted by the host; falls back to the sub-agent profile default, then the runner default."),
   });
   ```

   Note: the tool's wire input uses snake_case `subagent_type` (what the model sees), but `ChildSpec` uses camelCase `subagentType` (what `resolveChild` receives) — map between them in step 4. The one-at-a-time sentence is binding for v1 (R6) so the model does not assume parallel execution; keep the exact `TOOL_DESCRIPTION` string above and assert it in tests/acceptance.

2. **Define the public types.** Per the spec's contract block:

   ```ts
   export type ChildSpec = {
     subagentType?: string;   // opaque
     model?: string;          // opaque
     provider?: string;       // opaque
     prompt: string;
     signal: AbortSignal;     // linked child signal
   };

   export type CreateTaskToolOptions = {
     resolveChild: (spec: ChildSpec) => Agent | Promise<Agent>;  // MANDATORY
     name?: string;           // override wire name, default "task"
     // NOTE: no maxDepth in v1 — recursion is bounded structurally (resolveChild
     // must omit the `task` tool from the child). See spec §Risks R2.
   };

   export function createTaskTool(options: CreateTaskToolOptions): Tool { /* step 3+ */ }
   ```

   `resolveChild` being a required field of `CreateTaskToolOptions` makes `createTaskTool({})` a compile error (T7) — no runtime guard needed for the mandatory-ness, though a defensive `if (!options.resolveChild) throw` is acceptable belt-and-suspenders.

3. **Write the three pure helpers** (in `task.ts`, or split to `task.internal.ts` and re-import — either is fine; if split, keep them internal, not part of `index.ts`). Record the choice in the log.

   - **`extractResultText(messages: Message[]): string`** — walk `messages` from the end; find the last message with `role: "assistant"`; concatenate its `text` blocks (handle both `content: string` and `content: ContentBlock[]`). If the result is empty or whitespace-only, return `EMPTY_OUTPUT`. (E8)
   - **`mapChildTerminalToResult(terminal: Terminal): { text: string; isError: boolean }`** — the E4 mapping:
     - `agent_done` → `{ text: extractResultText(terminal.messages), isError: false }`
     - `max_turns_exceeded` → `{ text: TURN_CAP_PREFIX + extractResultText(terminal.messages), isError: false }` (best-effort partial; note `extractResultText` already substitutes `EMPTY_OUTPUT` if there is no assistant text, so the prefix may precede the empty-output string — that is acceptable and consistent)
     - `agent_error` → `{ text: FAILED_PREFIX + terminal.error.message, isError: true }`
   - **`sanitizeChildEvent(event: AgentEvent): SubagentChildEvent | undefined`** — map raw child events to the sanitized union, **dropping `messages` and raw tool-result payloads**:
     - `text_delta` → `{ type: "text_delta", text: event.text }`
     - `tool_use_start` → `{ type: "tool_use_start", toolName: event.toolName, toolInput: event.toolInput }`
     - `tool_result` → `{ type: "tool_result", toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError }` **(no `result`)**
     - `agent_done` → `{ type: "terminal", reason: "agent_done", usage: event.usage }`
     - `max_turns_exceeded` → `{ type: "terminal", reason: "max_turns_exceeded", usage: event.usage }`
     - `agent_error` → `{ type: "terminal", reason: "agent_error", usage: event.usage, errorMessage: event.error.message }`
     - `turn_complete` → return `undefined` (not surfaced as a child event; the terminal carries final usage). Skip `undefined` results when emitting.

     This is the single choke point that makes the boundary type-safe: it returns a `SubagentChildEvent`, so `messages`/`ContentBlock`/raw `result` **cannot** be represented in its output (a leak would be a compile error).

4. **Implement the tool `call`.** Inside `createTaskTool`, return a `Tool` (use `defineTool` or a plain object typed `Tool`) whose `call(input, platform, context)` does:

   1. **Build the linked child signal (E3).** `const childCtrl = new AbortController();` then `const linkedSignal = context.signal !== undefined ? AbortSignal.any([context.signal, childCtrl.signal]) : childCtrl.signal;`. Parent-abort cascades to the child; a child-internal failure does **not** touch `context.signal`. (`childCtrl` is available if the tool ever needs to abort the child on its own; in v1 you may not call `childCtrl.abort()` explicitly, but constructing the linked signal is what isolates parent from child.)
   2. **Resolve the child (E6).** In a `try`, `const child = await options.resolveChild({ prompt: input.prompt, signal: linkedSignal, ...(input.subagent_type !== undefined ? { subagentType: input.subagent_type } : {}), ...(input.model !== undefined ? { model: input.model } : {}), ...(input.provider !== undefined ? { provider: input.provider } : {}) });` — pass **only** defined optional fields (respect `exactOptionalPropertyTypes`; do not pass `undefined`). If `resolveChild` throws, `catch (err)` and **return** `CONFIG_ERROR_PREFIX + (err instanceof Error ? err.message : String(err))` as the result, and set an error flag — but the tool `call` returns a plain value; to signal `isError:true`, throw is *not* what we want here (the loop maps a thrown error to a generic error result). **Return the config-error string directly and rely on the S1 mapping**: the spec says config error is `isError:true`. Since `Tool.call` returns a value (mapped to `isError:false`) unless it throws (mapped to `isError:true`), the clean way to get `isError:true` for the config error is to **throw an `Error` whose message is exactly** `CONFIG_ERROR_PREFIX + detail` — the loop's `runTools` catch turns a thrown `Error` into `{ result: err.message, isError: true }` (see `runTools.ts:98-105`). **Verify against the committed `runTools.ts`**: a thrown `Error` from `call` becomes `result: err.message, isError: true`. So: on `resolveChild` throw, spend zero child tokens and `throw new Error(CONFIG_ERROR_PREFIX + detail)`. (Do **not** call `context.reportUsage` — no child ran.) This satisfies T5.

      > Important nuance: for the **child-error** case (E4, `agent_error`) the result must be `isError:true` **and** usage must still roll up, so that path cannot simply `throw` (a throw would skip the `reportUsage` and produce a generic message). Handle E4 by mapping the terminal and returning — but returning maps to `isError:false`. This is the one place the value-return contract fights the two-outcome need. Resolve it as follows (and confirm against the committed loop): the loop only distinguishes error via **throw**. So to make `agent_error` `isError:true` while still rolling up usage, **first** call `context.reportUsage(child-terminal-usage)`, **then** `throw new Error(FAILED_PREFIX + message)`. The usage is reported before the throw, so the post-batch fold still accumulates it (this is exactly the T14 scenario task-02 proved). For `agent_done` and `max_turns_exceeded` (both `isError:false`), report usage then **return** the mapped string. This gives: config-error → throw (no usage); child-error → report-then-throw; done/turn-cap → report-then-return. Bake this into the terminal handling in sub-step 4.
   3. **Drive the child + forward sanitized events.** `let terminal: Terminal;` then:

      ```ts
      const iter = child.run(input.prompt, { signal: linkedSignal });
      while (true) {
        const step = await iter.next();
        if (step.done) { terminal = step.value; break; }
        const sanitized = sanitizeChildEvent(step.value);
        if (sanitized !== undefined) context.emitEvent?.(sanitized);
      }
      ```

      (Using the explicit iterator form captures the `Terminal` return value; a `for await` loop discards it. Alternatively use `collectEvents`-style manual iteration.) Each non-`turn_complete` child event is emitted sanitized; the loop (task-02) buffers these and yields them before this tool's `tool_result`, tagged with `taskId = context.toolCallId`.
   4. **Roll up usage + map result (E4, E5).** Once `terminal` is set, in **all** non-config-error cases call `context.reportUsage?.(terminal.usage ?? EMPTY_USAGE)` **exactly once**. Then branch on `terminal.reason` per the report-then-throw / report-then-return rule from sub-step 2:
      - `agent_done` → `return mapChildTerminalToResult(terminal).text;` (report first)
      - `max_turns_exceeded` → `return mapChildTerminalToResult(terminal).text;` (report first; `isError:false`)
      - `agent_error` → report first, then `throw new Error(mapChildTerminalToResult(terminal).text);` (yields `isError:true`)

      Since `sanitizeChildEvent` already emitted a `terminal` `SubagentChildEvent` when the child's terminal `AgentEvent` came through the drive loop, the consumer sees the terminal on the stream **and** the usage rolls up — no double count (usage rolls up once via `reportUsage`, and the emitted `terminal` event is observation-only, never re-accounted; this is the E5 invariant task-02 enforces).

   5. **`isConcurrencySafe`** — omit it in v1 (sequential, R6). The tool description already notes one-at-a-time.

5. **Wire the wire-name override.** The returned `Tool.name` is `options.name ?? "task"`. Everything else (description, schema) is constant.

6. **Export from `index.ts`.** Append:

   ```ts
   export { createTaskTool } from "./tools/builtin/task.js";
   export type { CreateTaskToolOptions, ChildSpec } from "./tools/builtin/task.js";
   export type { SubagentChildEvent } from "./types/events.js";
   ```

   (This is the deferred-from-task-01 public export of `SubagentChildEvent`, now landing alongside the tool.)

7. **Write `task-tool.test.ts` (T1-T9).** New file `packages/core/src/__tests__/task-tool.test.ts`. Reuse `MockProvider`/`MockPlatform` (copy or import the local test helpers from `loop.test.ts` — if they are not exported, redefine minimal versions in this file, matching the existing pattern). Drive the parent with a `MockProvider` scripted to call `task` once, and have `resolveChild` return `new Agent({ provider: childMockProvider, tools: childTools, platform: new MockPlatform() })`. Use `collectEvents` to drain the parent.

   - **T1 — happy path (SC1):** child `MockProvider` ends `agent_done` with assistant text "OK". Assert the parent's `tool_result.result` for the `task` call is `"OK"`, `isError:false`.
   - **T2 — empty output (E8, microcopy):** child ends `agent_done` with no assistant text. Assert result `=== "(sub-agent produced no output)"`, `isError:false`.
   - **T3 — child error (E4, SC5):** child provider accumulates non-zero usage, then throws (use a `ThrowingProvider`-style child after at least one message-stop/usage-bearing turn if needed) → child `agent_error`. Assert result `=== "Sub-agent failed: <msg>"`, `isError:true`; assert the parent's terminal usage includes the child accumulated usage **exactly once** (the tool reported usage before throwing); and assert the **parent run continues** (parent reaches `agent_done` on its next turn, not `agent_error`).
   - **T4 — turn-cap partial (E4, SC5):** child scripted so it always returns a tool-use turn with a child `maxTurns` low enough to trip the cap (construct the child `Agent` with `maxTurns: 1` and a child provider that keeps requesting a tool). Assert result begins with `"[sub-agent stopped at turn cap] "` and `isError:false`.
   - **T5 — config error (E6, SC3):** `resolveChild` throws `new Error("unknown provider 'x'")`. Assert result `=== "Sub-agent config error: unknown provider 'x'"`, `isError:true`, and the child provider's `stream` was **never called** (assert via a spy / a `MockProvider` whose `requests` array stays empty — zero tokens).
   - **T6 — opaque hints passthrough (SC3, R4):** make `resolveChild` a spy that records its `spec` and returns a trivial child. Script the parent to call `task({ description:"d", prompt:"p", model:"m", provider:"pr", subagent_type:"t" })`. Assert the spy received `{ prompt:"p", model:"m", provider:"pr", subagentType:"t", signal: <AbortSignal> }` and that core did not transform/validate the hint strings (they arrive verbatim).
   - **T7 — `resolveChild` mandatory:** a `// @ts-expect-error` line `createTaskTool({})` proving it fails to compile (runtime mandatory-ness is unrepresentable otherwise).
   - **T8 — abort cascade (E3, SC4):** create a parent `AbortController`; script the child provider to check `signal.aborted` (or to be a long-ish generator) and abort the parent signal while the child is mid-run; assert the child's run receives an aborted signal (the child terminates, e.g. `agent_error` from the aborted stream) and the tool returns/throws **without** crashing the parent unexpectedly. Also assert a **child-internal** error (T3's path) does **not** abort the parent's own signal (the parent continues). Keep this test focused; if precise mid-stream timing is fiddly with the mock, assert the weaker-but-sufficient property: the signal passed into the child `stream()` is a **linked** signal derived from `context.signal` (i.e. aborting `context.signal` aborts the child's observed signal), and a child throw leaves `context.signal.aborted === false`.
   - **T9 — recursion bound (E1, SC2):** construct `resolveChild` to return a child whose tool set **omits** `task` (the correct host behavior). Script the child to attempt calling `task` anyway; assert the child gets the unknown-tool result (`"Unknown tool: 'task'"` from `runTools`), i.e. no spawn occurs. This asserts the documented contract (correct hosts are safe; core adds no second guard in v1).

8. **Typecheck and run the full suite.** All prior tests plus T1-T9 green.

## Acceptance criteria

- [ ] `pnpm -C packages/core typecheck` reports **zero errors** (the T7 `// @ts-expect-error` is satisfied).
- [ ] `pnpm -C packages/core test` passes — all prior tests green plus T1-T9.
- [ ] `git grep -n "createTaskTool" packages/core/src/index.ts` shows the export; `CreateTaskToolOptions`, `ChildSpec`, and `SubagentChildEvent` are also exported from `index.ts`.
- [ ] The tool result is a `string` in every case: `agent_done`→summary, empty→`"(sub-agent produced no output)"`, `max_turns_exceeded`→`"[sub-agent stopped at turn cap] "`+partial (`isError:false`), `agent_error`→`"Sub-agent failed: <msg>"` (`isError:true`), config error→`"Sub-agent config error: <detail>"` (`isError:true`).
- [ ] T3: when the child ends in `agent_error` after accumulating non-zero usage, the parent `tool_result` is `"Sub-agent failed: <msg>"` with `isError:true`, the parent run continues, and the parent terminal usage includes the child usage exactly once.
- [ ] T5: on a `resolveChild` throw, the child provider's `stream` is never invoked (zero child tokens) and `context.reportUsage` is not called.
- [ ] T6: the opaque `model`/`provider`/`subagent_type` strings reach `resolveChild` as `model`/`provider`/`subagentType` unchanged; core does not enumerate or validate them.
- [ ] T9: a child whose `resolveChild` omitted `task` cannot spawn — a child `task` call returns the unknown-tool result.
- [ ] The four microcopy prefixes and the exact tool description (including `"Sub-tasks run one at a time in this version."`) are present verbatim as named constants in `task.ts`.
- [ ] `Agent.run`, `agent.ts`, `loop.ts`, and `runTools.ts` are **not modified** by this task (it only adds `task.ts`, optional `task.internal.ts`, the `index.ts` exports, and the test).

## Output files

- Created: `packages/core/src/tools/builtin/task.ts` (`createTaskTool`, constants, types, `call` driver)
- Created (optional): `packages/core/src/tools/builtin/task.internal.ts` (`extractResultText`, `mapChildTerminalToResult`, `sanitizeChildEvent` — if split out)
- Modified: `packages/core/src/index.ts` (export `createTaskTool`, `CreateTaskToolOptions`, `ChildSpec`, `SubagentChildEvent`)
- Created: `packages/core/src/__tests__/task-tool.test.ts` (T1-T9)

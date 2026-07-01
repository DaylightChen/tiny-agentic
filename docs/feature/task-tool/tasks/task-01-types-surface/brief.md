# Task 01 — Type-level surface: sub-agent event union + context seams

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Add the **type-level foundation** for the sub-agent feature — no runtime behavior yet. Two type modules change:

1. `packages/core/src/types/events.ts` gains the **`SubagentChildEvent`** closed union (the sanitized child-lifecycle shape) and a new **`subagent_event`** arm on `AgentEvent` that wraps a `SubagentChildEvent` plus a `taskId` correlation string.
2. `packages/core/src/types/tool.ts` gains three **optional, core-populated** fields on the existing `ToolCallContext` interface: `reportUsage?`, `emitEvent?`, `toolCallId?`.

At the end of this task, the whole codebase still compiles and every existing test still passes (these are additive-only changes), and new **type tests** prove three properties the later tasks rely on: (T18) an existing tool ignoring the new context fields still compiles; (T19) an exhaustive `switch` over `AgentEvent` without a `subagent_event` arm and no `default` is a *compile error* (the arm is additive-and-visible); (T20) `SubagentChildEvent` is a closed union that a `Message`-bearing terminal `AgentEvent` is **not** assignable to (the boundary is type-level). This is the shared surface `loop.ts` (task-02) and `task.ts` (task-03) both import — landing it first, proven back-compatible, de-risks everything downstream.

## Context files

Read these before starting:

- `docs/feature/task-tool/engineering/2026-07-01-task-tool-engineering.md` — the binding spec. Focus on: **New interfaces / contracts** (the exact `ToolCallContext` and `SubagentChildEvent` code blocks), **Data model changes**, and **Architectural fit → back-compat plan**.
- `docs/feature/task-tool/plan/implementation-plan.md` — this plan; the Coverage check row for "Data model changes".
- `packages/core/src/types/events.ts` — the current `AgentEvent`/`Terminal` unions. The `subagent_event` arm is appended here; `SubagentChildEvent` is defined here.
- `packages/core/src/types/tool.ts` — the current `ToolCallContext` interface (currently only `signal?`). The three new fields are added here, alongside `signal`, with the existing declaration-merging doc-comment conventions.
- `packages/core/src/types/usage.ts` — `Usage` is referenced by both new types (`reportUsage(usage: Usage)`, the sanitized terminal's `usage: Usage`). Already imported into `events.ts`.
- `packages/core/src/types/messages.ts` — `Message`/`ContentBlock`; T20 proves these do **not** appear in `SubagentChildEvent`.
- `packages/core/src/__tests__/types.test.ts` — the existing type-test file and its conventions (this is where T18-T20 go, or a sibling `subagent-types.test.ts`; prefer extending `types.test.ts` if it already holds `// @ts-expect-error` patterns — read it first to decide).
- `packages/core/src/tools/builtin/bash.ts` — the existing tool used for the T18 "ignores new fields, still compiles" assertion.

## Downstream dependencies

- **task-02** imports `SubagentChildEvent` into `loop/loop.ts` (to buffer and yield as `subagent_event`) and reads/writes `context.reportUsage`/`emitEvent`/`toolCallId`. The exact field names, the `reportUsage(usage: Usage): void` and `emitEvent(event: SubagentChildEvent): void` signatures, and the `subagent_event` arm shape `{ type: "subagent_event"; taskId: string; event: SubagentChildEvent }` must match the spec verbatim — task-02 and task-03 code against these names.
- **task-03** imports `SubagentChildEvent` into `tools/builtin/task.ts` (its `sanitizeChildEvent` returns this type) and reads `context.toolCallId` as `taskId`. The `terminal` arm's exact shape (`{ type: "terminal"; reason: "agent_done" | "max_turns_exceeded" | "agent_error"; usage: Usage; errorMessage?: string }`) is what `mapChildTerminalToResult`/`sanitizeChildEvent` produce.
- **task-04** asserts (runtime) that no forwarded event has `messages`/`content` and that `tool_result` child events have no `result` — the *type* here is what makes those assertions provable and makes a leak a compile error.
- All three fields on `ToolCallContext` MUST stay **optional** (`?`) — every existing tool and `agentLoop`'s current `const context: ToolCallContext = { signal }` must keep compiling. Do not make any field required.

## Steps

1. **Define `SubagentChildEvent` in `types/events.ts`.** Add the closed union exactly as the spec's contract block specifies. Place it after the `Terminal` type (or before `AgentEvent` — anywhere top-level in the module). `Usage` is already imported.

   ```ts
   // types/events.ts — sanitized child-lifecycle union.
   // Deliberately omits `messages`, `content`/ContentBlock, and any provider-native
   // block, so nothing provider-shaped can cross the parent/child boundary through it.
   // The `tool_result` arm carries metadata only (no `result` payload) — a child's
   // raw tool result can embed provider structures; a consumer that needs full child
   // tool output reads the child Terminal inside its own resolveChild wiring.
   export type SubagentChildEvent =
     | { type: "text_delta";     text: string }
     | { type: "tool_use_start"; toolName: string; toolInput: unknown }
     | { type: "tool_result";    toolName: string; toolCallId: string; isError: boolean }
     | { type: "terminal";       reason: "agent_done" | "max_turns_exceeded" | "agent_error"; usage: Usage; errorMessage?: string };
   ```

2. **Add the `subagent_event` arm to `AgentEvent` in `types/events.ts`.** Append one arm to the existing union. Add a short doc-comment line to the existing "events" doc block noting `subagent_event` is a tertiary/advanced-consumer event (it follows the same forward-compat posture the file already documents at the top).

   ```ts
   // append to the AgentEvent union (before the terminal-events group is fine, or after tool_result):
   | { type: "subagent_event"; taskId: string; event: SubagentChildEvent }
   ```

   `taskId` is the spawning `task` call's tool-use id (sourced from `context.toolCallId` at runtime in task-02). Note in a comment that the arm is **not recursive**: the wrapped payload is a `SubagentChildEvent`, which has no `subagent_event` member, so a grandchild's events cannot nest onto the parent stream through this type.

3. **Add the three fields to `ToolCallContext` in `types/tool.ts`.** Insert them into the existing interface after `signal?`, each with the exact doc-comment from the spec's contract block. Keep them optional. Import `Usage` and `SubagentChildEvent`:

   ```ts
   // at the top of types/tool.ts, add type-only imports:
   import type { Usage } from "./usage.js";
   import type { SubagentChildEvent } from "./events.js";
   ```

   ```ts
   // inside ToolCallContext, after `signal?: AbortSignal;`
   /** Report token usage consumed by work a tool performed out-of-band (e.g. a
    *  child Agent run). agentLoop folds this into the run's cumulative usage
    *  after the tool batch. Safe to call multiple times; each call accumulates. */
   reportUsage?: (usage: Usage) => void;
   /** Emit a sanitized child event onto the parent's stream from inside a tool.
    *  Used by the task tool to surface the child's lifecycle. In v1 the loop
    *  buffers these and yields them (wrapped as `subagent_event`) immediately
    *  before the tool's `tool_result`. Never carries child `messages`. */
   emitEvent?: (event: SubagentChildEvent) => void;
   /** The tool-use id of the call currently executing. Populated by the loop per
    *  tool-use so a tool can correlate emitted events / logs to its own call
    *  (the task tool uses it as `taskId`). Absent for tools that don't need it. */
   toolCallId?: string;
   ```

   **Watch for an import cycle.** `tool.ts` importing from `events.ts` while `events.ts` imports from `usage.ts` (and `tool.ts` is imported by `loop.ts`, which imports `events.ts`) — these are **type-only** imports (`import type`), which are erased at compile time and do not create a runtime cycle. Verify `tsc` is happy; if a cycle warning appears, it is a type-only edge and the `import type` keyword is the fix (already specified above). Do not restructure modules to avoid it.

4. **Export the new type from `index.ts` scaffolding is deferred to task-03.** Do **not** touch `packages/core/src/index.ts` in this task — `SubagentChildEvent` becomes a public export in task-03 alongside `createTaskTool` and the tool option types, so all the new public surface lands in one export edit. (If a type test needs to import `SubagentChildEvent`, it imports from the source module path `../types/events.js`, not the package entry.)

5. **Write the type tests (T18-T20).** Read `packages/core/src/__tests__/types.test.ts` first. If it already uses `// @ts-expect-error` for compile-error assertions, extend it; otherwise create `packages/core/src/__tests__/subagent-types.test.ts` in the same style. These are compile-time assertions wrapped in a trivial `it(...)` so vitest reports them.

   - **T18 — additive context (SC back-compat):** import `bashTool` (or construct a `defineTool` whose `call` reads only `signal`); assert it is assignable to `Tool` and its `call` compiles unchanged. A value-level check like `expect(bashTool.name).toBe("bash")` plus the fact the file type-checks is sufficient; the real assertion is "this file compiles".
   - **T19 — `AgentEvent` exhaustiveness:** write a function with a `switch (ev.type)` over `AgentEvent` that handles every arm **except** `subagent_event` and has **no** `default`, then assign the switch's fall-through to `never` — guard it with `// @ts-expect-error` so the test *fails to compile if the arm is ever removed*. Example shape:

     ```ts
     function assertNever(x: never): never {
       throw new Error(String(x));
     }

     function missingSubagentEvent(ev: AgentEvent): void {
       switch (ev.type) {
         case "text_delta":
         case "tool_use_start":
         case "tool_result":
         case "turn_complete":
         case "agent_done":
         case "max_turns_exceeded":
         case "agent_error":
           return;
       }

       // @ts-expect-error — `subagent_event` must remain unhandled here,
       // so the residual `ev` is not `never`.
       assertNever(ev);
     }
     ```
     Adjust the exact arm list to the committed `AgentEvent` union if it has drifted. The load-bearing property is: **a compile error is expected precisely because `subagent_event` exists and is unhandled.** This helper shape keeps the expected error on the directive line and avoids fragile nested-expression diagnostics.
   - **T20 — `SubagentChildEvent` is closed / leak-proof:** assert (type-level) that a `Message`-bearing terminal `AgentEvent` (e.g. `{ type: "agent_done"; messages: Message[]; usage: Usage }`) is **not** assignable to `SubagentChildEvent`, and that `SubagentChildEvent`'s `terminal` arm has no `messages` key. A `// @ts-expect-error` on an attempted assignment `const _leak: SubagentChildEvent = someAgentDoneEvent;` proves it. Also assert positively that a valid sanitized terminal `{ type: "terminal", reason: "agent_done", usage: EMPTY_USAGE }` **is** assignable.

6. **Typecheck and test.** From the repo root (or `packages/core`), run the typechecker and the full test suite. Both must pass with zero errors — this task must not break any existing test.

## Acceptance criteria

- [ ] `pnpm -C packages/core typecheck` (i.e. `tsc --noEmit`) reports **zero errors**. The `// @ts-expect-error` lines in the type tests are *satisfied* (each suppresses a real error) — an unsatisfied `@ts-expect-error` is itself a `tsc` error, so a green typecheck proves T19/T20 assert what they claim.
- [ ] `pnpm -C packages/core test` passes with **all existing tests green** and the new T18-T20 present (in `types.test.ts` or `subagent-types.test.ts`).
- [ ] `git grep -n "subagent_event" packages/core/src/types/events.ts` shows the arm `{ type: "subagent_event"; taskId: string; event: SubagentChildEvent }`.
- [ ] `git grep -n "reportUsage\|emitEvent\|toolCallId" packages/core/src/types/tool.ts` shows all three fields, each with a trailing `?` (optional).
- [ ] `SubagentChildEvent` has exactly four arms (`text_delta`, `tool_use_start`, `tool_result`, `terminal`); the `tool_result` arm has **no** `result` field; the `terminal` arm has no `messages` field.
- [ ] `packages/core/src/index.ts` is **unchanged** by this task (public export of `SubagentChildEvent` is task-03's job).
- [ ] Manually: `bashTool` and the other existing builtin tools compile without modification (no edit to their `call` signatures).

## Output files

- Modified: `packages/core/src/types/events.ts` (add `SubagentChildEvent`, add `subagent_event` arm)
- Modified: `packages/core/src/types/tool.ts` (add three optional context fields + two `import type` lines)
- Created or Modified: `packages/core/src/__tests__/subagent-types.test.ts` (new) **or** `packages/core/src/__tests__/types.test.ts` (extended) — whichever matches the existing convention

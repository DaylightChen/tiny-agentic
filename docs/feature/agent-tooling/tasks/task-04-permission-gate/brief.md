# Task 04 — Permission Gate

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Implement the approval/permission gate — the seam that lets consumers intercept and deny tool calls before they execute. This task does four things:

1. Add `ApprovalDecision` and `ApprovalHandler` types to `packages/core/src/types/tool.ts`.
2. Add `approvalHandler?: ApprovalHandler` to `AgentOptions` in `agent.ts` and to `LoopParams` in `loop/loop.ts`.
3. Implement the gate in `runTools` — after Zod validation, before `tool.call` — and add `approvalHandler?` as a parameter to `runTools`.
4. Add gate tests to `packages/core/src/__tests__/runTools.test.ts`.

When this task is complete, a consumer can inject an `approvalHandler` into `new Agent({...})` that runs for every tool call. Without a handler, all tool calls pass through (backward-compatible default). The gate is not yet wired from `agentLoop` through to `runTools` — that wiring happens in task-05. For task-04, the gate exists and is testable by calling `runTools(...)` directly with an `approvalHandler` argument.

## Context files

- `packages/core/src/types/tool.ts` — current state after task-01: has `ToolCallContext` with `signal?`; add `ApprovalDecision` and `ApprovalHandler` here
- `packages/core/src/loop/runTools.ts` — current implementation to modify; add gate after Zod, before `tool.call`
- `packages/core/src/loop/loop.ts` — current `LoopParams` type; add `approvalHandler?` field
- `packages/core/src/agent.ts` — current `AgentOptions` type; add `approvalHandler?` field; store on instance
- `packages/core/src/__tests__/runTools.test.ts` — existing tests to extend; they must all still pass
- `docs/feature/agent-tooling/engineering/2026-06-29-agent-tooling-engineering.md` — §6.3 (exact type definitions for `ApprovalDecision`, `ApprovalHandler`), §8.3 (full gate pseudocode with exact error strings), §3.2 (states matrix for denied calls), §3.5 (exact microcopy strings for denied/check-failed), §12 (test strategy for `runTools.test.ts` additions)
- `docs/feature/agent-tooling/decisions.md` — decisions on seam surface, gate location, and type placement (no-circular-import rule)

## Downstream dependencies

- **Task-05 (wiring and exports)** imports `ApprovalHandler` from `types/tool.ts` and threads `approvalHandler` from `agent.ts` through `agentLoop` to `runTools`. Keep these exports stable:
  - `ApprovalDecision` (type) from `types/tool.ts`
  - `ApprovalHandler` (type) from `types/tool.ts`
  - `approvalHandler?: ApprovalHandler` field on `AgentOptions` in `agent.ts`
  - `approvalHandler?: ApprovalHandler` field on `LoopParams` in `loop/loop.ts`
  - `runTools` signature: `runTools(toolUses, registry, platform, context, approvalHandler?)` — the new fifth parameter
- **Task-05** wires the handler from `Agent` constructor through `agentLoop` to `runTools`. The wiring requires `approvalHandler` to exist on `AgentOptions`, `LoopParams`, and `runTools`.

## Steps

1. **Edit `packages/core/src/types/tool.ts`** — add the two new types after the `ToolCallContext` interface and before `Tool`. Do not modify `Tool` or `defineTool`. Add:
   ```ts
   /**
    * Decision returned by an ApprovalHandler.
    */
   export type ApprovalDecision = 'allow' | 'deny';

   /**
    * Optional callback injected into AgentOptions. Called before every tool.call,
    * after Zod validation. Return 'allow' to proceed or 'deny' to block. If this
    * callback throws, the tool call is blocked and the error message is returned
    * to the model.
    *
    * If not provided, all tool calls are allowed (blanket allow default).
    */
   export type ApprovalHandler = (
     toolName: string,
     input: unknown,
   ) => Promise<ApprovalDecision>;
   ```

2. **Edit `packages/core/src/loop/runTools.ts`** — add the gate. Changes:
   - Add `import type { ApprovalHandler } from "../types/tool.js";` at the top (alongside existing type imports).
   - Add `approvalHandler?: ApprovalHandler` as a fifth parameter to `runTools`:
     ```ts
     export async function* runTools(
       toolUses: ToolUseEntry[],
       registry: ToolRegistry,
       platform: Platform,
       context: ToolCallContext,
       approvalHandler?: ApprovalHandler,
     ): AsyncGenerator<AgentEvent> {
     ```
   - Insert the gate block after the Zod `safeParse` success check and before the `try { result = await tool.call(...) }` block:
     ```ts
     // Approval gate — runs after Zod validation, before tool.call
     if (approvalHandler !== undefined) {
       let decision: ApprovalDecision;
       try {
         decision = await approvalHandler(tool.name, parseResult.data);
       } catch (err) {
         yield {
           type: "tool_result",
           toolName: tool.name,
           toolCallId: tu.id,
           result: `Tool '${tool.name}': approval check failed — ${err instanceof Error ? err.message : String(err)}`,
           isError: true,
         };
         continue;
       }
       if (decision !== 'allow') {
         yield {
           type: "tool_result",
           toolName: tool.name,
           toolCallId: tu.id,
           result: `Tool '${tool.name}': call denied by approvalHandler`,
           isError: true,
         };
         continue;
       }
     }
     ```
   - The `ApprovalDecision` import in `runTools.ts` must come from `types/tool.ts`, NOT from `agent.ts` (circular import risk — `agent.ts` imports `loop/loop.ts` which imports `loop/runTools.ts`).

3. **Edit `packages/core/src/loop/loop.ts`** — add `approvalHandler?` to `LoopParams`:
   ```ts
   export type LoopParams = {
     provider: Provider;
     registry: ToolRegistry;
     platform: Platform;
     messages: Message[];
     systemPrompt: string;
     maxTurns: number;
     signal: AbortSignal;
     approvalHandler?: ApprovalHandler;  // NEW
   };
   ```
   Add `import type { ApprovalHandler } from "../types/tool.js";` to the imports in `loop.ts`.

   Do NOT yet pass `approvalHandler` into `runTools` here — that wiring happens in task-05. The field exists on `LoopParams` but `agentLoop` does not yet use it. The existing `runTools` call in `loop.ts` remains: `runTools(pendingToolUses, registry, platform, context)` — unchanged at this step.

4. **Edit `packages/core/src/agent.ts`** — add `approvalHandler?` to `AgentOptions` and store on the `Agent` instance:
   ```ts
   import type { ApprovalHandler } from "./types/tool.js";  // add this import

   export type AgentOptions = {
     provider: Provider;
     tools: Tool[];
     platform: Platform;
     systemPrompt?: string;
     maxTurns?: number;
     approvalHandler?: ApprovalHandler;  // NEW
   };
   ```
   In the `Agent` class, add:
   ```ts
   private readonly approvalHandler: ApprovalHandler | undefined;
   ```
   In the constructor: `this.approvalHandler = options.approvalHandler;`

   Do NOT yet pass `approvalHandler` into `agentLoop` in `run()` — that is task-05. The field is stored but not yet threaded.

5. **Extend `packages/core/src/__tests__/runTools.test.ts`** — add a new `describe("approvalHandler gate")` block. The existing tests must continue to pass exactly as-is (they pass `ctx` as the fourth arg and no fifth arg — they will pass `undefined` for the handler, which is the blanket-allow default).

   Required new test cases (per spec §12):
   - **No handler (blanket allow)**: pass `undefined` as `approvalHandler` (or omit) → `tool.call` is invoked, successful result yielded.
   - **Handler returns `'allow'`**: handler resolves `'allow'` → `tool.call` is invoked.
   - **Handler returns `'deny'`**: handler resolves `'deny'` → `tool.call` is NOT invoked, `isError: true` event with `"Tool '<name>': call denied by approvalHandler"`.
   - **Handler throws**: handler rejects → `tool.call` is NOT invoked, `isError: true` event with `"Tool '<name>': approval check failed — <error message>"`.
   - **Handler receives validated input**: the handler is called with `(toolName, validatedInput)` where `validatedInput` is the Zod-parsed result, not the raw input. Use a tool that transforms its input (e.g., `z.object({ n: z.number().default(42) })`) and assert the handler receives the defaulted value.

   Use `vi.fn()` for the handler spy. Import `vi` from `vitest` at the top of the test file.

6. **Run `pnpm test`** from `packages/core`. All prior tests (including existing `runTools.test.ts` tests) must still pass, plus the new gate tests.

7. **Run `pnpm typecheck`** from `packages/core`. Zero errors.

## Acceptance criteria

- [ ] `pnpm test` (in `packages/core`) passes: all existing 140 tests pass, plus new gate tests.
- [ ] `pnpm typecheck` reports zero errors.
- [ ] `ApprovalDecision` and `ApprovalHandler` are exported from `types/tool.ts` (verified by typecheck and by task-05's import).
- [ ] `runTools` accepts a fifth optional `approvalHandler?` parameter without breaking any existing call sites (the four existing call-site arguments remain valid — the fifth is optional).
- [ ] Handler returning `'deny'` for a tool: `tool.call` is not invoked, `isError: true` event with exact string `"Tool '<name>': call denied by approvalHandler"` (asserted in `runTools.test.ts`).
- [ ] Handler throwing: `tool.call` is not invoked, `isError: true` event containing `"approval check failed"` (asserted in `runTools.test.ts`).
- [ ] Handler returning `'allow'`: `tool.call` IS invoked (asserted in `runTools.test.ts`).
- [ ] No `approvalHandler` provided: existing tools run normally, no regression (asserted by existing tests + new blanket-allow test).
- [ ] `AgentOptions` has `approvalHandler?: ApprovalHandler` (verified by typecheck).
- [ ] `LoopParams` has `approvalHandler?: ApprovalHandler` (verified by typecheck).
- [ ] No circular import: `runTools.ts` does NOT import from `agent.ts` (verify: `grep "from.*agent" packages/core/src/loop/runTools.ts` → no matches).

## Output files

- Modified: `packages/core/src/types/tool.ts`
- Modified: `packages/core/src/loop/runTools.ts`
- Modified: `packages/core/src/loop/loop.ts`
- Modified: `packages/core/src/agent.ts`
- Modified: `packages/core/src/__tests__/runTools.test.ts`

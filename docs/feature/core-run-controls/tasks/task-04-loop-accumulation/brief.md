# Task 04 — loop-accumulation

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Wire usage accumulation into `agentLoop` in `packages/core/src/loop/loop.ts`. After this task:

- A function-level `cumulativeUsage: Usage` accumulates the run's total usage across all turns.
- A per-turn `turnUsage: Usage | undefined`, declared as the **first statement inside `while(true)`** (critical placement — see Constraints below), tracks the current turn's usage; reset to `undefined` at the top of each turn.
- When the inner `for await (provider.stream(...))` loop yields a `message_stop` event with `event.usage !== undefined`, `turnUsage` is set to that usage.
- After the inner `for await` completes and `turnUsage !== undefined`, `cumulativeUsage = accumulateUsage(cumulativeUsage, turnUsage)`.
- All three terminal event/return pairs (`agent_done`, `max_turns_exceeded`, `agent_error`) include `usage: cumulativeUsage`.
- Both `turn_complete` yield sites include `usage` conditionally: `...(turnUsage !== undefined ? { usage: turnUsage } : {})`.

The existing `MockProvider` in `loop.test.ts` emits bare `{ type: "message_stop", stopReason: "end_turn" }` (no `usage` field), so all existing tests' terminal events will carry `EMPTY_USAGE` — a correct outcome given zero usage was captured.

## Context files

Read these before starting:

- `packages/core/src/loop/loop.ts` — the full current implementation; this is the only production file modified.
- `packages/core/src/types/events.ts` — the updated types (from task-02); all terminal events require `usage: Usage`.
- `packages/core/src/types/provider.ts` — `message_stop` now optionally carries `usage?: Usage`.
- `packages/core/src/types/usage.ts` — `Usage`, `EMPTY_USAGE`, `accumulateUsage`.
- `packages/core/src/__tests__/loop.test.ts` — existing tests to extend; also note which assertions may become runtime mismatches.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §9 "Module-by-module change list" → `loop/loop.ts` section — the exact change list with code sketch. Read it carefully.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §13 "Test strategy" → `loop.ts — accumulation tests` subsection.
- `docs/feature/core-run-controls/engineering/2026-06-30-spec-review-addendum.md` item 2 — pins the `turnUsage` declaration site.

## Downstream dependencies

- **Task 05** (`anthropic-mapper.ts`) emits `message_stop` with `usage` — this task's loop code reads `event.usage` from that event. Once task-05 is committed, the tests added here will begin to exercise the real usage path.
- **Task 06** (`openai-mapper.ts`) similarly emits `message_stop` with `usage`.
- **Critical invariants that must be preserved:**
  - `let cumulativeUsage: Usage = { ...EMPTY_USAGE }` is at **function scope** inside `agentLoop` (run-level; survives across turns).
  - `let turnUsage: Usage | undefined` is declared as the **first statement inside `while(true)`** (not inside the `for await` or the `message_stop` branch; not at function scope). This is the only correct placement — see Constraints.
  - The conditional spread `...(turnUsage !== undefined ? { usage: turnUsage } : {})` is required for `turn_complete` under `exactOptionalPropertyTypes`. Never assign `usage: undefined`.

## Constraints (critical — do NOT get these wrong)

**`turnUsage` declaration site is PINNED.** The engineering spec (§6, §9) and review addendum (item 2) both require `let turnUsage: Usage | undefined` to be the FIRST statement inside the `while(true)` body. This is the only correct placement for two reasons:

1. **Reset per turn:** it must be `undefined` at the start of every iteration (not stale from the previous turn). A function-level declaration would carry the previous turn's value into the next iteration.
2. **In scope at the turn_complete yields:** the `turn_complete` yields occur at `loop.ts:123` (tool path) and `loop.ts:128` (natural-completion path) — after the inner `for await` loop. A declaration inside the `for await`'s `message_stop` branch would be out of scope at those sites.

Wrong placements that compile but are semantically incorrect:
- `let turnUsage` at function scope alongside `cumulativeUsage` → stale across turns.
- `let turnUsage` inside the `for await` → not in scope at the `turn_complete` yields.
- `let turnUsage` inside the `if (event.type === "message_stop")` branch → same scope problem as above.

**`cumulativeUsage` initialization must be a mutable copy of `EMPTY_USAGE`, not `EMPTY_USAGE` itself.** Use `let cumulativeUsage: Usage = { ...EMPTY_USAGE }` (spread) or an explicit `{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }` literal. `EMPTY_USAGE` is frozen (`Object.freeze`); attempting to reassign its fields would throw. However, `accumulateUsage` always returns a new object, so the `cumulativeUsage` variable is reassigned, not mutated — either form works as long as the initial value is the correct shape.

## Steps

1. **Update imports in `packages/core/src/loop/loop.ts`.**

   Add after the existing imports:
   ```typescript
   import { type Usage, EMPTY_USAGE, accumulateUsage } from "../types/usage.js";
   ```

2. **Declare `cumulativeUsage` at function scope inside `agentLoop`.**

   After the existing variable declarations (`const context`, `const toolSchemas`, `let turnIndex`, `let turnsUsed`), add:
   ```typescript
   let cumulativeUsage: Usage = { ...EMPTY_USAGE };
   ```

3. **Declare `turnUsage` as the first statement inside `while(true)`.**

   The current `while(true)` body starts with the maxTurns guard comment. Add `let turnUsage: Usage | undefined;` as the very first statement inside the `while(true)` body, before the `if (turnsUsed >= maxTurns)` guard:

   ```typescript
   while (true) {
     let turnUsage: Usage | undefined;   // ← FIRST statement; reset each turn

     // Guard
     if (turnsUsed >= maxTurns) {
       ...
   ```

4. **Handle `message_stop` in the inner `for await` loop.**

   The existing inner loop comment says "message_stop is consumed but not yielded". Update it to also capture usage. Inside the inner `for await (const event of provider.stream(...)) { ... }` body, add handling for `message_stop`:

   ```typescript
   } else if (event.type === "message_stop") {
     if (event.usage !== undefined) {
       turnUsage = event.usage;
     }
   }
   ```

   This goes alongside the existing `if (event.type === "text_delta")` and `else if (event.type === "tool_use")` branches, inside the `try { ... }` block that wraps the `for await`.

5. **Accumulate `turnUsage` into `cumulativeUsage` after the inner `for await`.**

   After the `try { for await ... } catch (err) { ... }` block — i.e., after the catch block but still inside the `while(true)` body — add:

   ```typescript
   if (turnUsage !== undefined) {
     cumulativeUsage = accumulateUsage(cumulativeUsage, turnUsage);
   }
   ```

   This runs only when the inner `for await` completed without throwing (i.e., the catch block did not return early). The existing code after the try/catch builds the assistant content, increments `turnsUsed`, and handles tools — the accumulation goes before all of that, right after the catch block ends.

   Wait — actually: the catch block does `return { reason: "agent_error", ... }` on error, so execution only continues past the try/catch on the happy path. Place the accumulation update immediately after the closing `}` of the catch block.

6. **Update the three terminal event/return pairs in `agentLoop`.**

   a. **`max_turns_exceeded`** (inside the `if (turnsUsed >= maxTurns)` guard at the top of the while body):
   ```typescript
   const event = { type: "max_turns_exceeded" as const, turnsUsed, messages: workingMessages, usage: cumulativeUsage };
   yield event;
   return { reason: "max_turns_exceeded", turnsUsed, messages: workingMessages, usage: cumulativeUsage };
   ```

   b. **`agent_error`** (inside the `catch (err)` block):
   ```typescript
   const event = { type: "agent_error" as const, error, messages: workingMessages, usage: cumulativeUsage };
   yield event;
   return { reason: "agent_error", error, messages: workingMessages, usage: cumulativeUsage };
   ```

   c. **`agent_done`** (in the natural-completion `else` branch, after the second `yield { type: "turn_complete", ... }`):
   ```typescript
   const event = { type: "agent_done" as const, messages: workingMessages, usage: cumulativeUsage };
   yield event;
   return { reason: "agent_done", messages: workingMessages, usage: cumulativeUsage };
   ```

7. **Update both `turn_complete` yield sites** to include the optional `usage` field.

   There are two `turn_complete` yields:
   - Tool path (after `workingMessages.push({ role: "user", content: toolResultBlocks })`):
     ```typescript
     yield { type: "turn_complete", turnIndex, ...(turnUsage !== undefined ? { usage: turnUsage } : {}) };
     ```
   - Natural-completion path (before the `agent_done` yield):
     ```typescript
     yield { type: "turn_complete", turnIndex, ...(turnUsage !== undefined ? { usage: turnUsage } : {}) };
     ```

   The conditional spread `...(turnUsage !== undefined ? { usage: turnUsage } : {})` is required. Under `exactOptionalPropertyTypes`, `usage: undefined` is a compile error for the `turn_complete` variant (which has `usage?: Usage`). Never write `usage: turnUsage` when `turnUsage` might be `undefined`.

8. **Extend `packages/core/src/__tests__/loop.test.ts`** with a new `describe` block `"agentLoop — usage accumulation"`:

   a. **No usage in provider → terminal carries EMPTY_USAGE:**
   MockProvider emits `{ type: "message_stop", stopReason: "end_turn" }` (no `usage` field). Assert `terminal.reason === "agent_done"` and `terminal.usage` deep-equals `EMPTY_USAGE` (i.e., `{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }` with no `cacheWriteTokens` key).

   b. **Single turn with usage → agent_done carries that usage:**
   MockProvider emits `{ type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } }`. Assert `terminal.usage.inputTokens === 10` and `terminal.usage.outputTokens === 5`.

   c. **Two turns, each with distinct usage → agent_done carries the sum:**
   Turn 1 ends with usage `{ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }` (tool_use response, loop continues).
   Turn 2 ends with usage `{ inputTokens: 3, outputTokens: 2, cacheReadTokens: 0 }` (end_turn, natural completion).
   Assert `terminal.usage.inputTokens === 13` and `terminal.usage.outputTokens === 7`.

   d. **`max_turns_exceeded` carries cumulative usage:**
   Two turns with usage before the cap. Assert `max_turns_exceeded` event and terminal both carry the summed usage.

   e. **`agent_error` carries cumulative usage from turns completed before the error:**
   First turn completes with usage; second turn throws. Assert `agent_error.usage` equals the first turn's usage.

   f. **`turn_complete` carries per-turn usage:**
   Single turn with usage. Assert `turn_complete.usage` equals the turn's usage (not cumulative; for a single turn they are the same).

   g. **`turn_complete` when no usage → `usage` field absent:**
   MockProvider emits bare `message_stop` (no usage). Assert `turn_complete.usage` is `undefined`.

   To emit usage-bearing `message_stop` from `MockProvider`, the test can use the updated `ProviderEvent` type which now allows `message_stop` to carry `usage?: Usage`. Construct:
   ```typescript
   { type: "message_stop", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } }
   ```

9. **Run the full suite:**
   ```
   pnpm -r typecheck
   pnpm -r test
   ```
   Both must exit 0. Expect (196 + new loop tests) total.

   Also scan existing `loop.test.ts` and `agent.test.ts` for `toEqual` / `toStrictEqual` on full terminal objects. The existing tests read `terminal.reason`, `terminal.messages`, `terminal.turnsUsed`, `terminal.error` but do NOT do `.toEqual({ reason: "agent_done", messages: [] })` — they access individual properties. If any such full-object `toEqual` exists, add `usage: EMPTY_USAGE` to the expected object. (Quick audit: `loop.test.ts` line ~103 uses `terminal.reason` not `.toEqual(terminal)`; same for `agent.test.ts`.)

## Acceptance criteria

- [ ] `pnpm -r typecheck` exits 0.
- [ ] `pnpm -r test` exits 0. All pre-existing tests continue to pass.
- [ ] `terminal.usage` on `agent_done` is `EMPTY_USAGE` when MockProvider emits no usage.
- [ ] `terminal.usage` on `agent_done` equals the accumulated sum when MockProvider emits usage-bearing `message_stop` events.
- [ ] `terminal.usage` on `max_turns_exceeded` equals the cumulative usage up to the cap.
- [ ] `terminal.usage` on `agent_error` equals the cumulative usage from turns that completed before the error.
- [ ] `turn_complete` events carry `usage` equal to the turn's own usage (not cumulative) when the provider emitted usage.
- [ ] `turn_complete.usage` is absent (not `undefined`) when the provider emitted no usage for that turn.
- [ ] `let turnUsage` is declared as the first statement inside `while(true)`, not at function scope and not inside the `for await`.
- [ ] No direct mutation of `EMPTY_USAGE`.

## Output files

- Modified: `packages/core/src/loop/loop.ts`
- Modified: `packages/core/src/__tests__/loop.test.ts`

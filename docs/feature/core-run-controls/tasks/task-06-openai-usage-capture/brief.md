# Task 06 — openai-usage-capture

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Add token usage capture to the OpenAI stream mapper in `packages/core/src/providers/openai-mapper.ts`. After this task:

- `OpenAIChatCompletionParams` gains `stream_options: { include_usage: true }` (required, literal type).
- `mapRequest` unconditionally includes `stream_options: { include_usage: true }` in the returned object.
- `ToolCallAccumulator` gains a `setUsage(u: Usage): void` method and a private `chunkUsage?: Usage` field.
- `translateChunk` is restructured to read `chunk.usage` **before** the `choices.length === 0` early-return guard (because the final usage chunk has `choices: []`).
- `ToolCallAccumulator.flush()` emits `message_stop` with `usage` conditionally (only when `chunkUsage` was set).
- `openai-mapper.test.ts` is extended with usage capture tests and the existing deep-equality assertion at L671 is updated to reflect the new conditional `usage` field.

This is the last feature task. After it, both providers deliver usage data to the loop (task-04), which delivers it to terminal events and `turn_complete`.

## Context files

Read these before starting:

- `packages/core/src/providers/openai-mapper.ts` — the full current implementation; the only production file modified.
- `packages/core/src/types/usage.ts` — `Usage`.
- `packages/core/src/types/provider.ts` — the updated `ProviderEvent.message_stop` type (from task-02); `usage?: Usage` is now allowed.
- `packages/core/src/__tests__/openai-mapper.test.ts` — existing tests; L671 is known to need updating; also scan for any `mapRequest` key-set assertions.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §7 — `OpenAIChatCompletionParams` before/after type diff.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §8 "Provider field mapping" → OpenAI section — exact field names and notes.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §9 "Module-by-module change list" → `openai-mapper.ts` section — the code sketch for the restructured `translateChunk`.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §11 "Risks" → `translateChunk` restructuring risk and `mapRequest` risk.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §13 "Test strategy" → `openai-mapper.ts` subsection.
- `docs/feature/core-run-controls/decisions.md` §2026-06-30 "stream_options.include_usage always-on for OpenAI".
- `docs/feature/core-run-controls/decisions.md` §2026-06-30 "message_stop usage attachment is CONDITIONAL on both providers".

## Downstream dependencies

This is the final task — nothing depends on its output. The end state must satisfy:
- `openai-mapper.test.ts:671` passes after the update.
- All 196 pre-existing tests pass.
- `pnpm -r typecheck` exits 0.

## OpenAI usage field mapping

Per spec §8:

| `Usage` field | SDK field | Notes |
|---|---|---|
| `inputTokens` | `chunk.usage.prompt_tokens` | Non-null number on final chunk |
| `outputTokens` | `chunk.usage.completion_tokens` | Non-null number on final chunk |
| `cacheReadTokens` | `chunk.usage.prompt_tokens_details?.cached_tokens` | Optional; `?? 0` |
| `cacheWriteTokens` | (absent) | OpenAI has no cache-write concept; never set |

The final chunk from OpenAI has `choices: []` (empty) and `usage: CompletionUsage | null`. Non-final chunks have `usage: null`. The existing code returned `[]` early when `choices.length === 0`, so the usage data on the final chunk was never read. The fix: check `chunk.usage` before the early return.

`isRecord(chunk.usage)` already excludes `null` (since `isRecord` checks `typeof value === "object" && value !== null`), so no separate `!= null` guard is needed. This is the insight from the spec review addendum (item 4 / verification note 7).

## Steps

1. **Add import to `packages/core/src/providers/openai-mapper.ts`:**
   ```typescript
   import type { Usage } from "../types/usage.js";
   ```
   (Add after the existing imports at the top of the file.)

2. **Update `OpenAIChatCompletionParams` type.**

   Change:
   ```typescript
   export type OpenAIChatCompletionParams = {
     model: string;
     max_completion_tokens: number;
     messages: OpenAIChatMessage[];
     tools?: OpenAIFunctionTool[];
   };
   ```
   To:
   ```typescript
   export type OpenAIChatCompletionParams = {
     model: string;
     max_completion_tokens: number;
     messages: OpenAIChatMessage[];
     tools?: OpenAIFunctionTool[];
     stream_options: { include_usage: true };
   };
   ```

   `stream_options` is required (not optional) with literal type `{ include_usage: true }`.

3. **Update `mapRequest` to unconditionally include `stream_options`.**

   In the `return { ... }` object of `mapRequest`, add:
   ```typescript
   stream_options: { include_usage: true as const },
   ```
   (The `as const` ensures the literal type `true` is preserved, matching the `{ include_usage: true }` literal type. Alternatively, write `stream_options: { include_usage: true }` — TypeScript should infer the literal type from the declared field type.)

4. **Add usage fields to `ToolCallAccumulator`.**

   Inside the class, add the private field (after `finishReason`):
   ```typescript
   private chunkUsage: Usage | undefined;
   ```

   Add the `setUsage` method (after `setFinishReason`):
   ```typescript
   /** Called when the final usage-only chunk is seen (chunk.choices === []). */
   setUsage(u: Usage): void {
     this.chunkUsage = u;
   }
   ```

   Update `flush()` to conditionally include `usage` in the emitted `message_stop`:
   ```typescript
   events.push({
     type: "message_stop",
     stopReason: mapFinishReason(this.finishReason),
     ...(this.chunkUsage !== undefined ? { usage: this.chunkUsage } : {}),
   });
   ```

   The conditional spread is required (`exactOptionalPropertyTypes` compliance).

5. **Restructure `translateChunk` to capture usage before the early return.**

   The current `translateChunk`:
   ```typescript
   export function translateChunk(chunk: unknown, accumulator: ToolCallAccumulator): ProviderEvent[] {
     if (!isRecord(chunk)) return [];
     const choices = chunk.choices;
     if (!Array.isArray(choices) || choices.length === 0) return []; // include_usage chunk, etc.
     // ...
   }
   ```

   Change to:
   ```typescript
   export function translateChunk(chunk: unknown, accumulator: ToolCallAccumulator): ProviderEvent[] {
     if (!isRecord(chunk)) return [];

     // Capture usage from the final usage-only chunk (choices: [], usage: {...}).
     // Must happen BEFORE the choices.length === 0 early-return.
     // isRecord already excludes null (honors verification note 7 — no separate != null guard needed).
     if (isRecord(chunk.usage)) {
       const u = chunk.usage;
       const ptDetails = isRecord(u.prompt_tokens_details) ? u.prompt_tokens_details : undefined;
       accumulator.setUsage({
         inputTokens: asNumber(u.prompt_tokens),
         outputTokens: asNumber(u.completion_tokens),
         cacheReadTokens: ptDetails !== undefined ? asNumber(ptDetails.cached_tokens) : 0,
       });
     }

     const choices = chunk.choices;
     if (!Array.isArray(choices) || choices.length === 0) return [];

     const choice = choices[0];
     if (!isRecord(choice)) return [];

     if (typeof choice.finish_reason === "string") {
       accumulator.setFinishReason(choice.finish_reason);
     }

     return accumulator.applyDelta(choice.delta);
   }
   ```

   Note: `cacheWriteTokens` is intentionally not set — OpenAI has no cache-write concept.

6. **Scan and update `packages/core/src/__tests__/openai-mapper.test.ts`.**

   Known required update:

   - **L671 (approximately)** — the test in the `"translateChunk — exactly one message_stop across a long mixed stream"` describe block. The final assertion:
     ```typescript
     expect(out[out.length - 1]).toEqual({ type: "message_stop", stopReason: "tool_use" });
     ```
     This test's `chunks` array includes the `usageChunk`:
     ```typescript
     const usageChunk = { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
     ```
     After the restructuring, `translateChunk(usageChunk, accumulator)` will call `accumulator.setUsage(...)`. When `flush()` runs, it emits `message_stop` WITH `usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }`.
     
     Update the assertion to:
     ```typescript
     expect(out[out.length - 1]).toEqual({
       type: "message_stop",
       stopReason: "tool_use",
       usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
     });
     ```

   Also check: the isolated `translateChunk(usageChunk, new ToolCallAccumulator())` test earlier in that block:
   ```typescript
   const usageChunk = { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
   expect(translateChunk(usageChunk, new ToolCallAccumulator())).toEqual([]);
   ```
   This test asserts the **return value** of `translateChunk` is `[]` — still correct after the restructuring (the usage chunk returns `[]`). However, it uses a fresh `new ToolCallAccumulator()` that is not flushed, so the accumulator state is not verified here. This test does NOT need updating.

   Also check any `mapRequest` tests that assert on the keys of the returned object. Look for:
   - Any test that uses `Object.keys(params)` or checks the exact key set.
   - Any test that currently asserts `"stream_options" in params` === false.
   Spec §8 notes that the existing `"stream" in params === false` test (L94) should not be affected. But add a NEW assertion to an existing `mapRequest` test:
   ```typescript
   expect(params.stream_options).toEqual({ include_usage: true });
   ```

7. **Add new tests to `openai-mapper.test.ts`** for the new usage capture functionality (new `describe` block: `"translateChunk — usage capture"`):

   a. **Usage chunk captures usage in accumulator; return value is `[]`:**
   ```
   const acc = new ToolCallAccumulator();
   const result = translateChunk({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } }, acc);
   expect(result).toEqual([]);
   // Flush to verify accumulator state
   const flushed = acc.flush();
   const stop = flushed.find(e => e.type === "message_stop");
   expect(stop?.usage).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 0 });
   ```

   b. **`usage: null` on non-final chunk → accumulator not updated:**
   ```
   const acc = new ToolCallAccumulator();
   translateChunk({ choices: [{ delta: {}, finish_reason: null }], usage: null }, acc);
   const flushed = acc.flush();
   const stop = flushed.find(e => e.type === "message_stop");
   expect("usage" in stop!).toBe(false);
   ```
   (`isRecord(null)` is `false`, so the usage branch is skipped — correct behavior.)

   c. **`prompt_tokens_details.cached_tokens` → `cacheReadTokens` mapped:**
   ```
   translateChunk({
     choices: [],
     usage: {
       prompt_tokens: 30,
       completion_tokens: 8,
       prompt_tokens_details: { cached_tokens: 15 }
     }
   }, acc);
   // flush → message_stop.usage.cacheReadTokens === 15
   ```

   d. **Absent `prompt_tokens_details` → `cacheReadTokens: 0`:**
   Usage chunk with no `prompt_tokens_details` → `cacheReadTokens: 0`.

   e. **`flush()` when no usage chunk received → `message_stop` has no `usage` field:**
   Fresh `ToolCallAccumulator`, call `flush()` without any `setUsage` — the `message_stop` has no `usage` key.

   f. **`mapRequest` includes `stream_options: { include_usage: true }`:**
   In the existing `mapRequest` describe block, add:
   ```
   const params = mapRequest(request, "gpt-4o", 32000);
   expect(params.stream_options).toEqual({ include_usage: true });
   ```

8. **Run the full suite:**
   ```
   pnpm -r typecheck
   pnpm -r test
   ```
   Both must exit 0. This is the final task — all 196 pre-existing tests plus all new tests from tasks 01–06 must pass.

## Acceptance criteria

- [ ] `pnpm -r typecheck` exits 0.
- [ ] `pnpm -r test` exits 0. All 196 pre-existing tests pass. All new tests from this and prior tasks pass.
- [ ] `OpenAIChatCompletionParams.stream_options` is a required field with type `{ include_usage: true }`.
- [ ] `mapRequest` output always includes `stream_options: { include_usage: true }`.
- [ ] `translateChunk` with `{ choices: [], usage: { prompt_tokens: N, completion_tokens: M } }` returns `[]` and calls `accumulator.setUsage(...)`.
- [ ] `translateChunk` with `usage: null` (non-final chunk) does not call `accumulator.setUsage`.
- [ ] `flush()` emits `message_stop` with `usage` when `setUsage` was called.
- [ ] `flush()` emits `message_stop` without `usage` when `setUsage` was not called (aborted/no-usage path).
- [ ] `cacheWriteTokens` is never set on OpenAI-sourced `Usage` objects.
- [ ] `openai-mapper.test.ts:671` (approximately) deep-equality assertion on `message_stop` is updated to include `usage`.
- [ ] The `Usage` type and `EMPTY_USAGE` are exported from `tiny-agentic` (re-export in `index.ts` from task-01 is still in place).

## Output files

- Modified: `packages/core/src/providers/openai-mapper.ts`
- Modified: `packages/core/src/__tests__/openai-mapper.test.ts`

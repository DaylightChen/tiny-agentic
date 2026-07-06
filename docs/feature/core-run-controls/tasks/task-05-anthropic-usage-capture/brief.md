# Task 05 — anthropic-usage-capture

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Add token usage capture to the Anthropic stream mapper in `packages/core/src/providers/anthropic-mapper.ts`. After this task:

- `InputAccumulator` gains three new methods (`setUsage`, `mergeInUsage`, `takeUsage`) mirroring the existing `setStopReason`/`takeStopReason` pattern.
- `translateStreamEvent` captures usage data from `message_start` (input tokens, cache tokens) and `message_delta` (output tokens, cache-read tokens) using `mergeUsage`.
- `translateStreamEvent` emits `usage` **conditionally** on `message_stop` — only when the accumulator has captured usage during this turn (i.e., `takeUsage()` returns a non-undefined value).
- A new `asNullableNumber` local type guard handles `number | null` SDK fields.
- `anthropic-mapper.test.ts` is extended with usage capture tests and any `message_stop` deep-equality assertions whose streams now carry usage are updated.

The conditional emit on `message_stop` is symmetric with the OpenAI mapper (task-06) and keeps the `ProviderEvent` shape backward-compatible for any mock that emits a bare `{ type: "message_stop", stopReason }`.

## Context files

Read these before starting:

- `packages/core/src/providers/anthropic-mapper.ts` — the full current implementation; the only production file modified.
- `packages/core/src/types/usage.ts` — `Usage`, `mergeUsage`, `EMPTY_USAGE`.
- `packages/core/src/types/provider.ts` — the updated `ProviderEvent.message_stop` type (from task-02); `usage?: Usage` is now allowed.
- `packages/core/src/__tests__/anthropic-mapper.test.ts` — existing tests; scan for `message_stop` deep-equality assertions.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §8 "Provider field mapping" → Anthropic section — exact field names, source events, guards.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §9 "Module-by-module change list" → `anthropic-mapper.ts` section — the code sketches for `InputAccumulator` additions and `translateStreamEvent` changes.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §13 "Test strategy" → `anthropic-mapper.ts` subsection.
- `docs/feature/core-run-controls/decisions.md` §2026-06-30 "Usage threading: extend message_stop ProviderEvent" — why conditional emit.
- `docs/feature/core-run-controls/decisions.md` §2026-06-30 "message_stop usage attachment is CONDITIONAL on both providers" — the symmetric behavior requirement.
- `docs/feature/core-run-controls/engineering/2026-06-30-spec-review-addendum.md` item 3 — motivated the symmetric conditional emit.

## Downstream dependencies

- **Task 06** (`openai-mapper.ts`) follows the same conditional-emit pattern; it is independent of this task.
- **Task 04 loop wiring** is already committed — once this task is committed, a run with `AnthropicProvider` will flow real usage from `message_stop` through the loop to `terminal.usage`.
- **Key invariants:**
  - `InputAccumulator.takeUsage(): Usage | undefined` — returns `undefined` when no usage event was seen this turn (degenerate/interrupted turn); returns the accumulated `Usage` on the happy path.
  - `message_stop` emitted by `translateStreamEvent` carries `usage` only via conditional spread: `...(u !== undefined ? { usage: u } : {})`. Never emit `usage: undefined`.
  - The existing `message_stop` assertions in `anthropic-mapper.test.ts` that use streams WITHOUT `message_start`/`message_delta` events (e.g., the bare `{ type: "message_stop" }` test at the "defaults stopReason to 'end_turn'" case) do NOT gain a `usage` field and do NOT need updating. Only assertions whose streams carry usage-emitting events need the `usage` field added.

## Provider field mapping (Anthropic)

Per spec §8:

| `Usage` field | Source event | SDK field | Notes |
|---|---|---|---|
| `inputTokens` | `message_start` | `message.usage.input_tokens` | Non-null number; use `asNumber(...)` |
| `outputTokens` | `message_delta` | `usage.output_tokens` | Non-null number; use `asNumber(...)` |
| `cacheReadTokens` | `message_delta` | `usage.cache_read_input_tokens` | `number \| null`; use `asNullableNumber(...) ?? 0` |
| `cacheWriteTokens` | `message_start` | `message.usage.cache_creation_input_tokens` | `number \| null`; only set if `> 0` |

Note: do NOT read `input_tokens` from `message_delta` — it is `number | null` there and always zero for our purposes. The `mergeUsage` guard handles this correctly because `b.inputTokens = 0` from the delta will not overwrite the real value from `message_start`.

## Steps

1. **Add import to `packages/core/src/providers/anthropic-mapper.ts`:**
   ```typescript
   import { type Usage, mergeUsage, EMPTY_USAGE } from "../types/usage.js";
   ```
   (Add after the existing type imports at the top of the file.)

2. **Add `asNullableNumber` to the local type-guard utilities** at the bottom of `anthropic-mapper.ts` (alongside the existing `isRecord`, `asString`, `asNumber` functions):
   ```typescript
   function asNullableNumber(value: unknown): number | null {
     return typeof value === "number" ? value : null;
   }
   ```

3. **Add usage fields to `InputAccumulator`.**

   Inside the `InputAccumulator` class, after the existing `private stopReason: string | undefined;` field, add:
   ```typescript
   private turnUsage: Usage | undefined;
   ```

   Add three new methods (after `takeStopReason`):
   ```typescript
   /** Initialize usage from message_start fields. Overwrites any prior usage for this turn. */
   setUsage(u: Usage): void {
     this.turnUsage = u;
   }

   /** Merge delta usage (message_delta fields) into the accumulated turn usage. */
   mergeInUsage(delta: Usage): void {
     this.turnUsage = mergeUsage(this.turnUsage ?? EMPTY_USAGE, delta);
   }

   /**
    * Return the accumulated turn usage and clear it for the next turn.
    * Returns undefined if no usage-bearing event was seen this turn.
    */
   takeUsage(): Usage | undefined {
     return this.turnUsage;
   }
   ```

   Note: `takeUsage()` does NOT need to reset `this.turnUsage` because `InputAccumulator` is one-per-stream-call (instantiated fresh inside each `provider.stream()` call in `anthropic.ts`). Each call gets a new accumulator; "clearing" is not necessary.

4. **Update `translateStreamEvent` case `"message_start"`.**

   The current implementation for `"message_start"` is:
   ```typescript
   default:
     return []; // message_start, ping, etc. — ignored in M1
   ```
   The `message_start` event is currently caught by the `default` case. Change the `switch` to handle it explicitly:

   Add a new case:
   ```typescript
   case "message_start": {
     const msg = event.message;
     if (!isRecord(msg)) return [];
     const usage = msg.usage;
     if (!isRecord(usage)) return [];

     const inputTokens = asNumber(usage.input_tokens);
     const cacheRead = asNullableNumber(usage.cache_read_input_tokens) ?? 0;
     const cacheWrite = asNullableNumber(usage.cache_creation_input_tokens);

     const initialUsage: Usage = {
       inputTokens,
       outputTokens: 0,
       cacheReadTokens: cacheRead,
       ...(cacheWrite != null && cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
     };
     accumulator.setUsage(initialUsage);
     return [];
   }
   ```

5. **Update `translateStreamEvent` case `"message_delta"`.**

   The current case:
   ```typescript
   case "message_delta": {
     const delta = event.delta;
     if (isRecord(delta) && typeof delta.stop_reason === "string") {
       accumulator.setStopReason(delta.stop_reason);
     }
     return [];
   }
   ```

   Add usage capture (in addition to the existing stop_reason capture):
   ```typescript
   case "message_delta": {
     const delta = event.delta;
     if (isRecord(delta) && typeof delta.stop_reason === "string") {
       accumulator.setStopReason(delta.stop_reason);
     }
     // Capture output tokens and cache-read tokens from this event.
     const deltaUsage = event.usage;  // top-level 'usage' on message_delta, not delta.usage
     if (isRecord(deltaUsage)) {
       const outputTokens = asNumber(deltaUsage.output_tokens);
       const cacheRead = asNullableNumber(deltaUsage.cache_read_input_tokens) ?? 0;
       accumulator.mergeInUsage({ inputTokens: 0, outputTokens, cacheReadTokens: cacheRead });
     }
     return [];
   }
   ```

   Note: the Anthropic stream event `message_delta` has the structure:
   ```
   { type: "message_delta", delta: { stop_reason, stop_sequence }, usage: { output_tokens, cache_read_input_tokens } }
   ```
   The `usage` object is at the top level of the event, NOT inside `delta`. Read `event.usage` (not `event.delta.usage`).

6. **Update `translateStreamEvent` case `"message_stop"`.**

   Current:
   ```typescript
   case "message_stop":
     return [{ type: "message_stop", stopReason: accumulator.takeStopReason() }];
   ```

   Change to conditional usage attachment:
   ```typescript
   case "message_stop": {
     const u = accumulator.takeUsage();
     return [{
       type: "message_stop",
       stopReason: accumulator.takeStopReason(),
       ...(u !== undefined ? { usage: u } : {}),
     }];
   }
   ```

   The conditional spread is required. Under `exactOptionalPropertyTypes`, `usage: undefined` is not assignable to `usage?: Usage`.

7. **Scan and update `packages/core/src/__tests__/anthropic-mapper.test.ts`.**

   The existing test suite for `message_stop` uses the `run(events)` helper which drives events through a fresh accumulator. Identify which existing test streams carry `message_start` or `message_delta` events (and thus will now produce a `message_stop` with a `usage` field):

   - The "emits the stop_reason cached from message_delta on the following message_stop" test at approximately L200-L210 — this stream has `{ type: "message_delta", delta: { stop_reason: "tool_use" } }` followed by `{ type: "message_stop" }`. The `message_delta` in this test has no top-level `usage` object, so `accumulator.mergeInUsage` is not called, and `takeUsage()` returns `undefined`. The emitted `message_stop` has NO `usage` field. No update needed.
   - The "defaults stopReason to 'end_turn'" test — stream has only `{ type: "message_stop" }`. No usage. No update needed.
   - Any test that uses `message_start` with a `message.usage` object — check if any such test asserts on the full `message_stop` event with `toEqual`. If any stream includes a `message_start` event with real usage fields AND asserts the final `message_stop` with `toEqual`, it will now need to include `usage` in the expected object.

   Review the test file carefully. If NO existing test uses a full `message_start` event with a `message.usage` object and then asserts on the final `message_stop`, there are no updates needed to existing test assertions.

8. **Add new tests to `anthropic-mapper.test.ts`** for the new usage capture functionality (new `describe` block: `"translateStreamEvent — usage capture"`):

   a. **`message_start` sets inputTokens and cacheWriteTokens:**
   ```
   events = [
     { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 7, cache_read_input_tokens: 0 } } },
     { type: "message_stop" },
   ]
   // The message_stop should carry usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 7 }
   ```

   b. **`message_start` with null `cache_creation_input_tokens` → `cacheWriteTokens` absent:**
   ```
   events = [
     { type: "message_start", message: { usage: { input_tokens: 50, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: 0 } } },
     { type: "message_stop" },
   ]
   // message_stop.usage has no cacheWriteTokens key
   ```

   c. **`message_delta` adds outputTokens:**
   ```
   events = [
     { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: 0 } } },
     { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 25, cache_read_input_tokens: 0 } },
     { type: "message_stop" },
   ]
   // message_stop.usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 0 }
   ```

   d. **Full sequence with cacheRead:**
   Include both `cache_read_input_tokens` from `message_start` (may be 0 or a number) and from `message_delta` (the final/authoritative value). Verify the `mergeUsage` `> 0` guard preserves the `message_start` `inputTokens`.

   e. **Bare `message_stop` without preceding usage events → no `usage` field:**
   ```
   events = [{ type: "message_stop" }]
   out = run(events)
   expect(out[0]).toEqual({ type: "message_stop", stopReason: "end_turn" })  // no usage key
   expect("usage" in out[0]).toBe(false)
   ```

   f. **`InputAccumulator` unit tests** (testing the class directly):
   - `setUsage` then `takeUsage` → returns the set value.
   - `mergeInUsage` with `outputTokens = 25` after `setUsage({ inputTokens: 100, ... })` → `takeUsage().outputTokens === 25` and `inputTokens === 100`.
   - Fresh accumulator (no setUsage/mergeInUsage called) → `takeUsage()` returns `undefined`.

9. **Run the full suite:**
   ```
   pnpm -r typecheck
   pnpm -r test
   ```
   Both must exit 0.

## Acceptance criteria

- [ ] `pnpm -r typecheck` exits 0.
- [ ] `pnpm -r test` exits 0. All pre-existing tests continue to pass.
- [ ] A stream `[message_start(usage), message_delta(usage), message_stop]` produces a `message_stop` event with the correct `usage` field.
- [ ] A stream `[message_stop]` (no usage events) produces a `message_stop` event with no `usage` field (`"usage" in event` is `false`).
- [ ] `message_stop.usage.cacheWriteTokens` is absent when `cache_creation_input_tokens` is `null` or `0`.
- [ ] `message_stop.usage.cacheWriteTokens` is set when `cache_creation_input_tokens > 0`.
- [ ] `mergeUsage`'s `> 0` guard: `inputTokens` from `message_delta: 0` does not overwrite the real value from `message_start`.
- [ ] `InputAccumulator.takeUsage()` returns `undefined` for a fresh accumulator with no usage events.
- [ ] Conditional spread is used at the `message_stop` emit site — never `usage: undefined`.
- [ ] No mutation of `EMPTY_USAGE` or input objects.

## Output files

- Modified: `packages/core/src/providers/anthropic-mapper.ts`
- Modified: `packages/core/src/__tests__/anthropic-mapper.test.ts`

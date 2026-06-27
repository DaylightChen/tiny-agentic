# Task 05 — Anthropic Stream Mapper

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Implement `packages/core/src/providers/anthropic-mapper.ts`: the pure translation layer between `ProviderRequest` and Anthropic API params, and between raw Anthropic SDK streaming events and `ProviderEvent[]`. Write comprehensive unit tests in `anthropic-mapper.test.ts`. At the end of this task:

- `mapRequest(request, model, maxTokens)` converts a `ProviderRequest` to Anthropic `MessageCreateParamsStreaming`.
- `InputAccumulator` tracks per-block-index JSON string accumulation across `content_block_start` / `input_json_delta` / `content_block_stop` events.
- `translateStreamEvent(event, accumulator)` converts one Anthropic streaming event to zero or more `ProviderEvent` values.
- All tests in `anthropic-mapper.test.ts` pass.

This module is the highest-risk piece of the codebase: it depends on the exact streaming event shapes of `@anthropic-ai/sdk` and implements a stateful accumulation state machine. Getting it right in isolation (before it is wired into the live provider) is the risk-mitigation strategy.

## Context files

- `docs/engineering/2026-06-27-engineering-spec.md` — §5.1 (request mapping), §5.2 (stream event translation), §6.1 (malformed JSON sentinel), §10.2 (multi-block accumulation test requirement)
- `docs/engineering/2026-06-27-code-architecture.md` — `providers/anthropic.ts` skeleton (shows how mapRequest and translateStreamEvent are used)
- `packages/core/src/types/provider.ts` — `ProviderRequest`, `ProviderEvent`, `ToolSchema`
- `packages/core/src/types/messages.ts` — `Message` type (what mapMessages must accept)

## Downstream dependencies

- Task 06 (`providers/anthropic.ts`) imports `mapRequest`, `translateStreamEvent`, and `InputAccumulator` from `"./anthropic-mapper.js"`. The exported names and signatures must be stable:
  - `mapRequest(request: ProviderRequest, model: string, maxTokens: number): Anthropic.MessageCreateParamsStreaming`
  - `InputAccumulator` class with a method called by `translateStreamEvent`
  - `translateStreamEvent(event: unknown, accumulator: InputAccumulator): ProviderEvent[]`

## Steps

1. **Understand the Anthropic SDK streaming event shapes.** The `@anthropic-ai/sdk` streaming API emits events of these types (in order for a typical tool-use turn):
   ```
   message_start            { type: "message_start", message: { ... } }
   content_block_start      { type: "content_block_start", index: 0, content_block: { type: "text" } }
   content_block_delta      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "..." } }
   content_block_stop       { type: "content_block_stop", index: 0 }
   content_block_start      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "...", name: "..." } }
   content_block_delta      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"pat' } }
   content_block_delta      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'h":"x"}' } }
   content_block_stop       { type: "content_block_stop", index: 1 }
   message_delta            { type: "message_delta", delta: { stop_reason: "tool_use" } }
   message_stop             { type: "message_stop" }
   ```

   Import SDK types as needed. If you're accessing these as strings use TypeScript type narrowing with type guards.

2. **Create `packages/core/src/providers/anthropic-mapper.ts`.**

   **`mapMessages(messages: Message[])`** — maps each `Message` to `Anthropic.MessageParam`. The `Message` type is structurally compatible with `Anthropic.MessageParam` for `user` and `assistant` roles with content blocks. Cast with `as Anthropic.MessageParam`. Note: `ToolResultBlock.is_error` maps to `is_error` in the Anthropic SDK shape — they match already.

   **`mapTools(schemas: ToolSchema[])`** — maps `ToolSchema[]` to `Anthropic.Tool[]`:
   ```ts
   schemas.map(s => ({
     name: s.name,
     description: s.description,
     input_schema: s.inputSchema as Anthropic.Tool["input_schema"],
   }))
   ```

   **`mapRequest(request, model, maxTokens)`** — assembles `Anthropic.MessageCreateParamsStreaming`:
   ```ts
   {
     model,
     max_tokens: request.maxTokens ?? maxTokens,
     system: request.systemPrompt,
     messages: mapMessages(request.messages),
     tools: mapTools(request.tools),
     stream: true,
   }
   ```

   **`InputAccumulator` class** — holds the per-turn streaming state the stateless `translateStreamEvent` cannot keep on its own: both the per-block tool-input JSON accumulation **and** the `stop_reason` cached from `message_delta` so it can be emitted at `message_stop`. (`translateStreamEvent(event, accumulator)` receives only these two arguments, so the accumulator is the only place cross-event state can live.)
   ```ts
   class InputAccumulator {
     private pending: Map<number, { id: string; name: string; json: string }> = new Map();
     // stop_reason arrives on message_delta but must be emitted on the later
     // message_stop event; cache it here between the two.
     private stopReason: string | undefined;

     startBlock(index: number, id: string, name: string): void {
       this.pending.set(index, { id, name, json: "" });
     }

     appendJson(index: number, partialJson: string): void {
       const entry = this.pending.get(index);
       if (entry) entry.json += partialJson;
     }

     finishBlock(index: number): { id: string; name: string; input: unknown } | null {
       const entry = this.pending.get(index);
       if (!entry) return null;
       this.pending.delete(index);
       try {
         return { id: entry.id, name: entry.name, input: JSON.parse(entry.json) };
       } catch {
         // Malformed JSON — return a sentinel input that Zod will reject (edge case 6.1)
         return { id: entry.id, name: entry.name, input: null };
       }
     }

     setStopReason(reason: string): void {
       this.stopReason = reason;
     }

     /** Returns the cached stop_reason, defaulting to "end_turn" if none was seen. */
     takeStopReason(): string {
       return this.stopReason ?? "end_turn";
     }
   }
   ```

   **`translateStreamEvent(event, accumulator)`** — returns `ProviderEvent[]` (zero or more per raw event):
   - `message_start` → `[]`
   - `content_block_start` where `content_block.type === "tool_use"` → `accumulator.startBlock(index, id, name)`; return `[]`
   - `content_block_start` where `content_block.type === "text"` → `[]`
   - `content_block_delta` where `delta.type === "text_delta"` → `[{ type: "text_delta", text: delta.text }]`
   - `content_block_delta` where `delta.type === "input_json_delta"` → `accumulator.appendJson(index, delta.partial_json)`; return `[]`
   - `content_block_stop` → try `accumulator.finishBlock(index)`; if non-null, `[{ type: "tool_use", id, name, input }]`; else `[]`
   - `message_delta` → if `delta.stop_reason` is present, `accumulator.setStopReason(delta.stop_reason)`; return `[]` (the reason is surfaced on the following `message_stop`, not here)
   - `message_stop` → emit `[{ type: "message_stop", stopReason: accumulator.takeStopReason() }]` (`takeStopReason()` returns the cached reason, defaulting to `"end_turn"`). Verify against the actual SDK types that `stop_reason` arrives on `message_delta.delta.stop_reason`; if the SDK delivers it elsewhere, adapt the source of `setStopReason` and note the deviation in the completion doc.
   - Unknown event types → `[]`

3. **Create `packages/core/src/__tests__/anthropic-mapper.test.ts`** — write Vitest tests covering:
   - `mapRequest` builds correct params (model, max_tokens, system, tools with input_schema).
   - `mapTools` produces `input_schema` (not `inputSchema`) for Anthropic.
   - Text streaming: simulate `content_block_start(text)` → multiple `content_block_delta(text_delta)` → `content_block_stop` → assert `ProviderEvent[]` contains `text_delta` events per delta and no `tool_use`.
   - Single tool use: simulate the full sequence above. Assert `ProviderEvent[]` from `content_block_stop` contains `{ type: "tool_use", id: "...", name: "...", input: { path: "x" } }`.
   - **Multi-block accumulation (engineering spec §10.2):** simulate two concurrent tool-use blocks (indices 1 and 2), interleaved `input_json_delta` events. Assert both `tool_use` events are emitted with correct inputs at their respective `content_block_stop`.
   - **Malformed JSON (edge case 6.1):** simulate `input_json_delta` events that accumulate to `"{bad json"`. Assert the `tool_use` event has `input: null` (the sentinel). (The Zod parse step in runTools will then reject it with an error fed back to the model.)
   - `message_stop` produces `{ type: "message_stop", stopReason: "tool_use" }` after a `message_delta` with `stop_reason: "tool_use"`.

4. **Run `pnpm --filter tiny-agentic test`** — all tests pass including mapper tests.

5. **Run `pnpm --filter tiny-agentic typecheck`** — no type errors.

## Acceptance criteria

- [ ] `pnpm --filter tiny-agentic test` passes with all `anthropic-mapper.test.ts` tests green.
- [ ] `pnpm --filter tiny-agentic typecheck` exits with code 0.
- [ ] `mapRequest` test: given a `ProviderRequest` with one tool schema, the output has `tools[0].input_schema` (not `inputSchema`).
- [ ] Multi-block accumulation test passes: two tool-use blocks with interleaved deltas both produce correct `tool_use` events.
- [ ] Malformed JSON test passes: sentinel `input: null` is emitted (Zod will reject it downstream).
- [ ] `packages/core/src/providers/anthropic-mapper.ts` exports `mapRequest`, `InputAccumulator`, `translateStreamEvent`.
- [ ] No import of `@anthropic-ai/sdk` types inside the function bodies (type imports are fine; runtime imports from the SDK are for the provider, not the mapper — the mapper only accesses typed event objects passed in).

## Output files

- Created: `packages/core/src/providers/anthropic-mapper.ts`
- Created: `packages/core/src/__tests__/anthropic-mapper.test.ts`

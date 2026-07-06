# Task 01 — OpenAI Stream Mapper

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Implement `packages/core/src/providers/openai-mapper.ts`: the pure translation layer between the framework's canonical `ProviderRequest` / `Message` types and OpenAI Chat Completions API params, and between raw OpenAI streaming chunks and the framework's `ProviderEvent[]`. Write comprehensive fixture-based unit tests in `packages/core/src/__tests__/openai-mapper.test.ts`. At the end of this task:

- `mapRequest(request, model, defaultMaxTokens)` converts a `ProviderRequest` to an OpenAI `ChatCompletionCreateParams` body (without the `stream` flag — the provider adds that), applying the **four LOCKED transforms**, tools mapping, and `max_completion_tokens`.
- `ToolCallAccumulator` tracks per-`tool_calls[].index` JSON-argument-string accumulation across streamed deltas, caches `finish_reason`, and **flushes at stream end** (OpenAI has no terminal event) to emit accumulated `tool_use` events plus exactly one synthesized `message_stop`.
- `translateChunk(chunk, accumulator)` converts one raw OpenAI chunk to zero or more **`text_delta`** events (tool_use and message_stop come from `accumulator.flush()`, called by the provider after the stream ends).
- All tests in `openai-mapper.test.ts` pass with **no network and no live SDK** (pure object fixtures).

This module is the load-bearing, highest-risk piece of the feature. It is the **first real translation the framework does** — the Anthropic mapper gets away with a cast (`anthropic-mapper.ts:12-14`); OpenAI's message/role/streaming shape genuinely differs. The two transforms most likely to break (the assistant-turn `tool_calls` split with JSON-stringified `arguments`, and exploding one batched `tool_result` user message into N `role:"tool"` messages) produce an opaque OpenAI 400 at runtime if wrong, not a typed error — so proving them in isolation against fixtures, before any wiring exists, is the risk-mitigation strategy.

## Context files

Read these before starting:

- `docs/feature/openai-provider/engineering/2026-06-29-openai-provider-engineering.md` — your primary input. Specifically:
  - §"Request-side transforms" (the four transforms + tools + `max_completion_tokens`, with the resulting `mapRequest` shape)
  - §"Streaming response mapping" (the three `ProviderEvent`s; the `ToolCallAccumulator` API sketch; why text comes out of `translateChunk` but tool_use/message_stop come out of `flush()`)
  - §"Edge cases" (malformed args, no-arg call, multiple concurrent calls, no `finish_reason`, `n>1`, empty `tools`)
  - §"Risks" (the mitigations that must become test assertions)
  - §"Success criteria" (the mapper-related bullets)
- `docs/feature/openai-provider/decisions.md` — the six LOCKED decisions. Load-bearing here: (a) Chat Completions API; (b) drop `is_error`, no `"Error: "` prefix; (c) `system` role for all models; (d) `maxTokens` default 32000 (the provider passes it in; the mapper receives it as `defaultMaxTokens`).
- `packages/core/src/providers/anthropic-mapper.ts` — the module this mirrors in structure. Reuse its patterns: the `mapTools` shape (`:17-23`), the discriminated finish result and empty-buffer→`{}` / parse-error contract (`:93-104`), the `unknown`-in + local type-guard narrowing for SDK-churn-proofing (`:113-117`, `:167-177`). **The key difference:** Anthropic flushes per `content_block_stop` event; OpenAI has no per-block stop and no terminal event, so flushing happens once at stream end via a separate `flush()` call.
- `packages/core/src/__tests__/anthropic-mapper.test.ts` — the test file this mirrors in depth and style. Match its structure: a `run(events)` helper that feeds object-literal fixtures through the translator against a shared accumulator, plus per-concern `describe` blocks.
- `packages/core/src/types/provider.ts` — `ProviderRequest` (`:20-25`), `ProviderEvent` (`:28-31`, note the `tool_use` variant carries optional `inputParseError?: boolean`, and `message_stop.stopReason` is `"end_turn" | "tool_use" | "max_tokens" | string`), `ToolSchema` (`:8-17`). **Do not modify this file.**
- `packages/core/src/types/messages.ts` — `Message` (`:25-27`), `ContentBlock` / `TextBlock` / `ToolUseBlock` / `ToolResultBlock` (`:4-23`). Note `ToolResultBlock` carries `is_error?: boolean` (`:20`) — Transform 4 drops it. Note `user` content is `string | ContentBlock[]` and the loop only ever emits `ContentBlock[]` user content for the tool-result batch.

## Downstream dependencies

Task 02 (`providers/openai.ts`) imports from `"./openai-mapper.js"` and depends on these **exact exported names and signatures** — keep them stable:

- `export function mapRequest(request: ProviderRequest, model: string, defaultMaxTokens: number): <OpenAI params body type>` — the provider spreads `{ ...params, stream: true }` into `client.chat.completions.create(...)`, so `mapRequest` must **not** set `stream` itself.
- `export class ToolCallAccumulator` with:
  - `applyDelta(delta): { type: "text_delta"; text: string }[]` — applies one chunk's `choices[0].delta`: captures `id`/`name` on first sight of each `tool_calls[].index`, appends `function.arguments` fragments, and returns any text deltas.
  - `setFinishReason(reason: string): void` — caches the `choices[0].finish_reason`.
  - `flush(): ProviderEvent[]` — returns the accumulated `tool_use` events (ascending `index` order) followed by **exactly one** `message_stop`.
- `export function translateChunk(chunk: unknown, accumulator: ToolCallAccumulator): ProviderEvent[]` — reads `chunk.choices[0]` only, forwards `delta` to `applyDelta` (returning text deltas), forwards `finish_reason` to `setFinishReason`, and returns **zero or more `text_delta` events only**. The provider calls `accumulator.flush()` after the `for await` loop ends.

The provider's loop will be exactly (mirror `anthropic.ts:55-59`, but with a trailing flush):

```ts
for await (const chunk of rawStream) {
  for (const ev of translateChunk(chunk, accumulator)) yield ev;
}
for (const ev of accumulator.flush()) yield ev;
```

Keep `translateChunk` free of "is this the last chunk?" logic — the single robust flush point is iterator-end (spec §"Note on the terminal flush"). Do **not** emit `message_stop` from `translateChunk`.

## Steps

1. **Understand the OpenAI streaming chunk shape.** OpenAI streams a flat sequence of `chat.completion.chunk` objects. Each carries `choices[0].delta` with optional fields, and `choices[0].finish_reason` (null until the last content chunk). A typical tool-call turn looks like (object-literal fixtures — `translateChunk` takes `unknown`, so no real SDK objects are needed):
   ```
   { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }
   { choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] }              // text fragment
   { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function",
                 function: { name: "read", arguments: "" } }] }, finish_reason: null }] }     // first delta for index 0: id+name
   { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }, finish_reason: null }] }  // arg fragment, no id/name
   { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] }, finish_reason: null }] }
   { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }                          // finish_reason arrives, no terminal event
   { choices: [], usage: { ... } }                                                              // OPTIONAL include_usage chunk — IGNORE (empty choices)
   ```
   Notes that drive the design: (a) the **first** delta for a given `tool_calls[].index` carries `id` + `function.name`; **later** deltas for the same index carry only `function.arguments` fragments and omit `id`/`name` — so accumulation must key on `index`, not on `id`. (b) There is **no terminal event** — the async iterator simply ends. (c) An `include_usage` final chunk has empty `choices` and must be ignored.

2. **Create `packages/core/src/providers/openai-mapper.ts`.** Import OpenAI **types only** (`import type OpenAI from "openai"`) where useful for the `mapRequest` return type — never a runtime import (the mapper must stay SDK-runtime-free, like `anthropic-mapper.ts:1`). If a precise SDK param type is awkward, a locally-defined structural return type is acceptable; prefer the SDK type if it is stable. Implement:

   **`mapTools(schemas: ToolSchema[])`** — map each `ToolSchema { name, description, inputSchema }` → `{ type: "function", function: { name, description, parameters: inputSchema } }`. Mirror `anthropic-mapper.ts:17-23`. `inputSchema` is the `openApi3` JSON Schema already accepted by both APIs — pass it through as `parameters`.

   **`mapMessages(messages: Message[])`** — the real work (where Anthropic casts). For each `Message`:
   - `role: "user"` with **string** content → `{ role: "user", content: <string> }` directly.
   - `role: "user"` with **`ContentBlock[]`** content → this is **always the batched tool-result message** (the only way the loop produces block-array user content, `loop.ts` pushes `{ role: "user", content: toolResultBlocks }`). **Transform 3:** explode it into **N** separate messages, one per `tool_result` block, in order: `{ role: "tool", tool_call_id: block.tool_use_id, content: block.content }`. **Transform 4:** drop `block.is_error` entirely (OpenAI's `role:"tool"` message has no error field; the error text already rides in `block.content`); do **not** synthesize an `"Error: "` prefix. Preserve order — do not reorder while splitting (the OpenAI pairing invariant is already satisfied by loop ordering; a reorder would cause a 400).
   - `role: "assistant"` with **string** content → `{ role: "assistant", content: <string> }` directly.
   - `role: "assistant"` with **`ContentBlock[]`** content → **Transform 2:** flatten all `text` blocks' `.text` into the assistant message's `content` string (concatenate); if there are no text blocks, set `content: null` (OpenAI permits `content: null` on an assistant message that only makes tool calls). Map each `tool_use` block `{ id, name, input }` → a `tool_calls[]` entry `{ id, type: "function", function: { name, arguments: JSON.stringify(input) } }`. **`arguments` is a JSON-encoded string, not an object** — `input` is the object, `JSON.stringify(input)` is what OpenAI wants. Result: `{ role: "assistant", content: <string|null>, tool_calls: [...] }`.

   The exploding map (Transform 3 produces 1→N) means `mapMessages` cannot be a 1:1 `map`; use a `flatMap` or accumulate into an output array.

   **`mapRequest(request, model, defaultMaxTokens)`** — assemble the body (no `stream` flag; the provider adds it). Mirror `anthropic-mapper.ts:26-42` for the signature/precedence:
   ```ts
   {
     model,
     max_completion_tokens: request.maxTokens ?? defaultMaxTokens, // NOT max_tokens — see below
     messages: [
       { role: "system", content: request.systemPrompt },          // Transform 1 — system role for all models (LOCKED)
       ...mapMessages(request.messages),
     ],
     ...(request.tools.length > 0 ? { tools: mapTools(request.tools) } : {}), // omit tools entirely when empty
   }
   ```
   - **Transform 1:** prepend `{ role: "system", content: request.systemPrompt }` as the first message (OpenAI has no top-level `system` field). Emit `system`, not `developer` (LOCKED).
   - **Max tokens:** emit `max_completion_tokens` (NOT `max_tokens`). The field rename is provider-internal — `ProviderRequest.maxTokens` is still the canonical knob. This is a hard constraint: o-series / GPT-5 reasoning models reject `max_tokens`; classic models accept `max_completion_tokens` as an alias, so one field name is safe for all.
   - **Empty tools:** omit the `tools` field entirely when `request.tools` is empty (some models reject an empty `tools` array). Do not emit `tools: []`.
   - Emit **no** `n` and **no** sampling params (`ProviderRequest` carries none; this conveniently keeps reasoning models safe).

   **`ToolCallAccumulator` class** — holds the per-stream state `translateChunk` cannot keep:
   ```ts
   export class ToolCallAccumulator {
     // keyed by tool_calls[].index
     private readonly calls = new Map<number, { id: string; name: string; args: string }>();
     private finishReason: string | undefined;

     /** Apply one chunk's delta: append any text fragment (returned as text_delta[]),
      *  capture id/name on first sight of each tool_calls[].index, append arg fragments. */
     applyDelta(delta: unknown): { type: "text_delta"; text: string }[] {
       // narrow `delta` with local type guards (unknown-in, SDK-churn-proof)
       // - if delta.content is a non-empty string → push { type: "text_delta", text }
       // - if delta.tool_calls is an array → for each entry keyed by its `index`:
       //     first sight: set { id, name: function.name, args: "" }
       //     append function.arguments (string) onto that index's args
       // return the collected text_delta[] (possibly empty)
     }

     setFinishReason(reason: string): void { this.finishReason = reason; }

     /** Called once at stream end. Returns accumulated tool_use events in ascending
      *  index order, then EXACTLY ONE message_stop. */
     flush(): ProviderEvent[] {
       // for each [index, call] sorted ascending by index:
       //   const raw = call.args.trim();
       //   try { input = raw === "" ? {} : JSON.parse(raw); emit { type:"tool_use", id, name, input } }
       //   catch { emit { type:"tool_use", id, name, input: {}, inputParseError: true } }
       // then push exactly one { type:"message_stop", stopReason: mapFinishReason(this.finishReason) }
     }
   }
   ```
   - Empty-buffer→`{}` and the `inputParseError`/`{}` parse-error contract are carried over **unchanged** from Anthropic (provider-agnostic by construction, `provider.ts:33-42`; `anthropic-mapper.ts:93-104`). On `JSON.parse` failure: emit `{ type: "tool_use", id, name, input: {}, inputParseError: true }` (a serializable `{}` placeholder + the flag — **never** a `null` sentinel).
   - **finish_reason → stopReason map:** `stop → "end_turn"`, `tool_calls → "tool_use"`, `length → "max_tokens"`; any other value (e.g. `content_filter`) passes through as-is (legal via the `| string` member of the union). If no `finish_reason` was ever seen (abort/disconnect), default to `"end_turn"` (mirror `takeStopReason()`, `anthropic-mapper.ts:68`).

   **`translateChunk(chunk, accumulator)`** — `unknown`-in; narrow with local type guards (mirror `anthropic-mapper.ts:113-117, 167-177`):
   - Read `chunk.choices[0]` only. If `choices` is absent/empty (the `include_usage` final chunk) → return `[]` (ignore usage; no tracking this feature).
   - If `choices[0].finish_reason` is a non-null string → `accumulator.setFinishReason(reason)`.
   - Forward `choices[0].delta` to `accumulator.applyDelta(delta)` and return its `text_delta[]` result.
   - Return **only** `text_delta` events. Never emit `tool_use` or `message_stop` from here.
   Add the same `isRecord` / `asString` / `asNumber` helpers as `anthropic-mapper.ts:167-177` (an `asNumber` defaulting to `0` is fine for the `tool_calls[].index`).

3. **Create `packages/core/src/__tests__/openai-mapper.test.ts`.** Mirror `anthropic-mapper.test.ts` in structure (a `run(chunks)` helper feeding fixtures through `translateChunk` against a shared accumulator, then calling `accumulator.flush()` and concatenating). Cover, with these named assertions (each traces to a spec Risk or Success-criterion):

   **`mapRequest` / transform tests (request side):**
   - `max_completion_tokens` is present and equals `request.maxTokens ?? defaultMaxTokens`; **`max_tokens` is absent** (`expect("max_tokens" in params).toBe(false)`). (Risk: `max_tokens` regression.)
   - The first message is exactly `{ role: "system", content: <systemPrompt> }`. (Transform 1; LOCKED `system` role.)
   - **Transform 2:** an assistant message with content `[{type:"text",text:"hi"},{type:"tool_use",id:"call_1",name:"read",input:{path:"x"}}]` maps to `{ role:"assistant", content:"hi", tool_calls:[{ id:"call_1", type:"function", function:{ name:"read", arguments: <string> } }] }`, and `arguments` is a **string** equal to `JSON.stringify({path:"x"})` (`expect(typeof ...).toBe("string")`). An assistant message with only tool_use blocks maps to `content: null`. (Risk: the split is the most error-prone transform.)
   - **Transform 3:** one `user` message whose content is `[{type:"tool_result",tool_use_id:"call_1",content:"A"},{type:"tool_result",tool_use_id:"call_2",content:"B"}]` becomes **two** messages `{role:"tool",tool_call_id:"call_1",content:"A"}` then `{role:"tool",tool_call_id:"call_2",content:"B"}`, in that order, with matching `tool_call_id`s. (Risk: the explode/order bug → 400.)
   - **Transform 4:** a `tool_result` block with `is_error: true` and `content: "boom"` maps to `{role:"tool",tool_call_id:...,content:"boom"}` with **no** `is_error` field and **no** `"Error: "` prefix (`expect(msg.content).toBe("boom")`, `expect("is_error" in msg).toBe(false)`). (LOCKED decision.)
   - A plain-string `user` message and a plain-string `assistant` message map straight through.
   - Tools: `mapTools` produces `{ type:"function", function:{ name, description, parameters: <inputSchema> } }`; `parameters` deep-equals the `ToolSchema.inputSchema`. When `request.tools` is empty, `mapRequest` output has **no** `tools` key (`expect("tools" in params).toBe(false)`).

   **Streaming tests (response side):**
   - **Text streaming:** chunks with `delta.content` fragments → one `text_delta` per non-empty fragment, in order; no `tool_use`. `flush()` then yields exactly one `message_stop`.
   - **Single tool call:** first delta carries `tool_calls:[{index:0,id:"call_1",function:{name:"read",arguments:""}}]`, later deltas carry only `{index:0,function:{arguments:'{"pa'}}` then `{index:0,function:{arguments:'th":"x"}'}}`. `translateChunk` yields no events; `flush()` yields `{type:"tool_use",id:"call_1",name:"read",input:{path:"x"}}` then one `message_stop`.
   - **Multiple concurrent tool calls (index 0 and 1, interleaved deltas):** assert both `tool_use` events flush in **ascending index order** with correct inputs. (Edge case + Risk.)
   - **Large argument JSON across many chunks:** split a long `arguments` string across 5+ deltas for one index; assert the flushed `input` equals the fully-parsed object. (Edge case.)
   - **Malformed JSON arguments:** accumulate `"{bad json"`; assert the flushed `tool_use` has `inputParseError: true` and `input` deep-equals `{}` (and `not.toBeNull()`). (Edge case + contract carry-over.)
   - **No-arg / empty arguments:** `arguments` is `""` (or never sent) → flushed `input` deep-equals `{}` with `inputParseError` undefined. (Edge case.)
   - **finish_reason mapping:** `finish_reason: "tool_calls"` → `message_stop.stopReason === "tool_use"`; `"stop"` → `"end_turn"`; `"length"` → `"max_tokens"`; `"content_filter"` passes through unchanged.
   - **No finish_reason (abort/disconnect):** drive a tool-call stream that ends with no `finish_reason` chunk; `flush()` still emits the accumulated `tool_use` **and** one `message_stop` defaulting to `stopReason: "end_turn"`. (Edge case + Risk: the flush-at-end design.)
   - **Exactly one message_stop regardless of chunk count:** across a long mixed stream (text + multiple tools + a finish_reason chunk + an `include_usage` empty-`choices` chunk), assert the total output contains **exactly one** `message_stop` and that the `include_usage` chunk produced zero events. (Risk: structural one-`message_stop` guarantee.)
   - **Empty turn:** a stream with no content and no tool_calls (just a finish_reason chunk or nothing) → `translateChunk` yields nothing; `flush()` yields exactly one `message_stop` and no `tool_use`. (States matrix: Empty.)
   - **Malformed / non-record chunks** (`null`, `42`, `{}`, `{choices:[]}`) → `translateChunk` returns `[]` without throwing. (Mirror `anthropic-mapper.test.ts:256-262`.)

4. **Run `pnpm --filter tiny-agentic test`** — all `openai-mapper.test.ts` tests green, all prior tests still green.

5. **Run `pnpm --filter tiny-agentic typecheck`** — exits 0 under `exactOptionalPropertyTypes`.

## Acceptance criteria

- [ ] `pnpm --filter tiny-agentic test` passes with all `openai-mapper.test.ts` tests green and no prior-test regression.
- [ ] `pnpm --filter tiny-agentic typecheck` exits with code 0.
- [ ] `packages/core/src/providers/openai-mapper.ts` exports `mapRequest`, `mapTools`, `ToolCallAccumulator`, and `translateChunk` with the signatures in §Downstream dependencies.
- [ ] `mapRequest` output: first message is `{ role: "system", content: <systemPrompt> }`; `max_completion_tokens` present and `max_tokens` absent; assistant `tool_calls[].function.arguments` is a `string` equal to `JSON.stringify(input)`; one batched `tool_result` user message of length N becomes N `role:"tool"` messages with matching `tool_call_id`s in order and no `is_error` field; empty `request.tools` → no `tools` key.
- [ ] Streaming: the accumulator keys on `tool_calls[].index`; `flush()` emits accumulated `tool_use` events in ascending index order followed by **exactly one** `message_stop`; the malformed-JSON case yields `inputParseError: true` with `input` deep-equal `{}` (never `null`); a stream with no `finish_reason` still flushes a `message_stop` defaulting to `"end_turn"`; the `include_usage` empty-`choices` chunk produces zero events.
- [ ] `translateChunk` returns **only** `text_delta` events — `grep -n "message_stop\|tool_use" packages/core/src/providers/openai-mapper.ts` shows those event literals only inside `flush()` / the accumulator, never in `translateChunk`.
- [ ] No runtime import of the `openai` SDK in the mapper — `grep -n "from \"openai\"" packages/core/src/providers/openai-mapper.ts` returns at most an `import type` line (type-only). The mapper accesses only typed/`unknown` objects passed in, plus the canonical framework types.

## Output files

- Created: `packages/core/src/providers/openai-mapper.ts`
- Created: `packages/core/src/__tests__/openai-mapper.test.ts`

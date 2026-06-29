# OpenAI Provider — Research

**Feature scope:** `feature/openai-provider`
**Phase:** research (phase zero)
**Date:** 2026-06-29
**Author:** researcher agent

> Evidence to inform adding an **OpenAI provider** to `tiny-agentic`, behind the existing `Provider` abstraction. This document makes **no engineering decisions** — it surfaces prior art, technical feasibility, integration points in the existing codebase, domain constraints, and open questions, framed as options with trade-offs for the `feature-architect` to consume next.

---

## 1. Research questions

Derived from the brief ("OpenAI provider first" — the M2 validation of the `Provider` seam):

1. **API surface** — OpenAI **Chat Completions** vs the newer **Responses** API: which should the provider target, and what trade-offs? What does the official `openai` Node SDK give us for streaming + tool calls + retries?
2. **Streaming event shape** — how do OpenAI streaming chunks differ from Anthropic's `message_start` / `content_block_delta` / `input_json_delta` / `message_delta` / `message_stop`? Specifically: how is tool-call argument JSON streamed and accumulated, and where does the finish/stop reason arrive?
3. **Message/role mapping** — how do `system` / `user` / `assistant` / `tool` roles and `tool_use` / `tool_result` blocks translate between the framework's Anthropic-shaped `Message` and OpenAI's chat message format? What exact translation points must the mapper own?
4. **`ProviderEvent` coverage** — can every variant the loop consumes (`text_delta`, `tool_use` with optional `inputParseError`, `message_stop` with a `stopReason`) be produced from OpenAI's stream? Any variant with no clean OpenAI source?
5. **Retry / timeouts** — does the OpenAI SDK own retry the same way the Anthropic SDK does, so the "Provider contract owns retry" decision holds unchanged? Any per-request timeout / idle differences.
6. **Reasoning models & gotchas** — o-series / GPT-5 reasoning behavior, `max_tokens` vs `max_completion_tokens`, base URL / Azure OpenAI compatibility, env-var conventions.

---

## 2. Existing-system integration points (the seams OpenAI must fit)

The codebase was built Anthropic-first but the abstraction was designed for a second provider. The relevant contract is small and stable. Each row below is grounded in the actual code, not the spec prose.

| Seam | File | What it fixes for any provider | What OpenAI must do |
|---|---|---|---|
| `Provider` interface | `packages/core/src/types/provider.ts:56-66` | `stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent>`. Retry is the provider's responsibility; surviving errors are thrown and the loop catches them. | Implement the same one-method interface. |
| `ProviderRequest` | `provider.ts:20-25` | Pure data: `{ systemPrompt: string; messages: Message[]; tools: ToolSchema[]; maxTokens?: number }`. **`systemPrompt` is a single string**, not a message. | Map `systemPrompt` into an OpenAI message (role `system` or `developer`); fold `tools` into OpenAI `tools`. |
| `ProviderEvent` union | `provider.ts:28-31` | Exactly three variants: `text_delta`, `tool_use` (`{ id, name, input, inputParseError? }`), `message_stop` (`{ stopReason }`). **This is the entire contract the loop consumes.** | Produce all three from the OpenAI stream (see §5). |
| `Message` shape | `packages/core/src/types/messages.ts:1-28` | Anthropic-isomorphic: `user` / `assistant` roles only; content is `string \| ContentBlock[]`; blocks are `text` / `tool_use` (`{id,name,input}`) / `tool_result` (`{tool_use_id,content,is_error?}`). | **The mapper owns the full translation to OpenAI's role/shape model** (see §4) — this is the single biggest piece of new work. |
| `ToolSchema` | `provider.ts:8-17` | `{ name, description, inputSchema }` where `inputSchema` is JSON Schema produced via `zodToJsonSchema(..., { target: "openApi3", $refStrategy: "none" })`. | Wrap each into OpenAI's `{ type: "function", function: { name, description, parameters } }`. Decisions log (`openApi3 via zod-to-json-schema`, 2026-06-27) explicitly states this output is accepted by **both** Anthropic and OpenAI tool definitions. |
| Retry contract | `docs/project/decisions.md` "Provider contract owns retry" + spec §5.3 | Every provider exposes `maxRetries` and delegates to its SDK; the spec **already names** `new OpenAI({ maxRetries })` as the OpenAI fulfillment (spec §5.3, line 826). | Pass `maxRetries` to `new OpenAI(...)`; do **not** wrap in `withRetry`. |
| AbortSignal | `docs/project/decisions.md` "AbortSignal threading", `anthropic.ts:41-53` | Signal is the second arg to `stream()`, threaded into the SDK call (`client.messages.stream(params, { signal })`). | Thread `signal` into the OpenAI SDK call the same way (see §6). |
| Logger hook | `provider.ts:48-53`, `anthropic.ts:46` | Optional `logger?: Logger`; emits `request_sent` before the call. `retry_attempt` is best-effort/unused while retry is SDK-delegated. | Mirror: emit `request_sent`; no per-retry hook available from the OpenAI SDK either (same limitation as Anthropic — see §6). |
| Loop consumption | `packages/core/src/loop/loop.ts:41-58` | The loop only reads `text_delta` (accumulates text), `tool_use` (pushes a pending tool-use, carrying `inputParseError` → `parseError`), and **silently consumes** `message_stop`. | Nothing extra required of OpenAI as long as the three events are produced. Note: **the loop ignores `stopReason`'s value** — it decides "done vs. more turns" purely from *whether any `tool_use` events arrived* (`loop.ts:88,125`), not from the stop reason. This loosens the fidelity bar on §5's stop-reason mapping. |
| Tool-result threading | `loop.ts:88-120`, `runTools.ts` | After tools run, results are pushed as **a single `user` message with `tool_result` content blocks** (Anthropic shape). | The mapper must **split** that one Anthropic `user`/`tool_result` message into N OpenAI `role:"tool"` messages (see §4.3) — the trickiest translation. |
| Packaging | `packages/core/package.json:37-45`, exports `:10-27` | `@anthropic-ai/sdk` is an **optional peer dependency** + a new export sub-path `./providers/anthropic`. | Add `openai` as a second optional peer dependency and a `./providers/openai` export sub-path, mirroring the Anthropic setup exactly. |

**Headline:** the only genuinely new and load-bearing module is **`openai-mapper.ts`** — request mapping, message-shape translation, and a streaming-chunk accumulator. Everything else (provider class, retry delegation, signal threading, packaging, exports) is a near-mechanical mirror of the Anthropic implementation. The decisions log (`Anthropic mapper is its own task`, 2026-06-27) already established the mapper as the highest-risk module and gave it its own task with isolated fixture tests; the same reasoning applies with **more** force to OpenAI, because OpenAI's shape genuinely differs (Anthropic's mapper is mostly a cast; OpenAI's is a real transform).

---

## 3. API surface: Chat Completions vs Responses API

### Findings
- **OpenAI now recommends the Responses API for all new projects.** It was built around reasoning models, tool use, and structured outputs; OpenAI is designing new models/features around it; internal evals claim a ~3% SWE-bench gain and 40–80% better cache utilization (lower cost) versus Chat Completions for reasoning models. ([OpenAI migration guide], [DEV comparison], [BSWEN])
- **Chat Completions remains fully supported** and is the long-standing, stable, widely-documented surface. Conversation state is managed manually (you pass the full message array each turn) — which is **exactly how `tiny-agentic`'s loop already works**: it threads `workingMessages` itself and is a stateless core by decision (`docs/project/decisions.md`, "Milestone-1 open questions resolved", Q1/A′). ([Simon Willison], [Portkey])
- The Responses API adds server-side conversation state (`previous_response_id`, Conversations API) and built-in server tools (web search, file search, code interpreter, MCP). **None of those map onto the framework's model** — the framework owns the loop, owns tool execution via its own `Tool`/`Platform` seam, and is deliberately stateless. The Responses API's headline benefits are largely features the framework intentionally implements itself.

### Options for the architect (NOT a decision)

**Option A — target Chat Completions.**
- *For:* its request/response shape is the closest structural match to the existing `ProviderRequest` (flat `messages` array, manual state — mirrors the loop) and to the Anthropic Messages mental model; the streaming chunk format and tool-call deltas are heavily documented and stable; the framework needs none of the Responses-API server-side features. Lowest translation distance from the existing Anthropic mapper.
- *Against:* it is the API OpenAI is steering new work away from; reasoning-model ergonomics are slightly more awkward here (`max_completion_tokens`, dropped sampling params — see §7); per the docs, *new* models get their best behavior on Responses.

**Option B — target the Responses API.**
- *For:* future-aligned; better reasoning-model behavior/caching; one fewer migration later.
- *Against:* its event/stream shape and request shape diverge **more** from the current `ProviderRequest` and from the Anthropic mapper, so it is a larger, less-paralleled build; several of its differentiating features (server-side state, built-in tools) are inert or actively conflict with the framework's own loop/tool/stateless design; the canonical streaming example in the SDK README is `responses.create({ stream: true })` yielding semantic events rather than `chat.completions` chunks, so the accumulator logic in §5 would be different again.

**Trade-off summary:** Chat Completions minimizes new surface and maximizes parallelism with the proven Anthropic path (the stated point of M2 is to *validate the abstraction*, not to chase the newest API); Responses is more future-proof but a bigger, less-mirrored build whose marquee features the framework doesn't use. The architect decides; this researcher notes only that the **stated M2 goal (validate the `Provider` seam with a second backend) is satisfied more cheaply by the closer-shaped API**, and that adding a *second* OpenAI variant later (Responses) behind the same seam would itself be further validation.

---

## 4. Message / role mapping (the mapper's core job)

This is where OpenAI genuinely differs from Anthropic and where the Anthropic mapper's "just cast it" approach (`anthropic-mapper.ts:12-14`, `mapMessages` is `return messages as Anthropic.MessageParam[]`) **cannot** be reused. Concrete translation points the OpenAI mapper must own:

### 4.1 System prompt
- Anthropic: `system` is a **top-level string field** on the request (`anthropic-mapper.ts:37`). The framework's `ProviderRequest.systemPrompt` matches this 1:1.
- OpenAI Chat Completions: the system prompt is a **message** at the head of the `messages` array, role `"system"` (or `"developer"` for newer/reasoning models — see §7). The mapper must prepend `{ role: "system", content: request.systemPrompt }`.

### 4.2 user / assistant text
- Shared role names (`user`, `assistant`). A `Message` whose `content` is a plain `string` maps to `{ role, content: string }` directly. A `Message` whose content is `ContentBlock[]` containing only `text` blocks must be **flattened** — OpenAI's `content` is a string (or a content-part array), not Anthropic's block array. ([CallSphere roles guide])

### 4.3 Assistant `tool_use` → OpenAI `tool_calls`  (and the result split)
This is the load-bearing translation:

- **Framework / Anthropic assistant turn:** one `assistant` message whose `content` array contains `tool_use` blocks `{ type:"tool_use", id, name, input }` (an *object* `input`), possibly alongside a `text` block.
- **OpenAI assistant turn:** one `assistant` message with a `tool_calls` array, each `{ id, type:"function", function: { name, arguments } }` where **`arguments` is a JSON-encoded *string*, not an object** (`"arguments": "{\"location\":\"Paris\"}"`). The mapper must `JSON.stringify(block.input)`. ([OpenAI function-calling guide], [create-chat-completion reference])
- **Framework / Anthropic tool results:** the loop emits **one `user` message** whose content array holds N `tool_result` blocks `{ type:"tool_result", tool_use_id, content, is_error? }` (`loop.ts:111-120`).
- **OpenAI tool results:** there is **no `tool_result` block and no batched-results message**. Each result is its **own message**: `{ role: "tool", tool_call_id, content }`. So the mapper must **explode** the framework's single `user`/`tool_result[]` message into **N separate `role:"tool"` messages**, mapping `tool_use_id → tool_call_id` and `content → content`. ([create-chat-completion reference], [OpenAI community thread on tool message validation])

**Two concrete gotchas the architect should flag for the mapper task:**
1. **`is_error` has no OpenAI field.** Anthropic's `tool_result.is_error` boolean does not exist on an OpenAI `role:"tool"` message — there is no error flag. The error must be conveyed *in the `content` string itself* (the framework already serializes a human-readable error string into `content` at `loop.ts:104-110`, so this is likely benign, but the mapper drops `is_error` and the architect should confirm that's acceptable — it means the model distinguishes success from error only by reading the content text, which is how OpenAI tool calling works in general).
2. **Ordering / pairing invariant.** OpenAI requires that every `role:"tool"` message's `tool_call_id` correspond to a `tool_calls[].id` on an immediately-preceding `assistant` message, and (in practice) that the assistant `tool_calls` message comes before its tool replies. The framework's loop already preserves this order (assistant turn pushed at `loop.ts:82`, then tool-results user message at `loop.ts:120`), so the *sequence* is correct; the mapper just has to preserve it while splitting. A mismatch produces an OpenAI 400, the same failure class the Anthropic-side §6.1 history-corruption note warns about.

### 4.4 Translation-point summary (what `mapMessages` must do, vs Anthropic's no-op)
| Framework message | Anthropic mapper | OpenAI mapper |
|---|---|---|
| `systemPrompt` string | top-level `system` field | prepend a `system`/`developer` message |
| `user`/`assistant` string content | cast | pass through (string content) |
| `assistant` with `text` blocks | cast | flatten blocks → string (or content-parts) |
| `assistant` with `tool_use` blocks | cast | → `tool_calls[]`, `input` object → `arguments` **string** |
| `user` with N `tool_result` blocks | cast | **explode into N `role:"tool"` messages**, drop `is_error` (encode in content) |

---

## 5. Streaming event shape & accumulation

### How OpenAI Chat Completions streams (vs Anthropic)
OpenAI streams a flat sequence of `chat.completion.chunk` objects. Each chunk carries `choices[0].delta` with optional fields. There is **no per-block start/stop event** like Anthropic's `content_block_start`/`content_block_stop` — accumulation is keyed off the `tool_calls[].index` integer inside the deltas. ([streaming-events reference], [create-chat-completion reference])

| Concern | Anthropic (current mapper) | OpenAI Chat Completions |
|---|---|---|
| Text | `content_block_delta` → `delta.text` | `choices[0].delta.content` (string fragment) |
| Tool-call identity | `content_block_start` → `content_block.{id,name}` | First tool-call delta carries `tool_calls[i].id` + `tool_calls[i].function.name`; later deltas for the same `index` carry only `function.arguments` fragments and **omit `id`/`name`** |
| Tool-call args | `input_json_delta.partial_json`, accumulated per **block index**, parsed at `content_block_stop` | `tool_calls[i].function.arguments` string fragments, accumulated per **`tool_calls[].index`**, parsed when the stream ends / `finish_reason` arrives |
| Stop reason | on `message_delta.delta.stop_reason`, emitted later at `message_stop` | `choices[0].finish_reason` — `null` on intermediate chunks, set on (typically) the final content chunk: `stop` / `tool_calls` / `length` / `content_filter` |
| End of stream | explicit `message_stop` event | the async iterator simply **ends** (no terminal event object); `finish_reason` is the only "why it stopped" signal. With `stream_options:{include_usage:true}`, a final chunk with empty `choices` + a `usage` object is appended |
| Usage | on `message_start` / `message_delta` (ignored in M1) | only if `stream_options.include_usage` requested; final chunk |

### Mapping to the framework's `ProviderEvent` union — coverage check
The loop consumes exactly `text_delta`, `tool_use`, `message_stop` (§2). All three are producible from the OpenAI stream:

- **`text_delta`** — direct: each `delta.content` fragment → `{ type:"text_delta", text }`. Clean.
- **`tool_use`** — requires an **`InputAccumulator` analogue keyed by `tool_calls[].index`** that captures `id`/`name` from the first delta and concatenates `function.arguments` fragments. There is **no `content_block_stop` to flush on** — the natural flush point is **when the stream ends** (or when `finish_reason` is seen). At flush, `JSON.parse` the accumulated arguments; on success emit `{ type:"tool_use", id, name, input }`; on parse failure emit `{ type:"tool_use", id, name, input:{}, inputParseError:true }` — **the §6.1 parse-error contract carries over unchanged** (the `inputParseError` boolean + `{}` placeholder design is provider-agnostic by construction; see `provider.ts:33-42` and the decisions-log entry "Malformed streamed tool input uses an `inputParseError` boolean flag"). Empty/no-arg calls: arguments may be `""` → treat as `{}`, identical to the Anthropic mapper's `raw === "" ? {}` rule (`anthropic-mapper.ts:99`).
- **`message_stop`** — `finish_reason` maps to `stopReason`. Mapping options: `stop → "end_turn"`, `tool_calls → "tool_use"`, `length → "max_tokens"`. The framework's `stopReason` type is `"end_turn" | "tool_use" | "max_tokens" | string` (`provider.ts:31`) — the open `| string` means even an unmapped value (e.g. `content_filter`) is type-legal. **And the loop never branches on the value** (§2, `loop.ts`), so an imperfect mapping is non-fatal; it only matters for observability/consumers. Still, the mapper must emit **exactly one** `message_stop` at end-of-stream (the iterator's end), since OpenAI has no explicit terminal event.

**Variants with no perfectly clean OpenAI source:**
- **`message_stop` timing.** Anthropic gives an explicit `message_stop`; OpenAI does not — the mapper must synthesize it when the chunk iterator completes. Edge case: a stream that ends *without* any `finish_reason` (rare, e.g. abort/disconnect) — the mapper should default to `"end_turn"`, mirroring `takeStopReason()`'s default (`anthropic-mapper.ts:68`).
- **Usage / cost.** No clean source unless `stream_options.include_usage` is opted in. M1 ignores usage on the Anthropic side too (`spec §5.2`), so this is a non-issue for parity; it is a **forward note** for the M2+ cost-tracking `LogEntry` variant the spec reserves (`provider.ts:46-47`).
- **Multiple `choices`.** OpenAI can return `n>1` choices; the framework's model assumes a single response stream. The mapper should read `choices[0]` only and not request `n>1` (default `n=1` is fine). Worth an explicit note so no one is surprised.

### SDK iteration: raw chunks vs. helper
The `openai` Node SDK offers two streaming entry points (both verified against the SDK README/helpers docs):
- `client.chat.completions.create({ ..., stream: true })` → an **async-iterable of raw `ChatCompletionChunk`** objects. "Returns an async iterable of the chunks in the stream and uses less memory." This is the **direct analogue of the Anthropic provider's `for await (const event of rawStream)`** loop (`anthropic.ts:55`) and keeps the mapper in full control of accumulation — consistent with how the Anthropic mapper is built/tested with fixture event sequences.
- `client.chat.completions.stream({...})` → a `ChatCompletionStreamingRunner` with higher-level events (`content.delta`, `tool_calls.function.arguments.delta`, `finalChatCompletion`, etc.) and built-in accumulation. Lower control; emits semantic events the framework would then have to re-map.
- `client.chat.completions.runTools({...})` → a full auto-loop that **executes tools itself**. This **conflicts with the framework's architecture** (the framework owns the loop and tool execution via `runTools.ts`/`Platform`) and must **not** be used. Worth flagging so an implementer doesn't reach for the convenient helper that would bypass the whole engine.

*Option for the architect:* iterate **raw chunks** (mirrors Anthropic, fixture-testable, full control) vs. consume the **stream-runner events** (less accumulation code, but introduces an OpenAI-specific event vocabulary and less parallelism with the Anthropic path). The raw-chunk path is the closer mirror; the runner trades control for convenience.

---

## 6. Retry, timeouts, AbortSignal

- **Retry is owned by the SDK, exactly like Anthropic.** `new OpenAI({ maxRetries })` — default **2** (note: Anthropic SDK default and the framework's `AnthropicProvider` default are **3**, `anthropic.ts:26`). The OpenAI SDK auto-retries on 429 and 5xx with exponential backoff. This **confirms the "Provider contract owns retry" decision holds unchanged**: `OpenAIProvider` passes `maxRetries` to the constructor and does **not** use `withRetry`. The spec already names this (spec §5.3, line 826). ([openai-node README])
  - *Minor architect note:* whether `OpenAIProvider`'s default `maxRetries` should be 3 (to match the framework's existing Anthropic default) or the SDK's native 2 is a small consistency call — surfaced, not decided.
- **Per-retry hook.** Like the Anthropic SDK, the OpenAI SDK exposes **no public per-retry callback**, so the `retry_attempt` `LogEntry` variant stays best-effort/unemitted in the SDK-delegated path — identical limitation to M1 Anthropic (spec §5.4, decisions-log "provider_retry not feasible while SDK-delegated"). No new design needed.
- **Timeouts.** The OpenAI SDK supports a global `timeout` (default **10 minutes**) and a per-request `timeout`, configurable on the client or per call. This is comparable to the Anthropic SDK. No idle-stream watchdog is needed in M1 (spec §10.1 defers the watchdog to M2 for both providers). ([openai-node README])
- **AbortSignal.** The OpenAI SDK accepts a `signal` in per-request options (same `fetch`-style convention the framework already uses). The provider threads the engine's `signal` into the create/stream call, mirroring `anthropic.ts:53`'s `client.messages.stream(params, { signal })`. The "AbortSignal threading: second argument to `Provider.stream()`" decision carries over with no change.

---

## 7. Reasoning models & other gotchas (constraints on the design)

- **`max_tokens` is deprecated for newer models; reasoning models require `max_completion_tokens`.** On Chat Completions, o-series (o1/o3/o4-mini) and GPT-5 models **only** honor `max_completion_tokens`; `max_tokens` is rejected/ignored for them. The framework currently models a single `maxTokens` knob and the Anthropic mapper emits `max_tokens` (`anthropic-mapper.ts:36`). The OpenAI mapper must emit **`max_completion_tokens`**, not `max_tokens`, to be safe across both classic and reasoning models (classic models accept `max_completion_tokens` as an alias). This is a **provider-internal field rename inside the mapper** — `ProviderRequest.maxTokens` stays the canonical knob; no public-surface change. ([OpenAI help: response length], [Azure reasoning docs], [community thread]) — **Hard constraint** for reasoning-model support.
- **Reasoning models drop sampling params.** `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `logprobs`, `logit_bias` are **unsupported** on reasoning models. The framework's `ProviderRequest` carries **none** of these today (`provider.ts:20-25`), so there is **nothing to strip** — the minimal request shape is conveniently safe. Worth recording so a future param addition knows the constraint. ([Azure reasoning docs])
- **`system` vs `developer` role.** Newer/reasoning models prefer the `developer` role over `system` for instructions (the API treats them compatibly in most cases). The mapper could emit `system` for parity/simplicity; whether to switch to `developer` for reasoning models is a small mapper decision the architect can defer. Not load-bearing for a first cut.
- **Env var.** `OPENAI_API_KEY` is the SDK's default; the SDK reads it automatically if `apiKey` is not passed. The `AnthropicProvider` requires `apiKey` explicitly and throws if missing (`anthropic.ts:23-24`); `OpenAIProvider` should mirror that explicit-required pattern for consistency rather than relying on implicit env reading — a small parity choice.
- **Base URL / Azure / OpenAI-compatible backends.** The SDK supports `baseURL` (and `OPENAI_BASE_URL`), making the *same* `OpenAIProvider` usable against **OpenAI-compatible** endpoints (many local/proxy servers, and some third-party gateways speak the Chat Completions wire format). Azure specifically uses a **separate `AzureOpenAI` client class** with `endpoint` + `apiVersion` + `deployment` (the Azure API shape "slightly differs"). **Decision-relevant:** the brief and `docs/project/decisions.md` say "Bedrock/Vertex/Foundry are explicitly out of scope" — so **Azure OpenAI is out of scope for this feature**; exposing a plain `baseURL` option (cheap, mirrors `AnthropicProviderOptions.baseURL`) covers generic OpenAI-compatible endpoints without taking on the `AzureOpenAI` class. Flag, don't decide. ([openai-node README], [Azure v1 API], [openai-node issue #53])
- **Packaging mirror.** `openai` becomes a **second optional peer dependency** (`peerDependenciesMeta.optional: true`) plus a `./providers/openai` export sub-path — an exact mirror of the `@anthropic-ai/sdk` setup (`package.json:37-45`). The decisions-log rationale (OpenAI-only consumers shouldn't be forced to install Anthropic, and vice-versa) is already established for this; this just adds the symmetric entry.

---

## 8. Prior art

- **The framework's own Anthropic provider** (`anthropic.ts`, `anthropic-mapper.ts`) is the **primary prior art and the template to mirror** — provider class shape, mapper-as-separate-tested-module, retry delegation, signal threading, the `InputAccumulator` pattern. The single divergence is that OpenAI's mapper does *real* translation where Anthropic's casts. (Primary source: the project's own code.)
- **OpenAI Node SDK helpers** (`chat.completions.stream`, `runTools`, `zodFunction()`) — useful reference for how OpenAI itself models streaming/tool accumulation, but `runTools` is an anti-pattern *here* (it owns the loop the framework owns). The `zodFunction()` helper is irrelevant — the framework already does Zod→JSON-Schema via `zod-to-json-schema`. (Secondary/official.)
- **Vercel AI SDK, LangChain, LiteLLM, Portkey** all implement multi-provider abstractions over Anthropic + OpenAI and confirm the canonical-shape-plus-per-provider-adapter approach the framework already chose. They are heavier and not worth importing, but they validate the design: every credible multi-provider layer translates the system-prompt placement, the tool-call args object-vs-string, and the batched-tool-result-vs-`role:tool` differences identified in §4. (Secondary; corroborating, not load-bearing.)

---

## 9. Domain & landscape constraints

- **OpenAI Chat Completions wire format is a de-facto standard.** Targeting it (with a configurable `baseURL`) means the provider also works against the many OpenAI-compatible endpoints, which is a free breadth win. (Soft constraint / opportunity.)
- **Reasoning-model parameter rules are a hard API constraint** (`max_completion_tokens`, dropped sampling params) — see §7. Any provider that wants to support GPT-5/o-series on Chat Completions **must** rename the tokens field in the mapper. **Hard constraint.**
- **Tool message pairing is a hard API invariant** — every `role:"tool"` message must reference a preceding assistant `tool_calls[].id`; violating it is a 400. The loop's ordering already satisfies this, but the mapper must not reorder. **Hard constraint (already satisfied by loop ordering; the mapper must preserve it).**
- **`max_tokens` is required by Anthropic but optional/defaulted by OpenAI.** The framework already always sends a concrete value (default 32000, decisions-log); harmless for OpenAI but the architect may reconsider whether 32000 is a sensible OpenAI default given different model output ceilings (minor).

---

## 10. Key findings & implications

1. **The abstraction holds; the work is one real mapper.** Every seam (`Provider`, `ProviderRequest`, `ProviderEvent`, retry, signal, logger, packaging) accommodates OpenAI with a mechanical mirror of the Anthropic implementation. The **only** load-bearing new module is `openai-mapper.ts`. *Implication for the architect:* isolate the mapper as its own task with fixture-based streaming tests, exactly as the decisions log did for Anthropic — but expect it to be **substantially more code** than the Anthropic mapper, because OpenAI requires genuine translation, not a cast.
2. **Message translation is the risk center, and it is concrete (§4).** Four specific transforms: system-prompt-string → leading message; `tool_use` block → `tool_calls` with **stringified** `arguments`; the **single batched `tool_result` user message → N `role:"tool"` messages**; and **dropping `is_error`** (error encoded in content). *Implication:* these are the assertions the mapper's tests must pin; the result-explosion and arguments-stringify are the two most likely to break.
3. **Streaming accumulation re-keys from block-index to `tool_calls[].index` and has no flush event (§5).** The `inputParseError`/`{}` parse-error contract carries over **unchanged and provider-agnostically** — good evidence the §6.1 design was the right call. *Implication:* build an OpenAI `InputAccumulator` analogue that flushes at stream end (not on a per-block stop event) and synthesizes the single `message_stop`. The loop ignores `stopReason`'s value, so finish-reason mapping fidelity is low-stakes.
4. **Retry/timeout/signal all carry over with zero design change** (§6) — `new OpenAI({ maxRetries })`, per-request `timeout`, `signal` in request options. The "Provider contract owns retry" decision is **confirmed, not just assumed**. Minor open call: default `maxRetries` 2 (SDK) vs 3 (framework's Anthropic default).
5. **`max_completion_tokens` rename is a hard constraint for reasoning models (§7).** *Implication:* the mapper must emit `max_completion_tokens`, not `max_tokens`; `ProviderRequest.maxTokens` stays the public knob. Classic models accept the alias, so one field name is safe for all.
6. **API-surface fork: Chat Completions vs Responses (§3).** *Implication:* this is the **one fork worth the architect's (and possibly the user's) explicit attention** — Chat Completions is the closer mirror and cheaper validation of the seam; Responses is future-aligned but a larger, less-paralleled build whose marquee features the framework doesn't use. Both are feasible. **Not a hard constraint** — both work — but the choice shapes the whole feature's size.
7. **Azure OpenAI is out of scope (§7, §9), but generic `baseURL` is a cheap win.** *Implication:* expose `baseURL` (mirrors Anthropic) to cover OpenAI-compatible endpoints; do **not** pull in the `AzureOpenAI` class — that's the explicitly-deferred Foundry territory.

---

## 11. Sources

**Primary (official docs / the project's own code):**
- `packages/core/src/types/provider.ts`, `types/messages.ts`, `providers/anthropic.ts`, `providers/anthropic-mapper.ts`, `providers/retry.ts`, `loop/loop.ts`, `loop/runTools.ts`, `package.json`, `src/index.ts` — the existing contract OpenAI must fit. **Highest trust** (ground truth).
- `docs/project/decisions.md`, `docs/project/engineering/2026-06-27-engineering-spec.md` (§5.1–5.4, §10.1, lines 267, 826) — the spec **already reserves the OpenAI seams**; states `new OpenAI({ maxRetries })` and that the mapper owns role translation. **Highest trust** (project intent).
- [openai-node README](https://github.com/openai/openai-node/blob/master/README.md) — `maxRetries` default 2, per-request/global `timeout` (default 10 min), Azure via `AzureOpenAI` class, raw-chunk streaming. **High trust** (official SDK).
- [Chat Completions streaming events reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events) — chunk/`delta`/`tool_calls` index shape, `finish_reason` values, `usage` via `include_usage`. **High trust** (official API reference).
- [Create chat completion reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) — assistant `tool_calls` (`arguments` is a string) and `role:"tool"` message shape (`tool_call_id`, `content`). **High trust.**
- [OpenAI function-calling guide](https://platform.openai.com/docs/guides/function-calling) — tool-call request/result message format. **High trust.**
- [openai-node helpers.md](https://github.com/openai/openai-node/blob/master/helpers.md) — `chat.completions.stream` events, `create({stream:true})` raw iterator, `runTools` auto-loop. **High trust** (official).
- [OpenAI migrate-to-Responses guide](https://developers.openai.com/api/docs/guides/migrate-to-responses) — Responses recommended for new projects; Chat Completions still supported. **High trust.**
- [Azure reasoning models (Microsoft Learn)](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning) — `max_completion_tokens` requirement, dropped sampling params for o-series/GPT-5. **High trust** (Microsoft official; mirrors OpenAI behavior).
- [OpenAI Help: controlling response length](https://help.openai.com/en/articles/5072518-controlling-the-length-of-openai-model-responses) — `max_tokens` deprecated in favor of `max_completion_tokens`. **High trust.**
- [Azure OpenAI v1 API / API-version lifecycle](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle) and [openai-node issue #53](https://github.com/openai/openai-node/issues/53) — Azure uses a distinct client/endpoint shape. **High trust.**

**Secondary (corroborating, lower trust):**
- [Simon Willison: Responses vs Chat Completions](https://simonwillison.net/2025/Mar/11/responses-vs-chat-completions/), [DEV: what actually changed](https://dev.to/dev-in-progress/chat-completions-vs-openai-responses-api-what-actually-changed-4bco), [BSWEN comparison](https://docs.bswen.com/blog/2026-04-16-responses-api-vs-chat-completions/), [Portkey comparison](https://portkey.ai/blog/open-ai-responses-api-vs-chat-completions-vs-anthropic-anthropic-messages-api/) — API-surface trade-offs. **Medium trust** (analysis posts; directionally consistent with official guidance).
- [CallSphere: roles & parameters](https://callsphere.ai/blog/openai-chat-completions-api-messages-roles-parameters), [OpenAI community: tool message validation](https://community.openai.com/t/a-correct-message-in-response-to-a-tool-call-cannot-validate-as-chatcompletionmessage/725036), [community: why max_completion_tokens](https://community.openai.com/t/why-was-max-tokens-changed-to-max-completion-tokens/938077) — message-shape and param specifics. **Medium trust** (corroborates the primary references).

---

## 12. Open questions for the architect

1. **Chat Completions vs Responses API (the one real fork).** Recommend resolving first — it sizes the whole feature. Chat Completions = closest mirror, cheapest validation of the seam, stateless-loop-aligned; Responses = future-aligned but larger/less-paralleled and its marquee features (server state, built-in tools) are inert here. *May warrant a one-line user check* given it shapes scope, though the stated M2 goal ("validate the seam") points at the cheaper option.
2. **Mapper module shape & task isolation.** Confirm `openai-mapper.ts` is its own task with fixture-based streaming tests (mirroring the Anthropic-mapper decision), and confirm the four §4 transforms (system-prompt prepend, args-stringify, tool-result explosion, `is_error` drop) are the pinned test assertions.
3. **Dropping `is_error` on tool results — acceptable?** OpenAI has no error flag on `role:"tool"` messages; the error rides in the content string (which the loop already serializes). Confirm this is fine, or whether the mapper should prefix error content (e.g. `"Error: ..."`).
4. **Streaming entry point:** raw `chat.completions.create({stream:true})` chunks (mirrors Anthropic, full control, fixture-testable) vs the `chat.completions.stream()` runner events. (Researcher note: raw chunks are the closer mirror; `runTools` is explicitly off-limits.)
5. **`max_completion_tokens` field name** in the mapper (hard constraint for reasoning models) and whether the **32000 default** is the right OpenAI default given different model output ceilings.
6. **Default `maxRetries`:** match the framework's Anthropic default (3) or the OpenAI SDK native default (2)?
7. **`baseURL` exposure** for OpenAI-compatible endpoints (cheap, mirrors Anthropic) — confirm in scope; confirm **Azure `AzureOpenAI` class stays out of scope** (Foundry is explicitly deferred per `docs/project/decisions.md`).
8. **`system` vs `developer` role** for the system prompt on reasoning models — emit `system` for a first cut, or branch to `developer`? (Low stakes; deferrable.)
9. **Decisions log:** the OpenAI-specific calls (API choice, field rename, retry default, baseURL scope) should be recorded in `docs/feature/openai-provider/decisions.md` as the architect makes them.

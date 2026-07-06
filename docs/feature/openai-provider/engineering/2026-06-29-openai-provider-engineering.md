# Feature Engineering Spec — OpenAI Provider

> Standard feature pipeline (combined product + engineering). Drafted by the `feature-architect` agent.
> Feature scope: `feature/openai-provider`. Phase: `engineering`. Date: 2026-06-29.
>
> This feature adds a second `Provider` backend to validate the M2 multi-provider seam. The four research forks
> are **LOCKED** in `docs/feature/openai-provider/decisions.md` and are not re-opened here; this spec designs the
> implementation against them. Where a translation point mirrors existing code, it cites `file:line`.

## Goal

Add an `OpenAIProvider` to `tiny-agentic`'s core package, behind the existing `Provider` interface, so a developer can run the agent loop against OpenAI's Chat Completions API (and any OpenAI-compatible endpoint via `baseURL`) by swapping the provider instance — with no change to the loop, tools, platform, or event stream. The audience is developers building on `tiny-agentic`; the only thing that changes for them is a new import (`tiny-agentic/providers/openai`) and a new constructor (`new OpenAIProvider({...})`) that is shape-for-shape parallel to `AnthropicProvider`. This is the M2 validation that the `Provider` abstraction holds for a genuinely different backend.

## Motivation

The framework was built Anthropic-first but explicitly designed the `Provider` seam for a second backend (project spec §3.2, line 267; `provider.ts:55-66`). The stated M2 goal is to *validate that seam* with a real second provider, not just assert it works. OpenAI is the highest-value second backend (largest non-Anthropic user base, and its Chat Completions wire format is a de-facto standard that many compatible endpoints speak). Until this lands, the abstraction is unproven: `anthropic-mapper.ts:12-14` gets away with `return messages as Anthropic.MessageParam[]` — a cast, not a translation — so the seam has never been exercised by a provider whose message/role/streaming shape genuinely differs. The OpenAI mapper is the first real test of whether the canonical `Message`/`ProviderEvent` types are truly provider-agnostic.

## User-visible behavior

> The "user" here is a **developer** consuming the `tiny-agentic` core package. The framework is UI-free and headless (CLAUDE.md hard boundary), so "user-visible behavior" means the developer-facing API surface and runtime behavior, not a graphical UI. Visual/interaction subsections below are `N/A` with reasons.

### Primary flow

1. Developer installs the optional peer dependency: `pnpm add openai` (alongside `tiny-agentic`). If they only use Anthropic, they never install it and get no warning — mirror of the `@anthropic-ai/sdk` arrangement (project spec §4.3, line 559; `package.json:37-45`).
2. Developer imports from the new sub-path: `import { OpenAIProvider } from "tiny-agentic/providers/openai"`.
3. Developer constructs it with options parallel to `AnthropicProvider`: `new OpenAIProvider({ apiKey, model, baseURL?, maxRetries?, maxTokens?, logger? })`. A missing/empty `apiKey` throws synchronously: `"OpenAIProvider: OPENAI_API_KEY is required"` (mirror of `anthropic.ts:23-24`).
4. Developer passes the instance to `new Agent({ provider, ... })` exactly as today. Nothing else in their code changes — the loop, tools, platform, event stream are identical.
5. At run time the agent streams the same `AgentEvent`s (`text_delta`, `tool_use_start`, `tool_result`, `turn_complete`, `agent_done`/`agent_error`). The developer observes identical behavior to the Anthropic path; only the backend differs.

### States matrix

The only "surface" is the `stream()` generator's behavior. Mapping the canonical `Provider` lifecycle states (the framework has no visual states):

| Surface | Empty (no content) | Loading (streaming) | Error | Partial | Offline |
|---|---|---|---|---|---|
| `OpenAIProvider.stream()` | Assistant turn with no text and no tool calls → loop skips the empty turn (`loop.ts:81`); a lone `message_stop` is still synthesized at stream end. | `text_delta` events flow as `choices[0].delta.content` fragments arrive; `tool_use` events flush at stream end. | Errors surviving the SDK's `maxRetries=3` are **thrown** from the generator; the loop's `try/catch` turns them into an `agent_error` terminal (`loop.ts:59-64`). No special handling in the provider. | Mid-stream abort via `AbortSignal` cancels the in-flight request; the SDK throws an abort error which propagates as `agent_error`. A tool already executing is not cancelled (M1 limitation, project spec §10.1). | No network / connection failure is a retryable error the SDK retries up to `maxRetries`, then throws → `agent_error`. |

### Accessibility

N/A — headless library with no UI; there is no keyboard or visual surface. The "a11y contract" equivalent is API ergonomic parity: the `OpenAIProvider` options type and error messages match `AnthropicProvider` field-for-field so a developer's mental model transfers.

### Edge-case behaviors

- **Large tool-call argument JSON streamed across many chunks** — the accumulator concatenates `function.arguments` string fragments keyed on `tool_calls[].index` and parses once at stream end (see §"Streaming response mapping"). No per-chunk parsing.
- **Multiple concurrent tool calls in one assistant turn** — OpenAI sends interleaved deltas distinguished by `tool_calls[].index`; the accumulator keeps each index separate, exactly as the Anthropic accumulator keys on block index (`anthropic-mapper.ts:59`).
- **Malformed JSON arguments** — flushes to `input: {}` + `inputParseError: true` (the provider-agnostic contract, `provider.ts:33-42`); the loop and `runTools` already handle this flag.
- **Stream ends with no `finish_reason`** (abort/disconnect mid-stream) — synthesize `message_stop` with `stopReason: "end_turn"` (mirrors `takeStopReason()` default, `anthropic-mapper.ts:68`).
- **`n > 1` choices** — the provider never requests `n>1` (default `n=1`) and reads `choices[0]` only; other choices are ignored.

### Microcopy

The only developer-visible strings the provider introduces:

- Constructor guard: `"OpenAIProvider: OPENAI_API_KEY is required"` (parallel to `anthropic.ts:24`).
- No new tool-result error text: the parse-error message (`"Tool '<name>': could not parse tool input as JSON"`) is owned by `runTools`, not the provider, and is reused unchanged.
- No `"Error: "` prefix is synthesized on tool-result mapping (LOCKED decision — `is_error` is dropped, error rides in content as-is).

## Out of scope

- **The OpenAI Responses API** — LOCKED to Chat Completions. A Responses provider, if ever wanted, is a separate provider, not a refactor of this one.
- **Azure `AzureOpenAI` client class** (`endpoint`/`apiVersion`/`deployment`) — LOCKED out of scope. Generic `baseURL` covers OpenAI-compatible endpoints; Azure is deferred Foundry territory.
- **Usage/cost tracking** — `stream_options.include_usage` is not requested; the `LogEntry` union gains no cost variant in this feature (M2+ forward note, `provider.ts:46-47`).
- **The `chat.completions.stream()` runner and `runTools()` helper** — not used. `runTools()` owns the loop the framework owns; the runner introduces an OpenAI-specific event vocabulary. We iterate **raw chunks** (`create({ stream: true })`), the direct mirror of `anthropic.ts:55`.
- **Stream-idle watchdog** — deferred to M2 for both providers (project spec §10.1); the SDK's per-request timeout bounds a hung stream.
- **Per-retry logging hook** — the OpenAI SDK exposes no public per-retry callback (same limitation as Anthropic); the `retry_attempt` `LogEntry` variant stays unemitted on the SDK-delegated path.
- **`developer` vs `system` role switching** for reasoning models — first cut emits `system` for all models (see Open Questions). Not load-bearing; the API treats them compatibly in most cases.
- **Changes to the public `ProviderRequest` / `ProviderEvent` / `Message` types** — none. The whole point is that they already accommodate OpenAI.

## Architectural fit

**Existing modules touched:**

- `packages/core/package.json` — add `openai` as a second optional peer dependency (`peerDependencies` + `peerDependenciesMeta.optional: true`), add it to `devDependencies` for local dev/tests, and add a `./providers/openai` export sub-path. Exact mirror of the `@anthropic-ai/sdk` entries (`package.json:15-18, 37-45`).
- `packages/core/tsup.config.ts` — add a build entry `"providers/openai": "src/providers/openai.ts"`, mirroring the `providers/anthropic` entry.
- `packages/core/src/index.ts` — **no change.** The main entry must NOT import `providers/openai.ts` (it must stay free of the `openai` SDK import so an Anthropic-only consumer is unaffected), exactly as it omits `providers/anthropic` today (`index.ts:7-18`; project spec §4.3, line 559).

**New modules / files introduced:**

- `packages/core/src/providers/openai.ts` — the `OpenAIProvider` class (mirror of `anthropic.ts`). Imports `openai` internally; threads `signal`, `maxRetries`, `logger`; delegates stream translation to the mapper.
- `packages/core/src/providers/openai-mapper.ts` — the load-bearing new module. Request mapping (4 transforms + tools + `max_completion_tokens`) and a streaming `ToolCallAccumulator` + `translateChunk`. This is the only file that does *real* translation (Anthropic's mapper casts).
- `packages/core/src/__tests__/openai-mapper.test.ts` — fixture-based streaming + transform tests (mirror of `anthropic-mapper.test.ts`). Tests live in `src/__tests__/`, not beside sources.
- `packages/core/src/__tests__/openai.test.ts` — provider-class tests with a mocked `openai` SDK (mirror of `anthropic.test.ts`).

**New interfaces / contracts:**

```ts
// packages/core/src/providers/openai.ts
export type OpenAIProviderOptions = {
  apiKey: string;
  model: string;
  maxRetries?: number; // default: 3 (LOCKED — match Anthropic, not the SDK's native 2)
  baseURL?: string;    // LOCKED — exposed; covers OpenAI-compatible endpoints
  maxTokens?: number;  // default: 32000 (mirrors Anthropic; see Open Questions on ceiling)
  logger?: Logger;
};

export class OpenAIProvider implements Provider {
  constructor(options: OpenAIProviderOptions);
  stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent>;
}
```

This adds **no** new public type to `provider.ts` — `OpenAIProviderOptions` lives in the provider module and is exported only from the `./providers/openai` sub-path, parallel to `AnthropicProviderOptions` (`anthropic.ts:6-13`).

**Modified existing interfaces (back-compat plan):**

- None. `Provider`, `ProviderRequest`, `ProviderEvent`, `ToolSchema`, `Logger`, `Message`, `ContentBlock` are unchanged. Back-compat is total: the feature is purely additive (one new module pair, two `package.json`/`tsup` entries).

### `OpenAIProvider` class — wiring detail

Mirror `anthropic.ts:15-61` exactly:

```ts
import OpenAI from "openai";
import type { Provider, ProviderRequest, ProviderEvent, Logger } from "../types/provider.js";
import { mapRequest, translateChunk, ToolCallAccumulator } from "./openai-mapper.js";
// withRetry is NOT imported — the OpenAI SDK retries internally via maxRetries.

export class OpenAIProvider implements Provider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly maxTokens: number;
  private readonly logger?: Logger;

  constructor(options: OpenAIProviderOptions) {
    if (!options.apiKey) throw new Error("OpenAIProvider: OPENAI_API_KEY is required");
    this.maxRetries = options.maxRetries ?? 3;            // LOCKED default 3
    this.maxTokens  = options.maxTokens  ?? 32000;
    if (options.logger) this.logger = options.logger;     // exactOptionalPropertyTypes: assign only when present
    this.model = options.model;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      maxRetries: this.maxRetries,                         // SDK owns retry — backoff+jitter on 429/5xx/connection
      ...(options.baseURL ? { baseURL: options.baseURL } : {}), // spread conditionally (exactOptionalPropertyTypes)
    });
  }

  async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
    const params = mapRequest(request, this.model, this.maxTokens);
    this.logger?.({ level: "info", event: "request_sent", request });
    const accumulator = new ToolCallAccumulator();

    const rawStream = await this.client.chat.completions.create(
      { ...params, stream: true },
      { signal },                                          // AbortSignal threaded as 2nd arg (mirror anthropic.ts:53)
    );

    for await (const chunk of rawStream) {
      for (const ev of translateChunk(chunk, accumulator)) yield ev;
    }
    // OpenAI has no terminal event; flush the synthesized message_stop after the iterator ends.
    for (const ev of accumulator.flush()) yield ev;
  }
}
```

Threading specifics required by the brief:
- **`signal`** — passed as the second argument to `client.chat.completions.create(params, { signal })`, the same `fetch`-style convention used at `anthropic.ts:53`.
- **`maxRetries`** — passed only to `new OpenAI({ maxRetries })`; the SDK owns retry. The provider does **not** wrap in `withRetry` (project spec §5.3, line 826; `retry.ts:13-22` documents that OpenAI follows the SDK-delegated path).
- **`request_sent` logger hook** — emitted once, before the create call, exactly as `anthropic.ts:46`. **No per-retry hook exists** (SDK limitation, same as Anthropic) — `retry_attempt` is not emitted on this path.

> Note on the terminal flush: unlike Anthropic, OpenAI has no `message_stop` chunk. The accumulator must flush at stream end to (a) emit any tool-call(s) whose arguments finished accumulating, and (b) synthesize the single `message_stop`. To keep `translateChunk` pure of "is this the last chunk?" logic, the flush is a separate `accumulator.flush()` call after the `for await` completes. (Alternative considered: detect `finish_reason !== null` inside `translateChunk` and flush there. Rejected — `finish_reason` can arrive on a chunk that is not strictly the last one when `include_usage` is on, and a stream can end with no `finish_reason` at all on abort; flushing on iterator-end is the single robust point.)

## Data model changes

**No persisted data, no schema, no migration.** The canonical `Message` / `ContentBlock` / `ProviderEvent` / `ToolSchema` shapes are unchanged. The only "data" is the in-memory, request-scoped transform inside the mapper. The two `package.json` entries and one `tsup` entry are build-config additions, not data-model changes.

### Request-side transforms (`openai-mapper.ts` — the four LOCKED transforms + tools + tokens)

`mapRequest(request, model, defaultMaxTokens)` produces the OpenAI `ChatCompletionCreateParams` body (the `stream: true` flag is added by the provider). Mirror the signature of `anthropic-mapper.ts:26-42`. The message-array build is the real work where Anthropic casts (`anthropic-mapper.ts:12-14`).

**Transform 1 — system prompt string → leading system message.** Anthropic puts `systemPrompt` in a top-level `system` field (`anthropic-mapper.ts:37`). OpenAI has no such field: prepend `{ role: "system", content: request.systemPrompt }` as the first element of the `messages` array. (Emit `system`, not `developer`, for the first cut — see Open Questions.)

**Transform 2 — framework `tool_use` blocks → OpenAI `tool_calls` with JSON-stringified `arguments`.** For an `assistant` message whose `content` is a `ContentBlock[]`:
- Flatten any `text` blocks into the assistant message's `content` string (concatenate their `text`); if there are no text blocks, `content` is `null` (OpenAI permits `content: null` on an assistant message that only makes tool calls).
- Map each `tool_use` block `{ id, name, input }` → a `tool_calls[]` entry `{ id, type: "function", function: { name, arguments: JSON.stringify(input) } }`. **`arguments` is a JSON-encoded string, not an object** — this is the most error-prone transform; `input` is the object, `JSON.stringify(input)` is what OpenAI wants.
- An `assistant` message whose `content` is a plain string maps to `{ role: "assistant", content: string }` directly.

**Transform 3 — the single batched `tool_result` user message → N separate `role:"tool"` messages.** The loop pushes **one** `user` message whose `content` is `ContentBlock[]` of `tool_result` blocks (`loop.ts:111-120`). OpenAI has no `tool_result` block and no batched-results message. **Explode** that one message into N messages, one per `tool_result` block: `{ role: "tool", tool_call_id: block.tool_use_id, content: block.content }`. Preserve order — the OpenAI pairing invariant (every `tool` message's `tool_call_id` must reference a `tool_calls[].id` on a preceding `assistant` message) is already satisfied by the loop's ordering (`loop.ts:82` assistant turn, then `loop.ts:120` results); the mapper must **not** reorder while splitting. A `user` message whose content is a plain string (a genuine user turn) maps to `{ role: "user", content: string }` directly. (Disambiguation rule: a `user` message with `ContentBlock[]` content is treated as the tool-result batch — that is the only way the loop ever produces block-array `user` content, `loop.ts:120`.)

**Transform 4 — drop `is_error`.** The `tool_result` block may carry `is_error?: boolean` (`messages.ts:20`). OpenAI's `role:"tool"` message has no error field. **Drop it**; the error text already lives in `block.content` (the loop serializes it there, `loop.ts:104-110`). Do **not** synthesize an `"Error: "` prefix (LOCKED).

**Tools — `ToolSchema` → OpenAI function tool.** Map each `ToolSchema` `{ name, description, inputSchema }` → `{ type: "function", function: { name, description, parameters: inputSchema } }`. `inputSchema` is the `openApi3` JSON Schema already accepted by both APIs (project spec §3.5, line 378; decisions log 2026-06-27). Mirror `anthropic-mapper.ts:17-23` (`mapTools`).

**Max tokens — `max_completion_tokens`, not `max_tokens`.** Emit `max_completion_tokens: request.maxTokens ?? defaultMaxTokens` (precedence identical to `anthropic-mapper.ts:36`). The field rename is provider-internal — `ProviderRequest.maxTokens` stays the canonical knob — and is a **hard constraint** for o-series/GPT-5 reasoning models (which reject `max_tokens`); classic models accept `max_completion_tokens` as an alias, so one field name is safe for all (LOCKED decision consequence).

Resulting `mapRequest` shape (no `n`, no sampling params — `ProviderRequest` carries none, so reasoning models are conveniently safe):

```ts
{
  model,
  max_completion_tokens: request.maxTokens ?? defaultMaxTokens,
  messages: [ { role: "system", content: request.systemPrompt }, ...mapMessages(request.messages) ],
  tools: mapTools(request.tools),   // omit the field entirely if tools is empty (OpenAI rejects an empty tools array on some models)
}
```

## Streaming response mapping (`openai-mapper.ts`)

OpenAI streams a flat sequence of `chat.completion.chunk` objects; each carries `choices[0].delta` with optional fields. There is **no per-block start/stop event** — accumulation keys on the `tool_calls[].index` integer inside the deltas, and there is **no terminal event** (the async iterator simply ends). Produce the three `ProviderEvent`s as follows:

- **`text_delta`** — `choices[0].delta.content` string fragment → `{ type: "text_delta", text }`. Direct; emit one per non-empty fragment. (Mirror of `anthropic-mapper.ts:134-135`.)

- **`tool_use`** — requires a `ToolCallAccumulator` keyed by `tool_calls[].index` (analogue of `InputAccumulator`, `anthropic-mapper.ts:58`):
  - The **first** delta for a given `index` carries `tool_calls[i].id` + `tool_calls[i].function.name`; capture them. Later deltas for the same `index` carry only `function.arguments` fragments and **omit `id`/`name`** — concatenate the fragments onto that index's buffer.
  - There is **no `content_block_stop` to flush on.** The natural flush point is **stream end** (the iterator completing). At flush, for each accumulated tool call: `raw = buffer.trim(); input = raw === "" ? {} : JSON.parse(raw)`. On success emit `{ type: "tool_use", id, name, input }`; on `JSON.parse` failure emit `{ type: "tool_use", id, name, input: {}, inputParseError: true }`. The empty-buffer → `{}` rule and the `inputParseError`/`{}` parse-error contract are **carried over unchanged** from Anthropic (provider-agnostic by construction, `provider.ts:33-42`; `anthropic-mapper.ts:93-104`).
  - Emit accumulated tool calls in ascending `index` order at flush.

- **`message_stop`** — synthesized **exactly once** at flush (stream end), since OpenAI has no terminal event. Map `choices[0].finish_reason` (cached as it arrives on a chunk) to `stopReason`: `stop → "end_turn"`, `tool_calls → "tool_use"`, `length → "max_tokens"`; any other value (e.g. `content_filter`) passes through as-is (the `| string` member of the union, `provider.ts:31`, makes it type-legal). If no `finish_reason` was ever seen (abort/disconnect), default to `"end_turn"` (mirror `takeStopReason()`, `anthropic-mapper.ts:68`). **The loop never branches on `stopReason`'s value** (`loop.ts:41-58`; it decides done-vs-more-turns purely from whether any `tool_use` arrived), so finish-reason fidelity is low-stakes — but map it sensibly for observability.

**Accumulator API (mirrors `InputAccumulator` but flushes at stream end):**

```ts
export class ToolCallAccumulator {
  // keyed by tool_calls[].index
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();
  private finishReason: string | undefined;

  /** Apply one chunk's delta: capture id/name on first sight of an index, append arg fragments,
   *  cache finish_reason if present. */
  applyDelta(delta: { content?: string | null; tool_calls?: ...; }): { type: "text_delta"; text: string }[];

  setFinishReason(reason: string): void;

  /** Called once at stream end: returns the accumulated tool_use events (ascending index)
   *  followed by exactly one message_stop. */
  flush(): ProviderEvent[];
}
```

`translateChunk(chunk, accumulator)` reads `chunk.choices[0]` only, narrows it with type guards (live SDK objects passed as `unknown`, mirroring `anthropic-mapper.ts:113-117`'s churn-proofing), forwards `delta` to `applyDelta` (returning any `text_delta`s), and forwards `finish_reason` to `setFinishReason`. It returns **zero or more `text_delta`** events; tool_use and message_stop come from `accumulator.flush()` in the provider after the loop. The `include_usage` final chunk (empty `choices`, `usage` set) is ignored (no usage tracking this feature).

> Why text comes out of `translateChunk` but tool_use/message_stop come out of `flush()`: text must stream as it arrives (latency); tool-call arguments are only valid once fully accumulated, and `message_stop` is by definition the end. Keeping the two flush-only events out of the per-chunk path also makes the "emit exactly one `message_stop`" guarantee structural rather than a guard.

## Edge cases

- **Malformed streamed tool arguments** — `JSON.parse` fails at flush → `input: {}` + `inputParseError: true`; `runTools` emits `"Tool '<name>': could not parse tool input as JSON"` before Zod (project spec §6.1, line 818). No provider-side change to the contract.
- **No-arg / empty-arguments tool call** — `arguments` is `""` → treated as `{}`, no parse error (identical to `anthropic-mapper.ts:99`).
- **Multiple concurrent tool calls** — distinct `tool_calls[].index` values keep buffers separate even under interleaved deltas; flush emits them in index order.
- **Stream ends with no `finish_reason`** (abort/disconnect) — `message_stop` defaults to `"end_turn"`; any accumulated complete tool calls still flush.
- **Assistant turn with text only / tool calls only / both** — text flattens into `content` (or `content: null` if only tool calls); tool calls go to `tool_calls[]`.
- **Tool-result pairing 400** — prevented by preserving loop order during the explode (Transform 3); a reorder bug would produce an OpenAI 400, surfaced as `agent_error`.
- **`n > 1`** — never requested; only `choices[0]` is read.
- **Empty `tools`** — omit the `tools` field entirely (some models reject an empty array).
- **AbortSignal mid-stream** — SDK throws an abort error; it propagates out of the generator to the loop's `try/catch` (`loop.ts:59-64`). A tool already mid-`call()` is not cancelled (M1 limitation, project spec §10.1) — unchanged by this feature.

## Risks

- **Risk: the assistant-turn flatten/`tool_calls` split (Transform 2) and the result explosion (Transform 3) are the two transforms most likely to break, and a mistake produces an opaque OpenAI 400, not a typed error.** — *Mitigation:* pin both as explicit mapper test assertions on object fixtures (no network): assert `arguments` is a *string* equal to `JSON.stringify(input)`; assert one `user`/`tool_result[]` message of length N becomes N `role:"tool"` messages with matching `tool_call_id`s in order. These are fixture-fast and catch the 400 class before runtime.
- **Risk: the no-terminal-event / flush-at-stream-end design diverges from the Anthropic mapper's per-event `message_stop`, so an implementer used to the Anthropic path may try to emit `message_stop` inside `translateChunk`.** — *Mitigation:* the flush-only design is spelled out above and enforced structurally (tool_use + message_stop only come from `flush()`); a test asserts exactly one `message_stop` is produced regardless of chunk count, including a stream with no `finish_reason`.
- **Risk: SDK type churn** — the `openai` SDK's chunk/delta types may shift across versions. — *Mitigation:* mirror the Anthropic mapper's defense — pass chunks as `unknown` into `translateChunk` and narrow with local type guards (`anthropic-mapper.ts:167-177`), so the contract is stable regardless of SDK type changes. Pin a peer-dependency range.
- **Risk: an implementer reaches for the convenient `client.chat.completions.runTools()` or `.stream()` runner.** — *Mitigation:* explicitly out of scope (§Out of scope); the spec mandates raw `create({ stream: true })`. `runTools()` would bypass the framework's own loop/tool engine and violate the architecture.
- **Risk: `max_tokens` vs `max_completion_tokens` regression** — using `max_tokens` would silently break reasoning models. — *Mitigation:* hard-pinned in Transform "Max tokens" and asserted in a mapper test (`max_completion_tokens` present, `max_tokens` absent).
- **Low/none: architectural fit** — no load-bearing architecture is modified; the seam was reserved for exactly this (project spec line 267). The feature is additive. No redesign risk to the loop/types.

## Success criteria

**Functional:**

- [ ] `import { OpenAIProvider } from "tiny-agentic/providers/openai"` resolves after `pnpm add openai`; the package builds with the new `tsup` entry and `./providers/openai` export.
- [ ] `new OpenAIProvider({ apiKey: "", model })` throws `"OpenAIProvider: OPENAI_API_KEY is required"`.
- [ ] An end-to-end run against a mocked `openai` SDK yields the same `AgentEvent` sequence as the Anthropic path for an equivalent scenario (text turn; single tool call; multi tool call; parse error).
- [ ] `mapRequest` emits: leading `system` message, `tool_calls` with **string** `arguments`, N `role:"tool"` messages from one batched result, no `is_error` field, `max_completion_tokens` (not `max_tokens`), and `function`-typed tools.
- [ ] The streaming accumulator keys on `tool_calls[].index`, flushes tool calls + one `message_stop` at stream end, and honors the `inputParseError`/`{}` contract.
- [ ] `AbortSignal` passed to `stream()` is threaded as the second arg to `chat.completions.create`; aborting cancels the request.
- [ ] `maxRetries` defaults to 3 and is passed to `new OpenAI({ maxRetries })`; the provider does not import or call `withRetry`.
- [ ] `baseURL`, when provided, is threaded to `new OpenAI({ baseURL })`; when absent, the field is omitted (not `undefined`).
- [ ] No console output when no `logger` is configured (mirror of the Anthropic 7.14 test, `anthropic.test.ts:47`).

**Non-functional:**

- [ ] `index.ts` does not import `providers/openai.ts` — an Anthropic-only consumer installs no `openai` package and sees no warning (verify the main entry's import graph).
- [ ] The UI-free boundary holds: neither `openai.ts` nor `openai-mapper.ts` imports any UI/TUI/CLI code; the mapper imports only `openai` *types* (`import type`) where needed and the canonical framework types.
- [ ] Mapper and provider tests run with no network (mocked SDK / object fixtures), mirroring `anthropic-mapper.test.ts` and `anthropic.test.ts`.
- [ ] No regression in the existing Anthropic provider, loop, tools, or types (full `vitest run` green; `tsc --noEmit` clean under `exactOptionalPropertyTypes`).

## Open questions

> All four research forks are LOCKED; these are the residual low-stakes calls the brief asked to flag rather than guess. None block planning — each has a stated first-cut default the planner can proceed on unless the user overrides.

1. **`system` vs `developer` role for the system prompt.** First-cut default: emit `role: "system"` for all models (simplest, parity with the framework's single-knob model; OpenAI treats them compatibly in most cases). Switching to `developer` for reasoning models would require the provider to know the model class — deferrable. **Confirm `system` is acceptable for the first cut**, or specify a switch rule.
2. **`maxTokens` default of 32000 for OpenAI.** Mirrored from Anthropic. Some OpenAI models have lower output ceilings than 32000; an over-ceiling value is generally clamped or rejected depending on model. First-cut default: keep 32000 for parity (overridable per instance/request). **Confirm, or set a different OpenAI default.** (Low stakes — always overridable.)
3. **Peer-dependency version range for `openai`.** First-cut: pin a recent major range (e.g. `^4.x` or the current major at implement time) and mirror it into `devDependencies`. The planner should pin the exact range against the SDK version available at implement time. (Not a design decision — an implement-time version pin.)

---

## Decision-log note

The four feature-level decisions are already recorded (LOCKED) in `docs/feature/openai-provider/decisions.md`. This spec adds no new *cross-feature* decisions, so `docs/project/decisions.md` is untouched. The three residual calls in §Open Questions, once the user confirms, should be recorded as feature-level decisions in `docs/feature/openai-provider/decisions.md` (no feature tag needed — the file is feature-scoped). I am not recording them now because they are flagged-not-decided pending user input.

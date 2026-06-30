# Research: core-run-controls — External AbortSignal + Token Usage

**Date:** 2026-06-30
**Feature scope:** `feature/core-run-controls`
**Phase:** research (phase 0 of 4)
**Researcher:** automated researcher agent

---

## 1. Research Questions

These are the concrete questions this sweep set out to answer:

**External AbortSignal:**

1. Exactly how does `Agent.run()` currently create and use its internal `AbortController`, and how does the signal flow into the provider and tool layers?
2. What is the idiomatic Node/Web platform API for combining an external `AbortSignal` with an internally-created one, and is it available on the Node 22 floor?
3. What are the surface options for exposing the signal to callers (where to add it, interaction with existing cleanup)?
4. What edge cases exist (signal already aborted before `run()` starts, signal aborted during env-context build before the first `provider.stream()` call, interaction with the `finally` cleanup)?

**Token usage:**

5. Exactly where in the Anthropic streaming event sequence does usage data appear, which fields are available, and at which events?
6. Exactly where in the OpenAI Chat Completions streaming surface does usage appear, what opt-in is required, what fields are available, and what caveats exist?
7. What is the shape of a normalized cross-provider usage struct that covers both providers without lying about unavailable fields?
8. Where in the public API (`AgentEvent`, `Terminal`, a new event type, or `ProviderEvent`) should usage surface, and what tension exists with the existing design decisions about event-union leanness?
9. Does usage need to thread through the `ProviderEvent` → `agentLoop` boundary, and what is the multi-turn accumulation question (per-turn vs. per-`run()`)?

---

## 2. Prior Art and Existing Solutions

This feature is about wiring well-understood platform primitives (`AbortSignal.any`, provider SDK usage fields) into an existing internal design. There is no "prior art" in the competitive-product sense. The relevant prior art is:

- **The platform specification itself** — the Web/WHATWG `AbortSignal.any()` static method (MDN, Node.js docs), Node 22 native support.
- **The Anthropic SDK v0.52.0 streaming type shapes** — `RawMessageStartEvent` / `RawMessageDeltaEvent` / `MessageDeltaUsage` / `Usage` (direct SDK type inspection, see §3).
- **The OpenAI SDK v6.45.0 streaming type shapes** — `ChatCompletionChunk.usage`, `CompletionUsage`, `ChatCompletionStreamOptions` (direct SDK type inspection, see §3).
- **The existing `agent-tooling` feature** — it wired `ToolCallContext.signal` and `Platform.exec` cancellation. This is the relevant internal "prior art" for cancellation propagation.

---

## 3. Technical Feasibility and Candidate Approaches

### 3a. External AbortSignal — current cancellation topology

Fully traced from source. Citations below use line numbers from the files read.

**`agent.ts` — where the controller is born:**

```
// agent.ts:41-66
async *run(prompt: string, options: RunOptions = {}): AsyncGenerator<AgentEvent, Terminal> {
  const abortCtrl = new AbortController();   // <— internal, no external linkage
  try {
    ...
    return yield* agentLoop({ ..., signal: abortCtrl.signal, ... });
  } finally {
    abortCtrl.abort();  // fires when consumer breaks or generator exhausts
  }
}
```

The `AbortController` is created fresh every `run()` call. `RunOptions` (agent.ts:19-21) currently has only `messages?: Message[]`. There is no way to inject an external signal.

**`loop.ts` — where the signal is consumed:**

```
// loop.ts:24 — context object passed to all tool calls
const context: ToolCallContext = { signal };

// loop.ts:42-44 — passed to provider.stream()
for await (const event of provider.stream(
  { systemPrompt, messages: workingMessages, tools: toolSchemas },
  signal,
))
```

The `signal` flows to two consumers:
1. `provider.stream(request, signal)` — both `AnthropicProvider` and `OpenAIProvider` pass it to their SDK calls (`anthropic.ts:53`, `openai.ts:57`).
2. `ToolCallContext.signal` — used by tools via `context` (e.g., `Platform.exec` for bash cancellation, added in `agent-tooling`).

**What abort triggers today:** `break` in a `for await` loop invokes the generator's `.return()` method, which runs the `finally` block in `agent.ts:61-65`, which calls `abortCtrl.abort()`. This is the *only* cancellation path today.

**What is missing:** No way for an external caller (a parent agent, a `setTimeout`, a process signal handler) to cancel an in-flight `run()` from outside the `for await` loop.

---

### 3b. Candidate approach: `AbortSignal.any([])`

**API:** `AbortSignal.any(signals: AbortSignal[]): AbortSignal`

**Availability:** Added in Node.js v18.17.0 and v20.3.0. Available on the project's Node 22 floor. Typed in TypeScript's `lib.dom.d.ts` (confirmed in `node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/lib.dom.d.ts`, the `AbortSignal` interface block). The project already uses `lib: ["ES2022"]` in `tsconfig.base.json`, which does not include `lib.dom`; however, `AbortSignal` is already used in the codebase via `@types/node@22` (see decisions log: "`@types/node` contributes the ambient `AbortSignal` type"). Confirming whether `@types/node@22` types `AbortSignal.any` is the only residual question for the architect (see §7).

**How it would work in `run()`:**

Option A — `AbortSignal.any([externalSignal, internalCtrl.signal])`:
```
const abortCtrl = new AbortController();
const signal = options.signal
  ? AbortSignal.any([options.signal, abortCtrl.signal])
  : abortCtrl.signal;
// pass `signal` to agentLoop instead of abortCtrl.signal
```

The combined signal aborts when *either* the external signal fires or the internal controller is aborted (from the `finally` cleanup).

Option B — manual listener wiring:
```
const abortCtrl = new AbortController();
if (options.signal) {
  options.signal.addEventListener("abort", () => abortCtrl.abort(options.signal!.reason), { once: true });
}
// always pass abortCtrl.signal downstream
```

**Trade-offs:**

| | Option A (`AbortSignal.any`) | Option B (listener) |
|---|---|---|
| Code simplicity | Very simple (one expression) | Slightly more code; must remove listener on completion to avoid leaks |
| Leak risk | None — the browser/Node runtime owns the composite signal | Must `removeEventListener` or `{ once: true }` to avoid a dangling listener if `options.signal` outlives the run |
| `abort.reason` propagation | The composite signal's `reason` is automatically set to whichever source triggered first | Must copy `options.signal.reason` explicitly in the listener |
| Node 22 availability | Confirmed available | Always available |
| TypeScript typing | Available in `lib.dom.d.ts`; need to confirm `@types/node@22` exposes it on the global `AbortSignal` | Always typed |

Option A is clearly simpler and safer. The only risk is the TypeScript availability of `AbortSignal.any` as a static method in the `@types/node@22` ambient environment (versus in `lib.dom` which is not included). This is the one open question (§7, Q1).

**Interaction with the existing `finally { abortCtrl.abort() }`:**

With Option A, the `finally` block still calls `abortCtrl.abort()`, which aborts the internal half of the composite signal. That is correct and harmless — it ensures the provider stream is cancelled even when the consumer breaks without an external signal. The composite signal is the one downstream sees; the internal `AbortController` is now just the "engine side" of the pair.

**Edge case: externally-provided signal already aborted:**

If `options.signal.aborted === true` before `run()` begins, `AbortSignal.any([...])` returns a signal that is already aborted. The `for await` over `provider.stream()` then throws at the first `await` (both Anthropic and OpenAI SDK respect signal abort synchronously on iteration). The loop's `catch (err)` block catches it and yields `{ type: "agent_error", error, messages }`, returning normally. This is an option the architect may or may not want — the alternative is an explicit pre-flight check (`if (options.signal?.aborted) throw ...` or early-return a synthetic `agent_error`). Both are feasible; neither is this phase's decision.

**`exactOptionalPropertyTypes` note:**

`RunOptions` would add `signal?: AbortSignal`. With `exactOptionalPropertyTypes: true`, the pattern `...(options.signal ? { signal: options.signal } : {})` is needed in callsites. Inside `run()`, `options.signal` can be accessed via `options.signal` (optional chaining or undefined check) since the option type is `AbortSignal` not `AbortSignal | undefined` — but the conditional spread is needed where forwarding to a callee that expects `signal?: AbortSignal` without `undefined`.

---

### 3c. Token usage — Anthropic streaming surface

**Sources:** Anthropic SDK v0.52.0 type declarations at `node_modules/.pnpm/@anthropic-ai+sdk@0.52.0/node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`. Primary source (official SDK type shapes).

**When usage appears in the stream:**

The Anthropic streaming event sequence for a single turn is:
1. `message_start` — carries `message: Message`, which includes a `usage: Usage` struct with **input tokens known at request time**.
2. `content_block_start` / `content_block_delta` / `content_block_stop` — content events (no usage).
3. `message_delta` — carries `usage: MessageDeltaUsage` with **output tokens and updated cache fields**.
4. `message_stop` — no usage fields.

The two usage structs from the SDK types:

**`Usage` (on `message_start.message.usage`):**
```typescript
interface Usage {
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  input_tokens: number;
  output_tokens: number;               // 0 at message_start; final on message_delta
  server_tool_use: ServerToolUsage | null;
  service_tier: 'standard' | 'priority' | 'batch' | null;
}
```

**`MessageDeltaUsage` (on `message_delta.usage`):**
```typescript
interface MessageDeltaUsage {
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  input_tokens: number | null;         // cumulative; may repeat the message_start value
  output_tokens: number;               // output tokens for this turn
  server_tool_use: ServerToolUsage | null;
}
```

**Key Anthropic findings:**

- `input_tokens` is reliably on `message_start.message.usage` (non-nullable `number`). On `message_delta`, `input_tokens` is `number | null`.
- `cache_creation_input_tokens` and `cache_read_input_tokens` are present on both events but nullable (`number | null`) — they are zero/null when prompt caching is not active.
- The current `anthropic-mapper.ts` ignores `message_start` entirely (line 163: `"message_start, ping, etc. — ignored in M1"`) and only captures `stop_reason` from `message_delta`. Usage data is present in the stream but entirely discarded today.
- `output_tokens` arrives on `message_delta`, not `message_stop`.
- The `accumulator` in `anthropic-mapper.ts` already holds per-stream state (it currently tracks `stopReason` and block JSON). Adding usage capture to the accumulator is the natural extension point.

---

### 3d. Token usage — OpenAI streaming surface

**Sources:** OpenAI SDK v6.45.0 type declarations at `node_modules/.pnpm/openai@6.45.0_zod@3.25.76/node_modules/openai/resources/chat/completions/completions.d.ts` and `.../resources/completions.d.ts`. Primary source.

**How usage appears in OpenAI streaming:**

OpenAI Chat Completions do *not* emit usage in the stream by default. Usage must be opted into via `stream_options: { include_usage: true }` in the request.

When opted in, a final extra chunk is emitted **after** the `[DONE]` terminator with `choices: []` (empty) and:
```typescript
// ChatCompletionChunk
usage?: CompletionUsage | null;
```

The `CompletionUsage` struct:
```typescript
interface CompletionUsage {
  completion_tokens: number;   // output tokens
  prompt_tokens: number;       // input tokens (includes cached)
  total_tokens: number;
  completion_tokens_details?: { ... }  // reasoning_tokens, audio_tokens, etc.
  prompt_tokens_details?: {
    audio_tokens?: number;
    cached_tokens?: number;    // <— this is the "cache read" equivalent
  };
}
```

**Key OpenAI findings:**

- `stream_options: { include_usage: true }` must be added to the request params. Today `openai-mapper.ts`'s `OpenAIChatCompletionParams` type and `mapRequest` do not include `stream_options`. This field must be added.
- The usage chunk has `choices: []` — the existing `translateChunk` guard (`if (!Array.isArray(choices) || choices.length === 0) return []`) already skips it silently (confirmed by the existing test: `"the include_usage chunk produces zero events"` in `openai-mapper.test.ts`, line 629-631 — this test explicitly documents that a `{ choices: [], usage: {...} }` chunk currently produces no events).
- OpenAI has **no** `cache_creation_input_tokens` equivalent (there is no concept of cache creation cost in the Chat Completions API pricing). Only `cached_tokens` (cache read hits) is available via `prompt_tokens_details.cached_tokens`.
- OpenAI usage arrives in a final chunk, not at the start of the stream like Anthropic's `message_start.usage`. So accumulation in `ToolCallAccumulator.flush()` is the natural place.
- The `cached_tokens` field is optional (`?`) — it is absent rather than zero when no caching occurred.
- OpenAI does not have a `cache_creation` concept at all in Chat Completions (it does in Batch API, but not relevant here).

**OpenAI vs. Anthropic field mapping:**

| Normalized field | Anthropic source | OpenAI source |
|---|---|---|
| `inputTokens` | `message_start.message.usage.input_tokens` | `prompt_tokens` |
| `outputTokens` | `message_delta.usage.output_tokens` | `completion_tokens` |
| `cacheReadTokens` | `message_delta.usage.cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` |
| `cacheWriteTokens` | `message_start.message.usage.cache_creation_input_tokens` | *not available* |

The asymmetry: Anthropic distinguishes `cache_creation` (paying to write) from `cache_read` (saving on reads). OpenAI only has `cached_tokens` (reads). `cacheWriteTokens` would need to be `undefined` or `0` on the OpenAI path.

---

### 3e. Where to surface usage in the public API — candidate options

The existing decisions and constraints set the context:
- The decisions log (2026-06-27) explicitly locked out `provider_retry` and `event_received` from the `ProviderEvent`/`AgentEvent` unions with the rationale of "keep the event unions lean."
- The `message_stop` event is currently "consumed but not yielded" (`loop.ts:58` comment). The loop uses `stopReason` internally but does not expose it.
- `AgentEvent` terminal variants (`agent_done`, `max_turns_exceeded`, `agent_error`) already carry `messages: Message[]`.
- `Terminal` mirrors the terminal `AgentEvent` shape.

**Option 1: Add usage to terminal `AgentEvent` variants + `Terminal`**

```typescript
type AgentEvent =
  | ...
  | { type: "agent_done"; messages: Message[]; usage: UsageSummary }
  | { type: "max_turns_exceeded"; turnsUsed: number; messages: Message[]; usage: UsageSummary }
  | { type: "agent_error"; error: Error; messages: Message[]; usage: UsageSummary }

type Terminal =
  | { reason: "agent_done"; messages: Message[]; usage: UsageSummary }
  | ...
```

- Usage is cumulative for the whole `run()` (sum of all turns).
- Pros: Consumers who only handle terminal events get usage automatically. Additive — does not change any existing event structure (just adds a field).
- Cons: `agent_error` midway through a multi-turn run may have partial usage — that's actually useful to expose. An error on turn 3 of 10 still consumed tokens.
- `exactOptionalPropertyTypes` consideration: if `usage` is always present on terminal events, it must be non-optional (`usage: UsageSummary`, not `usage?: UsageSummary`) to avoid the optional/undefined ambiguity. That requires the loop to always have a non-null usage value at terminal time — which requires that providers *always* produce a usage event (which means the opt-in for OpenAI is mandatory, not optional).

**Option 2: A new intermediate `usage_update` event**

```typescript
type AgentEvent =
  | ...
  | { type: "usage_update"; turnIndex: number; turnUsage: UsageSummary; cumulativeUsage: UsageSummary }
```

- Yields per-turn usage after each turn's `message_stop`.
- Pros: Richer; allows per-turn cost tracking, which is useful for long multi-turn runs and will be needed for the Task tool to attribute costs to individual sub-agent turns.
- Cons: Adds a new event type. Consumers must handle it (or ignore it). Slightly more surface. Somewhat analogous to `turn_complete` — is `usage_update` just a field-rich `turn_complete`?

**Option 3: Fold usage into `turn_complete`**

Extend `turn_complete` to carry per-turn and cumulative usage:
```typescript
| { type: "turn_complete"; turnIndex: number; turnUsage: UsageSummary; cumulativeUsage: UsageSummary }
```

- Pros: Reuses an existing event; fewer event types. `turn_complete` is already emitted every turn.
- Cons: `turn_complete` is documented as a "tertiary event (advanced consumers)" — usage is arguably important enough to not be tertiary.

**Option 4: Usage only on `Terminal` (not on events)**

Add `usage` only to `Terminal`, not to `AgentEvent`. `for await` consumers get usage from the terminal event (which, per the existing decision in decisions.md 2026-06-27, carries `messages`); `.next()`-style consumers get it from the generator's return value.

- Pros: Minimal public surface change.
- Cons: Users who `for await` and handle only `agent_done` to get `messages` can also get usage there. But users who only aggregate events without capturing `terminal` miss it. The Task tool needs cumulative usage to roll up — this is fine if the Task tool drives `agentLoop` directly and reads `Terminal`.

**Which option tensions with the "lean event union" decision:**

Options 2 and 3 add a new event type or expand an existing one. The decisions log argument for leanness was specifically about *internal* retry/network events that have no caller-visible semantics. Usage data is different — it is caller-visible and useful. The architect must weigh whether `usage_update` is in the same category as `provider_retry` (no) or in the same category as `tool_result` (observable, useful, worth the event). This is an open question for engineering, not a research decision.

---

### 3f. Threading usage through the `ProviderEvent` → `agentLoop` boundary

Today `ProviderEvent` has three variants: `text_delta`, `tool_use`, `message_stop`. The loop consumes `text_delta` and `tool_use` and ignores `message_stop` (beyond consuming its `stopReason` implicitly through the accumulator).

**Option A: Add a `usage` variant to `ProviderEvent`**

```typescript
type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; ... }
  | { type: "message_stop"; stopReason: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
```

The loop then collects `usage` events during the `for await` over `provider.stream()`.

- Pros: Clean abstraction — the loop does not need to know about provider-specific usage event timing (message_start vs. message_delta vs. final chunk).
- Cons: Adds a variant to `ProviderEvent`. Providers must always emit exactly one `usage` event per `stream()` call. If OpenAI's usage chunk is lost (stream interrupted — OpenAI's own docs note "you may not receive the final usage chunk if the stream is interrupted"), the loop receives no usage event. This creates an inconsistency.
- **Alternative under Option A:** Make the mapper accumulate usage and emit it as a `usage` event on `message_stop` (or alongside it). Both Anthropic and OpenAI would emit `usage` once per `stream()` call. The OpenAI case emits it during `flush()`.

**Option B: Pass usage out-of-band (not through `ProviderEvent`)**

Instead of a new event, change `Provider.stream()` to return a generator with a typed return value (the "return" of an `AsyncGenerator<T, TReturn>`) that carries usage. But the current contract is `AsyncGenerator<ProviderEvent>` with no typed return — changing the return type to `AsyncGenerator<ProviderEvent, ProviderUsage>` is a breaking change to the `Provider` interface. Not recommended.

**Option C: Attach usage to `message_stop`**

Extend the existing `message_stop` ProviderEvent:
```typescript
| { type: "message_stop"; stopReason: string; usage?: ProviderUsage }
```

The mapper emits usage on the `message_stop` event. The loop reads usage off `message_stop` when it arrives. This avoids a new event type.

- Pros: No new `ProviderEvent` variant; extends an existing one.
- Cons: `message_stop` is currently "consumed but not yielded" (`loop.ts:58`). Adding usage to it means the loop needs to read it, which it already suppresses. Minor rework of the loop's suppression logic.

**Multi-turn accumulation:**

Each call to `provider.stream()` is one model turn. For a multi-turn `run()`, usage must be accumulated across turns. The loop controls the turn iteration — it is the natural place to sum `turnUsage` into `cumulativeUsage`. The `agentLoop` function would maintain a mutable running total (similar to how it maintains `turnsUsed`) and attach the cumulative total to the terminal event (or emit `usage_update` per turn).

---

## 4. Domain and Landscape Constraints

**Hard constraint — UI-free/headless boundary (decisions.md 2026-06-26):** All changes are in `packages/core`. No rendering, no terminal dependency. Token counts are plain numbers — no display logic belongs in the core.

**Hard constraint — `exactOptionalPropertyTypes: true` (tsconfig.base.json, engineering spec §1.4):** All optional fields on new types must use the conditional-spread pattern when forwarding, and must be declared as `T` (not `T | undefined`) if they are always present, or `?: T` if they may be absent. The choice between `cacheWriteTokens?: number` and `cacheWriteTokens: number | undefined` matters under this flag.

**Hard constraint — additive/non-breaking:** The feature brief ("pure-core enablers") and the roadmap's framing ("small, clean, pure-core") imply this should not break any existing test. `packages/core` has 196 tests as of the `openai-provider` feature landing. All new fields must either be additive (new optional properties, new event types that existing consumers ignore) or exactly-typed additions that do not change the discriminant of existing union members.

**Hard constraint — symmetric provider treatment:** Both `AnthropicProvider` and `OpenAIProvider` must implement the usage surface. OpenAI requires `stream_options: { include_usage: true }` in the request body — the mapper's `OpenAIChatCompletionParams` type and `mapRequest` function must be updated to include this.

**Hard constraint — OpenAI stream interruption risk:** The OpenAI docs note explicitly that the usage chunk (the final `choices: []` chunk) "may not be received if the stream is interrupted or cancelled." If the consumer passes an `AbortSignal` and cancels mid-stream, OpenAI may not emit its usage chunk. The normalized usage value in that case would be zero/undefined. The architecture must decide whether to emit a partial/zero usage value or omit usage on abort. (This is an engineering decision, not a research decision — but it is a real constraint that the architect must address.)

**Node 22 floor:** `AbortSignal.any` was added in Node v18.17.0 / v20.3.0, so it is available on the Node 22 floor with no polyfill needed.

**`@types/node@22` vs. `lib.dom`:** `AbortSignal.any` is typed in `lib.dom.d.ts`. The project uses `lib: ["ES2022"]` (no `dom`), with `@types/node@22` providing ambient Node globals. The question is whether `@types/node@22` includes the static `any()` method on its ambient `AbortSignal` type. This is the one TypeScript-typing risk for the AbortSignal work (see §7, Q1).

---

## 5. Key Findings and Implications

1. **External signal wiring is minimal and low-risk.** `RunOptions` gains `signal?: AbortSignal`. In `Agent.run()`, `AbortSignal.any([options.signal, abortCtrl.signal])` (when `options.signal` is present) produces a composite signal passed downstream instead of `abortCtrl.signal`. The `finally { abortCtrl.abort() }` cleanup is unchanged and still correct. No changes needed in `agentLoop` or below. *Engineering-facing:* Confirm `AbortSignal.any` is typed in `@types/node@22` (Q1 in §7); if not, a two-line manual listener is the fallback. Confirm the already-aborted pre-flight behavior is intentional or add an early check.

2. **Anthropic usage is in the stream already; the mapper currently discards it.** The `InputAccumulator` in `anthropic-mapper.ts` is the natural place to capture `message_start.message.usage` (input + cache-write tokens) and `message_delta.usage` (output + cache-read tokens). No new SDK dependency; no new network call. *Engineering-facing:* The architect must choose which event carries usage out of the mapper (`message_stop` extension vs. a new `usage` ProviderEvent variant).

3. **OpenAI requires an explicit opt-in (`stream_options: { include_usage: true }`) and carries a caveat.** The mapper's `OpenAIChatCompletionParams` type and `mapRequest` function must be updated. The existing "include_usage chunk produces zero events" behavior (confirmed by test at `openai-mapper.test.ts:629`) is currently correct behavior for today's needs, but must become "capture this chunk's usage" when the feature lands. *Engineering-facing:* The OpenAI usage chunk may not arrive on abort (`choices: []`, docs say it may not be sent if stream interrupted). The architect must decide the emit-zero-on-abort vs. omit-on-abort policy.

4. **OpenAI lacks `cache_creation_input_tokens`.** Anthropic charges per-cache-write turn; OpenAI has no such concept. A normalized `UsageSummary` type that has `cacheWriteTokens?: number` (optional/undefined on OpenAI path) is the natural fit under `exactOptionalPropertyTypes`. This asymmetry is small but real. *Product-facing:* Does the brief require a fully symmetric usage surface, or is "field absent when provider doesn't support it" acceptable?

5. **Multi-turn accumulation belongs in `agentLoop`.** The loop already tracks `turnsUsed`. Per-turn usage from each `provider.stream()` call should be summed in `agentLoop` into a cumulative total attached to the terminal event. The Task tool (Tier-1 #4, the downstream consumer) needs cumulative per-`run()` usage to roll up child costs — per-turn granularity is a bonus but the cumulative total is the minimum needed. *Engineering-facing:* Isolate the per-turn accumulator as a `let` inside the loop and sum into a cumulative total; emit both per-turn and cumulative if usage_update events are chosen.

6. **The "lean event union" prior decision applies differently to usage than to `provider_retry`.** The decisions log (2026-06-27) locked out `provider_retry` because it is an internal retry mechanic with no user-visible semantics (and infeasible while SDK-delegated). Token usage is user-visible, cost-relevant, and the specific motivation stated in the roadmap. The constraint is still "don't add events for purely internal state" — but usage is not purely internal. *Engineering-facing:* Any of Options 1–4 in §3e is technically feasible; the architect should weigh the Task tool's consumption pattern (likely reads `Terminal` directly, so Option 1 or 4 suffice for the initial use case) against future SDK usage of per-turn data.

7. **The feature is additive and non-breaking if done correctly.** Adding `signal?: AbortSignal` to `RunOptions` is backward-compatible (existing callers pass no second argument). Adding usage to terminal events or to a new `usage_update` event does not change the discriminant of any existing event. The 196 existing tests should pass without modification if no existing event shapes change. *Engineering-facing:* `exactOptionalPropertyTypes` means the new `signal?` field on `RunOptions` is typed as `AbortSignal`, not `AbortSignal | undefined`; the `run()` body must use `options.signal !== undefined` (not `options.signal`) as the guard.

---

## 6. Sources

| Source | What it contributed | Trust |
|---|---|---|
| `packages/core/src/agent.ts` (project source) | Exact `AbortController` creation site, `RunOptions` shape, `finally` cleanup | Primary — the authoritative code |
| `packages/core/src/loop/loop.ts` (project source) | `LoopParams.signal`, signal flow to `provider.stream()` and `ToolCallContext`, `message_stop` suppression, turn loop structure | Primary |
| `packages/core/src/types/events.ts` (project source) | Full `AgentEvent` union, `Terminal` union — confirmed no usage fields | Primary |
| `packages/core/src/types/provider.ts` (project source) | `ProviderEvent` union, `Provider` interface, `LogEntry` (usage note "extend in M2") | Primary |
| `packages/core/src/providers/anthropic.ts` (project source) | How `signal` is threaded to Anthropic SDK, where to extend | Primary |
| `packages/core/src/providers/anthropic-mapper.ts` (project source) | `InputAccumulator` structure; `message_start` ignored at line 163; `message_delta` stop_reason capture; where usage would be captured | Primary |
| `packages/core/src/providers/openai.ts` (project source) | How `signal` is threaded to OpenAI SDK, `accumulator.flush()` as emission site | Primary |
| `packages/core/src/providers/openai-mapper.ts` (project source) | `ToolCallAccumulator.flush()`, `translateChunk` (choices guard skips usage chunk), `OpenAIChatCompletionParams` (no `stream_options` today) | Primary |
| `packages/core/src/__tests__/openai-mapper.test.ts` (project source) | Test at line 629-631 confirms the "include_usage chunk produces zero events" behavior is tested and current | Primary |
| `docs/project/decisions.md` (project docs) | "lean event union" rationale, `exactOptionalPropertyTypes` pattern, `AbortSignal` threading decision (second arg), M2 seams | Primary |
| `docs/project/core-roadmap.md` (project docs) | Tier-1 #2 and #3 descriptions, Task tool dependency stated | Primary |
| `node_modules/.pnpm/@anthropic-ai+sdk@0.52.0/.../messages.d.ts` | `RawMessageStartEvent`, `RawMessageDeltaEvent`, `Usage`, `MessageDeltaUsage` shapes — the exact SDK types the mapper processes | Primary (official SDK, installed version) |
| `node_modules/.pnpm/openai@6.45.0_.../completions.d.ts` | `ChatCompletionChunk.usage`, `CompletionUsage`, `stream_options`/`include_usage`, `prompt_tokens_details.cached_tokens` | Primary (official SDK, installed version) |
| `node_modules/.pnpm/typescript@5.9.3/.../lib.dom.d.ts` | `AbortSignal.any()` static method present — confirmed typed | Primary (TypeScript's bundled lib) |
| Node.js docs via WebFetch (`nodejs.org/api/globals.html`) | `AbortSignal.any()` added in Node v18.17.0 / v20.3.0 — confirmed available on Node 22 floor | Primary (official docs) |

---

## 7. Open Questions and Unknowns

These are unresolved by research and must be answered by the feature-architect or the user before implementation:

**Q1 — TypeScript typing of `AbortSignal.any` in `@types/node@22`:**
The project uses `lib: ["ES2022"]` (no `lib.dom`). `AbortSignal.any` is confirmed in `lib.dom.d.ts`. Does `@types/node@22`'s ambient `AbortSignal` type also declare the static `any()` method? If not, Option B (manual listener) is the fallback, or the project can add `"lib": ["ES2022", "DOM"]` — but adding `DOM` conflicts with the node-only target and the "no UI imports" rule. Resolution: `tsc` will tell in the implement phase; the architect should note this risk and specify the fallback.

**Q2 — Pre-flight check for already-aborted incoming signal:**
If `options.signal.aborted === true` when `run()` is called, `AbortSignal.any([...])` returns an already-aborted composite signal, and the first `provider.stream()` call will immediately throw. This surfaces as `agent_error` via the loop's catch block. Is this the desired behavior, or should `run()` short-circuit immediately with a clear "cancelled before start" signal/message?

**Q3 — Usage surface location (which events carry it):**
The research identified four options (§3e): (1) on terminal `AgentEvent`s + `Terminal`; (2) a new `usage_update` event; (3) folded into `turn_complete`; (4) `Terminal` only. The architect must pick one (or a combination). The Task tool's consumption pattern should drive this choice.

**Q4 — Usage threading through `ProviderEvent`:**
Does usage flow via a new `usage` variant on `ProviderEvent` (§3f Option A), as an extension to `message_stop` (Option C), or entirely out-of-band? The `Provider` interface contract for usage must be specified.

**Q5 — OpenAI abort behavior for usage chunk:**
The OpenAI final usage chunk ("may not be received if the stream is interrupted") creates a race: if the caller passes an external signal and cancels mid-stream, `ToolCallAccumulator.flush()` may have partial or zero usage data. Should the loop emit zero usage, omit usage, or log a warning on abort? What is the contract?

**Q6 — `cacheWriteTokens` optionality in normalized type:**
Should the normalized `UsageSummary` type include `cacheWriteTokens?: number` (absent/undefined for OpenAI) or `cacheWriteTokens: number` (zero for OpenAI, even though that is misleading — zero vs. "not applicable" are different)? This is a type-design decision with implications for correctness and for how the Task tool rolls up costs.

**Q7 — Per-turn vs. cumulative usage emission:**
Should `agentLoop` emit usage per-turn (useful for long runs, context budgeting, matching the Task tool attribution model) or only as a cumulative total on the terminal event? Can it do both (per-turn `usage_update` + cumulative on terminal)?

**Q8 — `stream_options: { include_usage: true }` as a mandatory or provider-option field:**
Should `OpenAIProvider` always add `stream_options: { include_usage: true }` unconditionally (making usage always available when possible), or expose it as a per-provider option? Given that the roadmap frames usage as a foundational feature ("unlock cost tracking"), mandatory seems correct — but this is an architectural decision.

# Feature Engineering Spec — core-run-controls

> Standard feature pipeline (combined product + engineering). Drafted by the `feature-architect` agent.
> Date: 2026-06-30. Scope: `feature/core-run-controls`.

---

## 1. Goal

This feature adds two pure-core enablers to `tiny-agentic`'s `packages/core`:

1. **External `AbortSignal` on `Agent.run()`** — `RunOptions` gains an optional `signal?: AbortSignal`. Inside `run()`, it is composed with the internally-created `AbortController.signal` via `AbortSignal.any([options.signal, abortCtrl.signal])`, producing a single composite signal that aborts when either source fires. This lets parent agents, timeouts, and process-signal handlers cancel an in-flight `run()` from outside the `for await` loop.

2. **Token usage on the event stream + `Terminal`** — both providers now capture and normalize cumulative token usage. Every terminal `AgentEvent` (`agent_done`, `max_turns_exceeded`, `agent_error`) and the `Terminal` return value gain a `usage` field carrying a normalized cross-provider shape (`{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens? }`). Two pure immutable helpers, `mergeUsage` and `accumulateUsage`, plus an `EMPTY_USAGE` constant, manage per-message accumulation and per-turn roll-up into the run-total. The existing `turn_complete` event also gets an optional `usage?: Usage` field for live per-turn metering.

These two enablers are the prerequisite for the upcoming sub-agent `Task` tool (roadmap #4): a parent must be able to cancel children (signal) and roll up child token costs (`Terminal.usage`).

---

## 2. Motivation

**External signal:** Today the only way to cancel an in-flight `run()` is to `break` inside the `for await` loop. There is no external cancellation path — no timeout, no parent-agent cancel, no `SIGINT` handler can stop an actively-streaming run without owning the consumer loop. The sub-agent Task tool must cancel child agents from outside their loops. A parent process-signal handler should be able to cancel all in-flight agents cleanly. Without `signal` support in `RunOptions`, every such use case requires a workaround (e.g., owning the consumer loop and calling `.return()`), which does not compose well.

**Token usage:** There is no token counting anywhere in the framework today. Both provider SDKs return usage data that the mappers currently discard. The roadmap's sub-agent Task tool must roll up child costs — the reference pattern (Claude Code's forked-agent `ForkedAgentResult.totalUsage`) shows this is done by returning cumulative usage on the child's terminal result. `Terminal.usage` is the roll-up seam. Without it, cost attribution across nested agents is impossible. Consumers also need run-level costs for budgeting, observability, and rate-limit awareness.

---

## 3. User-visible behavior

This is a headless library feature. "User" in this section means the TypeScript consumer writing application code against the `tiny-agentic` API.

### Primary flow

**Cancellation:**

1. Consumer creates an `AbortController` (or obtains a signal from a timeout utility, a parent agent's context, etc.).
2. Consumer calls `agent.run(prompt, { signal: controller.signal })`.
3. The agent runs normally. At any point, the consumer (or a timeout) calls `controller.abort()`.
4. The in-flight provider stream is cancelled at the next `await` point inside the provider's `for await` loop. The SDK respects the `AbortSignal` and throws (Anthropic: `APIUserAbortError`; OpenAI: similar fetch-abort error).
5. The loop's `catch` block catches the error and yields `{ type: "agent_error", error, messages, usage }` (usage is whatever was accumulated before abort). The generator then returns the matching `Terminal`.
6. The consumer's `for await` loop sees the `agent_error` terminal event and exits normally. The `finally { abortCtrl.abort() }` in `agent.ts` runs cleanup.

**Usage reading:**

1. Consumer runs `for await (const event of agent.run(prompt))`.
2. Consumer inspects terminal events: `event.type === "agent_done"` → `event.usage` contains cumulative token counts.
3. Or: consumer captures the generator's return value via `.next()` iteration and reads `terminal.usage`.
4. For per-turn metering: consumer handles `turn_complete` events and reads `event.usage` (the turn's usage, not cumulative; present when a usage-emitting provider is used).

### States matrix

N/A — This is a headless library. There are no rendered surfaces, loading indicators, or empty states. State is carried on the event stream.

| Event surface | Changed behavior |
|---|---|
| `agent_done` | Adds `usage: Usage` field (always present; may be `EMPTY_USAGE` on zero-token paths) |
| `max_turns_exceeded` | Adds `usage: Usage` field (cumulative up to the cap) |
| `agent_error` | Adds `usage: Usage` field (partial, whatever was accumulated before error) |
| `turn_complete` | Adds optional `usage?: Usage` field (present when provider emitted usage for this turn) |
| `Terminal` return | Adds `usage: Usage` field on all three variants |

### Accessibility

N/A — This is a headless library. No user interface exists in this package. There are no visual signals, keyboard interactions, or ARIA roles.

### Edge-case behaviors

- **Pre-aborted signal:** If `options.signal.aborted` is already `true` when `run()` is called, the composite `AbortSignal.any([...])` is also immediately aborted. An explicit pre-flight guard in `run()` catches this before the environment context build and yields `agent_error` immediately (see §5 Open Questions Q2 resolution). This is provider-independent and avoids emitting a confusing error from deep inside the SDK.
- **Signal abort during env-context build:** `buildEnvContext` runs before the first provider call. An abort during this window is not currently interceptable (no signal threading in `buildEnvContext`). An abort fires here goes unnoticed until the first `provider.stream()` call, at which point the SDK respects the already-aborted signal and throws immediately. This is acceptable for now; a future improvement could thread the signal into `buildEnvContext`.
- **No usage on abort:** OpenAI's final usage chunk may not arrive when the stream is interrupted. In that case `ToolCallAccumulator.flush()` emits no usage. The loop uses `EMPTY_USAGE` as the fallback. The `agent_error` event carries partial accumulated usage (which may be all zeros) — this is explicitly documented, not a bug.
- **Multi-turn partial usage:** A run that errors on turn 3 of 10 carries accumulated usage from turns 1–2 (plus whatever was accumulated in turn 3 before the error). This is intentionally preserved — partial cost attribution is better than zero.
- **`cacheWriteTokens` absent on OpenAI:** The normalized `Usage` type declares `cacheWriteTokens?` (optional). OpenAI responses never set this field. Consumers must not assume its presence.

### Microcopy

N/A — This is a headless library. There is no user-facing copy, CTAs, or error messages in this package. Error strings emitted to `agent_error.error.message` come from the provider SDK and are not modified by this feature.

---

## 4. Out of scope

- **Cost calculation in USD** — `Usage` carries token counts only. Dollar cost requires per-model pricing tables (Anthropic and OpenAI have different rates, and rates change). Cost is an SDK-layer or application-layer concern.
- **Per-turn cost attribution to individual tools** — tracking which token spend happened during which tool call is not addressed. The `turn_complete` usage covers the full model turn.
- **A dedicated `usage_update` AgentEvent** — considered and rejected (see Q3 resolution). Per-turn usage on `turn_complete` is the approach; a new event type is not added.
- **`stream_options.include_usage` as a configurable provider option** — it is always on. Users cannot disable it.
- **Usage accumulation across multiple sequential `agent.run()` calls** — each `run()` produces its own cumulative `Terminal.usage`. Cross-run aggregation is the caller's responsibility.
- **AbortSignal threading into `buildEnvContext`** — out of scope; `buildEnvContext` does not currently accept a signal.
- **`Platform.exec` timeout / cancellation seam** — the `ToolCallContext.signal` already flows to tool implementations. This feature does not change that seam.
- **Any changes to the `AgentOptions` constructor** — no new constructor arguments.
- **Provider-specific usage fields** (Anthropic `server_tool_use`, `service_tier`, ephemeral cache tiers) — not included in the normalized shape. They are Anthropic-internal metering details irrelevant to multi-provider code.

---

## 5. Open questions resolved

All 8 open questions from research are resolved here with rationale. Consequential decisions are also recorded in `docs/feature/core-run-controls/decisions.md`.

### Q1 — AbortSignal.any typing

**Resolution:** Use `AbortSignal.any([options.signal, abortCtrl.signal])` directly. No fallback needed.

**Rationale:** Verified by the verification addendum via a real `tsc --noEmit` run (exit 0). The static `any()` method is declared in `@types/node`'s `web-globals/abortcontroller.d.ts` and resolves because `lib` excludes `DOM` (using `lib: ["ES2022"]` and `types: ["node"]`). The typing is stable under the current config; the only risk is if `"DOM"` is ever added to `lib` (which the headless decision forbids anyway). The manual-listener fallback (Option B from research) is not needed and is not implemented.

**Implementation note:** The `AbortSignal.any(...)` call requires no DOM lib. Do NOT add `"DOM"` to `tsconfig` `lib`. The no-DOM-lib dependency is now a documented invariant.

### Q2 — Pre-aborted external signal

**Resolution:** Add an explicit `signal.aborted` pre-flight guard at the top of `run()`, before any async work.

**Rationale:** Relying on the SDK to reject on a pre-aborted signal is provider-dependent behavior. With `AbortSignal.any([...])`, an already-aborted input produces an already-aborted composite signal, and the first `await` inside `provider.stream()` would throw — but only after `buildEnvContext` has run (a potentially expensive async operation: git status, file reads, etc.). An explicit guard short-circuits immediately, before any work is done, with a clear error. It does not require a new terminal reason (the existing `agent_error` is appropriate — the run genuinely could not complete).

**Implementation:** In `agent.ts:run()`, after building the composite signal and before any `await`:

```typescript
// Composite signal (if external signal provided)
const signal = options.signal !== undefined
  ? AbortSignal.any([options.signal, abortCtrl.signal])
  : abortCtrl.signal;

// Pre-flight: fail fast if already aborted (provider-independent, avoids
// running buildEnvContext on a dead signal)
if (signal.aborted) {
  const error = new Error(
    signal.reason instanceof Error
      ? signal.reason.message
      : "Run aborted before start"
  );
  const event = { type: "agent_error" as const, error, messages: options.messages ?? [], usage: EMPTY_USAGE };
  yield event;
  return { reason: "agent_error", error, messages: options.messages ?? [], usage: EMPTY_USAGE };
}
```

The existing `catch (err)` in `agentLoop` handles mid-run aborts and produces `agent_error` with partial accumulated usage. The pre-flight guard handles the "never started" case, ensuring `buildEnvContext` is never called on a dead signal.

**No new terminal reason is introduced.** `agent_error` is the correct surface for "run was aborted" — it is already the signal for unrecoverable errors. Adding `"agent_aborted"` as a fourth terminal reason would widen the `Terminal` union and require every existing consumer's switch statement to handle it; the value is insufficient to justify that cost.

### Q3 — Per-turn usage on `turn_complete`

**Resolution:** Yes. Attach `usage?: Usage` to the `turn_complete` AgentEvent. It is optional and present only when the provider emitted usage for that turn (i.e., always for both providers in the happy path; absent/undefined on error or abort paths where no usage arrived).

**Rationale:** The reference (Claude Code) does not emit a dedicated usage event — per-turn usage rides on the raw stream for SDK consumers. Since our framework wraps the raw stream and does not expose `ProviderEvent`s directly, a consumer who wants per-turn token counts has no other mechanism. The `turn_complete` event is already the "this turn is done" signal for advanced consumers. Adding `usage?` there gives live metering capability (e.g., cumulative cost display, per-turn context-budget tracking) without adding a new event type. It remains optional to avoid forcing all consumers to handle it. Cumulative usage on terminal events is the primary surface; per-turn is additive.

### Q4 — ProviderEvent threading: extend `message_stop` vs new variant

**Resolution:** Extend the existing `message_stop` ProviderEvent with `usage?: Usage`.

**Rationale:** `message_stop` is already the once-per-turn event that marks the end of a model call. The loop already reads it (and currently discards it). Extending it to carry `usage?` is strictly additive — no new discriminant, no new case in switch statements, backward-compatible (the `usage` field is optional). Adding a new `usage` ProviderEvent variant would require providers to emit it separately and the loop to separately collect it; the `message_stop` extension is simpler and keeps the "one event per model-turn boundary" invariant. The research's own recommendation was to extend `message_stop`; the verification addendum confirmed this threading chain explicitly (note 5).

**The threading chain:**
- Anthropic: `InputAccumulator` gains `setUsage(u: Usage)`/`takeUsage(): Usage | undefined` (mirroring the existing `setStopReason`/`takeStopReason` pattern). The `message_start` and `message_delta` events are captured in `translateStreamEvent` to build the per-turn usage. On `message_stop`, `accumulator.takeUsage()` is included in the emitted event.
- OpenAI: `ToolCallAccumulator` gains a `usage?: Usage` field set when `translateChunk` sees a non-null `chunk.usage` on the final empty-choices chunk. `flush()` includes it in the `message_stop` event.
- Loop: the `message_stop` branch (currently "consumed but not yielded") reads `event.usage` and accumulates into the run-total `cumulativeUsage`. The per-turn usage is passed up for attachment to `turn_complete`.

### Q5 — Aborted-run / missing usage

**Resolution:** Use `EMPTY_USAGE` (all fields zero, `cacheWriteTokens` absent) as the fallback when usage never arrives. The `usage` field on terminal events is always present and never `undefined`. The `turn_complete.usage` field is optional (`usage?: Usage`) and is absent when the turn produced no usage data.

**Rationale:** A consistent non-null `usage` on terminal events makes consumers simpler — no need to null-check before accumulating child usage in the parent Task tool. The cost of emitting zeros is negligible (it is clearly zero, not misleading). Per the verification addendum note 9: "the normalized `Usage` must tolerate a missing-usage outcome." The design honors this by using `EMPTY_USAGE` as a well-defined zero value rather than making `usage?` on terminal events optional. The distinction between "run completed with zero tokens" (unlikely but theoretically possible) and "usage was not captured" is not surfaced — both emit `EMPTY_USAGE`. This is acceptable; the Task tool cares about non-zero children, and zeros are self-documenting.

**For `turn_complete`:** `usage?` is optional specifically because a mid-run-error can terminate the loop before a turn boundary (the `catch` block in `agentLoop` returns `agent_error` directly, bypassing `turn_complete`). So `turn_complete` is only emitted when a turn actually completes, and in that case usage is always available from the `message_stop` branch — making `usage` on `turn_complete` always present when the event itself is emitted. However, declaring it `?: Usage` is safer than `usage: Usage` because it allows future cases (a degenerate turn, a provider that omits usage data) without a breaking type change.

### Q6 — `cacheWriteTokens` optional vs. zero

**Resolution:** `cacheWriteTokens?: number` — optional, absent (not `0`) when the provider does not support it.

**Rationale:** Under `exactOptionalPropertyTypes: true`, `cacheWriteTokens?: number` means the field is either a number or not present at all. Emitting `cacheWriteTokens: 0` for OpenAI would lie — zero means "zero cache writes happened," while absence means "this provider does not have a cache-write concept." The Task tool roll-up (`accumulateUsage`) must handle the optional field correctly: `(a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0)`, only setting the field on the result if at least one operand had it set. This is the correct cross-provider behavior.

### Q7 — mergeUsage and accumulateUsage semantics

**Resolution:** Two pure immutable helpers, defined in the new `types/usage.ts` module:

- `mergeUsage(a: Usage, b: Usage): Usage` — merges two partial usages from events within the same model message (e.g., combining `message_start` fields with `message_delta` fields). Uses a `> 0` guard on the source value to avoid clobbering a real value with zero. Returns a new object.
- `accumulateUsage(total: Usage, turn: Usage): Usage` — field-wise addition of a completed turn's usage into the run total. No guards — this is final-value summation. Returns a new object.
- `EMPTY_USAGE: Readonly<Usage>` — `{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }`, no `cacheWriteTokens` (absent, since `exactOptionalPropertyTypes` means we cannot set it to `undefined`). Frozen constant, not cloned per use.

The `> 0` guard in `mergeUsage` follows the reference's `updateUsage` pattern: a later event (e.g., `message_delta` with `input_tokens: null` or `0`) must not overwrite the real value captured from the earlier event (`message_start`). Guards apply to the source value, not the target: `a > 0 ? a : existing`.

### Q8 — `include_usage` always-on for OpenAI

**Resolution:** `stream_options: { include_usage: true }` is always added to every OpenAI request. No configuration option.

**Rationale:** Usage is a foundational feature, not an opt-in. Keeping it always-on is simpler (no per-request conditional), consistent (all runs produce usage data, or a zero fallback on abort), and cheap (the usage chunk is a few bytes). A configurable option would require threading an additional parameter through `mapRequest` and `OpenAIProvider`, complicating the interface for no practical benefit — no consumer of `tiny-agentic` would want usage turned off once it is available. The always-on approach also makes the `OpenAIChatCompletionParams` type simpler (no optional `stream_options`).

**Test impact:** The existing `openai-mapper.test.ts` tests that call `mapRequest` and assert the request shape do NOT currently assert the absence or presence of `stream_options`. The test at line 92-96 asserts `"stream" in params === false` but does not assert on `stream_options`. Adding `stream_options: { include_usage: true }` to `mapRequest` output should not break existing tests. Confirm during implementation; if any test asserts `Object.keys(params)` or equivalent, it may need updating.

---

## 6. Architectural fit

### Existing modules touched

| Module | Change |
|---|---|
| `packages/core/src/agent.ts` | `RunOptions` gains `signal?: AbortSignal`. `run()` composes signals with `AbortSignal.any`, adds pre-flight abort guard, threads `usage` into all terminal-event construction (delegated via `agentLoop` return value). |
| `packages/core/src/loop/loop.ts` | `agentLoop` maintains a `cumulativeUsage: Usage` (starting `{ ...EMPTY_USAGE }`) and a `turnUsage: Usage | undefined`. Reads `event.usage` off `message_stop`. Accumulates with `accumulateUsage`. Attaches `usage` to `turn_complete` events and all terminal events/returns. |
| `packages/core/src/types/events.ts` | All three terminal `AgentEvent` variants gain `usage: Usage` (non-optional). `turn_complete` gains `usage?: Usage`. Imports `Usage` from `./usage.js`. |
| `packages/core/src/types/provider.ts` | `message_stop` ProviderEvent variant gains `usage?: Usage`. Imports `Usage` from `./usage.js`. |
| `packages/core/src/providers/anthropic-mapper.ts` | `InputAccumulator` gains `setUsage(u: Usage): void` and `takeUsage(): Usage | undefined` (mirroring `setStopReason`/`takeStopReason`). `translateStreamEvent` captures usage from `message_start` and `message_delta` events; emits `usage` on `message_stop`. Imports `Usage`, `mergeUsage` from `../types/usage.js`. |
| `packages/core/src/providers/openai-mapper.ts` | `OpenAIChatCompletionParams` gains `stream_options: { include_usage: true }` (concrete literal type, always set). `mapRequest` adds `stream_options: { include_usage: true }` unconditionally. `translateChunk` reads `chunk.usage` with `!= null` guard and calls `accumulator.setUsage(...)`. `ToolCallAccumulator` gains a `usage?: Usage` private field set by `setUsage(u: Usage)`. `flush()` includes `usage` in the emitted `message_stop`. Imports `Usage` from `../types/usage.js`. |
| `packages/core/src/index.ts` | Exports `Usage`, `mergeUsage`, `accumulateUsage`, `EMPTY_USAGE` from `./types/usage.js`. |

### New modules / files introduced

**`packages/core/src/types/usage.ts`** — the normalized usage type and pure helpers. Placed in `types/` to avoid import cycles (it imports nothing from the project; both `types/provider.ts` and `types/events.ts` import from it; mappers import from it; `loop.ts` imports from it).

```typescript
/**
 * Normalized cross-provider token usage for a model call or run.
 * inputTokens, outputTokens, cacheReadTokens are always present.
 * cacheWriteTokens is Anthropic-only; absent for OpenAI and when not applicable.
 */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens?: number;
};

/**
 * Zero usage constant. Use as the initial accumulator value.
 * Do NOT mutate. Clone with { ...EMPTY_USAGE } if a mutable copy is needed.
 * cacheWriteTokens is absent (exactOptionalPropertyTypes: absent ≠ undefined).
 */
export const EMPTY_USAGE: Readonly<Usage> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
});

/**
 * Merge two partial usage values from events within the same model message.
 * Uses a > 0 guard: a later event's zero does not overwrite an earlier non-zero.
 * Pure and immutable — returns a new Usage object.
 *
 * Use case: combining message_start (input tokens) with message_delta (output
 * tokens) from Anthropic's streaming event sequence.
 */
export function mergeUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: b.inputTokens > 0 ? b.inputTokens : a.inputTokens,
    outputTokens: b.outputTokens > 0 ? b.outputTokens : a.outputTokens,
    cacheReadTokens: b.cacheReadTokens > 0 ? b.cacheReadTokens : a.cacheReadTokens,
    ...(((b.cacheWriteTokens ?? 0) > 0)
      ? { cacheWriteTokens: b.cacheWriteTokens }
      : a.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: a.cacheWriteTokens }
        : {}),
  };
}

/**
 * Field-wise sum of a completed turn's usage into the run cumulative total.
 * No guards — final values only. Pure and immutable — returns a new Usage object.
 *
 * Use case: summing turn usage into the run-level total after each message_stop.
 */
export function accumulateUsage(total: Usage, turn: Usage): Usage {
  return {
    inputTokens: total.inputTokens + turn.inputTokens,
    outputTokens: total.outputTokens + turn.outputTokens,
    cacheReadTokens: total.cacheReadTokens + turn.cacheReadTokens,
    ...((total.cacheWriteTokens !== undefined || turn.cacheWriteTokens !== undefined)
      ? { cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (turn.cacheWriteTokens ?? 0) }
      : {}),
  };
}
```

**Why `types/usage.ts` and not inline in `types/provider.ts` or `types/events.ts`?** Both `types/provider.ts` and `types/events.ts` need `Usage`. Putting it in either one would require the other to import from it — creating a peer-type import that is confusing (why does `events.ts` import from `provider.ts`?). A dedicated `types/usage.ts` with zero project-internal imports is the clean solution and follows the existing pattern (`types/messages.ts`, `types/platform.ts`, etc. are independent modules).

### Modified existing interfaces (back-compat)

**`RunOptions`** — adds `signal?: AbortSignal`. Optional field; all existing callers that pass `{}` or no second argument are unaffected. Under `exactOptionalPropertyTypes`, callers must pass either `signal: someSignal` or omit the field; `signal: undefined` is a type error.

**`AgentEvent` terminal variants** — adds `usage: Usage` (non-optional) to `agent_done`, `max_turns_exceeded`, and `agent_error`. **This is a breaking change to the discriminated union shapes.** Existing consumers that destructure or assert on the exact shape of a terminal event will fail to compile until they add `usage` to their assertions or update destructuring. However, since `usage` is newly added, no consumer currently reads `usage` — the only breakage is if a consumer has an exhaustive type-check that lists every field of a terminal event explicitly. In practice, most consumers match on `event.type` and read only the fields they need (e.g., `event.messages`); adding a new field is backward-compatible at the value level even if technically not at the structural type level. The 196 existing tests are expected to pass without modification (they construct and assert on terminal events but should not fail from an additional field being added). **If any test uses `expect(event).toEqual({ type: "agent_done", messages: [...] })` without an `usage` field, it will fail.** The planner should flag these.

**`turn_complete` AgentEvent** — adds `usage?: Usage` (optional). Fully additive. Existing consumers that handle `turn_complete` and do not read `usage` are unaffected.

**`ProviderEvent.message_stop`** — adds `usage?: Usage` (optional). Additive to an event that is already "consumed but not yielded" in the loop. No external consumer currently reads `message_stop` (it is a `ProviderEvent`, not an `AgentEvent`). Mock providers in tests that emit `{ type: "message_stop", stopReason: "end_turn" }` remain valid (optional field absent = correctly typed as `message_stop` without usage).

---

## 7. Data model changes

### New type: `Usage` (in `types/usage.ts`)

```typescript
type Usage = {
  inputTokens: number;     // always present; both providers
  outputTokens: number;    // always present; both providers
  cacheReadTokens: number; // always present; 0 when no cache hits
  cacheWriteTokens?: number; // Anthropic-only; absent for OpenAI
};
```

No schema storage or migration. This is a pure in-memory type carried on the event stream and returned by `Agent.run()`. It is not persisted anywhere by the core.

### Updated `AgentEvent` (in `types/events.ts`)

```typescript
// Before
| { type: "agent_done";         messages: Message[] }
| { type: "max_turns_exceeded"; turnsUsed: number; messages: Message[] }
| { type: "agent_error";        error: Error; messages: Message[] }
| { type: "turn_complete";      turnIndex: number }

// After
| { type: "agent_done";         messages: Message[]; usage: Usage }
| { type: "max_turns_exceeded"; turnsUsed: number; messages: Message[]; usage: Usage }
| { type: "agent_error";        error: Error; messages: Message[]; usage: Usage }
| { type: "turn_complete";      turnIndex: number; usage?: Usage }
```

### Updated `Terminal` (in `types/events.ts`)

```typescript
// Before
type Terminal =
  | { reason: "agent_done";         messages: Message[] }
  | { reason: "max_turns_exceeded"; messages: Message[]; turnsUsed: number }
  | { reason: "agent_error";        messages: Message[]; error: Error }

// After
type Terminal =
  | { reason: "agent_done";         messages: Message[]; usage: Usage }
  | { reason: "max_turns_exceeded"; messages: Message[]; turnsUsed: number; usage: Usage }
  | { reason: "agent_error";        messages: Message[]; error: Error; usage: Usage }
```

### Updated `ProviderEvent` (in `types/provider.ts`)

```typescript
// Before
| { type: "message_stop"; stopReason: "end_turn" | "tool_use" | "max_tokens" | string }

// After
| { type: "message_stop"; stopReason: "end_turn" | "tool_use" | "max_tokens" | string; usage?: Usage }
```

### Updated `OpenAIChatCompletionParams` (in `providers/openai-mapper.ts`)

```typescript
// Before
export type OpenAIChatCompletionParams = {
  model: string;
  max_completion_tokens: number;
  messages: OpenAIChatMessage[];
  tools?: OpenAIFunctionTool[];
};

// After
export type OpenAIChatCompletionParams = {
  model: string;
  max_completion_tokens: number;
  messages: OpenAIChatMessage[];
  tools?: OpenAIFunctionTool[];
  stream_options: { include_usage: true };
};
```

---

## 8. Provider field mapping

### Anthropic → Usage (per turn)

| `Usage` field | Source event | SDK field | Notes |
|---|---|---|---|
| `inputTokens` | `message_start` | `message.usage.input_tokens` | Non-null `number` on `message_start`. Do NOT read from `message_delta` (it is `number \| null` there). |
| `outputTokens` | `message_delta` | `usage.output_tokens` | Non-null `number` on `message_delta`. |
| `cacheReadTokens` | `message_delta` | `usage.cache_read_input_tokens` | `number \| null`; both events carry it. Read from `message_delta` for the final value. Guard: `?? 0`. |
| `cacheWriteTokens` | `message_start` | `message.usage.cache_creation_input_tokens` | `number \| null`; both events carry it. Read from `message_start`. Only set on result if `> 0`. |

**Accumulation within a turn:** The `InputAccumulator` builds a per-turn `Usage` incrementally:
1. On `message_start`: initialize `{ inputTokens, outputTokens: 0, cacheReadTokens, cacheWriteTokens? }`.
2. On `message_delta`: call `mergeUsage(accumulated, delta_usage)` where `delta_usage = { inputTokens: 0, outputTokens, cacheReadTokens, cacheWriteTokens: 0 }`.

The `> 0` guard in `mergeUsage` ensures that if `message_delta.cache_read_input_tokens` is null (non-prompt-cached run), it does not overwrite a real value from `message_start`.

### OpenAI → Usage (per turn)

| `Usage` field | SDK field | Notes |
|---|---|---|
| `inputTokens` | `chunk.usage.prompt_tokens` | Non-null number on the final chunk |
| `outputTokens` | `chunk.usage.completion_tokens` | Non-null number on the final chunk |
| `cacheReadTokens` | `chunk.usage.prompt_tokens_details?.cached_tokens` | Optional; `?? 0` |
| `cacheWriteTokens` | (absent) | OpenAI has no cache-write concept; field omitted |

**When `chunk.usage` arrives:** The final chunk has `choices: []` (empty) and `usage: CompletionUsage | null`. Guard: `chunk.usage != null` (not `!== null`, since the value is typed as possibly `null`). All non-final chunks have `choices: [...]` (non-empty) with `usage: null` — the existing `choices.length === 0` early-return in `translateChunk` no longer applies because we need to read `chunk.usage` even when `choices` is empty. The fix: restructure `translateChunk` to check `chunk.usage` before the `choices.length === 0` return.

**Corrected `translateChunk` logic:**
```
1. if chunk.usage != null → accumulator.setUsage(normalize(chunk.usage))
2. if !choices || choices.length === 0 → return []   (original early return, now after usage capture)
3. ... existing delta/finishReason logic ...
```

---

## 9. Module-by-module change list

### `packages/core/src/types/usage.ts` (NEW)

- Export: `Usage` type
- Export: `EMPTY_USAGE` constant
- Export: `mergeUsage(a: Usage, b: Usage): Usage`
- Export: `accumulateUsage(total: Usage, turn: Usage): Usage`
- No project-internal imports

### `packages/core/src/types/events.ts`

- Import `Usage` from `./usage.js`
- Add `usage: Usage` to `agent_done`, `max_turns_exceeded`, `agent_error` variants
- Add `usage?: Usage` to `turn_complete` variant
- Add `usage: Usage` to all three `Terminal` variants

### `packages/core/src/types/provider.ts`

- Import `Usage` from `./usage.js`
- Add `usage?: Usage` to `message_stop` ProviderEvent variant

### `packages/core/src/agent.ts`

- Import `EMPTY_USAGE` from `./types/usage.js`
- Extend `RunOptions`: add `signal?: AbortSignal`
- In `run()`:
  - After `const abortCtrl = new AbortController();`, compute composite signal:
    ```typescript
    const signal = options.signal !== undefined
      ? AbortSignal.any([options.signal, abortCtrl.signal])
      : abortCtrl.signal;
    ```
  - Add pre-flight guard (see Q2 resolution above) — yield `agent_error` with `usage: EMPTY_USAGE` and return immediately if `signal.aborted`.
  - Replace `signal: abortCtrl.signal` in the `agentLoop` call with `signal` (the composite).

### `packages/core/src/loop/loop.ts`

- Import `Usage`, `EMPTY_USAGE`, `accumulateUsage` from `../types/usage.js`
- In `agentLoop`:
  - Declare `let cumulativeUsage: Usage = { ...EMPTY_USAGE };` at the start of the function.
  - In the `for await` over `provider.stream()`: when `event.type === "message_stop"`, capture `event.usage` into a local `let turnUsage: Usage | undefined`.
  - After the `for await` (or in the `message_stop` branch), if `turnUsage` is defined, call `cumulativeUsage = accumulateUsage(cumulativeUsage, turnUsage)`.
  - In `turn_complete` yield: `yield { type: "turn_complete", turnIndex, ...(turnUsage !== undefined ? { usage: turnUsage } : {}) };`
    - Note: `exactOptionalPropertyTypes` requires the conditional spread pattern here.
  - In `max_turns_exceeded`: `yield { type: "max_turns_exceeded", turnsUsed, messages: workingMessages, usage: cumulativeUsage }; return { reason: "max_turns_exceeded", turnsUsed, messages: workingMessages, usage: cumulativeUsage };`
  - In `agent_done`: `yield { type: "agent_done", messages: workingMessages, usage: cumulativeUsage }; return { reason: "agent_done", messages: workingMessages, usage: cumulativeUsage };`
  - In `catch (err)` (agent_error): `yield { type: "agent_error", error, messages: workingMessages, usage: cumulativeUsage }; return { reason: "agent_error", error, messages: workingMessages, usage: cumulativeUsage };`

### `packages/core/src/providers/anthropic-mapper.ts`

- Import `Usage`, `mergeUsage` from `../types/usage.js`
- `InputAccumulator` gains:
  - Private field `private turnUsage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };`
  - `setUsage(u: Usage): void` — stores `this.turnUsage = u`
  - `mergeInUsage(delta: Partial<Usage>): void` — merges delta into `this.turnUsage` via `mergeUsage`
  - `takeUsage(): Usage` — returns `this.turnUsage`
- `translateStreamEvent`:
  - `case "message_start"`: read `message.usage` fields, call `accumulator.setUsage(initialUsage)` where `initialUsage = { inputTokens: ..., outputTokens: 0, cacheReadTokens: ..., ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}) }`.
  - `case "message_delta"`: read `usage.output_tokens`, `usage.cache_read_input_tokens`; call `accumulator.mergeInUsage({ outputTokens: ..., cacheReadTokens: ... })`.
  - `case "message_stop"`: include `usage: accumulator.takeUsage()` in the emitted event: `return [{ type: "message_stop", stopReason: accumulator.takeStopReason(), usage: accumulator.takeUsage() }];`

**Anthropic field extraction guards:**
- `message_start.message.usage.input_tokens`: read as `asNumber(usage.input_tokens)` — safe (non-null in SDK).
- `message_start.message.usage.cache_creation_input_tokens`: `const cw = asNullableNumber(usage.cache_creation_input_tokens); if (cw != null && cw > 0) initialUsage.cacheWriteTokens = cw;`
- `message_start.message.usage.cache_read_input_tokens`: `asNullableNumber(usage.cache_read_input_tokens) ?? 0`
- `message_delta.usage.output_tokens`: `asNumber(delta_usage.output_tokens)`
- `message_delta.usage.cache_read_input_tokens`: `asNullableNumber(delta_usage.cache_read_input_tokens) ?? 0`

Add `function asNullableNumber(value: unknown): number | null { return typeof value === "number" ? value : null; }` to the mapper's local type-guard utilities.

### `packages/core/src/providers/openai-mapper.ts`

- Import `Usage` from `../types/usage.js`
- `OpenAIChatCompletionParams`: add `stream_options: { include_usage: true }` (non-optional, literal type)
- `mapRequest`: add `stream_options: { include_usage: true }` to the returned object (unconditionally)
- `ToolCallAccumulator`:
  - Gains `private chunkUsage: Usage | undefined`
  - Gains `setUsage(u: Usage): void` — `this.chunkUsage = u`
  - `flush()`: include `...(this.chunkUsage !== undefined ? { usage: this.chunkUsage } : {})` in the emitted `message_stop` event
- `translateChunk`:
  - **Restructure** to check `chunk.usage` before the `choices.length === 0` early-return:
    ```typescript
    export function translateChunk(chunk: unknown, accumulator: ToolCallAccumulator): ProviderEvent[] {
      if (!isRecord(chunk)) return [];
      
      // Capture usage from the final usage-only chunk (choices: [], usage: {...}).
      // This must happen BEFORE the choices.length === 0 return guard.
      if (isRecord(chunk.usage) && chunk.usage != null) {
        const u = chunk.usage;
        const ptDetails = isRecord(u.prompt_tokens_details) ? u.prompt_tokens_details : undefined;
        accumulator.setUsage({
          inputTokens: asNumber(u.prompt_tokens),
          outputTokens: asNumber(u.completion_tokens),
          cacheReadTokens: ptDetails ? (asNumber(ptDetails.cached_tokens) ?? 0) : 0,
        });
      }
      
      const choices = chunk.choices;
      if (!Array.isArray(choices) || choices.length === 0) return [];
      // ... rest of existing logic unchanged ...
    }
    ```

### `packages/core/src/index.ts`

- Add export: `export type { Usage } from "./types/usage.js";`
- Add exports: `export { EMPTY_USAGE, mergeUsage, accumulateUsage } from "./types/usage.js";`

---

## 10. Edge cases

- **OpenAI stream interrupted before usage chunk:** `ToolCallAccumulator.chunkUsage` remains `undefined`. `flush()` emits `message_stop` with no `usage` field (optional, absent). The loop's `message_stop` branch finds `event.usage === undefined` and does not update `cumulativeUsage` for that turn. The terminal event carries whatever was accumulated before that turn. This is correct — partial usage, not crashed.

- **Anthropic `cache_creation_input_tokens` null on non-cached runs:** The `?? 0` guards and `> 0` checks in `mergeUsage` handle this correctly. `cacheWriteTokens` is not set on the `Usage` object when the value is `null` or `0`.

- **Both `message_start` and `message_delta` carry cache fields (verification addendum note 3):** The implementation reads `cacheReadTokens` from `message_delta` (the final/authoritative value) and `cacheWriteTokens` from `message_start` (the initial value, which reflects prompt-caching decisions made at request time). `mergeUsage`'s `> 0` guard ensures neither overwrites the other's valid value.

- **`message_delta.input_tokens` is `number | null` (verification addendum note 4):** We do NOT read `input_tokens` from `message_delta`. It is read only from `message_start` where it is non-nullable. `mergeUsage` with `b.inputTokens = 0` (from the delta usage object we construct) will not overwrite the real value from `message_start` due to the `> 0` guard.

- **Multi-turn accumulation:** Each provider call (`provider.stream()`) produces one `message_stop` event with a per-turn `Usage`. The loop accumulates via `accumulateUsage`. On a 3-turn run, `cumulativeUsage` at the terminal event is the sum of turn 1 + turn 2 + turn 3 usage. This is correct and mirrors the Claude Code reference behavior.

- **Pre-aborted signal with no prior messages:** `options.messages` may be `undefined`. The pre-flight guard uses `options.messages ?? []` for the empty messages array in `agent_error`.

- **AbortSignal.any with a single source (no external signal):** The `options.signal !== undefined` guard means `AbortSignal.any` is only called when an external signal is provided. When absent, `abortCtrl.signal` is used directly. This avoids the minor overhead of composing a single-element signal array.

- **`AbortSignal.any` and `exactOptionalPropertyTypes`:** The guard `options.signal !== undefined` (not `options.signal`) is the correct narrowing under `exactOptionalPropertyTypes`. After the guard, `options.signal` is known to be `AbortSignal` (not `AbortSignal | undefined`).

---

## 11. Risks

- **Risk: `agent_done`/`max_turns_exceeded`/`agent_error` shape change breaks existing tests.**
  - **Mitigation:** The 196 existing tests use `MockProvider` and assert on terminal events. Tests that use deep-equality assertions on terminal events (e.g., `expect(event).toStrictEqual({ type: "agent_done", messages: [...] })`) will fail because the new `usage` field is missing from the expected object. The planner must scan all terminal-event assertions in `agent.test.ts`, `loop.test.ts`, and `agent-tooling-integration.test.ts` and add `usage: expect.any(Object)` or `usage: EMPTY_USAGE` to each. The `MockProvider` does not emit `message_stop` events with usage today — the loop will receive `undefined` for `event.usage` on `message_stop` and accumulate nothing, leaving `cumulativeUsage = { ...EMPTY_USAGE }`. All existing terminal events in tests will carry `EMPTY_USAGE`.

- **Risk: `openai-mapper.test.ts` `mapRequest` assertions may fail on `stream_options`.**
  - **Mitigation:** Review the `mapRequest` tests. Currently none assert the absence of `stream_options`, but any test that checks the exact keys on the returned object (e.g., via `Object.keys`) will fail. The planner should audit and update these tests. Adding an assertion `expect(params.stream_options).toEqual({ include_usage: true })` is the correct fix.

- **Risk: `translateChunk` restructuring breaks the existing "include_usage chunk produces zero events" test.**
  - **Mitigation:** That test (`openai-mapper.test.ts:629-631`) asserts `translateChunk(usageChunk, new ToolCallAccumulator()) === []`. With the restructured code, `translateChunk` will still return `[]` for a `{ choices: [], usage: {...} }` chunk — but it will now also call `accumulator.setUsage(...)` as a side effect. The test's `toEqual([])` assertion on the return value is still correct. However, if the test uses a fresh `new ToolCallAccumulator()` and does not verify accumulator state, it passes. If the test verifies the accumulator has no usage after calling `translateChunk`, it will need updating. Review and update as needed.

- **Risk: `EMPTY_USAGE` mutation (defensive coding).**
  - **Mitigation:** `EMPTY_USAGE` is `Object.freeze()`'d. Any attempt to mutate it throws in strict mode. The loop uses `{ ...EMPTY_USAGE }` if a mutable working copy is ever needed (see `cumulativeUsage` initialization: use `{ ...EMPTY_USAGE }` or literal `{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }` for the mutable accumulator, not `EMPTY_USAGE` directly since `accumulateUsage` returns a new object anyway and we initialize with a literal).

- **Risk: Anthropic `message_start` event shape change in future SDK update.**
  - **Mitigation:** The mapper uses runtime type narrowing (`isRecord`, `asNumber`) rather than SDK types directly, so it will degrade gracefully (yield zeros) if the shape changes. The same defensive pattern already protects the existing `message_delta` stop_reason capture.

- **Risk: OpenAI usage chunk comes after `accumulator.flush()` is called.**
  - **Mitigation:** Per the OpenAI API, the usage chunk is the last chunk before `[DONE]`. The `for await` loop in `openai.ts` exhausts the stream before calling `accumulator.flush()`. So usage is always captured (if present) before `flush()`. The `translateChunk` restructuring handles this correctly.

- **Risk: `AbortSignal.any` typing breaks if the TypeScript config changes.**
  - **Mitigation:** Document the invariant: `"DOM"` must NOT be added to `tsconfig.base.json`'s `lib` array (see decisions.md). Adding `DOM` would switch the `AbortSignal` source from `@types/node` to `lib.dom` — while `AbortSignal.any` also exists in lib.dom, any type incompatibility between the two would become a compile error. The invariant is now decision-logged.

---

## 12. Success criteria

**Functional:**

- [ ] `agent.run(prompt, { signal: ctrl.signal })` accepts an external `AbortSignal` without compile error.
- [ ] Calling `ctrl.abort()` during an in-flight `run()` cancels the provider stream and yields `agent_error` with partial accumulated usage.
- [ ] Passing an already-aborted signal to `run()` yields `agent_error` immediately with `usage: EMPTY_USAGE`, before `buildEnvContext` runs.
- [ ] `agent_done` events carry `usage` with accurate `inputTokens` and `outputTokens` for both Anthropic and OpenAI providers.
- [ ] `agent_error` events carry `usage` with whatever was accumulated before the error.
- [ ] `max_turns_exceeded` events carry cumulative `usage` across all turns up to the cap.
- [ ] `turn_complete` events carry `usage` for the completed turn.
- [ ] `Terminal.usage` is the field-wise sum of all per-turn usages for the run.
- [ ] OpenAI requests include `stream_options: { include_usage: true }`.
- [ ] `mergeUsage` and `accumulateUsage` are pure (do not mutate inputs; return new objects).
- [ ] All 196 existing tests continue to pass after updating terminal-event assertions to include `usage: EMPTY_USAGE` (since `MockProvider` emits no usage).
- [ ] The normalized `Usage` type is exported from `tiny-agentic`.

**Non-functional:**

- [ ] `AbortSignal.any` compiles without error under `pnpm -r typecheck` with the current `tsconfig` (no `DOM` lib).
- [ ] Adding `signal?: AbortSignal` to `RunOptions` does not introduce any compile error in existing call sites (it is an optional field).
- [ ] The `usage` accumulation in `agentLoop` adds no observable latency to the main streaming path (it is pure arithmetic on small integers).
- [ ] `EMPTY_USAGE` is frozen and throws on mutation attempt in strict mode.
- [ ] `cacheWriteTokens` is absent (not `undefined`) on `Usage` objects produced from OpenAI responses.

---

## 13. Test strategy notes (for planner and implementer)

The test strategy is organized by sub-feature. Each group should be an isolated test file or a well-labeled describe block in an existing file.

### `types/usage.ts` — unit tests (new `usage.test.ts`)

- `EMPTY_USAGE` is frozen (throws on mutation).
- `mergeUsage`: zero guard — a zero in `b` does not overwrite a non-zero in `a`.
- `mergeUsage`: non-zero in `b` overwrites `a`.
- `mergeUsage`: `cacheWriteTokens` optional handling — `a` has it, `b` does not → result has it; `b` has it and `> 0` → overwrites; both absent → absent.
- `accumulateUsage`: simple field-wise sum.
- `accumulateUsage`: `cacheWriteTokens` present on both → summed; present on one → summed from zero; absent on both → absent.
- Both helpers return new objects (referential inequality with inputs).

### `agent.ts` — AbortSignal tests (extend `agent.test.ts`)

- Mock signal already aborted → `agent_error` as first event, no `buildEnvContext` call (verify by asserting no `MockProvider.stream` was called).
- Mock signal aborted mid-run → `agent_error` emitted; partial usage present.
- No signal → run completes normally; `agent_done` emitted.
- `AbortSignal.any` composition: pass a `TimeoutSignal` (via `AbortSignal.timeout(Nms)`) and verify it aborts the run within time.
- Existing tests: terminal events now need `usage: expect.objectContaining({ inputTokens: 0 })` or similar (since MockProvider emits no usage → EMPTY_USAGE).

### `anthropic-mapper.ts` — usage capture tests (extend `anthropic-mapper.test.ts`)

- `translateStreamEvent` with a `message_start` event carrying usage fields → `InputAccumulator.takeUsage()` returns correct `inputTokens`, `cacheWriteTokens`.
- `translateStreamEvent` with `message_delta` carrying output tokens and cache-read tokens → `mergeUsage` applied correctly.
- `message_stop` emitted event includes `usage` matching accumulated values.
- `cache_creation_input_tokens: null` → `cacheWriteTokens` absent from result.
- `cache_read_input_tokens: null` on both events → `cacheReadTokens: 0`.
- Multiple turns through the accumulator → each `takeUsage()` returns only the current turn (accumulator resets on `takeUsage` or each turn's `setUsage`). Note: `InputAccumulator` is one-per-stream-call, so this is tested via multiple accumulator instances.

### `openai-mapper.ts` — usage capture + request shape tests (extend `openai-mapper.test.ts`)

- `mapRequest` includes `stream_options: { include_usage: true }` (new assertion on existing `mapRequest` tests).
- `translateChunk` with a `{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }` chunk → `accumulator.chunkUsage` is set; return value is `[]`.
- `translateChunk` with `usage: null` (non-final chunk) → accumulator not updated.
- `flush()` emits `message_stop` with `usage` matching the captured chunk usage.
- `flush()` emits `message_stop` with no `usage` field when no usage chunk was received (aborted stream).
- `prompt_tokens_details.cached_tokens` → `cacheReadTokens` mapped correctly; absent → `cacheReadTokens: 0`.
- End-to-end via `run()` helper: chunks including a final usage chunk → `message_stop` has correct `usage`.

### `loop.ts` — accumulation tests (extend `loop.test.ts`)

- `MockProvider` emitting `message_stop` with usage → `agent_done` carries that usage.
- Multi-turn: two turns, each with distinct usage → `agent_done.usage` is the field-wise sum.
- `max_turns_exceeded` carries cumulative usage from all turns completed before the cap.
- `agent_error` carries cumulative usage from turns completed before the error.
- `turn_complete` carries the per-turn usage (not cumulative).
- `MockProvider` emitting `message_stop` without usage → `cumulativeUsage` unchanged; terminal events carry `EMPTY_USAGE`.

### AbortSignal composition (integration)

- `AbortSignal.any` compiles — verify via `pnpm typecheck` (existing CI coverage).
- Pre-aborted: construct `AbortSignal.abort()` → pass to `run()` → first event is `agent_error`.
- Mid-run abort: use a real `AbortController` aborted during the first `provider.stream()` call via a mock provider that yields one event then awaits forever — abort from outside → `agent_error`.

---

## 14. Deferred items

- **`buildEnvContext` signal threading** — the pre-flight guard handles the already-aborted case; a signal abort during `buildEnvContext` execution is not interceptable by this feature. Deferred as a low-impact edge case (env context build is fast; mid-build abort surfaces as an SDK error anyway at the next `provider.stream` call).
- **Per-tool usage attribution** — knowing which tokens were spent on which tool's response is not addressed. Requires either per-tool turn tracking or a provider capability not present in both SDKs uniformly. Deferred.
- **OpenAI `prompt_tokens_details` full field set** (audio tokens, etc.) — only `cached_tokens` is mapped. Other detail fields are not relevant to the normalized usage shape. Deferred.
- **Usage logging via `Logger`** — the `LogEntry` union has a comment "extend in M2 when cost/token tracking is added." A `usage_captured` log entry could be added to `LogEntry` to give the optional logger visibility into per-turn usage. Not part of this feature's scope; the existing `request_sent` log gives the outbound view.

---

*End of spec.*

# Decision Log

> Record significant decisions with rationale. Each entry should be self-contained — a future reader should understand both what was decided and why without needing additional context.

## Format

```
## YYYY-MM-DD — [Decision title]

**Phase:** [phase name]

**Decision:** [What was decided]

**Rationale:** [Why this option was chosen — what trade-offs were considered, what alternatives were rejected and why]

**Consequences:** [What this enables, constrains, or commits the project to]
```

---

## 2026-06-30 — Token usage surface = Option A (mirror Claude Code)

**Phase:** research (user directive; binding input to engineering)

**Decision:** Surface **cumulative** token usage on the terminal `AgentEvent`s (`agent_done` / `max_turns_exceeded` / `agent_error`) **and** on the `Terminal` return value — a `usage` field carrying a normalized cross-provider shape `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens? }` (`cacheWriteTokens` optional — Anthropic-only). Adopt the reference's two pure-helper pattern: a per-event merge (with a `> 0` guard) + a per-turn `accumulateUsage` into the run total, plus an `EMPTY_USAGE` zero constant. Optionally also attach per-turn usage to the existing `turn_complete` event (architect's call) for live metering.

**Rationale:** Validated against the decompiled Claude Code v2.1.88 reference (see `research/2026-06-30-claude-code-usage-reference.md`). Claude Code emits cumulative usage exactly this way (`result.usage = this.totalUsage`) and exposes the child's cumulative total as a **return value** to the parent (forked-agent `ForkedAgentResult.totalUsage`) — which maps cleanly onto our stateless core: a child `Agent.run()` exposes `Terminal.usage`, and the future sub-agent `Task` tool reads and rolls it up explicitly (no global state). Rejected: a dedicated `usage_update` event (Claude Code doesn't use one; keeps our event union lean) and `Terminal`-only (terminal events should carry it too for `for await` consumers). Normalized shape rejected Claude Code's deeply Anthropic-specific `NonNullableUsage` (cache tiers, server_tool_use, service_tier) since we are multi-provider.

**Consequences:** `Terminal.usage` becomes the roll-up seam the sub-agent Task tool (roadmap #4) depends on — this is why `core-run-controls` precedes it. The architect must define the normalized `Usage` type, the merge/accumulate helpers, where each provider mapper reads usage (Anthropic: `message_start` + `message_delta`; OpenAI: final chunk via `stream_options:{include_usage:true}`, `cached_tokens` only, no cache-write), and how usage threads from `ProviderEvent` → `agentLoop` → terminal events. Additive only — must not break the existing 196 tests.

---

## 2026-06-30 — AbortSignal.any — drop-in confirmed; no fallback needed

**Phase:** engineering

**Decision:** Use `AbortSignal.any([options.signal, abortCtrl.signal])` directly in `agent.ts:run()`. No manual-listener fallback is implemented.

**Rationale:** The verification addendum proved via a real `tsc --noEmit` (exit 0 on a probe in `packages/core/src/`) that `AbortSignal.any` type-checks under the project's `lib: ["ES2022"]` + `types: ["node"]` config. The static `any()` method is declared in `@types/node`'s `web-globals/abortcontroller.d.ts` and resolves because DOM lib is excluded. Node 22 availability is confirmed (added in Node 18.17.0).

**Consequences:** The no-DOM-lib invariant is now load-bearing for this typing. `"DOM"` must NOT be added to `tsconfig.base.json`'s `lib` array — adding it would switch the `AbortSignal` source from `@types/node` to `lib.dom` and could introduce type incompatibilities. This constraint is documented in the engineering spec.

---

## 2026-06-30 — Pre-aborted external signal → explicit pre-flight guard in run()

**Phase:** engineering

**Decision:** Add an explicit `signal.aborted` check at the top of `agent.ts:run()`, before any async work (before `buildEnvContext`, before `agentLoop`). If the composite signal is already aborted, yield `{ type: "agent_error", ..., usage: EMPTY_USAGE }` and return immediately.

**Rationale:** Relying on SDK behavior for a pre-aborted signal is provider-dependent. An explicit guard provides a consistent, fast, provider-independent outcome. It also prevents `buildEnvContext` (git status, file reads) from running on a signal that is already dead. The `agent_error` reason is correct — no new terminal reason (`"agent_aborted"`) is introduced; widening the `Terminal` union for this case would require every existing consumer's switch to handle it, which is not worth the cost.

**Consequences:** The guard uses `options.messages ?? []` for the empty messages in the early `agent_error` yield. The pre-flight error does NOT include the full working messages (the env-context build has not happened), only the caller-supplied prior messages (if any).

---

## 2026-06-30 — Per-turn usage on turn_complete (optional field)

**Phase:** engineering

**Decision:** Add `usage?: Usage` (optional) to the `turn_complete` AgentEvent. The field is present when the provider emitted usage for that turn (both providers do so in the happy path). It carries the turn's usage, not the cumulative run total.

**Rationale:** The framework wraps raw provider streams and does not expose `ProviderEvent`s to consumers. A consumer who needs per-turn token counts for live metering (context-budget display, per-turn cost attribution) has no other mechanism. `turn_complete` is the natural "this turn is done" boundary. The field is optional because: (a) a mid-run-error path (`agent_error`) bypasses `turn_complete` entirely, and (b) future providers might not emit usage. Cumulative usage on terminal events remains the primary surface.

**Consequences:** The `turn_complete` shape change is additive (optional field). No existing consumer breaks. The loop uses the conditional spread pattern (`exactOptionalPropertyTypes` compliance) when constructing `turn_complete`.

---

## 2026-06-30 — Usage threading: extend message_stop ProviderEvent (not new variant)

**Phase:** engineering

**Decision:** The `message_stop` ProviderEvent variant gains `usage?: Usage` (optional). No new `usage` ProviderEvent variant is added.

**Rationale:** `message_stop` is already the once-per-turn event marking the end of a model call. The loop already processes it (the "consumed but not yielded" branch). Extending it with optional `usage` is strictly additive — no new discriminant, no new case in switch statements, backward-compatible (existing mock providers that emit `{ type: "message_stop", stopReason: "end_turn" }` remain valid). A separate `usage` ProviderEvent would require providers to emit it separately and the loop to separately collect it — more code, same information.

**Consequences:** Both `InputAccumulator` (Anthropic) and `ToolCallAccumulator` (OpenAI) carry a per-turn usage and include it in their `message_stop` emission. The loop reads `event.usage` from the `message_stop` branch and accumulates into `cumulativeUsage`.

---

## 2026-06-30 — Missing usage (aborted/error path) → EMPTY_USAGE; terminal usage always non-optional

**Phase:** engineering

**Decision:** Terminal `AgentEvent` variants (`agent_done`, `max_turns_exceeded`, `agent_error`) and `Terminal` return variants all carry `usage: Usage` (non-optional). When usage was not captured (OpenAI abort, pre-flight abort), `EMPTY_USAGE` is used. The `turn_complete.usage` is optional (`usage?: Usage`) because `turn_complete` may not be emitted on error paths.

**Rationale:** A non-optional `usage` on terminal events makes the parent Task tool roll-up simple — no null-check before `accumulateUsage`. The cost of emitting `EMPTY_USAGE` for aborted runs is negligible. Zeros are distinguishable from a non-run (a run that produced no tokens would be unusual). The alternative (`usage?: Usage` on terminal events) would require every Task tool accumulation to guard for undefined.

**Consequences:** `EMPTY_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })` — `cacheWriteTokens` absent (not `undefined`, per `exactOptionalPropertyTypes`). All existing tests that assert on terminal events will need `usage: EMPTY_USAGE` (or `usage: expect.objectContaining({...})`) added to their expectations, since `MockProvider` emits no usage.

---

## 2026-06-30 — cacheWriteTokens optional/absent on OpenAI (never zero)

**Phase:** engineering

**Decision:** The `cacheWriteTokens` field on `Usage` is `?: number` (optional). OpenAI-sourced `Usage` objects never set this field. It is absent (not `0`) when the provider has no cache-write concept.

**Rationale:** Under `exactOptionalPropertyTypes: true`, `cacheWriteTokens?: number` means the field is either a number or not present. Emitting `cacheWriteTokens: 0` for OpenAI would be misleading — zero means "zero cache writes occurred," while absence means "this provider has no cache-write pricing concept." The `accumulateUsage` helper uses `?? 0` when summing, so a run that mixes Anthropic and OpenAI turns (via a future multi-provider feature) would correctly accumulate only the Anthropic cache-write costs.

**Consequences:** `mergeUsage` and `accumulateUsage` both use conditional spread to propagate `cacheWriteTokens` only when at least one operand has it set. The field is set only on Anthropic-sourced `Usage` objects where `cache_creation_input_tokens > 0`.

---

## 2026-06-30 — Usage helpers live in types/usage.ts (new file, no project imports)

**Phase:** engineering

**Decision:** The `Usage` type, `EMPTY_USAGE`, `mergeUsage`, and `accumulateUsage` live in a new `packages/core/src/types/usage.ts` file with zero project-internal imports.

**Rationale:** Both `types/provider.ts` and `types/events.ts` need `Usage`. Putting it in either one would require the other to import from it — a confusing peer-type import. A dedicated `types/usage.ts` with no internal dependencies is the clean solution (it is imported by both), follows the existing pattern (`types/messages.ts`, `types/platform.ts`), and avoids any import cycle risk. All four exports are also re-exported from `index.ts`.

**Consequences:** New file `packages/core/src/types/usage.ts`. Import pattern: `import type { Usage } from "../types/usage.js"` (or `import { EMPTY_USAGE, mergeUsage, accumulateUsage } from "../types/usage.js"`). `types/provider.ts` and `types/events.ts` each gain one import from `./usage.js`.

---

## 2026-06-30 — stream_options.include_usage always-on for OpenAI

**Phase:** engineering

**Decision:** `stream_options: { include_usage: true }` is unconditionally included in every OpenAI request. There is no configuration option to disable it.

**Rationale:** Usage is foundational, not opt-in. Always-on is simpler (no conditional logic in `mapRequest`, no extra `OpenAIProvider` option), consistent (all runs produce usage data or EMPTY_USAGE fallback), and cheap (a few bytes of overhead). No consumer of `tiny-agentic` would want usage disabled once available.

**Consequences:** `OpenAIChatCompletionParams.stream_options` becomes a required field with literal type `{ include_usage: true }`. The `mapRequest` return object always includes it. Existing `openai-mapper.test.ts` tests that call `mapRequest` should be updated to assert `params.stream_options` equals `{ include_usage: true }`. Any test asserting the exact key set of the returned object will need updating.

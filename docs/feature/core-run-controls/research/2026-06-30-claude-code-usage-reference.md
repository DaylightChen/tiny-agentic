# Reference Findings — How Claude Code (v2.1.88) Handles Token Usage

> Supplementary research note. Source: decompiled reference at `claude-code-source-code/src/`. Captured 2026-06-30 to inform the `usage surface` decision (research open question #3) and the future sub-agent Task tool (roadmap #4). The reference is Anthropic-only; we are multi-provider, so adopt the *structure*, not the Anthropic-specific shape.

## 1. Read off the stream (3 events)
`src/services/api/claude.ts`:
- `message_start` (~L1980): carries `input_tokens` (+ initial cache fields).
- `message_delta` (~L2213): carries final `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`. Cost is computed here.
- `message_stop` (~L2295): end signal; the completed message's usage is accumulated into the running total.

## 2. Two pure helpers (the pattern to mirror)
- **`updateUsage(usage, partUsage)`** (`claude.ts` ~L2924) — merges a partial usage from one event into the in-progress message usage. Uses a `> 0` guard so a later `message_delta` carrying zeros does not clobber real values. Returns a new object (immutable).
- **`accumulateUsage(total, messageUsage)`** (`claude.ts` ~L2993) — field-wise sums a *completed* message's usage into the session total. Immutable.
- Zero/empty factory: **`EMPTY_USAGE`** (`src/services/api/emptyUsage.ts` L8) — an immutable constant cloned with `{ ...EMPTY_USAGE }` when a mutable copy is needed (notably in forked agents).

## 3. Where usage surfaces to the consumer
- **Per-turn:** NOT a dedicated event — per-turn usage rides on the raw streamed `message_delta` events (visible to SDK consumers that opt into partial messages). The QueryEngine tracks `currentMessageUsage` per turn and folds it into `this.totalUsage` on `message_stop` (`src/QueryEngine.ts` ~L657–816).
- **Per-session:** emitted **once at the end** in the terminal `result` message: `usage: this.totalUsage` (cumulative) plus `modelUsage` and `total_cost_usd` (`QueryEngine.ts` ~L1146).

→ **This is exactly the "cumulative total on the terminal value" model** (our Option A), with raw per-turn data available on the stream for those who want it.

## 4. Aggregation / cost
`updateUsage` (within a message) → `accumulateUsage` (message into session total) → `addToTotalSessionCost(cost, usage, model)` persists per-model + session cost to global state (`src/cost-tracker.ts` ~L278; `src/bootstrap/state.ts`). Cost = `calculateUSDCost(model, usage)`.

## 5. Sub-agent (Task / forked agent) roll-up — the key pattern
`src/utils/forkedAgent.ts` (`runForkedAgentQuery`, ~L501–626):
- The child accumulates its **own** `totalUsage` (starting from `{ ...EMPTY_USAGE }`, `accumulateUsage` per turn).
- It **returns** that as a discrete value: `ForkedAgentResult.totalUsage` (type at ~L115).
- The parent receives the child's total **as a return value** — it is logged separately (`tengu_fork_agent_query`) and is available to the caller; it is **not** silently merged into global session state by the fork runner.

→ For our **stateless** core this is the clean pattern: a child `Agent.run()` exposes its cumulative `usage` on its `Terminal`, and the parent Task tool reads `Terminal.usage` and accumulates explicitly. No hidden global state.

## 6. Multi-provider caveat
`NonNullableUsage` is **deeply Anthropic-specific**: `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_{1h,5m}_input_tokens`, `server_tool_use.{web_search,web_fetch}_requests`, `service_tier`, `inference_geo`, `speed`. Claude Code makes **zero** attempt at provider abstraction. We must normalize to a small cross-provider shape and treat Anthropic-only fields (cache-write / ephemeral tiers) as optional.

## Implications for this feature
1. **Surface = Option A** (cumulative `usage` on the terminal `AgentEvent`s + `Terminal`), validated by the reference's `result.usage = this.totalUsage`.
2. **Adopt the two-helper pattern**: a `mergeUsage`/`updateUsage` (intra-message, `>0` guard) + `accumulateUsage` (per-turn → run total), both pure/immutable, with an `EMPTY_USAGE` constant.
3. **Normalize the shape** to a small union both providers can fill: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens?` (Anthropic-only, optional). Don't import Anthropic's ephemeral/server-tool fields into core.
4. **Task-tool ready**: child cumulative usage on `Terminal` is the roll-up seam — parent accumulates explicitly (return-value pattern, not global state). This is why this feature precedes the Task tool.
5. **Optional nicety** (beyond the reference's dedicated-event stance): we *could* also attach per-turn usage to our existing `turn_complete` event for live metering, since we don't otherwise expose raw provider events. Architect to weigh vs. keeping the union lean.

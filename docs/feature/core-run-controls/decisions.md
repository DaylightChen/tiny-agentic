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

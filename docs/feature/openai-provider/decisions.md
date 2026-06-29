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

## 2026-06-29 — Target the OpenAI Chat Completions API (not the Responses API)

**Phase:** research

**Decision:** The OpenAI provider targets the **Chat Completions API** (`client.chat.completions.create({ stream: true })`), not the newer Responses API.

**Rationale:** The M2 goal is to validate the multi-provider `Provider` seam at the lowest risk. Chat Completions is a near-mechanical mirror of the existing `AnthropicProvider`, is stateless (matching the engine's stateless loop), and has fixture-testable streaming. The Responses API is future-aligned for OpenAI but is a larger, less-parallel build whose marquee features (server-side conversation state, hosted/built-in tools) are inert in tiny-agentic's stateless, framework-owned tool loop. User confirmed Chat Completions.

**Consequences:** The mapper renames `max_tokens` → `max_completion_tokens` to support o-series/GPT-5 reasoning models (classic models accept the alias, so one field name is safe for all). Streaming accumulation keys on `tool_calls[].index` and synthesizes the single `message_stop` at stream end (no per-block stop event). If the Responses API is wanted later, it would be a separate provider, not a refactor of this one.


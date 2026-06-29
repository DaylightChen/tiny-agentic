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

---

## 2026-06-29 — Tool-result errors ride in the content string (no `is_error` flag)

**Phase:** research

**Decision:** When mapping a framework `tool_result` block to an OpenAI `role:"tool"` message, **drop the `is_error` flag** and let the error information ride in the message `content` string as-is. Do **not** synthesize an `"Error: "` prefix in the mapper.

**Rationale:** OpenAI's Chat Completions API has no error flag on `role:"tool"` messages — the only channel is the content string. The framework's loop already serializes tool errors into the content it produces, so the error text reaches the model intact. Adding a mapper-side prefix would be a lossy, provider-specific transformation that diverges from how the Anthropic path presents the same result. Keeping the mapper a faithful, minimal translator is the project's stated design value.

**Consequences:** The OpenAI mapper does not branch on `is_error`. If a future need arises to make errors more salient to OpenAI models, that belongs upstream (in how the loop serializes the tool result), not in the mapper. A mapper test asserts `is_error` is dropped without altering content.

---

## 2026-06-29 — Default `maxRetries` is 3 (match the framework's Anthropic default)

**Phase:** research

**Decision:** `OpenAIProvider` defaults `maxRetries` to **3**, matching the existing `AnthropicProvider` default, rather than the OpenAI SDK's native default of 2.

**Rationale:** Consistency across providers is more valuable than matching each vendor SDK's idiosyncratic default. A developer who sets no `maxRetries` should get the same resilience regardless of which provider they pick. The framework already standardizes on 3 for Anthropic; the OpenAI provider should not silently behave differently.

**Consequences:** The provider passes `maxRetries` (default 3) to `new OpenAI({ maxRetries })`, which owns retry per the "Provider contract owns retry" decision. The default is documented in the provider options. If a vendor-specific default is ever wanted, it remains overridable per-instance.

---

## 2026-06-29 — Expose `baseURL`; Azure `AzureOpenAI` stays out of scope

**Phase:** research

**Decision:** `OpenAIProviderOptions` exposes an optional **`baseURL`**, mirroring `AnthropicProviderOptions.baseURL`, and threads it into `new OpenAI({ baseURL })`. The dedicated Azure `AzureOpenAI` client class is **out of scope** for this feature.

**Rationale:** A plain `baseURL` is cheap, mirrors the Anthropic provider, and makes the same `OpenAIProvider` usable against OpenAI-compatible endpoints (local servers, proxies, gateways speaking the Chat Completions wire format) at no extra design cost. Azure OpenAI uses a distinct client/endpoint shape (`endpoint` + `apiVersion` + `deployment`) — supporting it is a separate body of work, and Bedrock/Vertex/Foundry are already explicitly deferred per the project `docs/project/decisions.md`.

**Consequences:** Generic OpenAI-compatible backends work via `baseURL` with no further code. Azure-specific support, if ever needed, is a future provider/option, not part of this feature.

---

## 2026-06-29 — System prompt uses the `system` role for all models (first cut)

**Phase:** engineering

**Decision:** The mapper emits the framework `systemPrompt` string as a leading message with role **`system`** for all OpenAI models, including reasoning (o-series / GPT-5) models. It does not branch to the `developer` role.

**Rationale:** OpenAI's reasoning models still accept the `system` role (it is treated equivalently to `developer` for compatibility), so a single code path is correct for all models and avoids per-model branching in the mapper. Keeping one path is simpler to test and matches the project's "minimal faithful translator" value. If a future model requires `developer`, the branch is a localized, non-breaking addition.

**Consequences:** No model-detection logic in the mapper for role selection. A mapper test asserts the leading message is `{ role: "system", content: <systemPrompt> }`.

---

## 2026-06-29 — OpenAI `maxTokens` default is 32000 (mirrors Anthropic)

**Phase:** engineering

**Decision:** When `ProviderRequest.maxTokens` is unset, `OpenAIProvider` defaults the request to **32000**, mapped to `max_completion_tokens`. This mirrors the framework's Anthropic default.

**Rationale:** Cross-provider consistency: a developer who sets no `maxTokens` gets the same ceiling regardless of provider. The value is always overridable per request via `ProviderRequest.maxTokens`. Some OpenAI models have lower output ceilings, but the SDK/API surfaces an error if the value exceeds a model's limit, and the caller can lower it — a too-high default is not silently harmful and keeps behavior predictable across providers.

**Consequences:** `OpenAIProvider` sends `max_completion_tokens: maxTokens ?? 32000`. Documented in the provider options. If a model rejects 32000, the developer lowers `maxTokens` for that call.


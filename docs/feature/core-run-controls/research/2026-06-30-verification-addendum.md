# Research Verification Addendum

> Max-effort adversarial re-verification of the `core-run-controls` research, run 2026-06-30 by three independent verifier agents that checked every load-bearing claim against the **actual repo code** and the **real SDK `.d.ts` files in node_modules** (not from memory). Verdict: **research is sound — 0 claims refuted.** The notes below are precision corrections/additions the engineering phase MUST honor.

## Verdict summary

| Cluster | Claims | Result |
|---|---|---|
| External AbortSignal | A1–A4 | **All CONFIRMED** — incl. a real `tsc --noEmit` proof |
| Anthropic usage | N1–N4 | N2/N3/N4 CONFIRMED; N1 PARTIALLY-CORRECT (the *doc* is accurate; see note 2) |
| OpenAI usage | O1–O5 | **All CONFIRMED** against `openai@6.45.0` types |

Installed SDK versions verified: `@anthropic-ai/sdk@0.52.0`, `openai@6.45.0`, `@types/node@22.20.0`.

## Resolved: the research's biggest open question (AbortSignal.any typing)
`AbortSignal.any([...])` **does** type-check under this project's config. Proven by writing a probe into `packages/core/src` and running `npx tsc -p packages/core/tsconfig.json --noEmit` → **exit 0**; a negative-control (`const bad: number = AbortSignal.any([a])`) produced `TS2322`, proving genuine symbol resolution (not silent `any`, not skipped by `skipLibCheck`).
- **Mechanism (engineering note):** the static `any()` is declared in `@types/node`'s `web-globals/abortcontroller.d.ts` (conditional type, fallback branch). It resolves **because `lib` excludes DOM** (`lib: ["ES2022"]`, `types: ["node"]`) — NOT because of `skipLibCheck`. If anyone ever adds `"DOM"` to `lib`, the typedef flips to lib.dom's `AbortSignal` (which also has `any` in current TS, so still fine) — but know the dependency.

## Engineering precision notes (must honor)

### AbortSignal
1. **Drop-in confirmed:** only `agent.ts` (the single `signal: abortCtrl.signal` call site, ~L58) changes — replace with `AbortSignal.any([options.signal, abortCtrl.signal])`. No loop/provider edits; lifetime is sound (both source signals stay reachable; the `finally { abortCtrl.abort() }` still propagates to the composite).
2. **Pre-aborted external signal (open Q2):** the loop has **no** explicit `signal.aborted` pre-check before `provider.stream`. "Already-aborted → `agent_error`" therefore relies on the SDK/`fetch` rejecting on a pre-aborted signal (which fetch-based SDKs do). If you want a guaranteed, provider-independent outcome (or a distinct "aborted" terminal reason), add an explicit `signal.aborted` guard in `run()`/`agentLoop` rather than relying on SDK behavior. This is a design choice to settle, not a bug.

### Anthropic usage (`@anthropic-ai/sdk@0.52.0`)
3. **Cache-field partitioning trap:** both `cache_creation_input_tokens` AND `cache_read_input_tokens` appear on **both** `Usage` (message_start) and `MessageDeltaUsage` (message_delta), each `number | null`. Do NOT design the mapper to pull cache_creation only from `message_start` and cache_read only from `message_delta` — they are not partitioned that way. (The research doc §3c gets this right; an earlier paraphrase did not — trust the doc.)
4. **`input_tokens` nullability differs by event:** `number` (non-null) on `message_start.message.usage`, but `number | null` on `message_delta.usage`. Read `input_tokens` from `message_start` (guaranteed); read `output_tokens` from `message_delta` (non-null there, 0 at start).
5. **Threading point:** attach usage to the existing `message_stop` `ProviderEvent` (the once-per-turn event). Chain: `InputAccumulator` (add `setUsage`/`takeUsage`, mirroring the existing `stopReason` pattern) → `message_stop` variant in `types/provider.ts` + `anthropic-mapper.ts:161` → `loop.ts:~58` (the "`message_stop` is consumed but not yielded" branch) reads `event.usage` and accumulates.

### OpenAI usage (`openai@6.45.0`)
6. **Two-site fix:** capturing usage means (a) sending `stream_options: { include_usage: true }` in the request (`openai.ts` / `mapRequest`), and (b) reading `chunk.usage` in `translateChunk` — which currently **early-returns `[]` at openai-mapper.ts:272 BEFORE touching `chunk.usage`**. The `ToolCallAccumulator` is the right home, but it can't capture what `translateChunk` never reads — both must change.
7. **Null-guard, not undefined-guard:** `usage` is present-but-`null` on every non-final chunk (only the final empty-`choices` chunk has real numbers). Capture logic must guard `usage != null`.
8. **No cache-write field:** `CompletionUsage` has `prompt_tokens` / `completion_tokens` / `total_tokens` / `prompt_tokens_details.cached_tokens` (reads only). There is no cache-creation/write analog → the normalized shape's `cacheWriteTokens` is **optional/absent** for OpenAI.
9. **Usage may be absent on aborted runs (SDK-documented, twice):** usage rides on a single chunk emitted just before `[DONE]`; an aborted/interrupted stream breaks out before it. The normalized `Usage` must tolerate a *missing-usage* outcome (e.g. `usage?` on the terminal event, or a zero/`EMPTY_USAGE` fallback) — a design choice for engineering.

## Net
No claim is refuted; the foundations are solid and now independently verified against real SDK types and a real compile. Engineering can proceed with confidence, honoring notes 1–9.

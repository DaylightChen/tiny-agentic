# 03 — LLM Provider / API / Networking

Files: `src/bridge/`, `src/services/api/`, `src/services/api/claude.ts`,
`src/services/api/client.ts`, `src/services/api/withRetry.ts`, `src/cost-tracker.ts`,
`src/upstreamproxy/`, `src/remote/`, `src/server/`

## Provider model (important caveat for us)

Claude Code does **not** have a generic multi-vendor provider interface. It is
Anthropic-API-shaped throughout, with provider selection only choosing *which Anthropic SDK*
to instantiate (`utils/model/providers.ts:6`):

- **firstParty** (default) — `@anthropic-ai/sdk`, needs `ANTHROPIC_API_KEY`
- **bedrock** — `@anthropic-ai/bedrock-sdk`, AWS creds
- **vertex** — `@anthropic-ai/vertex-sdk`, GCP creds
- **foundry** — `@anthropic-ai/foundry-sdk`, Azure creds

All are cast to the `Anthropic` type (`client.ts:153–298`). There is **no OpenAI support** in
the reference — everything assumes the Anthropic Messages API shape.

> **Design consequence for tiny-agentic:** since we want both Anthropic *and* OpenAI, we
> must build the provider abstraction the reference lacks. Define a canonical internal event
> union and request shape, then write two adapters. The reference gives us the Anthropic side
> in detail; the OpenAI side we design ourselves.

## Request / response shape (Anthropic)

Request (`claude.ts:1`): Anthropic `BetaMessageStreamParams`:
`messages[]`, `model`, `system` (string | blocks), `tools[]`, `max_tokens`, `temperature`,
`thinking`, `tool_choice`, `metadata`, `betas[]`.

Response: a stream of `BetaRawMessageStreamEvent`:
`message_start` (usage, stop_reason) → `content_block_start/delta/stop`
(text / tool_use / thinking) → `message_delta` (final usage, stop_reason) → `message_stop`.

## Streaming pipeline

`claude.ts:1940–2099`:

1. Get client via `getAnthropicClient()`, wrapped in `withRetry()`.
2. `.beta.messages.create({ stream: true }).withResponse()`.
3. Switch on event type and accumulate:
   - `message_start` → init message, capture TTFB, usage
   - `content_block_start` → create empty text/tool_use/thinking block
   - `content_block_delta` → append text / `input_json_delta` (tool args) / thinking
   - `message_stop` → finalize, yield `AssistantMessage`
4. Yields an `AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage>`.
5. **Watchdog**: abort if no chunk for 90s (`STREAM_IDLE_TIMEOUT_MS`).

The canonical internal `StreamEvent` union (text delta, tool_use, stop reason, usage) is the
abstraction seam we want to copy.

## Retries / errors / rate limits

`withRetry.ts:50–257`:
- Exponential backoff, `BASE_DELAY_MS=500`, `DEFAULT_MAX_RETRIES=10`.
- 529 overload limited to 3 retries; 429 retried for foreground queries.
- Streaming 529/timeout → fallback to **non-streaming** with `MAX_NON_STREAMING_TOKENS=64k`.
- Connection errors (ECONNRESET/EPIPE) retried; 401 → refresh creds & retry; abort → throw.

## Cost / token accounting

`cost-tracker.ts`: `updateUsage()` accumulates `BetaUsage`
(input/output/cache_read/cache_creation tokens); `calculateUSDCost()` applies a per-provider
pricing table; per-session cost stored in project config.

## Config

Env-var driven: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `API_TIMEOUT_MS`, provider creds,
plus dynamic beta headers gated by feature flags (sticky-on latches for fast mode, 1M context,
cache editing).

## Minimal essence (build first — for Anthropic + OpenAI)

1. **Provider enum + factory** — pick SDK/client from config. ~50 LOC.
2. **Request mapper** — normalize our internal `{system, messages, tools}` to each API's
   shape. ~100 LOC (the two APIs differ most here: tool schema + message roles).
3. **Stream-event adapter** — translate each provider's stream into our canonical
   `StreamEvent` union (text delta, tool_use, stop). ~150 LOC.
4. **Retry wrapper** — exponential backoff + per-provider error classification. ~100 LOC
   (can start minimal: retry on 429/5xx).
5. **Usage accumulator** — pull tokens/cost out of each provider's response. ~50 LOC.

Defer: Bedrock/Vertex/Foundry, non-streaming fallback, betas/sticky headers, 1M context.

## Citations

- Provider instantiation — client.ts:153–298; utils/model/providers.ts:6
- Stream setup + retry — claude.ts:1777–1856
- Event parsing loop — claude.ts:1940–2099
- Retry logic — withRetry.ts:50–160
- Usage — cost-tracker.ts:1–70

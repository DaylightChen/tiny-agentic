# Task 06 — AnthropicProvider and withRetry

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Implement `packages/core/src/providers/retry.ts` (the generic `withRetry` utility) and `packages/core/src/providers/anthropic.ts` (`AnthropicProvider` class). Write unit tests for `withRetry` in isolation. At the end of this task:

- `withRetry` is a tested, provider-agnostic retry helper with exponential backoff + jitter.
- `AnthropicProvider` compiles, delegates retry to the Anthropic SDK's `maxRetries` option, passes `AbortSignal` to the SDK stream, and fires the logger at the right points.
- `pnpm --filter tiny-agentic typecheck` is clean.

Note: `AnthropicProvider`'s full request/response correctness is validated end-to-end in the integration example (task 10). This task does add a focused **mock-SDK** test (`vi.mock("@anthropic-ai/sdk")`) for the logger hook, which verifies success criterion 7.14 (logger off by default) without a network — see step 3b.

## Context files

- `docs/engineering/2026-06-27-code-architecture.md` — Exact skeletons for `providers/retry.ts` and `providers/anthropic.ts`
- `docs/engineering/2026-06-27-engineering-spec.md` — §5.3 (retry model and `withRetry` design), §5.4 (logger hook: request_sent, retry_attempt, request_failed), §3.12 (AnthropicProvider class signature), §6.8 (400 not retried), §6.12 (401 not retried)
- `docs/decisions.md` — "Provider contract owns retry; SDKs delegate; withRetry is the no-SDK fallback"
- `packages/core/src/types/provider.ts` — `Provider`, `ProviderRequest`, `ProviderEvent`, `Logger`, `LogEntry`
- `packages/core/src/providers/anthropic-mapper.ts` (task 05) — `mapRequest`, `translateStreamEvent`, `InputAccumulator`

## Downstream dependencies

- Task 07 (`loop/loop.ts`) uses `MockProvider` in tests — `AnthropicProvider` is not called in unit tests. But the `Provider` interface type must match; `AnthropicProvider` is the proof that `Provider` is implementable with a real SDK.
- Task 08 (`agent.ts`) does not import `AnthropicProvider` (the provider is injected, not constructed inside the agent). But the logger-off-by-default test in task 08 verifies that `AnthropicProvider` without a logger produces no console output — this is implicitly tested if `AnthropicProvider` does not call `console.log` internally.
- Task 10 (example) constructs `new AnthropicProvider({ apiKey, model })` and passes it to the `Agent`. The constructor must throw a clear error if `apiKey` is missing.
- `withRetry` is exported from `providers/retry.ts` but is NOT wired into `AnthropicProvider` in M1. It is available for any future provider that lacks built-in retry.

## Steps

1. **Create `packages/core/src/providers/retry.ts`** — implement exactly as in the code-architecture doc:
   - Constants: `BASE_DELAY_MS = 500`, `MAX_DELAY_MS = 30_000`.
   - `defaultDelayMs(attempt)` function: `min(500 * 2^attempt + random*500, 30000)`.
   - `withRetry<T>(operation, options)` — the generic retry wrapper:
     - Loops from `attempt = 0` to `options.maxRetries`.
     - On success: returns the result immediately.
     - On error: if `!options.isRetryable(err) || attempt === options.maxRetries`, break.
     - Otherwise: compute delay, call logger with `retry_attempt`, `await setTimeout(delay)`.
     - After loop: call logger with `request_failed`, throw the last error.
   - **No import of `@anthropic-ai/sdk`** — this utility is provider-agnostic. The `isRetryable` callback handles error classification.

2. **Replace the task-01 stub at `packages/core/src/providers/anthropic.ts`** (currently `export {};`) with the full implementation from the code-architecture doc:

   Constructor:
   - Throw `new Error("AnthropicProvider: ANTHROPIC_API_KEY is required")` if `options.apiKey` is falsy.
   - Store `this.maxRetries` (default 3), `this.maxTokens` (**default 32000** — `options.maxTokens ?? 32000`; the Anthropic API requires `max_tokens`, so the provider always resolves a concrete value), `this.logger`, `this.model`.
   - Construct `this.client = new Anthropic({ apiKey: options.apiKey, maxRetries: this.maxRetries, ...(options.baseURL ? { baseURL: options.baseURL } : {}) })`.
   - `exactOptionalPropertyTypes` note: use conditional spread for `baseURL` — do not pass `baseURL: undefined`.

   `stream(request, signal?)`:
   - Call `this.logger?.({ level: "info", event: "request_sent", request })`.
   - Call `mapRequest(request, this.model, this.maxTokens)` to get `params`. Inside `mapRequest`, `max_tokens` resolves as `request.maxTokens ?? this.maxTokens` (per-request override → provider default 32000), so a concrete `max_tokens` is always sent.
   - Create `new InputAccumulator()`.
   - Call `this.client.messages.stream(params, { signal })` — pass the signal as the second argument (options object). Check the Anthropic SDK's `stream()` signature — if it accepts `{ signal }` in the options, use that. If the API changed, adapt accordingly and note the deviation in the completion doc. Note: `mapRequest` sets `stream: true` in `params`; the `messages.stream()` helper implies streaming and its param type may not declare `stream`. This is structurally assignable (extra property on a typed variable, not an object literal, so no excess-property error) and harmless at runtime — but verify the call typechecks. If the SDK rejects the extra field, either drop `stream: true` from `mapRequest` (and have the mapper target `MessageCreateParamsStreaming` only for the `.create()` path) or switch to `this.client.messages.create({ ...params, stream: true })`, which also yields raw stream events. Note whichever you choose in the completion doc.
   - `for await (const event of rawStream)`: call `translateStreamEvent(event, accumulator)`, yield each resulting `ProviderEvent`.
   - Do NOT wrap this in `withRetry` — the SDK's `maxRetries` handles transient errors.

3. **Write a Vitest test file for `withRetry`.** Create `packages/core/src/__tests__/retry.test.ts`:

   Test cases:
   - **Success on first attempt:** operation succeeds immediately → result returned, no delay, no logger calls.
   - **Retry then succeed:** operation fails once (retryable), succeeds on second attempt → result returned; logger called once with `retry_attempt` (attempt: 1).
   - **All retries exhausted:** operation fails `maxRetries + 1` times (all retryable) → throws last error; logger called with `request_failed`.
   - **Non-retryable error:** first failure is non-retryable (`isRetryable` returns false) → throws immediately, no retry delay, `request_failed` logged.
   - **Custom delayMs:** override `delayMs` with a function that returns 0 to avoid real sleeps in tests (or mock `setTimeout`).

   Use Vitest's `vi.useFakeTimers()` to avoid real async delay in retry tests, or pass `delayMs: () => 0` in test options to make retries instant.

3b. **Write a mock-SDK provider test for the logger hook (success criterion 7.14).** Create `packages/core/src/__tests__/anthropic.test.ts`. Mock the Anthropic SDK so no network is touched and the streaming path actually runs:
   ```ts
   import { vi, describe, it, expect } from "vitest";

   // Stub the default-exported Anthropic class. messages.stream() returns an
   // async-iterable of a couple of raw events so stream() runs to completion.
   vi.mock("@anthropic-ai/sdk", () => {
     async function* fakeStream() {
       yield { type: "message_start", message: {} };
       yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
       yield { type: "message_stop" };
     }
     return {
       default: class {
         messages = { stream: () => fakeStream() };
       },
     };
   });
   ```
   Vitest hoists the `vi.mock(...)` call above the file's imports, so a normal top-level `import { AnthropicProvider } from "../providers/anthropic.js"` picks up the mock — no manual ordering or dynamic import needed. Test cases:
   - **Logger off by default:** construct `new AnthropicProvider({ apiKey: "k", model: "m" })` (no `logger`). Spy on `console.log`/`console.error`/`console.warn` with `vi.spyOn`. Drive `stream({ systemPrompt: "", messages: [], tools: [] })` to completion. Assert **zero** console calls — the provider emits nothing when no logger is configured. (This is the real 7.14 check.)
   - **Logger fires when provided:** construct with a `logger: vi.fn()`. Drive `stream(...)` to completion. Assert the logger was called at least once with `{ event: "request_sent" }`.
   - **Constructor validation:** `new AnthropicProvider({ apiKey: "", model: "m" })` throws `"AnthropicProvider: ANTHROPIC_API_KEY is required"`.

4. **Run `pnpm --filter tiny-agentic test`** — all tests pass including retry tests, the mock-SDK provider test, and all prior tests.

5. **Run `pnpm --filter tiny-agentic typecheck`** — no errors. Ensure the `AnthropicProvider` implements `Provider` correctly (TypeScript will verify this via `implements Provider`).

## Acceptance criteria

- [ ] `pnpm --filter tiny-agentic test` passes with all tests in `retry.test.ts` green, plus all prior tests still green.
- [ ] `pnpm --filter tiny-agentic typecheck` exits with code 0.
- [ ] `AnthropicProvider` constructor throws `"AnthropicProvider: ANTHROPIC_API_KEY is required"` when `apiKey` is empty or undefined — verified by the `anthropic.test.ts` constructor-validation test.
- [ ] Success criterion 7.14 (logger off by default) is verified in `anthropic.test.ts`: with no logger, driving `stream()` produces zero console output; with a logger, `request_sent` fires.
- [ ] `AnthropicProvider` does NOT call `withRetry` anywhere in its implementation (the SDK handles it). Verify with `grep -n "withRetry" packages/core/src/providers/anthropic.ts` returning no results.
- [ ] `retry.ts` does NOT import from `@anthropic-ai/sdk` — verify with `grep "@anthropic-ai" packages/core/src/providers/retry.ts` returning no results.
- [ ] `AnthropicProvider` passes the `signal` to `this.client.messages.stream(params, { signal })` — verify in the code.

## Output files

- Created: `packages/core/src/providers/retry.ts`
- Modified: `packages/core/src/providers/anthropic.ts` (replaced task-01 stub with full implementation)
- Created: `packages/core/src/__tests__/retry.test.ts`
- Created: `packages/core/src/__tests__/anthropic.test.ts` (mock-SDK logger test — success criterion 7.14)

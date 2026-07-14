import type { Logger } from "../types/provider.js";
// No @anthropic-ai/sdk import — this module is provider-agnostic.

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

function defaultDelayMs(attempt: number): number {
  const base = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * BASE_DELAY_MS;
  return Math.min(base + jitter, MAX_DELAY_MS);
}

/**
 * Generic transient-error retry with exponential backoff + jitter.
 *
 * Not used by AnthropicProvider or OpenAIProvider: both vendor SDKs retry
 * internally via their `maxRetries` constructor option (backoff and jitter for
 * transient rate-limit, server, and connection failures).
 *
 * Provided as a documented fallback for any future provider whose backend lacks
 * built-in retry. The caller supplies `isRetryable` to classify vendor-specific
 * error shapes — this utility has no knowledge of any SDK's error types.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries: number;
    isRetryable: (error: unknown) => boolean;
    delayMs?: (attempt: number) => number;
    logger?: Logger;
  },
): Promise<T> {
  const computeDelay = options.delayMs ?? defaultDelayMs;
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (!options.isRetryable(err) || attempt === options.maxRetries) break;
      const delay = computeDelay(attempt);
      options.logger?.({
        level: "info",
        event: "retry_attempt",
        attempt: attempt + 1,
        delayMs: delay,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  const finalError = lastError instanceof Error ? lastError : new Error(String(lastError));
  options.logger?.({ level: "error", event: "request_failed", error: finalError });
  throw finalError;
}

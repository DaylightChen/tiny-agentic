import { describe, it, expect, vi } from "vitest";

import { withRetry } from "../providers/retry.js";
import type { LogEntry } from "../types/provider.js";

/** A logger that records every LogEntry it receives, plus a vi.fn for call assertions. */
function recordingLogger() {
  const entries: LogEntry[] = [];
  const fn = vi.fn((entry: LogEntry) => {
    entries.push(entry);
  });
  return { fn, entries };
}

describe("withRetry", () => {
  it("returns the result on first attempt with no delay and no logger calls", async () => {
    const { fn, entries } = recordingLogger();
    const operation = vi.fn(async () => "ok");

    const result = await withRetry(operation, {
      maxRetries: 3,
      isRetryable: () => true,
      delayMs: () => 0,
      logger: fn,
    });

    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
    // No retry_attempt, no request_failed when the first attempt succeeds.
    expect(fn).not.toHaveBeenCalled();
    expect(entries).toEqual([]);
  });

  it("retries a retryable failure then succeeds, logging one retry_attempt (attempt: 1)", async () => {
    const { fn, entries } = recordingLogger();
    let calls = 0;
    const operation = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return "recovered";
    });

    const result = await withRetry(operation, {
      maxRetries: 3,
      isRetryable: () => true,
      delayMs: () => 0, // instant retry, no real sleep
      logger: fn,
    });

    expect(result).toBe("recovered");
    expect(operation).toHaveBeenCalledTimes(2);

    const retryEntries = entries.filter((e) => e.event === "retry_attempt");
    expect(retryEntries).toHaveLength(1);
    const retry = retryEntries[0];
    // Narrow for type-safe field access.
    if (!retry || retry.event !== "retry_attempt") throw new Error("unreachable");
    expect(retry.attempt).toBe(1);
    expect(retry.level).toBe("info");
    expect(retry.error).toBeInstanceOf(Error);
    expect((retry.error as Error).message).toBe("transient");

    // A successful recovery must NOT log request_failed.
    expect(entries.some((e) => e.event === "request_failed")).toBe(false);
  });

  it("throws the last error after exhausting maxRetries+1 retryable failures and logs request_failed", async () => {
    const { fn, entries } = recordingLogger();
    const maxRetries = 2;
    let calls = 0;
    const operation = vi.fn(async () => {
      calls += 1;
      throw new Error(`fail-${calls}`);
    });

    await expect(
      withRetry(operation, {
        maxRetries,
        isRetryable: () => true,
        delayMs: () => 0,
        logger: fn,
      }),
    ).rejects.toThrow("fail-3"); // last error of maxRetries+1 = 3 attempts

    // maxRetries + 1 total attempts.
    expect(operation).toHaveBeenCalledTimes(maxRetries + 1);

    // One retry_attempt per retry between attempts (maxRetries of them).
    const retryEntries = entries.filter((e) => e.event === "retry_attempt");
    expect(retryEntries).toHaveLength(maxRetries);

    const failedEntries = entries.filter((e) => e.event === "request_failed");
    expect(failedEntries).toHaveLength(1);
    const failed = failedEntries[0];
    if (!failed || failed.event !== "request_failed") throw new Error("unreachable");
    expect(failed.level).toBe("error");
    expect(failed.error.message).toBe("fail-3");
  });

  it("throws immediately on a non-retryable error: no retry, no delay, request_failed logged", async () => {
    const { fn, entries } = recordingLogger();
    const operation = vi.fn(async () => {
      throw new Error("non-retryable");
    });
    const delaySpy = vi.fn(() => 0);

    await expect(
      withRetry(operation, {
        maxRetries: 5,
        isRetryable: () => false, // classify every error as non-retryable
        delayMs: delaySpy,
        logger: fn,
      }),
    ).rejects.toThrow("non-retryable");

    // Operation runs exactly once — no retry attempted.
    expect(operation).toHaveBeenCalledTimes(1);
    // delayMs is never consulted because we break before computing a delay.
    expect(delaySpy).not.toHaveBeenCalled();
    // No retry_attempt logged.
    expect(entries.some((e) => e.event === "retry_attempt")).toBe(false);
    // request_failed is still logged once.
    const failedEntries = entries.filter((e) => e.event === "request_failed");
    expect(failedEntries).toHaveLength(1);
  });

  it("wraps a non-Error throw into an Error before rethrowing and logging", async () => {
    const { fn, entries } = recordingLogger();
    const operation = vi.fn(async () => {
      throw "string failure"; // non-Error rejection
    });

    await expect(
      withRetry(operation, {
        maxRetries: 0,
        isRetryable: () => false,
        delayMs: () => 0,
        logger: fn,
      }),
    ).rejects.toThrow("string failure");

    const failed = entries.find((e) => e.event === "request_failed");
    expect(failed).toBeDefined();
    if (failed && failed.event === "request_failed") {
      expect(failed.error).toBeInstanceOf(Error);
      expect(failed.error.message).toBe("string failure");
    }
  });

  // Note: the "retry.ts does NOT import @anthropic-ai/sdk" invariant is verified
  // out-of-band via grep (core's lint rule forbids `node:fs` in src, so a
  // source-reading in-suite assertion is not possible here). See the test report.
});

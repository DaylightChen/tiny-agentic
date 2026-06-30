/**
 * Normalized cross-provider token usage for a model call or run.
 * inputTokens, outputTokens, cacheReadTokens are always present.
 * cacheWriteTokens is Anthropic-only; absent for OpenAI and when not applicable.
 */
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens?: number;
};

/**
 * Zero usage constant. Use as the initial accumulator value.
 * Do NOT mutate. Clone with { ...EMPTY_USAGE } if a mutable copy is needed.
 * cacheWriteTokens is absent (exactOptionalPropertyTypes: absent ≠ undefined).
 */
export const EMPTY_USAGE: Readonly<Usage> = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
});

/**
 * Merge two partial usage values from events within the same model message.
 * Uses a > 0 guard: a later event's zero does not overwrite an earlier non-zero.
 * Pure and immutable — returns a new Usage object.
 *
 * Use case: combining message_start (input tokens) with message_delta (output
 * tokens) from Anthropic's streaming event sequence.
 */
export function mergeUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: b.inputTokens > 0 ? b.inputTokens : a.inputTokens,
    outputTokens: b.outputTokens > 0 ? b.outputTokens : a.outputTokens,
    cacheReadTokens: b.cacheReadTokens > 0 ? b.cacheReadTokens : a.cacheReadTokens,
    ...(((b.cacheWriteTokens ?? 0) > 0)
      ? { cacheWriteTokens: b.cacheWriteTokens }
      : a.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: a.cacheWriteTokens }
        : {}),
  };
}

/**
 * Field-wise sum of a completed turn's usage into the run cumulative total.
 * No guards — final values only. Pure and immutable — returns a new Usage object.
 *
 * Use case: summing turn usage into the run-level total after each message_stop.
 */
export function accumulateUsage(total: Usage, turn: Usage): Usage {
  return {
    inputTokens: total.inputTokens + turn.inputTokens,
    outputTokens: total.outputTokens + turn.outputTokens,
    cacheReadTokens: total.cacheReadTokens + turn.cacheReadTokens,
    ...((total.cacheWriteTokens !== undefined || turn.cacheWriteTokens !== undefined)
      ? { cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (turn.cacheWriteTokens ?? 0) }
      : {}),
  };
}

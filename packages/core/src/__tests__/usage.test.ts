import { describe, it, expect } from "vitest";

import { EMPTY_USAGE, mergeUsage, accumulateUsage } from "../types/usage.js";
import type { Usage } from "../types/usage.js";

// ---------------------------------------------------------------------------
// EMPTY_USAGE
// ---------------------------------------------------------------------------

describe("EMPTY_USAGE", () => {
  it("is frozen (Object.isFrozen returns true)", () => {
    expect(Object.isFrozen(EMPTY_USAGE)).toBe(true);
  });

  it("throws when mutated in strict mode", () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (EMPTY_USAGE as any).inputTokens = 99;
    }).toThrow();
  });

  it("has inputTokens: 0", () => {
    expect(EMPTY_USAGE.inputTokens).toBe(0);
  });

  it("has outputTokens: 0", () => {
    expect(EMPTY_USAGE.outputTokens).toBe(0);
  });

  it("has cacheReadTokens: 0", () => {
    expect(EMPTY_USAGE.cacheReadTokens).toBe(0);
  });

  it("does NOT have a cacheWriteTokens key", () => {
    expect("cacheWriteTokens" in EMPTY_USAGE).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mergeUsage
// ---------------------------------------------------------------------------

describe("mergeUsage", () => {
  it("zero guard: b.inputTokens=0 does not overwrite a positive a.inputTokens", () => {
    const a: Usage = { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 };
    const b: Usage = { inputTokens: 0, outputTokens: 5, cacheReadTokens: 0 };
    const result = mergeUsage(a, b);
    expect(result.inputTokens).toBe(10);
  });

  it("zero guard: b.outputTokens=0 does not overwrite a positive a.outputTokens", () => {
    const a: Usage = { inputTokens: 0, outputTokens: 7, cacheReadTokens: 0 };
    const b: Usage = { inputTokens: 3, outputTokens: 0, cacheReadTokens: 0 };
    const result = mergeUsage(a, b);
    expect(result.outputTokens).toBe(7);
  });

  it("zero guard: b.cacheReadTokens=0 does not overwrite a positive a.cacheReadTokens", () => {
    const a: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 4 };
    const b: Usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 };
    const result = mergeUsage(a, b);
    expect(result.cacheReadTokens).toBe(4);
  });

  it("non-zero b.outputTokens overwrites a.outputTokens", () => {
    const a: Usage = { inputTokens: 0, outputTokens: 3, cacheReadTokens: 0 };
    const b: Usage = { inputTokens: 0, outputTokens: 5, cacheReadTokens: 0 };
    const result = mergeUsage(a, b);
    expect(result.outputTokens).toBe(5);
  });

  it("non-zero b.inputTokens overwrites a.inputTokens", () => {
    const a: Usage = { inputTokens: 2, outputTokens: 0, cacheReadTokens: 0 };
    const b: Usage = { inputTokens: 8, outputTokens: 0, cacheReadTokens: 0 };
    const result = mergeUsage(a, b);
    expect(result.inputTokens).toBe(8);
  });

  describe("cacheWriteTokens", () => {
    it("preserves a.cacheWriteTokens when b has no cacheWriteTokens", () => {
      const a: Usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 42 };
      const b: Usage = { inputTokens: 0, outputTokens: 2, cacheReadTokens: 0 };
      const result = mergeUsage(a, b);
      expect("cacheWriteTokens" in result).toBe(true);
      expect(result.cacheWriteTokens).toBe(42);
    });

    it("takes b.cacheWriteTokens when b has it and it is > 0", () => {
      const a: Usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 10 };
      const b: Usage = { inputTokens: 0, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 99 };
      const result = mergeUsage(a, b);
      expect(result.cacheWriteTokens).toBe(99);
    });

    it("falls back to a.cacheWriteTokens when b.cacheWriteTokens is 0 (zero guard)", () => {
      const a: Usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 7 };
      const b: Usage = { inputTokens: 0, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const result = mergeUsage(a, b);
      expect("cacheWriteTokens" in result).toBe(true);
      expect(result.cacheWriteTokens).toBe(7);
    });

    it("result has no cacheWriteTokens key when both a and b lack it", () => {
      const a: Usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 };
      const b: Usage = { inputTokens: 0, outputTokens: 2, cacheReadTokens: 0 };
      const result = mergeUsage(a, b);
      expect("cacheWriteTokens" in result).toBe(false);
    });
  });

  describe("purity", () => {
    it("returns a new object — not referentially equal to a or b", () => {
      const a: Usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 };
      const b: Usage = { inputTokens: 4, outputTokens: 5, cacheReadTokens: 6 };
      const result = mergeUsage(a, b);
      expect(result).not.toBe(a);
      expect(result).not.toBe(b);
    });

    it("does not mutate input a", () => {
      const a: Usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 };
      const aSnapshot = { ...a };
      const b: Usage = { inputTokens: 9, outputTokens: 8, cacheReadTokens: 7, cacheWriteTokens: 6 };
      mergeUsage(a, b);
      expect(a).toEqual(aSnapshot);
    });

    it("does not mutate input b", () => {
      const a: Usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 };
      const b: Usage = { inputTokens: 9, outputTokens: 8, cacheReadTokens: 7, cacheWriteTokens: 5 };
      const bSnapshot = { ...b };
      mergeUsage(a, b);
      expect(b).toEqual(bSnapshot);
    });
  });
});

// ---------------------------------------------------------------------------
// accumulateUsage
// ---------------------------------------------------------------------------

describe("accumulateUsage", () => {
  it("sums inputTokens correctly", () => {
    const total: Usage = { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 };
    const turn: Usage = { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0 };
    const result = accumulateUsage(total, turn);
    expect(result.inputTokens).toBe(15);
  });

  it("sums outputTokens correctly", () => {
    const total: Usage = { inputTokens: 0, outputTokens: 20, cacheReadTokens: 0 };
    const turn: Usage = { inputTokens: 0, outputTokens: 8, cacheReadTokens: 0 };
    const result = accumulateUsage(total, turn);
    expect(result.outputTokens).toBe(28);
  });

  it("sums cacheReadTokens correctly", () => {
    const total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 100 };
    const turn: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 50 };
    const result = accumulateUsage(total, turn);
    expect(result.cacheReadTokens).toBe(150);
  });

  it("sums all three required fields together (integration)", () => {
    const total: Usage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 };
    const turn: Usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 };
    const result = accumulateUsage(total, turn);
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(22);
    expect(result.cacheReadTokens).toBe(33);
  });

  describe("cacheWriteTokens", () => {
    it("sums cacheWriteTokens when both total and turn have it", () => {
      const total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 40 };
      const turn: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 10 };
      const result = accumulateUsage(total, turn);
      expect("cacheWriteTokens" in result).toBe(true);
      expect(result.cacheWriteTokens).toBe(50);
    });

    it("treats absent total.cacheWriteTokens as 0 when turn has it", () => {
      const total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      const turn: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 15 };
      const result = accumulateUsage(total, turn);
      expect("cacheWriteTokens" in result).toBe(true);
      expect(result.cacheWriteTokens).toBe(15);
    });

    it("treats absent turn.cacheWriteTokens as 0 when total has it", () => {
      const total: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 25 };
      const turn: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      const result = accumulateUsage(total, turn);
      expect("cacheWriteTokens" in result).toBe(true);
      expect(result.cacheWriteTokens).toBe(25);
    });

    it("result has no cacheWriteTokens key when both total and turn lack it", () => {
      const total: Usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 };
      const turn: Usage = { inputTokens: 4, outputTokens: 5, cacheReadTokens: 6 };
      const result = accumulateUsage(total, turn);
      expect("cacheWriteTokens" in result).toBe(false);
    });
  });

  describe("purity", () => {
    it("returns a new object — not referentially equal to total or turn", () => {
      const total: Usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 };
      const turn: Usage = { inputTokens: 4, outputTokens: 5, cacheReadTokens: 6 };
      const result = accumulateUsage(total, turn);
      expect(result).not.toBe(total);
      expect(result).not.toBe(turn);
    });

    it("does not mutate input total", () => {
      const total: Usage = { inputTokens: 5, outputTokens: 10, cacheReadTokens: 15, cacheWriteTokens: 20 };
      const totalSnapshot = { ...total };
      const turn: Usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 };
      accumulateUsage(total, turn);
      expect(total).toEqual(totalSnapshot);
    });

    it("does not mutate input turn", () => {
      const total: Usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 };
      const turn: Usage = { inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6 };
      const turnSnapshot = { ...turn };
      accumulateUsage(total, turn);
      expect(turn).toEqual(turnSnapshot);
    });
  });
});

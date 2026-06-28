import { describe, it, expect } from "vitest";

import { serializeToolResult } from "../utils/serialize.js";

describe("serializeToolResult", () => {
  it("returns a string input unchanged (no JSON quoting)", () => {
    expect(serializeToolResult("already a string")).toBe("already a string");
    // An empty string stays an empty string, not the literal "".
    expect(serializeToolResult("")).toBe("");
  });

  it("JSON.stringifies an object input", () => {
    expect(serializeToolResult({ a: 1, b: "two" })).toBe('{"a":1,"b":"two"}');
  });

  it("JSON.stringifies arrays, numbers, booleans, and null", () => {
    expect(serializeToolResult([1, 2, 3])).toBe("[1,2,3]");
    expect(serializeToolResult(42)).toBe("42");
    expect(serializeToolResult(true)).toBe("true");
    expect(serializeToolResult(null)).toBe("null");
  });

  it("throws on a BigInt value (JSON.stringify cannot serialize it)", () => {
    // The loop (task 07) relies on this throwing so it can convert the failure
    // into a recoverable tool error rather than emitting `undefined`.
    expect(() => serializeToolResult(10n)).toThrow(TypeError);
    expect(() => serializeToolResult({ big: 10n })).toThrow(TypeError);
  });

  it("throws on a circular reference", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => serializeToolResult(circular)).toThrow(TypeError);
  });
});

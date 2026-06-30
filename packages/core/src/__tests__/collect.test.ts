import { describe, it, expect } from "vitest";

import { collectText, collectEvents } from "../utils/collect.js";
import type { AgentEvent, Terminal } from "../types/events.js";
import { EMPTY_USAGE } from "../types/usage.js";

/**
 * Build a mock AsyncGenerator that yields the given events in order,
 * then returns the given terminal — mirroring the shape Agent.run() produces.
 */
async function* mockGen(
  events: AgentEvent[],
  terminal: Terminal,
): AsyncGenerator<AgentEvent, Terminal> {
  for (const e of events) yield e;
  return terminal;
}

const terminal: Terminal = { reason: "agent_done", messages: [], usage: EMPTY_USAGE };

describe("collectText", () => {
  it("returns the joined text from text_delta events", async () => {
    const events: AgentEvent[] = [
      { type: "text_delta", text: "Hello, " },
      { type: "text_delta", text: "world" },
      { type: "text_delta", text: "!" },
    ];
    const text = await collectText(mockGen(events, terminal));
    expect(text).toBe("Hello, world!");
  });

  it("ignores non-text_delta events and accumulates only text_delta text", async () => {
    const events: AgentEvent[] = [
      { type: "text_delta", text: "a" },
      { type: "tool_use_start", toolName: "read", toolInput: { path: "x" } },
      { type: "text_delta", text: "b" },
      { type: "tool_result", toolName: "read", toolCallId: "t1", result: "ok", isError: false },
      { type: "turn_complete", turnIndex: 0 },
      { type: "text_delta", text: "c" },
    ];
    const text = await collectText(mockGen(events, terminal));
    expect(text).toBe("abc");
  });

  it("returns empty string when there are no text_delta events", async () => {
    const events: AgentEvent[] = [
      { type: "tool_use_start", toolName: "read", toolInput: {} },
      { type: "turn_complete", turnIndex: 0 },
    ];
    const text = await collectText(mockGen(events, terminal));
    expect(text).toBe("");
  });

  it("returns empty string when the generator yields no events at all", async () => {
    const text = await collectText(mockGen([], terminal));
    expect(text).toBe("");
  });
});

describe("collectEvents", () => {
  it("returns all yielded events in order plus the Terminal", async () => {
    const events: AgentEvent[] = [
      { type: "text_delta", text: "hi" },
      { type: "tool_use_start", toolName: "read", toolInput: { path: "x" } },
      { type: "turn_complete", turnIndex: 0 },
    ];
    const term: Terminal = { reason: "agent_done", messages: [], usage: EMPTY_USAGE };

    const result = await collectEvents(mockGen(events, term));

    expect(result.events).toEqual(events);
    // Order is preserved exactly.
    expect(result.events.map((e) => e.type)).toEqual([
      "text_delta",
      "tool_use_start",
      "turn_complete",
    ]);
    expect(result.terminal).toEqual(term);
    expect(result.terminal).toBe(term);
  });

  it("captures the terminal's full payload (reason + messages)", async () => {
    const term: Terminal = {
      reason: "max_turns_exceeded",
      messages: [{ role: "assistant", content: "stopped" }],
      turnsUsed: 3,
      usage: EMPTY_USAGE,
    };
    const result = await collectEvents(mockGen([], term));
    expect(result.terminal).toEqual(term);
  });

  it("returns empty events array when the generator immediately returns the Terminal", async () => {
    const result = await collectEvents(mockGen([], terminal));
    expect(result.events).toEqual([]);
    expect(result.terminal).toEqual(terminal);
  });
});

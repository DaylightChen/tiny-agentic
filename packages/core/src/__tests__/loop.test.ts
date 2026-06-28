import { describe, it, expect } from "vitest";
import { z } from "zod";

import { agentLoop } from "../loop/loop.js";
import type { LoopParams } from "../loop/loop.js";
import { collectEvents } from "../utils/collect.js";
import { ToolRegistry } from "../tools/registry.js";
import { defineTool } from "../types/tool.js";
import type { Provider, ProviderEvent, ProviderRequest } from "../types/provider.js";
import type { Platform, ExecResult } from "../types/platform.js";
import type { Message, ToolResultBlock } from "../types/messages.js";

/**
 * Replays a scripted sequence of provider turns, one inner array per call to
 * stream(). Records each ProviderRequest it receives so tests can assert on the
 * messages threaded back into a later turn (tool-result bundling).
 */
class MockProvider implements Provider {
  private responses: ProviderEvent[][];
  readonly requests: ProviderRequest[] = [];

  constructor(responses: ProviderEvent[][]) {
    this.responses = responses;
  }

  async *stream(req: ProviderRequest, _signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
    // Snapshot the messages array so later mutation of workingMessages does not
    // retroactively change what we recorded for this turn.
    this.requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    const turn = this.responses.shift();
    if (!turn) throw new Error("MockProvider: no more responses");
    for (const e of turn) yield e;
  }
}

/** Provider that always throws when stream() is invoked. */
class ThrowingProvider implements Provider {
  async *stream(): AsyncGenerator<ProviderEvent> {
    throw new Error("network down");
  }
}

class MockPlatform implements Platform {
  cwd(): string {
    return "/work";
  }
  readFile(): Promise<string> {
    return Promise.reject(new Error("not used"));
  }
  writeFile(): Promise<void> {
    return Promise.reject(new Error("not used"));
  }
  exec(): Promise<ExecResult> {
    return Promise.reject(new Error("not used"));
  }
}

function makeParams(
  provider: Provider,
  registry: ToolRegistry,
  overrides?: Partial<LoopParams>,
): LoopParams {
  return {
    provider,
    registry,
    platform: new MockPlatform(),
    messages: [{ role: "user", content: "hello" }],
    systemPrompt: "sys",
    maxTurns: 10,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const okTool = defineTool({
  name: "ok_tool",
  description: "returns ok",
  inputSchema: z.object({}).passthrough(),
  call: async () => "tool-output",
});

describe("agentLoop", () => {
  it("streams text and completes naturally with no tools (basic run)", async () => {
    const provider = new MockProvider([
      [
        { type: "text_delta", text: "hi" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([]));

    const { events, terminal } = await collectEvents(agentLoop(params));

    expect(events.map((e) => e.type)).toEqual([
      "text_delta",
      "turn_complete",
      "agent_done",
    ]);
    expect(events.find((e) => e.type === "text_delta")).toEqual({
      type: "text_delta",
      text: "hi",
    });
    expect(terminal.reason).toBe("agent_done");
  });

  it("runs a tool then completes on the next turn (7.2)", async () => {
    const provider = new MockProvider([
      [
        { type: "tool_use", id: "t1", name: "ok_tool", input: {} },
        { type: "message_stop", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([okTool]));

    const { events, terminal } = await collectEvents(agentLoop(params));

    expect(events.map((e) => e.type)).toEqual([
      "tool_use_start",
      "tool_result",
      "turn_complete",
      "text_delta",
      "turn_complete",
      "agent_done",
    ]);

    const toolResult = events.find((e) => e.type === "tool_result");
    if (toolResult?.type !== "tool_result") throw new Error("expected tool_result");
    expect(toolResult.isError).toBe(false);
    expect(toolResult.result).toBe("tool-output");
    expect(toolResult.toolCallId).toBe("t1");

    expect(terminal.reason).toBe("agent_done");
  });

  it("stops at maxTurns when the model keeps requesting tools (7.5)", async () => {
    // Provider always returns a tool-use turn, so the loop never completes
    // naturally — the maxTurns guard must stop it.
    const alwaysToolTurn: ProviderEvent[] = [
      { type: "tool_use", id: "t", name: "ok_tool", input: {} },
      { type: "message_stop", stopReason: "tool_use" },
    ];
    const provider = new MockProvider([alwaysToolTurn, alwaysToolTurn, alwaysToolTurn]);
    const params = makeParams(provider, new ToolRegistry([okTool]), { maxTurns: 2 });

    const { events, terminal } = await collectEvents(agentLoop(params));

    const turnCompletes = events.filter((e) => e.type === "turn_complete");
    expect(turnCompletes).toHaveLength(2);

    const maxTurns = events.find((e) => e.type === "max_turns_exceeded");
    if (maxTurns?.type !== "max_turns_exceeded") {
      throw new Error("expected max_turns_exceeded event");
    }
    expect(maxTurns.turnsUsed).toBe(2);

    // The guard fires before a third turn_complete.
    const order = events.map((e) => e.type);
    expect(order[order.length - 1]).toBe("max_turns_exceeded");

    expect(terminal.reason).toBe("max_turns_exceeded");
    if (terminal.reason !== "max_turns_exceeded") throw new Error("unreachable");
    expect(terminal.turnsUsed).toBe(2);
  });

  it("yields agent_error when the provider stream throws (7.6)", async () => {
    const params = makeParams(new ThrowingProvider(), new ToolRegistry([]));

    const { events, terminal } = await collectEvents(agentLoop(params));

    const errorEvent = events.find((e) => e.type === "agent_error");
    if (errorEvent?.type !== "agent_error") throw new Error("expected agent_error event");
    expect(errorEvent.error).toBeInstanceOf(Error);
    expect(errorEvent.error.message).toBe("network down");

    expect(terminal.reason).toBe("agent_error");
    if (terminal.reason !== "agent_error") throw new Error("unreachable");
    expect(terminal.error.message).toBe("network down");
  });

  it("does not push an assistant message for an empty turn", async () => {
    const provider = new MockProvider([
      [{ type: "message_stop", stopReason: "end_turn" }],
    ]);
    const params = makeParams(provider, new ToolRegistry([]));

    const { events, terminal } = await collectEvents(agentLoop(params));

    expect(events.map((e) => e.type)).toEqual(["turn_complete", "agent_done"]);
    expect(terminal.reason).toBe("agent_done");

    // No assistant message was appended: only the seed user message remains.
    expect(terminal.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("bundles multiple tool results from one turn into a single user message (7.16)", async () => {
    const toolA = defineTool({
      name: "tool_a",
      description: "a",
      inputSchema: z.object({}).passthrough(),
      call: async () => "result-a",
    });
    const toolB = defineTool({
      name: "tool_b",
      description: "b",
      inputSchema: z.object({}).passthrough(),
      call: async () => "result-b",
    });

    const provider = new MockProvider([
      [
        { type: "tool_use", id: "ta", name: "tool_a", input: {} },
        { type: "tool_use", id: "tb", name: "tool_b", input: {} },
        { type: "message_stop", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "fin" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([toolA, toolB]));

    const { events, terminal } = await collectEvents(agentLoop(params));

    // Two tool_result events were yielded.
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(2);
    expect(terminal.reason).toBe("agent_done");

    // The request the provider received on turn 2 must end with ONE user message
    // whose content is two tool_result blocks with matching tool_use_ids.
    expect(provider.requests).toHaveLength(2);
    const turn2Request = provider.requests[1];
    if (!turn2Request) throw new Error("provider did not receive a second request");
    const turn2Messages: Message[] = turn2Request.messages;
    const last = turn2Messages.at(-1);
    if (!last) throw new Error("turn 2 request had no messages");
    expect(last.role).toBe("user");
    expect(Array.isArray(last.content)).toBe(true);

    const blocks = last.content as ToolResultBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.type === "tool_result")).toBe(true);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(["ta", "tb"]);
    expect(blocks.map((b) => b.content)).toEqual(["result-a", "result-b"]);
  });

  it("surfaces each text_delta incrementally, all before turn_complete (7.18)", async () => {
    const provider = new MockProvider([
      [
        { type: "text_delta", text: "a" },
        { type: "text_delta", text: "b" },
        { type: "text_delta", text: "c" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([]));

    const { events } = await collectEvents(agentLoop(params));

    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(3);
    expect(deltas.map((e) => (e.type === "text_delta" ? e.text : ""))).toEqual([
      "a",
      "b",
      "c",
    ]);

    // All three deltas precede the turn's turn_complete (not coalesced after it).
    const turnCompleteIndex = events.findIndex((e) => e.type === "turn_complete");
    const lastDeltaIndex =
      events.length -
      1 -
      [...events].reverse().findIndex((e) => e.type === "text_delta");
    expect(turnCompleteIndex).toBeGreaterThan(lastDeltaIndex);

    // And they appear in source order within the event list.
    const deltaIndices = events
      .map((e, i) => (e.type === "text_delta" ? i : -1))
      .filter((i) => i >= 0);
    expect(deltaIndices).toEqual([...deltaIndices].sort((x, y) => x - y));
  });
});

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
import type { AgentEvent } from "../types/events.js";
import { EMPTY_USAGE } from "../types/usage.js";

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

describe("agentLoop — usage accumulation", () => {
  // -------------------------------------------------------------------------
  // a. No usage in provider → terminal carries EMPTY_USAGE
  // -------------------------------------------------------------------------
  it("terminal carries EMPTY_USAGE when provider emits bare message_stop (no usage field)", async () => {
    const provider = new MockProvider([
      [
        { type: "text_delta", text: "hi" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([]));

    const { terminal } = await collectEvents(agentLoop(params));

    expect(terminal.reason).toBe("agent_done");
    // usage must equal EMPTY_USAGE exactly — all three base fields at 0
    expect(terminal.usage).toEqual(EMPTY_USAGE);
    // cacheWriteTokens must be absent (not merely undefined) per exactOptionalPropertyTypes
    expect("cacheWriteTokens" in terminal.usage).toBe(false);
  });

  // -------------------------------------------------------------------------
  // b. Single turn with usage → agent_done carries that usage
  // -------------------------------------------------------------------------
  it("agent_done carries the turn's usage when message_stop includes usage", async () => {
    const provider = new MockProvider([
      [
        { type: "text_delta", text: "hello" },
        {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
        },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([]));

    const { terminal } = await collectEvents(agentLoop(params));

    expect(terminal.reason).toBe("agent_done");
    expect(terminal.usage.inputTokens).toBe(10);
    expect(terminal.usage.outputTokens).toBe(5);
    expect(terminal.usage.cacheReadTokens).toBe(0);
  });

  // -------------------------------------------------------------------------
  // c. Two turns, each with distinct usage → agent_done carries the sum
  // -------------------------------------------------------------------------
  it("agent_done carries summed usage across two turns", async () => {
    // Turn 1: tool_use so the loop continues; turn 2: natural completion.
    const provider = new MockProvider([
      [
        { type: "tool_use", id: "t1", name: "ok_tool", input: {} },
        {
          type: "message_stop",
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
        },
      ],
      [
        { type: "text_delta", text: "done" },
        {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0 },
        },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([okTool]));

    const { terminal } = await collectEvents(agentLoop(params));

    expect(terminal.reason).toBe("agent_done");
    expect(terminal.usage.inputTokens).toBe(13);   // 10 + 3
    expect(terminal.usage.outputTokens).toBe(7);   // 5 + 2
    expect(terminal.usage.cacheReadTokens).toBe(0);
  });

  // -------------------------------------------------------------------------
  // d. max_turns_exceeded carries cumulative usage
  // -------------------------------------------------------------------------
  it("max_turns_exceeded event and terminal both carry summed usage up to the cap", async () => {
    const toolTurnWithUsage = (inputTokens: number, outputTokens: number): ProviderEvent[] => [
      { type: "tool_use", id: "t", name: "ok_tool", input: {} },
      {
        type: "message_stop",
        stopReason: "tool_use",
        usage: { inputTokens, outputTokens, cacheReadTokens: 0 },
      },
    ];

    // 3 provider responses but maxTurns = 2: only turns 0 and 1 run, then cap fires.
    const provider = new MockProvider([
      toolTurnWithUsage(10, 5),
      toolTurnWithUsage(3, 2),
      toolTurnWithUsage(99, 99), // never reached
    ]);
    const params = makeParams(provider, new ToolRegistry([okTool]), { maxTurns: 2 });

    const { events, terminal } = await collectEvents(agentLoop(params));

    // Verify we hit the cap
    expect(terminal.reason).toBe("max_turns_exceeded");

    // Both the yielded event and the terminal return value must carry summed usage
    const maxTurnsEvent = events.find((e) => e.type === "max_turns_exceeded");
    if (maxTurnsEvent?.type !== "max_turns_exceeded") throw new Error("expected max_turns_exceeded");
    expect(maxTurnsEvent.usage.inputTokens).toBe(13);    // 10 + 3
    expect(maxTurnsEvent.usage.outputTokens).toBe(7);    // 5 + 2

    expect(terminal.usage.inputTokens).toBe(13);
    expect(terminal.usage.outputTokens).toBe(7);
  });

  // -------------------------------------------------------------------------
  // e. agent_error carries cumulative usage from turns completed before error
  // -------------------------------------------------------------------------
  it("agent_error carries usage from completed turns when a later turn throws", async () => {
    // First turn completes normally with usage; second turn's provider throws.
    class FailOnSecondCallProvider implements Provider {
      private callCount = 0;
      async *stream(): AsyncGenerator<ProviderEvent> {
        this.callCount++;
        if (this.callCount === 1) {
          yield { type: "tool_use", id: "t1", name: "ok_tool", input: {} };
          yield {
            type: "message_stop",
            stopReason: "tool_use",
            usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
          };
        } else {
          throw new Error("second call failed");
        }
      }
    }

    const params = makeParams(new FailOnSecondCallProvider(), new ToolRegistry([okTool]));
    const { events, terminal } = await collectEvents(agentLoop(params));

    expect(terminal.reason).toBe("agent_error");

    // The agent_error event and terminal must carry usage from turn 1 only
    const errorEvent = events.find((e) => e.type === "agent_error");
    if (errorEvent?.type !== "agent_error") throw new Error("expected agent_error");
    expect(errorEvent.usage.inputTokens).toBe(10);
    expect(errorEvent.usage.outputTokens).toBe(5);

    expect(terminal.usage.inputTokens).toBe(10);
    expect(terminal.usage.outputTokens).toBe(5);
  });

  // -------------------------------------------------------------------------
  // f. turn_complete carries per-turn usage (not cumulative)
  // -------------------------------------------------------------------------
  it("turn_complete carries the per-turn usage (not cumulative) when usage is present", async () => {
    // Single turn: turn_complete.usage equals that turn's usage.
    const provider = new MockProvider([
      [
        { type: "text_delta", text: "hi" },
        {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
        },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([]));

    const { events } = await collectEvents(agentLoop(params));

    const turnComplete = events.find((e) => e.type === "turn_complete");
    if (turnComplete?.type !== "turn_complete") throw new Error("expected turn_complete");
    // turn_complete.usage must equal the turn's own usage (not a cumulative total)
    expect(turnComplete.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 });
  });

  // -------------------------------------------------------------------------
  // g. turn_complete.usage is absent when provider emits no usage
  // -------------------------------------------------------------------------
  it("turn_complete.usage is absent (not undefined value) when provider emits bare message_stop", async () => {
    const provider = new MockProvider([
      [
        { type: "text_delta", text: "hi" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([]));

    const { events } = await collectEvents(agentLoop(params));

    const turnComplete = events.find((e) => e.type === "turn_complete");
    if (turnComplete?.type !== "turn_complete") throw new Error("expected turn_complete");
    // The property must be absent, not merely set to undefined
    expect(turnComplete.usage).toBeUndefined();
    expect("usage" in turnComplete).toBe(false);
  });
});

// ===========================================================================
// Subagent seams (task-02): usage write-back, child-event forwarding, toolCallId
//
// These tests exercise the three context seams the loop wires into tool
// execution using STUB tools that call context.reportUsage / context.emitEvent
// and read context.toolCallId directly — deliberately no `task` tool and no
// child Agent, isolating the loop mechanics from the tool mechanics (brief R1).
// ===========================================================================

// A tool that reports out-of-band usage, then returns normally.
const reportingTool = defineTool({
  name: "report_tool",
  description: "reports usage",
  inputSchema: z.object({}).passthrough(),
  call: async (_input, _platform, context) => {
    context.reportUsage?.({ inputTokens: 5, outputTokens: 7, cacheReadTokens: 0 });
    return "reported";
  },
});

// A tool that reports out-of-band usage and THEN throws (so its tool_result is
// isError:true). Used to prove the post-batch fold still counts the report
// exactly once even when the call errors (E5: no double-count, no loss).
const reportThenThrowTool = defineTool({
  name: "report_then_throw_tool",
  description: "reports usage then throws",
  inputSchema: z.object({}).passthrough(),
  call: async (_input, _platform, context) => {
    context.reportUsage?.({ inputTokens: 5, outputTokens: 7, cacheReadTokens: 0 });
    throw new Error("boom-after-report");
  },
});

// A tool that emits two child events (in order) then returns.
const emittingTool = defineTool({
  name: "emit_tool",
  description: "emits child events",
  inputSchema: z.object({}).passthrough(),
  call: async (_input, _platform, context) => {
    context.emitEvent?.({ type: "text_delta", text: "child-a" });
    context.emitEvent?.({ type: "text_delta", text: "child-b" });
    return "emitted";
  },
});

// A tool that echoes its own toolCallId as its result, or "MISSING" if absent.
const idEchoTool = defineTool({
  name: "id_tool",
  description: "echoes toolCallId",
  inputSchema: z.object({}).passthrough(),
  call: async (_input, _platform, context) => context.toolCallId ?? "MISSING",
});

// A tool that both emits an event AND echoes its toolCallId — used to assert the
// emitted subagent_event.taskId matches the toolCallId the tool observed.
const idEchoEmitTool = defineTool({
  name: "id_emit_tool",
  description: "emits then echoes toolCallId",
  inputSchema: z.object({}).passthrough(),
  call: async (_input, _platform, context) => {
    context.emitEvent?.({ type: "text_delta", text: "from-child" });
    return context.toolCallId ?? "MISSING";
  },
});

/** Narrow-or-throw helper for a tool_result at a given index. */
function toolResultAt(
  events: AgentEvent[],
  index: number,
): Extract<AgentEvent, { type: "tool_result" }> {
  const ev = events[index];
  if (!ev) throw new Error(`no event at index ${index}`);
  if (ev.type !== "tool_result") throw new Error(`event ${index} is ${ev.type}, not tool_result`);
  return ev;
}

describe("agentLoop — subagent seams", () => {
  // -------------------------------------------------------------------------
  // T13 — Usage write-back (R1, SC6)
  //
  // Turn 1: report_tool (message_stop usage {in:10,out:5}); the tool reports an
  // additional {in:5,out:7}. Turn 2: natural completion (message_stop {in:3,out:2}).
  // Terminal usage must equal the parent's own tokens PLUS the reported tokens,
  // field-wise exact: in = 10+3+5 = 18, out = 5+2+7 = 14, cacheRead = 0.
  // -------------------------------------------------------------------------
  it("T13: folds tool-reported usage into the run's cumulative total (field-wise exact)", async () => {
    const provider = new MockProvider([
      [
        { type: "tool_use", id: "r1", name: "report_tool", input: {} },
        {
          type: "message_stop",
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
        },
      ],
      [
        { type: "text_delta", text: "done" },
        {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0 },
        },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([reportingTool]));

    const { terminal } = await collectEvents(agentLoop(params));

    expect(terminal.reason).toBe("agent_done");
    // Field-wise exact: message-stop total (13/7) + reported (5/7).
    expect(terminal.usage).toEqual({
      inputTokens: 18,
      outputTokens: 14,
      cacheReadTokens: 0,
    });
    // cacheWriteTokens must remain absent (never introduced by the fold).
    expect("cacheWriteTokens" in terminal.usage).toBe(false);
  });

  it("T13: a report of {in:5,out:7} adds exactly {in:5,out:7} over the no-report baseline", async () => {
    // Guards against the fold silently no-op'ing OR over-counting: run the SAME
    // two-turn script with a non-reporting tool, then with report_tool, and
    // assert the delta is precisely the reported value.
    const scriptTurns = (): ProviderEvent[][] => [
      [
        { type: "tool_use", id: "r1", name: "TOOL", input: {} },
        {
          type: "message_stop",
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
        },
      ],
      [
        { type: "text_delta", text: "done" },
        {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0 },
        },
      ],
    ];

    // Baseline: okTool reports nothing.
    const baselineScript = scriptTurns();
    baselineScript[0]![0] = { type: "tool_use", id: "r1", name: "ok_tool", input: {} };
    const baseline = await collectEvents(
      agentLoop(makeParams(new MockProvider(baselineScript), new ToolRegistry([okTool]))),
    );

    // With report_tool.
    const reportScript = scriptTurns();
    reportScript[0]![0] = { type: "tool_use", id: "r1", name: "report_tool", input: {} };
    const reported = await collectEvents(
      agentLoop(makeParams(new MockProvider(reportScript), new ToolRegistry([reportingTool]))),
    );

    expect(reported.terminal.usage.inputTokens - baseline.terminal.usage.inputTokens).toBe(5);
    expect(reported.terminal.usage.outputTokens - baseline.terminal.usage.outputTokens).toBe(7);
    expect(
      reported.terminal.usage.cacheReadTokens - baseline.terminal.usage.cacheReadTokens,
    ).toBe(0);
  });

  // -------------------------------------------------------------------------
  // T14 — No double-count / no loss on error (E5, SC6)
  //
  // A tool that reports usage and THEN throws. The report happens before the
  // throw; the loop's post-batch fold runs regardless of per-tool error, so the
  // reported usage must be accumulated EXACTLY ONCE. A second turn completes
  // naturally so the run terminates agent_done.
  // -------------------------------------------------------------------------
  it("T14: reported usage on a turn whose tool errors is accumulated exactly once", async () => {
    const provider = new MockProvider([
      [
        { type: "tool_use", id: "e1", name: "report_then_throw_tool", input: {} },
        {
          type: "message_stop",
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
        },
      ],
      [
        { type: "text_delta", text: "recovered" },
        {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0 },
        },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([reportThenThrowTool]));

    const { events, terminal } = await collectEvents(agentLoop(params));

    // Run still terminates cleanly on the second turn.
    expect(terminal.reason).toBe("agent_done");

    // The erroring tool's result is an error carrying its throw message.
    const toolResult = events.find((e) => e.type === "tool_result");
    if (toolResult?.type !== "tool_result") throw new Error("expected tool_result");
    expect(toolResult.isError).toBe(true);
    expect(String(toolResult.result)).toBe("boom-after-report");

    // Reported {in:5,out:7} counted EXACTLY ONCE on top of message-stop total
    // (13/7): 13+5 = 18, 7+7 = 14. If it were double-counted we'd see 23/21;
    // if lost, 13/7.
    expect(terminal.usage).toEqual({
      inputTokens: 18,
      outputTokens: 14,
      cacheReadTokens: 0,
    });
  });

  // -------------------------------------------------------------------------
  // T15 — Event batch ordering (R3, SC7)
  //
  // Turn 1 calls emit_tool (emits child-a then child-b); turn 2 completes. The
  // subsequence for that call must be: tool_use_start(emit_tool) →
  // subagent_event(child-a) → subagent_event(child-b) → tool_result(emit_tool),
  // and each subagent_event.taskId must equal the tool-use id "e1".
  // -------------------------------------------------------------------------
  it("T15: child events are yielded in order between tool_use_start and tool_result", async () => {
    const provider = new MockProvider([
      [
        { type: "tool_use", id: "e1", name: "emit_tool", input: {} },
        { type: "message_stop", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "fin" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([emittingTool]));

    const { events, terminal } = await collectEvents(agentLoop(params));
    expect(terminal.reason).toBe("agent_done");

    // The exact prefix of the event stream around the emitting call.
    expect(events.slice(0, 4).map((e) => e.type)).toEqual([
      "tool_use_start",
      "subagent_event",
      "subagent_event",
      "tool_result",
    ]);

    // Both subagent_events carry the child text deltas, in order, tagged with e1.
    const subEvents = events.filter((e) => e.type === "subagent_event");
    expect(subEvents).toHaveLength(2);
    for (const se of subEvents) {
      if (se.type !== "subagent_event") throw new Error("unreachable");
      expect(se.taskId).toBe("e1");
      expect(se.event.type).toBe("text_delta");
    }
    expect(
      subEvents.map((se) =>
        se.type === "subagent_event" && se.event.type === "text_delta" ? se.event.text : "",
      ),
    ).toEqual(["child-a", "child-b"]);

    // Positional guarantee: every subagent_event index sits strictly between the
    // spawning tool_use_start and its tool_result.
    const startIdx = events.findIndex((e) => e.type === "tool_use_start");
    const resultIdx = events.findIndex((e) => e.type === "tool_result");
    const subIdxs = events
      .map((e, i) => (e.type === "subagent_event" ? i : -1))
      .filter((i) => i >= 0);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(resultIdx).toBeGreaterThan(startIdx);
    for (const i of subIdxs) {
      expect(i).toBeGreaterThan(startIdx);
      expect(i).toBeLessThan(resultIdx);
    }
  });

  it("T15: child events flush per-call and correlate to the right taskId across two tool calls", async () => {
    // Two emitting tools in ONE turn. Because runTools is sequential and each
    // tool_result flushes only that call's buffer, the first call's events must
    // carry the first id and the second call's the second id — a buffer that
    // leaked across calls would mis-tag or duplicate.
    const emitA = defineTool({
      name: "emit_a",
      description: "emits one child event",
      inputSchema: z.object({}).passthrough(),
      call: async (_input, _platform, context) => {
        context.emitEvent?.({ type: "text_delta", text: "AAA" });
        return "a";
      },
    });
    const emitB = defineTool({
      name: "emit_b",
      description: "emits one child event",
      inputSchema: z.object({}).passthrough(),
      call: async (_input, _platform, context) => {
        context.emitEvent?.({ type: "text_delta", text: "BBB" });
        return "b";
      },
    });

    const provider = new MockProvider([
      [
        { type: "tool_use", id: "ta", name: "emit_a", input: {} },
        { type: "tool_use", id: "tb", name: "emit_b", input: {} },
        { type: "message_stop", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "fin" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([emitA, emitB]));

    const { events } = await collectEvents(agentLoop(params));

    // Order: start(a) result(a) start(b) result(b) is how runTools yields — the
    // events per call are flushed right before that call's result.
    expect(events.slice(0, 6).map((e) => e.type)).toEqual([
      "tool_use_start",
      "tool_use_start",
      "subagent_event",
      "tool_result",
      "subagent_event",
      "tool_result",
    ]);

    const subEvents = events.filter((e) => e.type === "subagent_event");
    expect(subEvents).toHaveLength(2);
    const tagged = subEvents.map((se) =>
      se.type === "subagent_event" && se.event.type === "text_delta"
        ? [se.taskId, se.event.text]
        : [],
    );
    expect(tagged).toEqual([
      ["ta", "AAA"],
      ["tb", "BBB"],
    ]);
  });

  // -------------------------------------------------------------------------
  // T16 — toolCallId correlation
  //
  // A tool reading context.toolCallId sees the current tu.id; an emitted
  // subagent_event.taskId matches it.
  // -------------------------------------------------------------------------
  it("T16: a tool reads context.toolCallId equal to its own tool-use id", async () => {
    const provider = new MockProvider([
      [
        { type: "tool_use", id: "x1", name: "id_tool", input: {} },
        { type: "message_stop", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "ok" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([idEchoTool]));

    const { events } = await collectEvents(agentLoop(params));

    const toolResult = events.find((e) => e.type === "tool_result");
    if (toolResult?.type !== "tool_result") throw new Error("expected tool_result");
    // The tool echoed context.toolCallId — proves it equals tu.id, not "MISSING".
    expect(toolResult.result).toBe("x1");
    expect(toolResult.toolCallId).toBe("x1");
  });

  it("T16: an emitted subagent_event.taskId matches the toolCallId the tool observed", async () => {
    const provider = new MockProvider([
      [
        { type: "tool_use", id: "x1", name: "id_emit_tool", input: {} },
        { type: "message_stop", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "ok" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([idEchoEmitTool]));

    const { events } = await collectEvents(agentLoop(params));

    // The tool's own view of its id.
    const toolResult = events.find((e) => e.type === "tool_result");
    if (toolResult?.type !== "tool_result") throw new Error("expected tool_result");
    expect(toolResult.result).toBe("x1");

    // The emitted event, surfaced as subagent_event, carries the same taskId.
    const subEvent = events.find((e) => e.type === "subagent_event");
    if (subEvent?.type !== "subagent_event") throw new Error("expected subagent_event");
    expect(subEvent.taskId).toBe("x1");
    expect(subEvent.event.type).toBe("text_delta");
    if (subEvent.event.type !== "text_delta") throw new Error("unreachable");
    expect(subEvent.event.text).toBe("from-child");
  });

  // -------------------------------------------------------------------------
  // T17 — No-subagent no-op (NF overhead)
  //
  // A run with okTool (touches no new sink) yields exactly the event sequence
  // the existing "runs a tool then completes" test asserts — no subagent_event,
  // and usage identical to the message_stop-only path.
  // -------------------------------------------------------------------------
  it("T17: a run whose tool touches no new sink emits no subagent_event (byte-identical sequence)", async () => {
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

    // Exactly the sequence asserted by the pre-existing "runs a tool" test.
    expect(events.map((e) => e.type)).toEqual([
      "tool_use_start",
      "tool_result",
      "turn_complete",
      "text_delta",
      "turn_complete",
      "agent_done",
    ]);

    // No subagent_event anywhere.
    expect(events.every((e) => e.type !== "subagent_event")).toBe(true);

    expect(terminal.reason).toBe("agent_done");
    const okResult = toolResultAt(events, 1);
    expect(okResult.result).toBe("tool-output");
    expect(okResult.toolCallId).toBe("t1");
  });

  it("T17: a no-report run's usage is unchanged from the message_stop-only total", async () => {
    // okTool reports nothing, so the fold is a zero-iteration no-op: terminal
    // usage must equal the sum of the two turns' message_stop usage exactly.
    const provider = new MockProvider([
      [
        { type: "tool_use", id: "t1", name: "ok_tool", input: {} },
        {
          type: "message_stop",
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
        },
      ],
      [
        { type: "text_delta", text: "done" },
        {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0 },
        },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([okTool]));

    const { events, terminal } = await collectEvents(agentLoop(params));

    // No new accounting source ran → exactly the message-stop total (13/7).
    expect(terminal.usage).toEqual({ inputTokens: 13, outputTokens: 7, cacheReadTokens: 0 });
    expect(events.every((e) => e.type !== "subagent_event")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Downstream-dependency guards (task-03 relies on these; not spelled out as
  // T13-T17 but protected here so a regression is caught by a test, not review):
  //   - reportUsage is additive across multiple calls in one batch (the
  //     ToolCallContext doc contract: "Safe to call multiple times; each call
  //     accumulates"). task-03 calls it once today, but the loop must PUSH, not
  //     overwrite, or a future multi-report tool silently loses usage.
  //   - the non-text_delta SubagentChildEvent arms (tool_use_start / tool_result
  //     / terminal — the ones a real child emits in task-03) flow through the
  //     subagent_event wrapper intact.
  //   - events emitted BEFORE a tool throws still flush, ordered ahead of the
  //     (error) tool_result — a child can emit lifecycle events then fail.
  // -------------------------------------------------------------------------
  it("reportUsage called twice in one call accumulates BOTH reports (additive, not last-wins)", async () => {
    // A tool that reports two distinct usages in a single call. The loop's
    // per-batch buffer must retain both (push semantics), and the post-batch
    // fold must sum both — total reported = {in:5,out:7} + {in:1,out:2}.
    const multiReportTool = defineTool({
      name: "multi_report_tool",
      description: "reports usage twice",
      inputSchema: z.object({}).passthrough(),
      call: async (_input, _platform, context) => {
        context.reportUsage?.({ inputTokens: 5, outputTokens: 7, cacheReadTokens: 0 });
        context.reportUsage?.({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 });
        return "reported-twice";
      },
    });

    const provider = new MockProvider([
      [
        { type: "tool_use", id: "m1", name: "multi_report_tool", input: {} },
        {
          type: "message_stop",
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
        },
      ],
      [
        { type: "text_delta", text: "done" },
        {
          type: "message_stop",
          stopReason: "end_turn",
          usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0 },
        },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([multiReportTool]));

    const { terminal } = await collectEvents(agentLoop(params));

    expect(terminal.reason).toBe("agent_done");
    // message-stop total (13/7) + report#1 (5/7) + report#2 (1/2) = 19/16.
    // If the loop overwrote instead of accumulating, we'd see only the last
    // report folded (13+1 / 7+2 = 14/9) — this asserts both landed.
    expect(terminal.usage).toEqual({
      inputTokens: 19,
      outputTokens: 16,
      cacheReadTokens: 0,
    });
  });

  it("forwards a non-text_delta child event arm (terminal) intact through subagent_event", async () => {
    // task-03's child emits tool_use_start / tool_result / terminal arms — not
    // just text_delta. Prove a `terminal` SubagentChildEvent survives the
    // wrapper unchanged (reason, usage, and optional errorMessage all intact).
    const terminalEmitTool = defineTool({
      name: "terminal_emit_tool",
      description: "emits a terminal child event",
      inputSchema: z.object({}).passthrough(),
      call: async (_input, _platform, context) => {
        context.emitEvent?.({
          type: "terminal",
          reason: "agent_done",
          usage: { inputTokens: 4, outputTokens: 6, cacheReadTokens: 0 },
        });
        return "spawned";
      },
    });

    const provider = new MockProvider([
      [
        { type: "tool_use", id: "term1", name: "terminal_emit_tool", input: {} },
        { type: "message_stop", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "fin" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([terminalEmitTool]));

    const { events } = await collectEvents(agentLoop(params));

    const subEvent = events.find((e) => e.type === "subagent_event");
    if (subEvent?.type !== "subagent_event") throw new Error("expected subagent_event");
    expect(subEvent.taskId).toBe("term1");
    expect(subEvent.event).toEqual({
      type: "terminal",
      reason: "agent_done",
      usage: { inputTokens: 4, outputTokens: 6, cacheReadTokens: 0 },
    });
  });

  it("forwards a tool_use_start child event arm with its toolInput payload intact", async () => {
    // The tool_use_start arm carries an arbitrary `toolInput` (unknown) — assert
    // a structured payload round-trips unmodified through the wrapper.
    const childToolUseEmitTool = defineTool({
      name: "child_tooluse_emit_tool",
      description: "emits a child tool_use_start event",
      inputSchema: z.object({}).passthrough(),
      call: async (_input, _platform, context) => {
        context.emitEvent?.({
          type: "tool_use_start",
          toolName: "grep",
          toolInput: { pattern: "TODO", path: "/src" },
        });
        return "spawned";
      },
    });

    const provider = new MockProvider([
      [
        { type: "tool_use", id: "cu1", name: "child_tooluse_emit_tool", input: {} },
        { type: "message_stop", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "fin" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([childToolUseEmitTool]));

    const { events } = await collectEvents(agentLoop(params));

    const subEvent = events.find((e) => e.type === "subagent_event");
    if (subEvent?.type !== "subagent_event") throw new Error("expected subagent_event");
    expect(subEvent.taskId).toBe("cu1");
    expect(subEvent.event).toEqual({
      type: "tool_use_start",
      toolName: "grep",
      toolInput: { pattern: "TODO", path: "/src" },
    });
  });

  it("flushes events emitted BEFORE a throw, ordered ahead of the (error) tool_result", async () => {
    // A tool emits a child event and THEN throws. The emitted event must still
    // surface (child pushed it before failing) AND land before the error
    // tool_result — the same batch-before-result ordering as the success path.
    // Guards the emit path against loss-on-error, mirroring T14 for usage.
    const emitThenThrowTool = defineTool({
      name: "emit_then_throw_tool",
      description: "emits a child event then throws",
      inputSchema: z.object({}).passthrough(),
      call: async (_input, _platform, context) => {
        context.emitEvent?.({ type: "text_delta", text: "pre-throw" });
        throw new Error("boom-after-emit");
      },
    });

    const provider = new MockProvider([
      [
        { type: "tool_use", id: "et1", name: "emit_then_throw_tool", input: {} },
        { type: "message_stop", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "recovered" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([emitThenThrowTool]));

    const { events, terminal } = await collectEvents(agentLoop(params));
    expect(terminal.reason).toBe("agent_done");

    // The emitted event surfaced despite the throw...
    const subIdx = events.findIndex((e) => e.type === "subagent_event");
    const resultIdx = events.findIndex((e) => e.type === "tool_result");
    expect(subIdx).toBeGreaterThanOrEqual(0);
    // ...and is ordered before the (error) tool_result for the same call.
    expect(resultIdx).toBeGreaterThan(subIdx);

    const subEvent = events[subIdx];
    if (subEvent?.type !== "subagent_event") throw new Error("expected subagent_event");
    expect(subEvent.taskId).toBe("et1");
    expect(subEvent.event.type).toBe("text_delta");
    if (subEvent.event.type !== "text_delta") throw new Error("unreachable");
    expect(subEvent.event.text).toBe("pre-throw");

    // The tool_result is the error from the throw.
    const toolResult = events[resultIdx];
    if (toolResult?.type !== "tool_result") throw new Error("expected tool_result");
    expect(toolResult.isError).toBe(true);
    expect(String(toolResult.result)).toBe("boom-after-emit");
  });

  it("resets the child-event buffer between calls: a non-emitting tool after an emitting one gets no stray subagent_event", async () => {
    // emit_tool (emits child-a, child-b) then ok_tool (emits nothing) in ONE
    // turn. The buffer reset after the first tool_result must leave ok_tool with
    // an empty buffer — no subagent_event may be attributed to ok_tool's call.
    const provider = new MockProvider([
      [
        { type: "tool_use", id: "e1", name: "emit_tool", input: {} },
        { type: "tool_use", id: "o1", name: "ok_tool", input: {} },
        { type: "message_stop", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "fin" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const params = makeParams(provider, new ToolRegistry([emittingTool, okTool]));

    const { events } = await collectEvents(agentLoop(params));

    // Both subagent_events belong to the FIRST call (e1); none leak onto o1.
    const subEvents = events.filter((e) => e.type === "subagent_event");
    expect(subEvents).toHaveLength(2);
    for (const se of subEvents) {
      if (se.type !== "subagent_event") throw new Error("unreachable");
      expect(se.taskId).toBe("e1");
    }

    // Positional: every subagent_event precedes the FIRST tool_result (emit_tool's);
    // ok_tool's result (the second) has no subagent_event after the first result.
    const resultIdxs = events
      .map((e, i) => (e.type === "tool_result" ? i : -1))
      .filter((i) => i >= 0);
    expect(resultIdxs).toHaveLength(2);
    const firstResultIdx = resultIdxs[0]!;
    const secondResultIdx = resultIdxs[1]!;
    const subIdxs = events
      .map((e, i) => (e.type === "subagent_event" ? i : -1))
      .filter((i) => i >= 0);
    for (const i of subIdxs) {
      expect(i).toBeLessThan(firstResultIdx);
    }
    // No subagent_event sits between the two tool_results (ok_tool's flush window).
    for (const i of subIdxs) {
      expect(i > firstResultIdx && i < secondResultIdx).toBe(false);
    }
  });
});

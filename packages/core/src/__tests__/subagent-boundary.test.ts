import { describe, it, expect } from "vitest";
import { z } from "zod";

import { Agent } from "../agent.js";
import { createTaskTool } from "../tools/builtin/task.js";
import { collectEvents } from "../utils/collect.js";
import { defineTool } from "../types/tool.js";
import type { Provider, ProviderEvent, ProviderRequest } from "../types/provider.js";
import type { Platform, ExecResult } from "../types/platform.js";
import type { AgentEvent, Terminal, SubagentChildEvent } from "../types/events.js";

// ===========================================================================
// Task 04 — parent/child boundary guarantee (T10-T12).
//
// A full parent -> child -> parent flow where the child DELIBERATELY tries to
// leak: it runs a tool returning a provider-shaped object carrying a unique
// marker string, so the raw payload lands in the child's `messages` transcript.
// The boundary (sanitizeChildEvent + the loop flush) must ensure NONE of that
// crosses onto the parent's stream. Assertions are structural + marker-based so
// a future refactor that reintroduces a leak fails here.
// ===========================================================================

// Forbidden leak markers — these live ONLY inside the child's raw tool result /
// transcript and must never surface on the parent stream. The child tool NAME
// ("leaky_child_tool") is intentionally allowed to appear (as `toolName`).
const TRANSCRIPT_MARKER = "CHILD_TRANSCRIPT_MARKER";
const RAW_NESTED_PAYLOAD = '"nested":{"provider":"raw"}';

// ---------------------------------------------------------------------------
// Test doubles — mirror the loop.test.ts / task-tool.test.ts harness so parent
// and child are driven by scripted provider turns (no network).
// ---------------------------------------------------------------------------

/** Replays a scripted sequence of provider turns, one inner array per stream() call. */
class MockProvider implements Provider {
  private responses: ProviderEvent[][];
  readonly requests: ProviderRequest[] = [];

  constructor(responses: ProviderEvent[][]) {
    this.responses = responses;
  }

  async *stream(req: ProviderRequest, _signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
    this.requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    const turn = this.responses.shift();
    if (!turn) throw new Error("MockProvider: no more responses");
    for (const e of turn) yield e;
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

// A trivial child tool that returns a provider-shaped structured object carrying
// the forbidden marker. When the child runs it, this raw payload is serialized
// into the child's tool_result transcript block — the thing the boundary must
// drop from the sanitized `tool_result` child event.
const leakyChildTool = defineTool({
  name: "leaky_child_tool",
  description: "returns a structured object that must not cross the boundary",
  inputSchema: z.object({}).passthrough(),
  call: async () => ({ nested: { provider: "raw" }, marker: TRANSCRIPT_MARKER }),
});

/**
 * Build a child Agent that tries to leak: turn 1 emits text + a tool_use for
 * `leaky_child_tool`; turn 2 completes with a final assistant answer. The tool's
 * raw result lands in `terminal.messages`, so the child's transcript genuinely
 * contains the marker (proven vacuous-free by the direct-run test below).
 */
function makeLeakyChild(): Agent {
  const childProvider = new MockProvider([
    [
      { type: "text_delta", text: "child says hi" },
      { type: "tool_use", id: "child_tool_1", name: "leaky_child_tool", input: {} },
      {
        type: "message_stop",
        stopReason: "tool_use",
        usage: { inputTokens: 8, outputTokens: 4, cacheReadTokens: 0 },
      },
    ],
    [
      { type: "text_delta", text: "child final answer" },
      {
        type: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0 },
      },
    ],
  ]);
  return new Agent({
    provider: childProvider,
    tools: [leakyChildTool],
    platform: new MockPlatform(),
  });
}

/**
 * Drive a parent Agent that calls `task` once, resolving to a fresh leaky child.
 * Parent turn 1 calls `task`; turn 2 completes naturally. Usages are set so the
 * child's rolled-up usage is distinguishable in the parent total.
 */
function runParentWithLeakyChild(): Promise<{ events: AgentEvent[]; terminal: Terminal }> {
  const taskTool = createTaskTool({ resolveChild: () => makeLeakyChild() });
  const parentProvider = new MockProvider([
    [
      { type: "tool_use", id: "task1", name: "task", input: { description: "d", prompt: "sub" } },
      {
        type: "message_stop",
        stopReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 },
      },
    ],
    [
      { type: "text_delta", text: "parent done" },
      {
        type: "message_stop",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      },
    ],
  ]);
  const parent = new Agent({
    provider: parentProvider,
    tools: [taskTool],
    platform: new MockPlatform(),
  });
  return collectEvents(parent.run("go"));
}

function subagentEvents(events: AgentEvent[]): Array<Extract<AgentEvent, { type: "subagent_event" }>> {
  return events.filter(
    (e): e is Extract<AgentEvent, { type: "subagent_event" }> => e.type === "subagent_event",
  );
}

describe("subagent boundary — T10-T12 (leak-proof, end-to-end)", () => {
  // Sanity precondition (guards against a vacuous suite): the child's transcript
  // MUST actually contain the forbidden markers, so the T10/T11 absence checks
  // are meaningful. If this ever stops holding, the leak scenario is broken and
  // the boundary tests below prove nothing.
  it("precondition: the leaky child's own terminal transcript really contains the forbidden markers", async () => {
    const child = makeLeakyChild();
    const { terminal } = await collectEvents(child.run("sub"));
    expect(terminal.reason).toBe("agent_done");
    const transcript = JSON.stringify(terminal.messages);
    // The marker is a plain identifier with no JSON-special chars, so it appears
    // verbatim in the stringified transcript regardless of nesting/escaping.
    expect(transcript).toContain(TRANSCRIPT_MARKER);
    // The raw provider-shaped payload is genuinely present too: the child's tool
    // result is serialized into the tool_result block's `content` field (a JSON
    // string), so within the full transcript it appears in escaped form. Its
    // constituent keys/values are all present — proving the leak scenario is not
    // vacuous. (The T10 constant RAW_NESTED_PAYLOAD checks the UNescaped form,
    // which is what a real leak into a sanitized event — a retained raw object —
    // would produce; see T10.)
    expect(transcript).toContain("nested");
    expect(transcript).toContain("provider");
    expect(transcript).toContain("raw");
    // Sanity: the unescaped payload form does NOT appear here (it's escaped),
    // and it must equally not appear on any sanitized parent event (T10).
    expect(JSON.stringify({ nested: { provider: "raw" } })).toContain(RAW_NESTED_PAYLOAD);
  });

  // T10 — sanitized events only (E7, SC8).
  it("T10: every subagent_event on the parent stream is sanitized (no transcript, no raw result, no marker)", async () => {
    const { events } = await runParentWithLeakyChild();

    const subEvents = subagentEvents(events);
    // The leaky child emits text + tool_use_start + tool_result + terminal, so we
    // expect several sanitized events to inspect.
    expect(subEvents.length).toBeGreaterThan(0);

    for (const se of subEvents) {
      const child: SubagentChildEvent = se.event;

      // No transcript / message-shape leak.
      expect("messages" in child).toBe(false);
      expect("content" in child).toBe(false);
      // Not a Message: the sanitized union never carries a `role`.
      expect("role" in child).toBe(false);

      // The tool_result arm carries metadata only — the raw payload is dropped.
      if (child.type === "tool_result") {
        expect("result" in child).toBe(false);
        // The child tool name IS allowed to appear as toolName (not a leak).
        expect(child.toolName).toBe("leaky_child_tool");
      }

      // Strong, refactor-proof assertion: neither the transcript marker nor the
      // raw nested tool-result payload appears anywhere in the wrapped event.
      const serialized = JSON.stringify(child);
      expect(serialized).not.toContain(TRANSCRIPT_MARKER);
      expect(serialized).not.toContain(RAW_NESTED_PAYLOAD);
    }

    // Belt-and-braces: the marker/raw payload appear nowhere across the entire
    // set of subagent_events (including their taskId wrappers).
    const allSub = JSON.stringify(subEvents);
    expect(allSub).not.toContain(TRANSCRIPT_MARKER);
    expect(allSub).not.toContain(RAW_NESTED_PAYLOAD);
  });

  // T11 — result is a string (E7).
  it("T11: the task call's tool_result.result is a string and carries no transcript marker", async () => {
    const { events } = await runParentWithLeakyChild();

    const taskResult = events.find(
      (e): e is Extract<AgentEvent, { type: "tool_result" }> =>
        e.type === "tool_result" && e.toolName === "task",
    );
    if (!taskResult) throw new Error("expected a tool_result for 'task'");

    // Never an object/array/Message — the summary is a plain string.
    expect(typeof taskResult.result).toBe("string");
    const resultStr = taskResult.result as string;

    // It surfaces the child's final assistant text (not the transcript).
    expect(resultStr).toBe("child final answer");
    // And it is not a stringified transcript smuggling the marker across.
    expect(resultStr).not.toContain(TRANSCRIPT_MARKER);
    expect(resultStr).not.toContain(RAW_NESTED_PAYLOAD);
    expect(resultStr.includes('"role"')).toBe(false);
    expect(resultStr.includes('"messages"')).toBe(false);
  });

  // T12 — terminal reduced (data model).
  it("T12: the child terminal subagent_event is reduced to {type, reason, usage, errorMessage?} only", async () => {
    const { events } = await runParentWithLeakyChild();

    const terminalEvent = subagentEvents(events).find((se) => se.event.type === "terminal");
    if (!terminalEvent) throw new Error("expected a terminal subagent_event");
    const child = terminalEvent.event;
    if (child.type !== "terminal") throw new Error("unreachable");

    // Only keys within the allowed set — no `messages`, no provider-native field.
    const allowed = new Set(["type", "reason", "usage", "errorMessage"]);
    for (const key of Object.keys(child)) {
      expect(allowed.has(key)).toBe(true);
    }
    expect("messages" in child).toBe(false);

    // reason is one of the three allowed terminal reasons.
    expect(["agent_done", "max_turns_exceeded", "agent_error"]).toContain(child.reason);
    expect(child.reason).toBe("agent_done");

    // usage is a Usage-shaped object (the three base fields present, numeric) and
    // equals the child's rolled-up usage (8/4 + 2/1 = 10/5).
    expect(typeof child.usage.inputTokens).toBe("number");
    expect(typeof child.usage.outputTokens).toBe("number");
    expect(typeof child.usage.cacheReadTokens).toBe("number");
    expect(child.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 });

    // agent_done has no errorMessage.
    expect("errorMessage" in child).toBe(false);
  });

  // Optional hardening — sanitization must not have broken the usage roll-up.
  it("co-assertion: the parent terminal usage includes the child's rolled-up usage", async () => {
    const { terminal } = await runParentWithLeakyChild();

    // Parent's own tokens (100/50 + 1/1 = 101/51) PLUS the child's (10/5),
    // folded exactly once: 111/56.
    expect(terminal.reason).toBe("agent_done");
    expect(terminal.usage).toEqual({ inputTokens: 111, outputTokens: 56, cacheReadTokens: 0 });
  });
});

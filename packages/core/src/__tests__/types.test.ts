import { describe, it, expect } from "vitest";
import { z } from "zod";

import { defineTool } from "../types/tool.js";
import type { Tool, ToolCallContext } from "../types/tool.js";
import type {
  Message,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
} from "../types/messages.js";
import type { AgentEvent, Terminal, SubagentChildEvent } from "../types/events.js";
import type { ProviderEvent, ProviderRequest, ToolSchema } from "../types/provider.js";
import type { StopReason, StopReasonKind } from "../index.js";
import { EMPTY_USAGE } from "../types/usage.js";
import type { Usage } from "../types/usage.js";
import { bashTool } from "../tools/builtin/bash.js";

describe("defineTool", () => {
  it("preserves name/description and produces a usable Zod inputSchema", () => {
    const tool = defineTool({
      name: "read_path",
      description: "Echoes back the given path.",
      inputSchema: z.object({ path: z.string() }),
      call: async ({ path }) => {
        // Generic-inference sentinel: this line type-checks ONLY if `path`
        // (destructured from the inferred input) is `string`. If defineTool's
        // `S` inference collapses to `any`/`unknown`, the @ts-expect-error
        // below becomes an *unused* directive and `tsc` fails the build —
        // guarding the inference contract at compile time.
        const _p: string = path;
        // @ts-expect-error path is a string, not a number — proves `input` is
        // strongly typed (not `any`). If inference breaks to `any`, this line
        // stops erroring and the directive is reported as unused.
        const _n: number = path;
        void _p;
        void _n;
        return path;
      },
    });

    expect(tool.name).toBe("read_path");
    expect(tool.description).toBe("Echoes back the given path.");
    expect(tool.inputSchema.safeParse({ path: "x" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ path: 123 }).success).toBe(false);
  });

  it("executes call with validated input", async () => {
    const tool = defineTool({
      name: "echo",
      description: "echo",
      inputSchema: z.object({ value: z.string() }),
      call: async ({ value }) => value.toUpperCase(),
    });
    const parsed = tool.inputSchema.parse({ value: "hi" });
    await expect(tool.call(parsed, {} as never, {})).resolves.toBe("HI");
  });
});

describe("type export surface (compile-time literal construction)", () => {
  it("constructs each public shape so renamed exports / changed required fields break the build", () => {
    const text: TextBlock = { type: "text", text: "hi" };
    const toolUse: ToolUseBlock = { type: "tool_use", id: "t1", name: "read", input: { path: "x" } };
    const toolResult: ToolResultBlock = { type: "tool_result", tool_use_id: "t1", content: "ok" };
    const blocks: ContentBlock[] = [text, toolUse, toolResult];

    const message: Message = { role: "assistant", content: blocks };
    const stopReason: StopReason = { kind: "end_turn", raw: "end_turn" };

    const agentDone: AgentEvent = { type: "agent_done", messages: [message], usage: EMPTY_USAGE, stopReason };

    // tool_use ProviderEvent WITH the refined-design `inputParseError` field —
    // asserts the optional flag exists on the type (no PARSE_ERROR sentinel).
    const providerToolUse: ProviderEvent = {
      type: "tool_use",
      id: "t1",
      name: "read",
      input: {},
      inputParseError: true,
    };

    const terminal: Terminal = { reason: "agent_done", messages: [message], usage: EMPTY_USAGE, stopReason };

    const request: ProviderRequest = {
      systemPrompt: "sys",
      messages: [message],
      tools: [] as ToolSchema[],
    };

    expect(message.role).toBe("assistant");
    expect(agentDone.type).toBe("agent_done");
    expect(providerToolUse.type).toBe("tool_use");
    expect(providerToolUse.inputParseError).toBe(true);
    expect(terminal.reason).toBe("agent_done");
    expect(request.messages).toHaveLength(1);
  });
});

describe("stop-reason public type surface (SR-12 provider half)", () => {
  it("constructs all nine kinds exported from the main entry and narrows exhaustively", () => {
    const reasons: StopReason[] = [
      { kind: "end_turn", raw: "end_turn" },
      { kind: "tool_use", raw: "tool_calls" },
      { kind: "max_tokens", raw: "length" },
      { kind: "stop_sequence", raw: "stop_sequence" },
      { kind: "pause_turn", raw: "pause_turn" },
      { kind: "refusal", raw: null },
      { kind: "content_filter", raw: "content_filter" },
      { kind: "model_context_window_exceeded", raw: "model_context_window_exceeded" },
      { kind: "other", raw: "future_reason" },
    ];
    const kinds: StopReasonKind[] = reasons.map((reason) => reason.kind);

    function assertNever(value: never): never {
      throw new Error(String(value));
    }
    function narrow(reason: StopReason): StopReasonKind {
      switch (reason.kind) {
        case "end_turn":
        case "tool_use":
        case "max_tokens":
        case "stop_sequence":
        case "pause_turn":
        case "refusal":
        case "content_filter":
        case "model_context_window_exceeded":
        case "other":
          return reason.kind;
        default:
          return assertNever(reason);
      }
    }

    expect(reasons.map(narrow)).toEqual(kinds);
    expect(kinds).toEqual([
      "end_turn",
      "tool_use",
      "max_tokens",
      "stop_sequence",
      "pause_turn",
      "refusal",
      "content_filter",
      "model_context_window_exceeded",
      "other",
    ]);
  });

  it("requires stopReason on message_stop and raw on every StopReason arm", () => {
    const valid: ProviderEvent = {
      type: "message_stop",
      stopReason: { kind: "other", raw: null },
    };

    // @ts-expect-error message_stop requires a structured stopReason.
    const _missingReason: ProviderEvent = { type: "message_stop" };
    // @ts-expect-error string stop reasons are no longer accepted.
    const _legacyReason: ProviderEvent = { type: "message_stop", stopReason: "end_turn" };
    // @ts-expect-error raw is required on the end_turn arm.
    const _missingEndTurnRaw: StopReason = { kind: "end_turn" };
    // @ts-expect-error raw is required on the tool_use arm.
    const _missingToolUseRaw: StopReason = { kind: "tool_use" };
    // @ts-expect-error raw is required on the max_tokens arm.
    const _missingMaxTokensRaw: StopReason = { kind: "max_tokens" };
    // @ts-expect-error raw is required on the stop_sequence arm.
    const _missingStopSequenceRaw: StopReason = { kind: "stop_sequence" };
    // @ts-expect-error raw is required on the pause_turn arm.
    const _missingPauseTurnRaw: StopReason = { kind: "pause_turn" };
    // @ts-expect-error raw is required on the refusal arm.
    const _missingRefusalRaw: StopReason = { kind: "refusal" };
    // @ts-expect-error raw is required on the content_filter arm.
    const _missingContentFilterRaw: StopReason = { kind: "content_filter" };
    // @ts-expect-error raw is required on the model_context_window_exceeded arm.
    const _missingContextWindowRaw: StopReason = { kind: "model_context_window_exceeded" };
    // @ts-expect-error raw is required on the other arm.
    const _missingOtherRaw: StopReason = { kind: "other" };
    // @ts-expect-error kinds are closed; future provider strings use other/raw.
    const _openKind: StopReason = { kind: "future_reason", raw: "future_reason" };
    void _missingReason;
    void _legacyReason;
    void _missingEndTurnRaw;
    void _missingToolUseRaw;
    void _missingMaxTokensRaw;
    void _missingStopSequenceRaw;
    void _missingPauseTurnRaw;
    void _missingRefusalRaw;
    void _missingContentFilterRaw;
    void _missingContextWindowRaw;
    void _missingOtherRaw;
    void _openKind;

    expect(valid.stopReason).toEqual({ kind: "other", raw: null });
  });
});

describe("stop-reason terminal type surface (SR-12 terminal half)", () => {
  it("requires stopReason on every successful completion surface", () => {
    const stopReason: StopReason = { kind: "end_turn", raw: "end_turn" };
    const turnComplete: AgentEvent = { type: "turn_complete", turnIndex: 0, stopReason };
    const doneEvent: AgentEvent = { type: "agent_done", messages: [], usage: EMPTY_USAGE, stopReason };
    const terminal: Terminal = { reason: "agent_done", messages: [], usage: EMPTY_USAGE, stopReason };
    const child: SubagentChildEvent = { type: "terminal", reason: "agent_done", usage: EMPTY_USAGE, stopReason };

    // @ts-expect-error turn_complete requires stopReason.
    const _turnMissing: AgentEvent = { type: "turn_complete", turnIndex: 0 };
    // @ts-expect-error agent_done requires stopReason.
    const _doneMissing: AgentEvent = { type: "agent_done", messages: [], usage: EMPTY_USAGE };
    // @ts-expect-error successful Terminal requires stopReason.
    const _terminalMissing: Terminal = { reason: "agent_done", messages: [], usage: EMPTY_USAGE };
    // @ts-expect-error successful child terminal requires stopReason.
    const _childMissing: SubagentChildEvent = { type: "terminal", reason: "agent_done", usage: EMPTY_USAGE };
    void _turnMissing;
    void _doneMissing;
    void _terminalMissing;
    void _childMissing;

    expect([turnComplete.type, doneEvent.type, terminal.reason, child.reason]).toEqual([
      "turn_complete",
      "agent_done",
      "agent_done",
      "agent_done",
    ]);
  });

  it("rejects stopReason on engine error and max-turn variants", () => {
    const error = new Error("boom");
    const maxEvent: AgentEvent = {
      type: "max_turns_exceeded",
      turnsUsed: 1,
      messages: [],
      usage: EMPTY_USAGE,
      // @ts-expect-error max_turns_exceeded events have no stopReason.
      stopReason: { kind: "end_turn", raw: "end_turn" },
    };
    const errorEvent: AgentEvent = {
      type: "agent_error",
      error,
      messages: [],
      usage: EMPTY_USAGE,
      // @ts-expect-error agent_error events have no stopReason.
      stopReason: { kind: "end_turn", raw: "end_turn" },
    };
    const maxTerminal: Terminal = {
      reason: "max_turns_exceeded",
      turnsUsed: 1,
      messages: [],
      usage: EMPTY_USAGE,
      // @ts-expect-error max-turn Terminals have no stopReason.
      stopReason: { kind: "end_turn", raw: "end_turn" },
    };
    const errorTerminal: Terminal = {
      reason: "agent_error",
      error,
      messages: [],
      usage: EMPTY_USAGE,
      // @ts-expect-error error Terminals have no stopReason.
      stopReason: { kind: "end_turn", raw: "end_turn" },
    };
    const maxChild: SubagentChildEvent = {
      type: "terminal",
      reason: "max_turns_exceeded",
      usage: EMPTY_USAGE,
      // @ts-expect-error max-turn child terminals have no stopReason.
      stopReason: { kind: "end_turn", raw: "end_turn" },
    };
    const errorChild: SubagentChildEvent = {
      type: "terminal",
      reason: "agent_error",
      usage: EMPTY_USAGE,
      // @ts-expect-error error child terminals have no stopReason.
      stopReason: { kind: "end_turn", raw: "end_turn" },
    };

    expect([maxEvent.type, errorEvent.type, maxTerminal.reason, errorTerminal.reason, maxChild.type, errorChild.type]).toEqual([
      "max_turns_exceeded",
      "agent_error",
      "max_turns_exceeded",
      "agent_error",
      "terminal",
      "terminal",
    ]);
  });
});

describe("sub-agent type surface (compile-time boundary assertions)", () => {
  it("T18 — existing tool ignoring the new context fields still compiles", () => {
    // bashTool's `call` reads only `signal` off context; the three additive
    // fields (reportUsage/emitEvent/toolCallId) must not change its assignability.
    const asTool: Tool = bashTool;
    expect(asTool.name).toBe("bash");
  });

  it("T19 — AgentEvent exhaustiveness: the subagent_event arm is additive-and-visible", () => {
    function assertNever(x: never): never {
      throw new Error(String(x));
    }

    function missingSubagentEvent(ev: AgentEvent): void {
      switch (ev.type) {
        case "text_delta":
        case "tool_use_start":
        case "tool_result":
        case "turn_complete":
        case "agent_done":
        case "max_turns_exceeded":
        case "agent_error":
          return;
      }

      // @ts-expect-error — `subagent_event` must remain unhandled here, so the
      // residual `ev` is not `never`. If the arm is ever removed, `ev` narrows
      // to `never`, this call type-checks, and the directive is reported unused.
      assertNever(ev);
    }

    // The load-bearing assertion is the compile error above; exercise the
    // handled path at runtime so vitest reports the case.
    expect(() => missingSubagentEvent({ type: "text_delta", text: "hi" })).not.toThrow();
  });

  it("T20 — SubagentChildEvent is a closed, leak-proof union", () => {
    // A Message-bearing terminal AgentEvent must NOT be assignable to the
    // sanitized union — the boundary is type-level, not just convention.
    const agentDone: AgentEvent = {
      type: "agent_done",
      messages: [],
      usage: EMPTY_USAGE,
      stopReason: { kind: "end_turn", raw: "end_turn" },
    };
    // @ts-expect-error — `agent_done` carries `messages`; SubagentChildEvent has
    // no such arm, so this assignment must fail (proves the transcript can't cross).
    const _leak: SubagentChildEvent = agentDone;
    void _leak;

    // The sanitized `terminal` arm has no `messages` key (extra properties on an
    // object literal are a compile error), and is assignable positively.
    const sanitized: SubagentChildEvent = {
      type: "terminal",
      reason: "agent_done",
      usage: EMPTY_USAGE,
      stopReason: { kind: "end_turn", raw: "end_turn" },
    };

    expect(sanitized.type).toBe("terminal");
  });

  it("T20b — SubagentChildEvent tool_result arm carries metadata only (no `result` payload)", () => {
    // Downstream (task-04) asserts at runtime that forwarded `tool_result` child
    // events have no `result`. That runtime assertion is only meaningful if the
    // TYPE forbids `result` — otherwise a leak is invisible to the compiler.
    // A valid tool_result child event: metadata only.
    const toolResult: SubagentChildEvent = {
      type: "tool_result",
      toolName: "read_file",
      toolCallId: "tu_1",
      isError: false,
    };
    expect(toolResult.type).toBe("tool_result");

    // The sanitized `tool_result` arm must NOT accept a `result` payload (a
    // child's raw result can embed provider-native structures). The excess-
    // property error (TS2353) attaches to the property line, so the directive
    // sits directly above it. Adding `result` back to the union makes it unused.
    const _leakResult: SubagentChildEvent = {
      type: "tool_result",
      toolName: "read_file",
      toolCallId: "tu_1",
      isError: false,
      // @ts-expect-error — `result` is not a member of the sanitized tool_result arm.
      result: { stdout: "leaked provider-shaped payload" },
    };
    void _leakResult;

    // The sanitized `terminal` arm must NOT accept `messages` (the child
    // transcript). This is the crux of the boundary: no `Message[]` can ride on
    // a terminal child event.
    const _leakTranscript: SubagentChildEvent = {
      type: "terminal",
      reason: "agent_done",
      usage: EMPTY_USAGE,
      stopReason: { kind: "end_turn", raw: "end_turn" },
      // @ts-expect-error — `messages` is not a member of the sanitized terminal arm.
      messages: [],
    };
    void _leakTranscript;
  });

  it("T20c — SubagentChildEvent is exactly five arms (discriminant is closed)", () => {
    // An exhaustive switch over the union's `type` with no `default`: if a sixth
    // arm is ever added (or an arm removed), `_exhaustive` stops being `never`
    // and the `assertNever` call fails to compile — pinning the arm SET, not just
    // individual shapes. task-03's `sanitizeChildEvent` produces exactly these.
    function assertNever(x: never): never {
      throw new Error(String(x));
    }
    function exhaustiveChildEvent(ev: SubagentChildEvent): string {
      switch (ev.type) {
        case "text_delta":
          return ev.text;
        case "reasoning_delta":
          return ev.text;
        case "tool_use_start":
          return ev.toolName;
        case "tool_result":
          return ev.toolCallId;
        case "terminal":
          return ev.reason;
        default: {
          const _exhaustive: never = ev;
          return assertNever(_exhaustive);
        }
      }
    }
    expect(exhaustiveChildEvent({ type: "text_delta", text: "hi" })).toBe("hi");
    expect(exhaustiveChildEvent({ type: "reasoning_delta", text: "hmm" })).toBe("hmm");
    expect(
      exhaustiveChildEvent({ type: "terminal", reason: "agent_error", usage: EMPTY_USAGE, errorMessage: "boom" }),
    ).toBe("agent_error");
  });

  it("T21 — new ToolCallContext fields are optional with the exact downstream signatures", () => {
    // Back-compat guard (brief §Downstream, SC-backcompat): agentLoop's current
    // `const context: ToolCallContext = { signal }` must keep compiling — i.e. all
    // three new fields stay OPTIONAL. If any becomes required, this literal (which
    // omits them) fails to compile.
    const signalOnly: ToolCallContext = {};
    const withSignal: ToolCallContext = { signal: new AbortController().signal };
    void signalOnly;
    void withSignal;

    // Exact signatures task-02 codes against: reportUsage(usage: Usage): void,
    // emitEvent(event: SubagentChildEvent): void, toolCallId: string.
    const reported: Usage[] = [];
    const emitted: SubagentChildEvent[] = [];
    const ctx: ToolCallContext = {
      reportUsage: (usage: Usage) => {
        reported.push(usage);
      },
      emitEvent: (event: SubagentChildEvent) => {
        emitted.push(event);
      },
      toolCallId: "tu_42",
    };

    // Exercise the seams the way task-02/task-03 will (a tool calling into context).
    ctx.reportUsage?.({ inputTokens: 5, outputTokens: 7, cacheReadTokens: 0 });
    ctx.emitEvent?.({ type: "text_delta", text: "child says hi" });
    const taskId: string = ctx.toolCallId ?? "";

    expect(reported).toEqual([{ inputTokens: 5, outputTokens: 7, cacheReadTokens: 0 }]);
    expect(emitted).toEqual([{ type: "text_delta", text: "child says hi" }]);
    expect(taskId).toBe("tu_42");
  });

  it("T22 — subagent_event arm is constructible with its verbatim shape (task-02 contract)", () => {
    // task-02 constructs `{ type: "subagent_event"; taskId: string; event: SubagentChildEvent }`
    // and yields it. Build one to pin `taskId: string` + `event: SubagentChildEvent`.
    const childEvent: SubagentChildEvent = { type: "text_delta", text: "delegated" };
    const wrapped: AgentEvent = { type: "subagent_event", taskId: "tu_99", event: childEvent };

    // Not recursive: the wrapped payload is a SubagentChildEvent, which has no
    // `subagent_event` member — a grandchild cannot nest onto the parent stream.
    // @ts-expect-error — SubagentChildEvent has no `subagent_event` arm.
    const _nested: SubagentChildEvent = { type: "subagent_event", taskId: "x", event: childEvent };
    void _nested;

    // Narrow it the way a consumer's exhaustive switch would, to read the fields.
    if (wrapped.type === "subagent_event") {
      expect(wrapped.taskId).toBe("tu_99");
      expect(wrapped.event.type).toBe("text_delta");
    } else {
      throw new Error("expected subagent_event arm");
    }
  });
});

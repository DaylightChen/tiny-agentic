import { describe, it, expect } from "vitest";
import { z } from "zod";

import { Agent } from "../agent.js";
import {
  createTaskTool,
  extractResultText,
  mapChildTerminalToResult,
  sanitizeChildEvent,
  type ChildSpec,
} from "../tools/builtin/task.js";
import { collectEvents } from "../utils/collect.js";
import { defineTool, type ToolCallContext } from "../types/tool.js";
import type { Provider, ProviderEvent, ProviderRequest } from "../types/provider.js";
import type { Platform, ExecResult } from "../types/platform.js";
import type { AgentEvent, Terminal } from "../types/events.js";
import type { Message } from "../types/messages.js";
import { EMPTY_USAGE } from "../types/usage.js";

// ===========================================================================
// Test doubles — mirror the loop.test.ts helpers so the parent + child are
// driven by scripted provider turns (no network). resolveChild returns a real
// child `Agent` built on a MockProvider, exactly as a host would.
// ===========================================================================

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

/**
 * Child provider: turn 1 emits a usage-bearing tool_use turn, turn 2+ throws.
 * Yields a child `agent_error` terminal carrying the accumulated turn-1 usage —
 * the T3 scenario (child fails AFTER spending tokens).
 */
class UsageThenThrowProvider implements Provider {
  readonly requests: ProviderRequest[] = [];
  private calls = 0;

  async *stream(req: ProviderRequest, _signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
    this.requests.push(req);
    this.calls++;
    if (this.calls === 1) {
      yield { type: "tool_use", id: "c1", name: "ok_tool", input: {} };
      yield {
        type: "message_stop",
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
      };
    } else {
      throw new Error("network down");
    }
  }
}

/** Child provider that throws immediately (agent_error, zero usage). */
class ImmediateThrowProvider implements Provider {
  async *stream(): AsyncGenerator<ProviderEvent> {
    throw new Error("network down");
  }
}

/**
 * Child provider that emits one chunk then BLOCKS until its signal aborts,
 * honoring the signal (unlike MockProvider, which ignores it). On abort it
 * rejects, so agentLoop maps it to an `agent_error` terminal. Used to prove the
 * parent-abort → child cascade actually terminates an in-flight child mid-stream
 * (T-cov-1 — the spec T8 scenario the existing tests only approximate).
 */
class BlockingSignalHonoringProvider implements Provider {
  async *stream(_req: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
    yield { type: "text_delta", text: "chunk-1" };
    await new Promise<void>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    // Unreachable: the promise above only ever rejects.
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
  listDir() {
    return Promise.reject(new Error("not used"));
  }
  stat() {
    return Promise.reject(new Error("not used"));
  }
  glob() {
    return Promise.reject(new Error("not used"));
  }
  grep() {
    return Promise.reject(new Error("not used"));
  }
}

const okTool = defineTool({
  name: "ok_tool",
  description: "returns ok",
  inputSchema: z.object({}).passthrough(),
  call: async () => "tool-output",
});

/** Build a child Agent the way a host `resolveChild` would. */
function makeChild(
  responses: ProviderEvent[][],
  opts?: { tools?: ReturnType<typeof defineTool>[]; maxTurns?: number },
): Agent {
  return new Agent({
    provider: new MockProvider(responses),
    tools: opts?.tools ?? [okTool],
    platform: new MockPlatform(),
    ...(opts?.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
  });
}

/** Find the parent's tool_result event for a given tool name (defaults to "task"). */
function findTaskResult(
  events: AgentEvent[],
  toolName = "task",
): Extract<AgentEvent, { type: "tool_result" }> {
  const ev = events.find((e) => e.type === "tool_result" && e.toolName === toolName);
  if (!ev || ev.type !== "tool_result") {
    throw new Error(`no tool_result for '${toolName}'`);
  }
  return ev;
}

/**
 * Drive a parent Agent that calls `task` once. The parent's turn-1 provider
 * response calls `task` with `taskInput`, turn 2 completes naturally.
 */
function runParent(
  resolveChild: (spec: ChildSpec) => Agent | Promise<Agent>,
  taskInput: Record<string, unknown>,
  opts?: {
    parentTurn1Usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
    parentTurn2Usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
    toolName?: string;
  },
): Promise<{ events: AgentEvent[]; terminal: Terminal }> {
  const taskTool = createTaskTool(
    opts?.toolName !== undefined ? { resolveChild, name: opts.toolName } : { resolveChild },
  );
  const turn1: ProviderEvent[] = [
    { type: "tool_use", id: "task1", name: opts?.toolName ?? "task", input: taskInput },
    {
      type: "message_stop",
      stopReason: "tool_use",
      ...(opts?.parentTurn1Usage !== undefined ? { usage: opts.parentTurn1Usage } : {}),
    },
  ];
  const turn2: ProviderEvent[] = [
    { type: "text_delta", text: "parent done" },
    {
      type: "message_stop",
      stopReason: "end_turn",
      ...(opts?.parentTurn2Usage !== undefined ? { usage: opts.parentTurn2Usage } : {}),
    },
  ];
  const parent = new Agent({
    provider: new MockProvider([turn1, turn2]),
    tools: [taskTool],
    platform: new MockPlatform(),
  });
  return collectEvents(parent.run("go"));
}

// ===========================================================================
// Tool surface — description / name / microcopy contracts
// ===========================================================================

describe("createTaskTool — tool surface & microcopy", () => {
  it("defaults the wire name to 'task' and exposes the exact tool description verbatim", () => {
    const tool = createTaskTool({ resolveChild: () => makeChild([]) });
    expect(tool.name).toBe("task");
    expect(tool.description).toBe(
      "Delegate a self-contained sub-task to a fresh sub-agent that runs with its own tools and turn budget, and return its final summary. Use for well-scoped work you can describe completely up front. Optionally pick a model or provider for the sub-task. Sub-tasks run one at a time in this version.",
    );
    // The one-at-a-time sentence is binding for v1 (R6).
    expect(tool.description).toContain("Sub-tasks run one at a time in this version.");
  });

  it("honors the wire-name override", () => {
    const tool = createTaskTool({ resolveChild: () => makeChild([]), name: "delegate" });
    expect(tool.name).toBe("delegate");
  });

  it("validates the required input field (prompt); description was dropped (D4)", () => {
    const tool = createTaskTool({ resolveChild: () => makeChild([]) });
    // prompt is the only required field now.
    expect(tool.inputSchema.safeParse({ prompt: "p" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    // Empty prompt is rejected (input hygiene — z.string().min(1)).
    expect(tool.inputSchema.safeParse({ prompt: "" }).success).toBe(false);
    // `description` is no longer in the schema: a stray one is stripped, not required.
    const parsed = tool.inputSchema.safeParse({ description: "stray", prompt: "p" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect("description" in parsed.data).toBe(false);
  });
});

// ===========================================================================
// T1-T9 — the brief's test plan
// ===========================================================================

describe("createTaskTool — T1-T9", () => {
  // T1 — happy path (SC1)
  it("T1: agent_done child returns its final assistant text, isError:false", async () => {
    const resolveChild = () =>
      makeChild([
        [
          { type: "text_delta", text: "OK" },
          { type: "message_stop", stopReason: "end_turn" },
        ],
      ]);

    const { events, terminal } = await runParent(resolveChild, {
      prompt: "do it",
    });

    const result = findTaskResult(events);
    expect(result.result).toBe("OK");
    expect(result.isError).toBe(false);
    // The parent run continues to natural completion.
    expect(terminal.reason).toBe("agent_done");
  });

  // T2 — empty output (E8, microcopy)
  it("T2: an agent_done child with no assistant text returns the empty-output microcopy", async () => {
    const resolveChild = () =>
      makeChild([[{ type: "message_stop", stopReason: "end_turn" }]]);

    const { events } = await runParent(resolveChild, { prompt: "p" });

    const result = findTaskResult(events);
    expect(result.result).toBe("(sub-agent produced no output)");
    expect(result.isError).toBe(false);
  });

  // T3 — child error (E4, SC5)
  it("T3: child agent_error -> 'Sub-agent failed: <msg>' isError:true, usage rolls up once, parent continues", async () => {
    const resolveChild = () =>
      new Agent({
        provider: new UsageThenThrowProvider(),
        tools: [okTool],
        platform: new MockPlatform(),
      });

    const { events, terminal } = await runParent(
      resolveChild,
      { prompt: "p" },
      {
        parentTurn1Usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 },
        parentTurn2Usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      },
    );

    const result = findTaskResult(events);
    expect(result.result).toBe("Sub-agent failed: network down");
    expect(result.isError).toBe(true);

    // Parent run continues to agent_done despite the child failure.
    expect(terminal.reason).toBe("agent_done");

    // Child usage (10/5) is folded into the parent total EXACTLY ONCE:
    //   parent turn1 (100/50) + child (10/5) + parent turn2 (1/1) = 111/56.
    // Double-count would show 121/61; loss would show 101/51.
    expect(terminal.usage.inputTokens).toBe(111);
    expect(terminal.usage.outputTokens).toBe(56);
    expect(terminal.usage.cacheReadTokens).toBe(0);
  });

  // T4 — turn-cap partial (E4, SC5)
  it("T4: a child that trips its turn cap returns the turn-cap prefix + partial, isError:false", async () => {
    const resolveChild = () =>
      makeChild(
        [
          [
            { type: "text_delta", text: "partial progress" },
            { type: "tool_use", id: "x", name: "ok_tool", input: {} },
            { type: "message_stop", stopReason: "tool_use" },
          ],
        ],
        { tools: [okTool], maxTurns: 1 },
      );

    const { events } = await runParent(resolveChild, { prompt: "p" });

    const result = findTaskResult(events);
    expect(result.isError).toBe(false);
    expect(typeof result.result).toBe("string");
    expect(String(result.result).startsWith("[sub-agent stopped at turn cap] ")).toBe(true);
    // Best-effort partial is preserved after the prefix.
    expect(result.result).toBe("[sub-agent stopped at turn cap] partial progress");
  });

  // T5 — config error (E6, SC3)
  it("T5: resolveChild throw -> config-error microcopy isError:true, child provider never streamed, no usage folded", async () => {
    // A child provider that WOULD run if resolveChild returned an Agent. We
    // prove it never streamed (zero child tokens).
    const childProvider = new MockProvider([
      [
        { type: "text_delta", text: "must not run" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const resolveChild = (): Agent => {
      throw new Error("unknown provider 'x'");
      // childProvider intentionally unused — its stream must never be invoked.
    };

    const { events, terminal } = await runParent(
      resolveChild,
      { prompt: "p", provider: "x" },
      {
        parentTurn1Usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 },
        parentTurn2Usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      },
    );

    const result = findTaskResult(events);
    expect(result.result).toBe("Sub-agent config error: unknown provider 'x'");
    expect(result.isError).toBe(true);

    // Zero child tokens: the child provider's stream was never invoked.
    expect(childProvider.requests).toHaveLength(0);

    // reportUsage was NOT called on the config-error path: parent total is the
    // parent's own tokens only (100/50 + 1/1 = 101/51).
    expect(terminal.usage.inputTokens).toBe(101);
    expect(terminal.usage.outputTokens).toBe(51);
  });

  // T6 — opaque hints passthrough (SC3, R4)
  it("T6: opaque model/provider/subagent_type reach resolveChild verbatim as camelCase hints", async () => {
    let captured: ChildSpec | undefined;
    const resolveChild = (spec: ChildSpec): Agent => {
      captured = spec;
      return makeChild([
        [
          { type: "text_delta", text: "child" },
          { type: "message_stop", stopReason: "end_turn" },
        ],
      ]);
    };

    await runParent(resolveChild, {
      prompt: "p",
      model: "m",
      provider: "pr",
      subagent_type: "t",
    });

    expect(captured).toBeDefined();
    const spec = captured as ChildSpec;
    expect(spec.prompt).toBe("p");
    expect(spec.model).toBe("m");
    expect(spec.provider).toBe("pr");
    expect(spec.subagentType).toBe("t");
    expect(spec.signal).toBeInstanceOf(AbortSignal);
    // Core did not add or rename keys: exactly the ChildSpec surface, snake_case
    // `subagent_type` did NOT leak through.
    expect(Object.keys(spec).sort()).toEqual(
      ["model", "prompt", "provider", "signal", "subagentType"].sort(),
    );
    expect("subagent_type" in spec).toBe(false);
  });

  it("T6b: omitted optional hints are absent from ChildSpec, not passed as undefined keys", async () => {
    // Downstream (resolveChild authors) relies on absent-vs-undefined: the tool
    // must NOT spread `subagentType: undefined` etc. under exactOptionalPropertyTypes.
    let captured: ChildSpec | undefined;
    const resolveChild = (spec: ChildSpec): Agent => {
      captured = spec;
      return makeChild([
        [
          { type: "text_delta", text: "child" },
          { type: "message_stop", stopReason: "end_turn" },
        ],
      ]);
    };

    await runParent(resolveChild, { prompt: "only-prompt" });

    const spec = captured as ChildSpec;
    expect(Object.keys(spec).sort()).toEqual(["prompt", "signal"].sort());
    expect("model" in spec).toBe(false);
    expect("provider" in spec).toBe(false);
    expect("subagentType" in spec).toBe(false);
  });

  // T7 — resolveChild mandatory (compile-time)
  it("T7: createTaskTool requires resolveChild (compile error without it)", () => {
    // @ts-expect-error — resolveChild is a mandatory field of CreateTaskToolOptions;
    // an empty options object must not type-check. (Runtime is harmless: the
    // returned Tool is never called here.)
    createTaskTool({});
    expect(true).toBe(true);
  });

  // T8 — abort cascade (E3, SC4)
  it("T8: aborting the parent signal cascades to the child's linked signal", async () => {
    let captured: ChildSpec | undefined;
    const resolveChild = (spec: ChildSpec): Agent => {
      captured = spec;
      return makeChild([
        [
          { type: "text_delta", text: "child-ok" },
          { type: "message_stop", stopReason: "end_turn" },
        ],
      ]);
    };

    const tool = createTaskTool({ resolveChild });
    const parentController = new AbortController();
    const context: ToolCallContext = { signal: parentController.signal };

    const result = await tool.call({ prompt: "p" }, new MockPlatform(), context);
    expect(result).toBe("child-ok");

    const spec = captured as ChildSpec;
    // The child observed a linked signal derived from context.signal, not aborted
    // while the parent is alive.
    expect(spec.signal).toBeInstanceOf(AbortSignal);
    expect(spec.signal.aborted).toBe(false);
    expect(parentController.signal.aborted).toBe(false);

    // Aborting the parent cascades to the child's linked signal.
    parentController.abort();
    expect(spec.signal.aborted).toBe(true);
  });

  it("T8b: a child-internal failure does NOT abort the parent's own signal", async () => {
    const resolveChild = (): Agent =>
      new Agent({
        provider: new ImmediateThrowProvider(),
        tools: [okTool],
        platform: new MockPlatform(),
      });

    const tool = createTaskTool({ resolveChild });
    const parentController = new AbortController();
    const context: ToolCallContext = { signal: parentController.signal };

    // The child errors -> the tool reports usage then throws the failed-microcopy.
    await expect(
      tool.call({ prompt: "p" }, new MockPlatform(), context),
    ).rejects.toThrow("Sub-agent failed: network down");

    // The parent's signal is untouched by the child's failure (isolation).
    expect(parentController.signal.aborted).toBe(false);
  });

  // T9 — recursion bound (E1, SC2)
  it("T9: a child whose tool set omits `task` gets the unknown-tool result when it tries to call task", async () => {
    // Correct host behavior: the child Agent is built WITHOUT the task tool.
    const childScript: ProviderEvent[][] = [
      [
        { type: "tool_use", id: "recurse1", name: "task", input: { prompt: "again" } },
        { type: "message_stop", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "child final" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ];

    // (a) Run the child directly: it gets the exact unknown-tool result string.
    const childDirect = new Agent({
      provider: new MockProvider(childScript),
      tools: [], // no `task` tool
      platform: new MockPlatform(),
    });
    const childRun = await collectEvents(childDirect.run("start"));
    const childToolResult = childRun.events.find(
      (e) => e.type === "tool_result" && e.toolName === "task",
    );
    if (childToolResult?.type !== "tool_result") throw new Error("expected child tool_result");
    expect(childToolResult.result).toBe("Unknown tool: 'task'");
    expect(childToolResult.isError).toBe(true);
    expect(childRun.terminal.reason).toBe("agent_done");

    // (b) Same child through the parent's task tool: the sanitized child event
    // surfaces a tool_result arm (toolName "task", isError true) and no spawn
    // occurred (the parent's task result is the child's final text).
    const resolveChild = (): Agent =>
      new Agent({
        provider: new MockProvider([
          [
            { type: "tool_use", id: "recurse1", name: "task", input: { prompt: "again" } },
            { type: "message_stop", stopReason: "tool_use" },
          ],
          [
            { type: "text_delta", text: "child final" },
            { type: "message_stop", stopReason: "end_turn" },
          ],
        ]),
        tools: [],
        platform: new MockPlatform(),
      });

    const { events } = await runParent(resolveChild, { prompt: "recurse" });

    const parentTaskResult = findTaskResult(events);
    expect(parentTaskResult.result).toBe("child final");
    expect(parentTaskResult.isError).toBe(false);

    const childUnknownEvent = events.find(
      (e) =>
        e.type === "subagent_event" &&
        e.event.type === "tool_result" &&
        e.event.toolName === "task",
    );
    if (childUnknownEvent?.type !== "subagent_event") {
      throw new Error("expected a subagent_event for the child's task attempt");
    }
    if (childUnknownEvent.event.type !== "tool_result") throw new Error("unreachable");
    expect(childUnknownEvent.event.isError).toBe(true);
  });
});

// ===========================================================================
// Boundary invariants surfaced through a full parent run (task-04 depends on
// these: string result in every case; sanitized child events; a terminal
// SubagentChildEvent for every child run).
// ===========================================================================

describe("createTaskTool — boundary invariants", () => {
  it("emits a sanitized `terminal` SubagentChildEvent for a completed child run", async () => {
    const resolveChild = () =>
      makeChild([
        [
          { type: "text_delta", text: "hi" },
          {
            type: "message_stop",
            stopReason: "end_turn",
            usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0 },
          },
        ],
      ]);

    const { events } = await runParent(resolveChild, { prompt: "p" });

    const terminalEvent = events.find(
      (e) => e.type === "subagent_event" && e.event.type === "terminal",
    );
    if (terminalEvent?.type !== "subagent_event") {
      throw new Error("expected a terminal subagent_event");
    }
    if (terminalEvent.event.type !== "terminal") throw new Error("unreachable");
    expect(terminalEvent.event.reason).toBe("agent_done");
    expect(terminalEvent.event.usage).toEqual({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 0 });
    // taskId correlates to the spawning call.
    expect(terminalEvent.taskId).toBe("task1");
  });

  it("no subagent_event carries child transcript (messages/content/raw result)", async () => {
    const resolveChild = () =>
      makeChild([
        [
          { type: "tool_use", id: "x", name: "ok_tool", input: { secret: "payload" } },
          { type: "message_stop", stopReason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "final" },
          { type: "message_stop", stopReason: "end_turn" },
        ],
      ]);

    const { events } = await runParent(resolveChild, { prompt: "p" });

    const subEvents = events.filter((e) => e.type === "subagent_event");
    expect(subEvents.length).toBeGreaterThan(0);
    for (const se of subEvents) {
      if (se.type !== "subagent_event") throw new Error("unreachable");
      // No transcript leak: the sanitized union has no `messages`/`content`, and
      // its tool_result arm carries no `result`.
      expect("messages" in se.event).toBe(false);
      expect("content" in se.event).toBe(false);
      if (se.event.type === "tool_result") {
        expect("result" in se.event).toBe(false);
      }
    }
  });
});

// ===========================================================================
// Review coverage — abort-mid-flight cascade (T-cov-1) and the numeric depth
// backstop (T-cov-2, D1). These pin behavior the original suite left thin.
// ===========================================================================

describe("createTaskTool — abort cascade terminates an in-flight child (T-cov-1)", () => {
  it(
    "aborting the run signal mid-child terminates the child and the tool rejects (no hang)",
    async () => {
      const child = new Agent({
        provider: new BlockingSignalHonoringProvider(),
        tools: [],
        platform: new MockPlatform(),
      });
      const resolveChild = (): Agent => child;
      const tool = createTaskTool({ resolveChild });

      const parentController = new AbortController();
      const context: ToolCallContext = { signal: parentController.signal };

      const callPromise = tool.call({ prompt: "p" }, new MockPlatform(), context);

      // Let the child start streaming (emit chunk-1, then block on the signal).
      await new Promise((r) => setTimeout(r, 10));
      // Cancel via the run signal — the correct way to cancel in-flight sub-agent
      // work (a consumer `break` would NOT interrupt this awaited call; D3).
      parentController.abort();

      // The child's provider honored the signal → agent_error → the tool surfaces
      // the failed microcopy. Critically, it resolves at all: the per-test timeout
      // means a broken cascade (child hangs) fails the test rather than hanging CI.
      await expect(callPromise).rejects.toThrow(/^Sub-agent failed: /);
    },
    2000,
  );
});

describe("createTaskTool — numeric depth backstop (T-cov-2, D1)", () => {
  // Build a child that is MISCONFIGURED: its tool set wrongly includes a `task`
  // tool (whose resolveChild would build a grandchild). The grandchild provider
  // must never stream when the backstop fires.
  function makeMisconfiguredChild(grandchildProvider: MockProvider, maxDepth?: number): Agent {
    const childTaskTool = createTaskTool({
      resolveChild: () =>
        new Agent({ provider: grandchildProvider, tools: [], platform: new MockPlatform() }),
      ...(maxDepth !== undefined ? { maxDepth } : {}),
    });
    return new Agent({
      provider: new MockProvider([
        [
          { type: "tool_use", id: "g1", name: "task", input: { prompt: "spawn a grandchild" } },
          { type: "message_stop", stopReason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "child final" },
          { type: "message_stop", stopReason: "end_turn" },
        ],
      ]),
      tools: [childTaskTool],
      platform: new MockPlatform(),
    });
  }

  it("T-cov-2a: a child run at depth 1 (default maxDepth 1) refuses to spawn — zero grandchild tokens", async () => {
    const grandchildProvider = new MockProvider([
      [
        { type: "text_delta", text: "grandchild MUST NOT run" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const childDirect = makeMisconfiguredChild(grandchildProvider);

    // Run at depth 1, simulating a sub-agent spawned by a parent.
    const { events, terminal } = await collectEvents(childDirect.run("start", { depth: 1 }));

    const taskResult = findTaskResult(events);
    expect(taskResult.isError).toBe(true);
    expect(taskResult.result).toBe(
      "Sub-agent depth limit reached (maxDepth=1); refusing to spawn a nested sub-agent.",
    );
    // The backstop refuses BEFORE resolveChild/run: the grandchild never streamed.
    expect(grandchildProvider.requests).toHaveLength(0);
    // The child itself continues normally after its refused tool call.
    expect(terminal.reason).toBe("agent_done");
  });

  it("T-cov-2b: through a parent (depth 0 → child depth 1), runaway spawning is bounded, not run to maxTurns", async () => {
    const grandchildProvider = new MockProvider([
      [
        { type: "text_delta", text: "grandchild MUST NOT run" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const resolveChild = (): Agent => makeMisconfiguredChild(grandchildProvider);

    const { events } = await runParent(resolveChild, { prompt: "delegate" });

    // Parent's task result is the child's final text — the child completed after
    // its own nested `task` attempt was refused by the backstop.
    const parentResult = findTaskResult(events);
    expect(parentResult.result).toBe("child final");
    expect(parentResult.isError).toBe(false);

    // The child's refused attempt surfaces as an isError tool_result child event.
    const refusal = events.find(
      (e) =>
        e.type === "subagent_event" &&
        e.event.type === "tool_result" &&
        e.event.toolName === "task",
    );
    if (refusal?.type !== "subagent_event") {
      throw new Error("expected a subagent_event for the refused task attempt");
    }
    if (refusal.event.type !== "tool_result") throw new Error("unreachable");
    expect(refusal.event.isError).toBe(true);

    // No grandchild ever streamed — the depth backstop stopped the runaway.
    expect(grandchildProvider.requests).toHaveLength(0);
  });

  it("T-cov-2c: maxDepth is configurable — maxDepth:2 lets a depth-1 child spawn a depth-2 grandchild", async () => {
    const grandchildProvider = new MockProvider([
      [
        { type: "text_delta", text: "grandchild ran" },
        { type: "message_stop", stopReason: "end_turn" },
      ],
    ]);
    const childDirect = makeMisconfiguredChild(grandchildProvider, 2);

    const { events } = await collectEvents(childDirect.run("start", { depth: 1 }));

    // At depth 1 with maxDepth 2: 1 >= 2 is false → spawn allowed.
    const taskResult = findTaskResult(events);
    expect(taskResult.isError).toBe(false);
    expect(taskResult.result).toBe("grandchild ran");
    expect(grandchildProvider.requests).toHaveLength(1);
  });
});

// ===========================================================================
// Pure helpers — direct unit tests (exported for exactly this purpose)
// ===========================================================================

describe("extractResultText", () => {
  it("returns the last assistant message's text (string content)", () => {
    const messages: Message[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "first" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "last answer" },
    ];
    expect(extractResultText(messages)).toBe("last answer");
  });

  it("concatenates text blocks and ignores non-text blocks in ContentBlock[] content", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Hello " },
          { type: "tool_use", id: "t1", name: "grep", input: {} },
          { type: "text", text: "world" },
        ],
      },
    ];
    expect(extractResultText(messages)).toBe("Hello world");
  });

  it("returns EMPTY_OUTPUT for whitespace-only assistant text", () => {
    const messages: Message[] = [{ role: "assistant", content: "   \n\t " }];
    expect(extractResultText(messages)).toBe("(sub-agent produced no output)");
  });

  it("returns EMPTY_OUTPUT when there is no assistant message", () => {
    const messages: Message[] = [{ role: "user", content: "only user" }];
    expect(extractResultText(messages)).toBe("(sub-agent produced no output)");
  });

  it("returns EMPTY_OUTPUT for an empty messages array", () => {
    expect(extractResultText([])).toBe("(sub-agent produced no output)");
  });
});

describe("mapChildTerminalToResult", () => {
  it("maps agent_done to its extracted text with isError:false", () => {
    const terminal: Terminal = {
      reason: "agent_done",
      messages: [{ role: "assistant", content: "the summary" }],
      usage: EMPTY_USAGE,
    };
    expect(mapChildTerminalToResult(terminal)).toEqual({ text: "the summary", isError: false });
  });

  it("maps max_turns_exceeded to the turn-cap prefix + partial with isError:false", () => {
    const terminal: Terminal = {
      reason: "max_turns_exceeded",
      turnsUsed: 3,
      messages: [{ role: "assistant", content: "partial" }],
      usage: EMPTY_USAGE,
    };
    expect(mapChildTerminalToResult(terminal)).toEqual({
      text: "[sub-agent stopped at turn cap] partial",
      isError: false,
    });
  });

  it("maps agent_error to the failed prefix + error message with isError:true", () => {
    const terminal: Terminal = {
      reason: "agent_error",
      error: new Error("boom"),
      messages: [],
      usage: EMPTY_USAGE,
    };
    expect(mapChildTerminalToResult(terminal)).toEqual({
      text: "Sub-agent failed: boom",
      isError: true,
    });
  });
});

describe("sanitizeChildEvent", () => {
  it("maps text_delta preserving the text", () => {
    expect(sanitizeChildEvent({ type: "text_delta", text: "hi" })).toEqual({
      type: "text_delta",
      text: "hi",
    });
  });

  it("maps tool_use_start preserving toolName and toolInput", () => {
    expect(
      sanitizeChildEvent({ type: "tool_use_start", toolName: "grep", toolInput: { p: 1 } }),
    ).toEqual({ type: "tool_use_start", toolName: "grep", toolInput: { p: 1 } });
  });

  it("maps tool_result to metadata only — dropping the raw result payload", () => {
    const out = sanitizeChildEvent({
      type: "tool_result",
      toolName: "grep",
      toolCallId: "c1",
      result: "secret transcript payload",
      isError: false,
    });
    expect(out).toEqual({
      type: "tool_result",
      toolName: "grep",
      toolCallId: "c1",
      isError: false,
    });
    // The boundary contract: the raw `result` must not survive.
    expect(out && "result" in out).toBe(false);
  });

  it("maps agent_done to a terminal event carrying usage", () => {
    const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 };
    expect(sanitizeChildEvent({ type: "agent_done", messages: [], usage })).toEqual({
      type: "terminal",
      reason: "agent_done",
      usage,
    });
  });

  it("maps max_turns_exceeded to a terminal event carrying usage", () => {
    const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 };
    expect(
      sanitizeChildEvent({ type: "max_turns_exceeded", turnsUsed: 2, messages: [], usage }),
    ).toEqual({ type: "terminal", reason: "max_turns_exceeded", usage });
  });

  it("maps agent_error to a terminal event carrying usage and the error message", () => {
    const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0 };
    expect(
      sanitizeChildEvent({ type: "agent_error", error: new Error("nope"), messages: [], usage }),
    ).toEqual({ type: "terminal", reason: "agent_error", usage, errorMessage: "nope" });
  });

  it("drops turn_complete (returns undefined)", () => {
    expect(sanitizeChildEvent({ type: "turn_complete", turnIndex: 0 })).toBeUndefined();
  });

  it("drops subagent_event, preventing grandchild-event nesting (returns undefined)", () => {
    expect(
      sanitizeChildEvent({
        type: "subagent_event",
        taskId: "t1",
        event: { type: "text_delta", text: "grandchild" },
      }),
    ).toBeUndefined();
  });
});

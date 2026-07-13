import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { runTools } from "../loop/runTools.js";
import { ToolRegistry } from "../tools/registry.js";
import { defineTool } from "../types/tool.js";
import type { Tool, ToolCallContext } from "../types/tool.js";
import type { Platform, ExecResult, ExecOptions } from "../types/platform.js";

declare module "../types/tool.js" {
  interface ToolCallContext {
    testAttributionScalar?: string;
    sharedTestService?: { label: string };
  }
}

type ToolExecution = ReturnType<typeof runTools> extends AsyncGenerator<infer T> ? T : never;

/**
 * Minimal Platform stub. Each filesystem op can be overridden per test;
 * unconfigured ops reject loudly so an accidental call is visible.
 */
class MockPlatform implements Platform {
  constructor(
    private overrides: Partial<{
      readFile: (path: string) => Promise<string>;
      writeFile: (path: string, content: string) => Promise<void>;
      exec: (command: string, options?: ExecOptions) => Promise<ExecResult>;
    }> = {},
  ) {}

  resolvePath(path: string): string {
    return path;
  }
  formatPath(path: string): string {
    return path;
  }
  cwd(): string {
    return "/work";
  }
  readFile(path: string): Promise<string> {
    if (this.overrides.readFile) return this.overrides.readFile(path);
    return Promise.reject(new Error("readFile not configured"));
  }
  writeFile(path: string, content: string): Promise<void> {
    if (this.overrides.writeFile) return this.overrides.writeFile(path, content);
    return Promise.reject(new Error("writeFile not configured"));
  }
  exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (this.overrides.exec) return this.overrides.exec(command, options);
    return Promise.reject(new Error("exec not configured"));
  }
  listDir() {
    return Promise.reject(new Error("listDir not configured"));
  }
  stat() {
    return Promise.reject(new Error("stat not configured"));
  }
  glob() {
    return Promise.reject(new Error("glob not configured"));
  }
  grep() {
    return Promise.reject(new Error("grep not configured"));
  }
}

function makeRegistry(tools: Tool[]): ToolRegistry {
  return new ToolRegistry(tools);
}

const ctx: ToolCallContext = {};

/** Drive the runTools generator to completion, collecting attributed envelopes. */
async function collect(gen: AsyncGenerator<ToolExecution>): Promise<ToolExecution[]> {
  const out: ToolExecution[] = [];
  for await (const execution of gen) out.push(execution);
  return out;
}

/** Assert an envelope exists at `index`, returning its tool_result event. */
function toolResultAt(
  executions: ToolExecution[],
  index: number,
): ToolExecution["event"] {
  const execution = executions[index];
  if (!execution) throw new Error(`no execution at index ${index}`);
  return execution.event;
}

describe("runTools", () => {
  it("yields an unknown-tool error event when the tool is not registered (7.4)", async () => {
    const registry = makeRegistry([]);
    const events = await collect(
      runTools(
        [{ id: "1", name: "no_such_tool", input: {} }],
        registry,
        new MockPlatform(),
        ctx,
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: {
        type: "tool_result",
        toolName: "no_such_tool",
        toolCallId: "1",
        result: "Unknown tool: 'no_such_tool'",
        isError: true,
      },
      childEvents: [],
      reportedUsage: [],
    });
  });

  it("yields a Zod validation error when input fails the schema (7.3)", async () => {
    const tool = defineTool({
      name: "needs_number",
      description: "needs a number",
      inputSchema: z.object({ n: z.number() }),
      call: async ({ n }) => n,
    });
    const registry = makeRegistry([tool]);

    const events = await collect(
      runTools(
        [{ id: "1", name: "needs_number", input: { n: "not-a-number" } }],
        registry,
        new MockPlatform(),
        ctx,
      ),
    );

    expect(events).toHaveLength(1);
    const ev = toolResultAt(events, 0);
    expect(ev.isError).toBe(true);
    expect(ev.toolName).toBe("needs_number");
    expect(String(ev.result)).toContain("invalid input");
  });

  it("yields a successful tool_result with the tool's return value", async () => {
    const tool = defineTool({
      name: "echo_ok",
      description: "returns ok",
      inputSchema: z.object({}).passthrough(),
      call: async () => ({ ok: true }),
    });
    const registry = makeRegistry([tool]);

    const events = await collect(
      runTools([{ id: "42", name: "echo_ok", input: {} }], registry, new MockPlatform(), ctx),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: {
        type: "tool_result",
        toolName: "echo_ok",
        toolCallId: "42",
        result: { ok: true },
        isError: false,
      },
      childEvents: [],
      reportedUsage: [],
    });
  });

  it("catches a thrown error from tool.call and reports its message (6.4)", async () => {
    const tool = defineTool({
      name: "explode",
      description: "throws",
      inputSchema: z.object({}).passthrough(),
      call: async () => {
        throw new Error("boom");
      },
    });
    const registry = makeRegistry([tool]);

    const events = await collect(
      runTools([{ id: "1", name: "explode", input: {} }], registry, new MockPlatform(), ctx),
    );

    expect(events).toHaveLength(1);
    const ev = toolResultAt(events, 0);
    expect(ev.isError).toBe(true);
    expect(ev.result).toBe("boom");
  });

  it("surfaces a Platform op failure as a recoverable tool error (6.16)", async () => {
    // Tool reaches into the platform; the platform rejects. The rejection must
    // surface through the same try/catch as a direct throw — proving a Platform
    // failure becomes a recoverable tool_result rather than escaping the loop.
    const tool = defineTool({
      name: "read_it",
      description: "reads a file via the platform",
      inputSchema: z.object({ path: z.string() }),
      call: async ({ path }, platform) => {
        return platform.readFile(path);
      },
    });
    const registry = makeRegistry([tool]);
    const platform = new MockPlatform({
      readFile: () => Promise.reject(new Error("ENOENT: /nope")),
    });

    const events = await collect(
      runTools(
        [{ id: "1", name: "read_it", input: { path: "/nope" } }],
        registry,
        platform,
        ctx,
      ),
    );

    expect(events).toHaveLength(1);
    const ev = toolResultAt(events, 0);
    expect(ev.isError).toBe(true);
    expect(String(ev.result)).toContain("ENOENT: /nope");
  });

  it("emits the dedicated parse-error message before Zod when parseError is true (6.1)", async () => {
    // The tool's schema would reject `{}` (requires `n`). If the parse-error
    // branch were missing, the empty input would fall through to Zod and produce
    // an "invalid input" message instead. Asserting the exact parse-error string
    // (and that it is NOT the Zod message) proves the flag is checked first.
    const tool = defineTool({
      name: "needs_number",
      description: "needs a number",
      inputSchema: z.object({ n: z.number() }),
      call: async ({ n }) => n,
    });
    const registry = makeRegistry([tool]);

    const events = await collect(
      runTools(
        [{ id: "1", name: "needs_number", input: {}, parseError: true }],
        registry,
        new MockPlatform(),
        ctx,
      ),
    );

    expect(events).toHaveLength(1);
    const ev = toolResultAt(events, 0);
    expect(ev.isError).toBe(true);
    expect(ev.result).toBe("Tool 'needs_number': could not parse tool input as JSON");
    // Must NOT be the Zod validation message.
    expect(String(ev.result)).not.toContain("invalid input");
  });

  it("executes two tool uses sequentially and yields two events in order", async () => {
    const first = defineTool({
      name: "first",
      description: "first",
      inputSchema: z.object({}).passthrough(),
      call: async () => "a",
    });
    const second = defineTool({
      name: "second",
      description: "second",
      inputSchema: z.object({}).passthrough(),
      call: async () => "b",
    });
    const registry = makeRegistry([first, second]);

    const events = await collect(
      runTools(
        [
          { id: "1", name: "first", input: {} },
          { id: "2", name: "second", input: {} },
        ],
        registry,
        new MockPlatform(),
        ctx,
      ),
    );

    expect(events).toHaveLength(2);
    expect(events.map((execution) => execution.event.toolName)).toEqual(["first", "second"]);
    expect(events.map((execution) => execution.event.toolCallId)).toEqual(["1", "2"]);
  });
});

describe("runTools — per-call attribution envelopes", () => {
  it("CB-12: gives each call a distinct context and local mutation cannot alter its sibling or base", async () => {
    const seenContexts: ToolCallContext[] = [];
    const seenIds: Array<string | undefined> = [];
    const sharedService = { label: "shared" };
    const baseReportUsage = vi.fn();
    const baseEmitEvent = vi.fn();
    const baseContext: ToolCallContext = {
      toolCallId: "base-id",
      reportUsage: baseReportUsage,
      emitEvent: baseEmitEvent,
      testAttributionScalar: "merged-scalar",
      sharedTestService: sharedService,
    };

    const tool = defineTool({
      name: "inspect_context",
      description: "inspects per-call context",
      inputSchema: z.object({ mutate: z.boolean() }),
      call: async ({ mutate }, _platform, context) => {
        seenContexts.push(context);
        seenIds.push(context.toolCallId);
        expect(context.testAttributionScalar).toBe("merged-scalar");
        expect(context.sharedTestService).toBe(sharedService);
        if (mutate) {
          context.testAttributionScalar = "local-only";
          delete context.toolCallId;
          delete context.reportUsage;
          delete context.emitEvent;
        }
        return "ok";
      },
    });

    await collect(runTools(
      [
        { id: "call-a", name: "inspect_context", input: { mutate: true } },
        { id: "call-b", name: "inspect_context", input: { mutate: false } },
      ],
      makeRegistry([tool]),
      new MockPlatform(),
      baseContext,
    ));

    expect(seenIds).toEqual(["call-a", "call-b"]);
    expect(seenContexts).toHaveLength(2);
    expect(seenContexts[0]).not.toBe(seenContexts[1]);
    expect(seenContexts[0]).not.toBe(baseContext);
    expect(seenContexts[1]).not.toBe(baseContext);
    expect(baseContext).toEqual({
      toolCallId: "base-id",
      reportUsage: baseReportUsage,
      emitEvent: baseEmitEvent,
      testAttributionScalar: "merged-scalar",
      sharedTestService: sharedService,
    });
    expect(baseReportUsage).not.toHaveBeenCalled();
    expect(baseEmitEvent).not.toHaveBeenCalled();
  });

  it("CB-14/CB-20: keeps event and usage buffers call-local even when an old context is retained", async () => {
    let staleContext: ToolCallContext | undefined;
    const firstUsage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 };
    const staleUsage = { inputTokens: 50, outputTokens: 60, cacheReadTokens: 70 };
    const secondUsage = { inputTokens: 4, outputTokens: 5, cacheReadTokens: 6 };

    const tool = defineTool({
      name: "retain_context",
      description: "retains and invokes callbacks",
      inputSchema: z.object({ call: z.number() }),
      call: async ({ call }, _platform, context) => {
        if (call === 1) {
          staleContext = context;
          context.emitEvent?.({ type: "text_delta", text: "first-live" });
          context.reportUsage?.(firstUsage);
        } else {
          staleContext?.emitEvent?.({ type: "text_delta", text: "stale-late" });
          staleContext?.reportUsage?.(staleUsage);
          context.emitEvent?.({ type: "text_delta", text: "second-live" });
          context.reportUsage?.(secondUsage);
        }
        return `result-${call}`;
      },
    });

    const executions = await collect(runTools(
      [
        { id: "one", name: "retain_context", input: { call: 1 } },
        { id: "two", name: "retain_context", input: { call: 2 } },
      ],
      makeRegistry([tool]),
      new MockPlatform(),
      {},
    ));

    expect(executions[0]?.childEvents).toEqual([
      { type: "text_delta", text: "first-live" },
      { type: "text_delta", text: "stale-late" },
    ]);
    expect(executions[0]?.reportedUsage).toEqual([firstUsage, staleUsage]);
    expect(executions[1]?.childEvents).toEqual([{ type: "text_delta", text: "second-live" }]);
    expect(executions[1]?.reportedUsage).toEqual([secondUsage]);
    expect(executions[0]?.childEvents).not.toBe(executions[1]?.childEvents);
    expect(executions[0]?.reportedUsage).not.toBe(executions[1]?.reportedUsage);
  });

  it("CB-15: does not classify or Promise-batch calls and starts the second only after the first settles", async () => {
    let releaseFirst: (() => void) | undefined;
    let firstSettled = false;
    let secondStarted = false;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const classifier = vi.fn(() => true);
    const order: string[] = [];

    const first = defineTool({
      name: "task_like_first",
      description: "unmarked Task-like call",
      inputSchema: z.object({}),
      isConcurrencySafe: classifier,
      call: async () => {
        order.push("first:start");
        await firstGate;
        firstSettled = true;
        order.push("first:end");
        return "first";
      },
    });
    const second = defineTool({
      name: "task_like_second",
      description: "unmarked Task-like call",
      inputSchema: z.object({}),
      isConcurrencySafe: classifier,
      call: async () => {
        secondStarted = true;
        order.push("second:start");
        expect(firstSettled).toBe(true);
        return "second";
      },
    });

    const collecting = collect(runTools(
      [
        { id: "one", name: first.name, input: {} },
        { id: "two", name: second.name, input: {} },
      ],
      makeRegistry([first, second]),
      new MockPlatform(),
      {},
    ));
    await Promise.resolve();
    await Promise.resolve();

    expect(secondStarted).toBe(false);
    expect(classifier).not.toHaveBeenCalled();
    releaseFirst?.();
    await collecting;
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
    expect(classifier).not.toHaveBeenCalled();
  });

  it("does not leak an early-return tool-use id into a later executable call", async () => {
    let seenBySecond: string | undefined = "UNSET";
    const second = defineTool({
      name: "second",
      description: "records the toolCallId it observes",
      inputSchema: z.object({}).passthrough(),
      call: async (_input, _platform, context) => {
        seenBySecond = context.toolCallId;
        return "ok";
      },
    });
    const baseContext: ToolCallContext = {};

    await collect(runTools(
      [
        { id: "unknown-1", name: "no_such_tool", input: {} },
        { id: "second-2", name: "second", input: {} },
      ],
      makeRegistry([second]),
      new MockPlatform(),
      baseContext,
    ));

    expect(seenBySecond).toBe("second-2");
    expect("toolCallId" in baseContext).toBe(false);
  });
});

describe("approvalHandler gate", () => {
  it("no handler (undefined) — tool.call is invoked and success result yielded", async () => {
    // Explicit undefined (omitted 5th arg) is the blanket-allow default.
    // This test documents the contract; existing tests also rely on this behaviour.
    const callSpy = vi.fn().mockResolvedValue({ ok: true });
    const tool = defineTool({
      name: "blanket_allow",
      description: "always allowed",
      inputSchema: z.object({}).passthrough(),
      call: callSpy,
    });
    const registry = makeRegistry([tool]);

    const events = await collect(
      runTools([{ id: "1", name: "blanket_allow", input: {} }], registry, new MockPlatform(), ctx),
    );

    expect(events).toHaveLength(1);
    const ev = toolResultAt(events, 0);
    expect(ev.isError).toBe(false);
    expect(callSpy).toHaveBeenCalledOnce();
  });

  it("handler returns 'allow' — tool.call is invoked", async () => {
    const callSpy = vi.fn().mockResolvedValue({ ok: true });
    const tool = defineTool({
      name: "allowed_tool",
      description: "will be allowed",
      inputSchema: z.object({}).passthrough(),
      call: callSpy,
    });
    const registry = makeRegistry([tool]);
    const handler = vi.fn().mockResolvedValue("allow");

    const events = await collect(
      runTools(
        [{ id: "2", name: "allowed_tool", input: {} }],
        registry,
        new MockPlatform(),
        ctx,
        handler,
      ),
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(callSpy).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
    const ev = toolResultAt(events, 0);
    expect(ev.isError).toBe(false);
  });

  it("handler returns 'deny' — tool.call is NOT invoked; isError true with exact denial string", async () => {
    const callSpy = vi.fn().mockResolvedValue({ ok: true });
    const tool = defineTool({
      name: "denied_tool",
      description: "will be denied",
      inputSchema: z.object({}).passthrough(),
      call: callSpy,
    });
    const registry = makeRegistry([tool]);
    const handler = vi.fn().mockResolvedValue("deny");

    const events = await collect(
      runTools(
        [{ id: "3", name: "denied_tool", input: {} }],
        registry,
        new MockPlatform(),
        ctx,
        handler,
      ),
    );

    // tool.call must NOT have run
    expect(callSpy).not.toHaveBeenCalled();

    expect(events).toHaveLength(1);
    const ev = toolResultAt(events, 0);
    expect(ev.isError).toBe(true);
    expect(ev.toolName).toBe("denied_tool");
    // Exact string from spec §3.5 / §8.3
    expect(ev.result).toBe("Tool 'denied_tool': call denied by approvalHandler");
  });

  it("handler throws — tool.call is NOT invoked; isError true with 'approval check failed' message", async () => {
    const callSpy = vi.fn().mockResolvedValue({ ok: true });
    const tool = defineTool({
      name: "check_throws",
      description: "handler will throw",
      inputSchema: z.object({}).passthrough(),
      call: callSpy,
    });
    const registry = makeRegistry([tool]);
    const handler = vi.fn().mockRejectedValue(new Error("boom"));

    const events = await collect(
      runTools(
        [{ id: "4", name: "check_throws", input: {} }],
        registry,
        new MockPlatform(),
        ctx,
        handler,
      ),
    );

    // tool.call must NOT have run
    expect(callSpy).not.toHaveBeenCalled();

    expect(events).toHaveLength(1);
    const ev = toolResultAt(events, 0);
    expect(ev.isError).toBe(true);
    expect(ev.toolName).toBe("check_throws");
    // Must contain the sentinel phrase from spec §3.5 / §8.3
    expect(String(ev.result)).toContain("approval check failed");
    // Must also carry the original error message
    expect(String(ev.result)).toContain("boom");
  });

  it("handler receives Zod-parsed (validated) input, not raw input", async () => {
    // The schema supplies a default for `n`. Calling the tool with `{}` (raw input
    // has no `n`) means Zod will default it to 42. The handler must see `{ n: 42 }`,
    // not `{}`, proving the gate runs after — not before — Zod validation.
    const tool = defineTool({
      name: "defaulted_input",
      description: "schema with default",
      inputSchema: z.object({ n: z.number().default(42) }),
      call: async ({ n }) => n,
    });
    const registry = makeRegistry([tool]);
    const handler = vi.fn().mockResolvedValue("allow");

    await collect(
      runTools(
        [{ id: "5", name: "defaulted_input", input: {} }],
        registry,
        new MockPlatform(),
        ctx,
        handler,
      ),
    );

    expect(handler).toHaveBeenCalledOnce();
    // First argument is toolName, second is validated (Zod-parsed) input
    expect(handler).toHaveBeenCalledWith("defaulted_input", { n: 42 });
  });

  it("handler denies one tool but allows another — only the denied call is blocked", async () => {
    // Tests that the gate evaluates per-tool-call, not globally.
    const callA = vi.fn().mockResolvedValue("a-result");
    const callB = vi.fn().mockResolvedValue("b-result");
    const toolA = defineTool({
      name: "tool_a",
      description: "will be allowed",
      inputSchema: z.object({}).passthrough(),
      call: callA,
    });
    const toolB = defineTool({
      name: "tool_b",
      description: "will be denied",
      inputSchema: z.object({}).passthrough(),
      call: callB,
    });
    const registry = makeRegistry([toolA, toolB]);

    const handler = vi.fn().mockImplementation((name: string) =>
      Promise.resolve(name === "tool_a" ? "allow" : "deny"),
    );

    const events = await collect(
      runTools(
        [
          { id: "10", name: "tool_a", input: {} },
          { id: "11", name: "tool_b", input: {} },
        ],
        registry,
        new MockPlatform(),
        ctx,
        handler,
      ),
    );

    expect(events).toHaveLength(2);

    const evA = toolResultAt(events, 0);
    expect(evA.toolName).toBe("tool_a");
    expect(evA.isError).toBe(false);
    expect(callA).toHaveBeenCalledOnce();

    const evB = toolResultAt(events, 1);
    expect(evB.toolName).toBe("tool_b");
    expect(evB.isError).toBe(true);
    expect(evB.result).toBe("Tool 'tool_b': call denied by approvalHandler");
    expect(callB).not.toHaveBeenCalled();
  });
});

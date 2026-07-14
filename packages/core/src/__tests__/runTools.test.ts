import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { runTools } from "../loop/runTools.js";
import { bashTool } from "../tools/builtin/bash.js";
import { editFileTool } from "../tools/builtin/editFile.js";
import { globTool } from "../tools/builtin/glob.js";
import { grepTool } from "../tools/builtin/grep.js";
import { lsTool } from "../tools/builtin/ls.js";
import { readFileTool } from "../tools/builtin/readFile.js";
import { createTaskTool } from "../tools/builtin/task.js";
import { writeFileTool } from "../tools/builtin/writeFile.js";
import { ToolRegistry } from "../tools/registry.js";
import { defineTool } from "../types/tool.js";
import type { Tool, ToolCallContext } from "../types/tool.js";
import type { Platform, DirEntry, ExecResult, ExecOptions } from "../types/platform.js";

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
      listDir: (path: string) => Promise<DirEntry[]>;
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
  listDir(path: string) {
    if (this.overrides.listDir) return this.overrides.listDir(path);
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

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value?: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value?: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => resolvePromise(value as T);
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeStartedLatch(expected: number): { started: () => void; allStarted: Promise<void> } {
  const latch = deferred();
  let count = 0;
  return {
    started: () => {
      count += 1;
      if (count === expected) latch.resolve();
    },
    allStarted: latch.promise,
  };
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
    const concurrentLatch = makeStartedLatch(2);
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
      isConcurrencySafe: () => true,
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
        concurrentLatch.started();
        await concurrentLatch.allStarted;
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
      isConcurrencySafe: () => true,
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

    staleContext?.emitEvent?.({ type: "text_delta", text: "stale-after-completion" });
    staleContext?.reportUsage?.(staleUsage);

    expect(executions[0]?.childEvents).toEqual([
      { type: "text_delta", text: "first-live" },
      { type: "text_delta", text: "stale-late" },
      { type: "text_delta", text: "stale-after-completion" },
    ]);
    expect(executions[0]?.reportedUsage).toEqual([firstUsage, staleUsage, staleUsage]);
    expect(executions[1]?.childEvents).toEqual([{ type: "text_delta", text: "second-live" }]);
    expect(executions[1]?.reportedUsage).toEqual([secondUsage]);
    expect(executions[0]?.childEvents).not.toBe(executions[1]?.childEvents);
    expect(executions[0]?.reportedUsage).not.toBe(executions[1]?.reportedUsage);
  });

  it("CB-15: keeps unmarked Task-like calls sequential", async () => {
    const firstGate = deferred();
    const firstStarted = deferred();
    let firstSettled = false;
    let secondStarted = false;
    const order: string[] = [];

    const first = defineTool({
      name: "task_like_first",
      description: "unmarked Task-like call",
      inputSchema: z.object({}),
      call: async () => {
        order.push("first:start");
        firstStarted.resolve();
        await firstGate.promise;
        firstSettled = true;
        order.push("first:end");
        return "first";
      },
    });
    const second = defineTool({
      name: "task_like_second",
      description: "unmarked Task-like call",
      inputSchema: z.object({}),
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
    await firstStarted.promise;

    expect(secondStarted).toBe(false);
    firstGate.resolve();
    await collecting;
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
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

describe("runTools — safe-batch scheduler", () => {
  it("CB-1/CB-2: starts a safe batch together and preserves model order after reverse completion", async () => {
    const gates = [deferred(), deferred()];
    const latch = makeStartedLatch(2);
    const tool = defineTool({
      name: "safe_deferred",
      description: "controlled safe work",
      inputSchema: z.object({ index: z.number() }),
      isConcurrencySafe: () => true,
      call: async ({ index }) => {
        latch.started();
        await gates[index]!.promise;
        return `result-${index}`;
      },
    });

    let collectionSettled = false;
    const collecting = collect(runTools(
      [
        { id: "first", name: tool.name, input: { index: 0 } },
        { id: "second", name: tool.name, input: { index: 1 } },
      ],
      makeRegistry([tool]),
      new MockPlatform(),
      {},
    )).finally(() => { collectionSettled = true; });

    await latch.allStarted;
    gates[1]!.resolve();
    await Promise.resolve();
    expect(collectionSettled).toBe(false);
    gates[0]!.resolve();

    const executions = await collecting;
    expect(executions.map(({ event }) => [event.toolCallId, event.result])).toEqual([
      ["first", "result-0"],
      ["second", "result-1"],
    ]);
  });

  it("CB-3: treats safe → classifier-false → safe as temporal barriers", async () => {
    const safeBeforeGate = deferred();
    const unsafeGate = deferred();
    const safeAfterGate = deferred();
    const safeBeforeStarted = deferred();
    const unsafeStarted = deferred();
    const safeAfterStarted = deferred();
    const order: string[] = [];

    const tool = defineTool({
      name: "conditional_safety",
      description: "safe only when marked",
      inputSchema: z.object({ kind: z.enum(["safe-before", "unsafe", "safe-after"]) }),
      isConcurrencySafe: ({ kind }) => kind !== "unsafe",
      call: async ({ kind }) => {
        order.push(`${kind}:start`);
        if (kind === "safe-before") {
          safeBeforeStarted.resolve();
          await safeBeforeGate.promise;
        } else if (kind === "unsafe") {
          unsafeStarted.resolve();
          await unsafeGate.promise;
        } else {
          safeAfterStarted.resolve();
          await safeAfterGate.promise;
        }
        order.push(`${kind}:end`);
        return kind;
      },
    });

    const collecting = collect(runTools(
      [
        { id: "one", name: tool.name, input: { kind: "safe-before" } },
        { id: "two", name: tool.name, input: { kind: "unsafe" } },
        { id: "three", name: tool.name, input: { kind: "safe-after" } },
      ],
      makeRegistry([tool]),
      new MockPlatform(),
      {},
    ));

    await safeBeforeStarted.promise;
    expect(order).toEqual(["safe-before:start"]);
    safeBeforeGate.resolve();
    await unsafeStarted.promise;
    expect(order).toEqual(["safe-before:start", "safe-before:end", "unsafe:start"]);
    unsafeGate.resolve();
    await safeAfterStarted.promise;
    expect(order).toEqual([
      "safe-before:start",
      "safe-before:end",
      "unsafe:start",
      "unsafe:end",
      "safe-after:start",
    ]);
    safeAfterGate.resolve();

    const executions = await collecting;
    expect(executions.map(({ event }) => event.toolCallId)).toEqual(["one", "two", "three"]);
  });

  it.each([
    {
      label: "unknown",
      barrier: { id: "barrier", name: "missing_tool", input: {} },
      expected: "Unknown tool: 'missing_tool'",
    },
    {
      label: "provider parse-invalid",
      barrier: { id: "barrier", name: "barrier_tool", input: {}, parseError: true },
      expected: "Tool 'barrier_tool': could not parse tool input as JSON",
    },
    {
      label: "Zod-invalid",
      barrier: { id: "barrier", name: "barrier_tool", input: { value: "wrong" } },
      expected: undefined,
    },
  ])("CB-5: $label is an immediate barrier with no look-ahead", async ({ barrier, expected }) => {
    const beforeGate = deferred();
    const afterGate = deferred();
    const beforeStarted = deferred();
    const afterStarted = deferred();
    const afterClassifier = vi.fn(() => true);
    const schema = z.object({ value: z.number() });
    const safeBefore = defineTool({
      name: "safe_before_immediate_barrier",
      description: "safe before barrier",
      inputSchema: z.object({}),
      isConcurrencySafe: () => true,
      call: async () => {
        beforeStarted.resolve();
        await beforeGate.promise;
        return "before";
      },
    });
    const barrierTool = defineTool({
      name: "barrier_tool",
      description: "validation barrier",
      inputSchema: schema,
      isConcurrencySafe: () => true,
      call: vi.fn().mockResolvedValue("must not run"),
    });
    const safeAfter = defineTool({
      name: "safe_after_immediate_barrier",
      description: "safe after barrier",
      inputSchema: z.object({}),
      isConcurrencySafe: afterClassifier,
      call: async () => {
        afterStarted.resolve();
        await afterGate.promise;
        return "after";
      },
    });
    const registry = makeRegistry([safeBefore, barrierTool, safeAfter]);
    const findByName = vi.spyOn(registry, "findByName");
    const gen = runTools(
      [
        { id: "before", name: safeBefore.name, input: {} },
        barrier,
        { id: "after", name: safeAfter.name, input: {} },
      ],
      registry,
      new MockPlatform(),
      {},
    );

    const beforeResultPromise = gen.next();
    await beforeStarted.promise;
    expect(findByName.mock.calls.map(([name]) => name)).toEqual([
      safeBefore.name,
      barrier.name,
    ]);
    expect(afterClassifier).not.toHaveBeenCalled();
    beforeGate.resolve();
    expect((await beforeResultPromise).value?.event.toolCallId).toBe("before");
    expect(findByName.mock.calls.map(([name]) => name)).toEqual([
      safeBefore.name,
      barrier.name,
    ]);

    const barrierResult = await gen.next();
    expect(barrierResult.value?.event.result).toBe(
      expected ?? `Tool 'barrier_tool': invalid input — ${schema.safeParse(barrier.input).error?.message}`,
    );
    expect(findByName.mock.calls.map(([name]) => name)).toEqual([
      safeBefore.name,
      barrier.name,
    ]);
    expect(afterClassifier).not.toHaveBeenCalled();

    const afterResultPromise = gen.next();
    await afterStarted.promise;
    expect(findByName.mock.calls.map(([name]) => name)).toEqual([
      safeBefore.name,
      barrier.name,
      safeAfter.name,
    ]);
    expect(afterClassifier).toHaveBeenCalledOnce();
    afterGate.resolve();
    expect((await afterResultPromise).value?.event.toolCallId).toBe("after");
    expect((await gen.next()).done).toBe(true);
  });

  it("CB-6: invokes approvals serially and makes denial and approval throw barriers", async () => {
    let resolveFirstApproval!: (decision: "allow" | "deny") => void;
    let resolveSecondApproval!: (decision: "allow" | "deny") => void;
    const firstApproval = new Promise<"allow" | "deny">((resolve) => { resolveFirstApproval = resolve; });
    const secondApproval = new Promise<"allow" | "deny">((resolve) => { resolveSecondApproval = resolve; });
    const firstApprovalStarted = deferred();
    const secondApprovalStarted = deferred();
    const firstCallGate = deferred();
    const firstCallStarted = deferred();
    const fourthCallStarted = deferred();
    const approvalOrder: string[] = [];
    const callOrder: string[] = [];

    const tool = defineTool({
      name: "approval_safe",
      description: "safe calls with controlled approvals",
      inputSchema: z.object({ id: z.string() }),
      isConcurrencySafe: () => true,
      call: async ({ id }) => {
        callOrder.push(id);
        if (id === "one") {
          firstCallStarted.resolve();
          await firstCallGate.promise;
        }
        if (id === "four") fourthCallStarted.resolve();
        return id;
      },
    });
    const approval = vi.fn(async (_name: string, input: unknown) => {
      const id = (input as { id: string }).id;
      approvalOrder.push(id);
      if (id === "one") {
        firstApprovalStarted.resolve();
        return firstApproval;
      }
      if (id === "two") {
        secondApprovalStarted.resolve();
        return secondApproval;
      }
      if (id === "three") throw new Error("approval exploded");
      return "allow" as const;
    });
    const gen = runTools(
      ["one", "two", "three", "four"].map((id) => ({ id, name: tool.name, input: { id } })),
      makeRegistry([tool]),
      new MockPlatform(),
      {},
      approval,
    );

    const firstResultPromise = gen.next();
    await firstApprovalStarted.promise;
    expect(approvalOrder).toEqual(["one"]);
    resolveFirstApproval("allow");
    await secondApprovalStarted.promise;
    expect(approvalOrder).toEqual(["one", "two"]);
    expect(callOrder).toEqual([]);

    resolveSecondApproval("deny");
    await firstCallStarted.promise;
    expect(approvalOrder).toEqual(["one", "two"]);
    expect(callOrder).toEqual(["one"]);
    firstCallGate.resolve();
    expect((await firstResultPromise).value?.event.toolCallId).toBe("one");

    const denied = await gen.next();
    expect(denied.value?.event.result).toBe("Tool 'approval_safe': call denied by approvalHandler");
    expect(callOrder).not.toContain("two");
    expect(approvalOrder).toEqual(["one", "two"]);

    const approvalFailure = await gen.next();
    expect(approvalFailure.value?.event.result).toBe(
      "Tool 'approval_safe': approval check failed — approval exploded",
    );
    expect(callOrder).not.toContain("three");
    expect(approvalOrder).toEqual(["one", "two", "three"]);

    const fourthResultPromise = gen.next();
    await fourthCallStarted.promise;
    expect(approvalOrder).toEqual(["one", "two", "three", "four"]);
    expect((await fourthResultPromise).value?.event.toolCallId).toBe("four");
    expect((await gen.next()).done).toBe(true);
  });

  it("CB-7: waits for the prior safe result yield before approving an unmarked call alone", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started = [deferred(), deferred(), deferred()];
    const active = new Set<number>();
    const overlaps: Array<[number, number[]]> = [];
    const approvals: number[] = [];
    let safeBeforeSettled = false;
    const safe = defineTool({
      name: "safe_around_unmarked",
      description: "safe work",
      inputSchema: z.object({ index: z.union([z.literal(0), z.literal(2)]) }),
      isConcurrencySafe: () => true,
      call: async ({ index }) => {
        overlaps.push([index, [...active]]);
        active.add(index);
        started[index]!.resolve();
        await gates[index]!.promise;
        active.delete(index);
        if (index === 0) safeBeforeSettled = true;
        return index;
      },
    });
    const unmarked = defineTool({
      name: "unmarked_barrier",
      description: "must execute alone",
      inputSchema: z.object({ index: z.literal(1) }),
      call: async ({ index }) => {
        overlaps.push([index, [...active]]);
        active.add(index);
        started[index]!.resolve();
        await gates[index]!.promise;
        active.delete(index);
        return index;
      },
    });
    const approval = vi.fn(async (_name: string, input: unknown) => {
      approvals.push((input as { index: number }).index);
      return "allow" as const;
    });
    const gen = runTools(
      [
        { id: "safe-before", name: safe.name, input: { index: 0 } },
        { id: "unmarked", name: unmarked.name, input: { index: 1 } },
        { id: "safe-after", name: safe.name, input: { index: 2 } },
      ],
      makeRegistry([safe, unmarked]),
      new MockPlatform(),
      {},
      approval,
    );

    const safeBeforeResultPromise = gen.next();
    await started[0]!.promise;
    expect(safeBeforeSettled).toBe(false);
    expect(approvals).toEqual([0]);
    expect(overlaps).toEqual([[0, []]]);

    gates[0]!.resolve();
    const safeBeforeResult = await safeBeforeResultPromise;
    expect(safeBeforeSettled).toBe(true);
    expect(safeBeforeResult.value?.event.toolCallId).toBe("safe-before");
    expect(approvals).toEqual([0]);

    const unmarkedResultPromise = gen.next();
    await started[1]!.promise;
    expect(approvals).toEqual([0, 1]);
    expect(overlaps).toEqual([[0, []], [1, []]]);
    gates[1]!.resolve();
    expect((await unmarkedResultPromise).value?.event.toolCallId).toBe("unmarked");

    const safeAfterResultPromise = gen.next();
    await started[2]!.promise;
    expect(approvals).toEqual([0, 1, 2]);
    expect(overlaps).toEqual([[0, []], [1, []], [2, []]]);
    gates[2]!.resolve();
    expect((await safeAfterResultPromise).value?.event.toolCallId).toBe("safe-after");
    expect((await gen.next()).done).toBe(true);
  });

  it("CB-8: classifier false executes alone; classifier throw is exact and skips approval/call", async () => {
    const falseGate = deferred();
    const falseStarted = deferred();
    const falseClassifier = vi.fn(() => false);
    const throwingClassifier = vi.fn(() => { throw new Error("classifier exploded"); });
    const throwingCall = vi.fn().mockResolvedValue("must not run");
    const followingClassifier = vi.fn(() => true);
    const followingStarted = deferred();
    const falseTool = defineTool({
      name: "classifier_false",
      description: "false barrier",
      inputSchema: z.object({ value: z.number().default(7) }),
      isConcurrencySafe: falseClassifier,
      call: async () => {
        falseStarted.resolve();
        await falseGate.promise;
        return "false-result";
      },
    });
    const throwingTool = defineTool({
      name: "classifier_throw",
      description: "throwing barrier",
      inputSchema: z.object({}),
      isConcurrencySafe: throwingClassifier,
      call: throwingCall,
    });
    const following = defineTool({
      name: "after_classifier_throw",
      description: "following safe work",
      inputSchema: z.object({}),
      isConcurrencySafe: followingClassifier,
      call: async () => {
        followingStarted.resolve();
        return "after";
      },
    });
    const approval = vi.fn().mockResolvedValue("allow");
    const gen = runTools(
      [
        { id: "false", name: falseTool.name, input: {} },
        { id: "throw", name: throwingTool.name, input: {} },
        { id: "after", name: following.name, input: {} },
      ],
      makeRegistry([falseTool, throwingTool, following]),
      new MockPlatform(),
      {},
      approval,
    );

    const falseResultPromise = gen.next();
    await falseStarted.promise;
    expect(falseClassifier).toHaveBeenCalledOnce();
    expect(falseClassifier).toHaveBeenCalledWith({ value: 7 });
    expect(throwingClassifier).not.toHaveBeenCalled();
    falseGate.resolve();
    expect((await falseResultPromise).value?.event.result).toBe("false-result");

    const thrown = await gen.next();
    expect(thrown.value?.event.result).toBe(
      "Tool 'classifier_throw': concurrency safety check failed — classifier exploded",
    );
    expect(throwingClassifier).toHaveBeenCalledOnce();
    expect(throwingCall).not.toHaveBeenCalled();
    expect(approval).toHaveBeenCalledTimes(1);
    expect(followingClassifier).not.toHaveBeenCalled();

    const followingResultPromise = gen.next();
    await followingStarted.promise;
    expect(followingClassifier).toHaveBeenCalledOnce();
    expect(approval).toHaveBeenCalledTimes(2);
    expect((await followingResultPromise).value?.event.toolCallId).toBe("after");
    expect((await gen.next()).done).toBe(true);
  });

  it("CB-9: a safe tool throw does not suppress its sibling or permit an early yield", async () => {
    const siblingGate = deferred();
    const siblingStarted = deferred();
    const throwing = defineTool({
      name: "safe_throw",
      description: "throws safely",
      inputSchema: z.object({}),
      isConcurrencySafe: () => true,
      call: async () => { throw new Error("safe boom"); },
    });
    const sibling = defineTool({
      name: "safe_sibling",
      description: "controlled safe sibling",
      inputSchema: z.object({}),
      isConcurrencySafe: () => true,
      call: async () => {
        siblingStarted.resolve();
        await siblingGate.promise;
        return "sibling success";
      },
    });
    const gen = runTools(
      [
        { id: "throwing", name: throwing.name, input: {} },
        { id: "sibling", name: sibling.name, input: {} },
      ],
      makeRegistry([throwing, sibling]),
      new MockPlatform(),
      {},
    );

    let firstYielded = false;
    const firstResultPromise = gen.next().then((result) => {
      firstYielded = true;
      return result;
    });
    await siblingStarted.promise;
    await Promise.resolve();
    expect(firstYielded).toBe(false);
    siblingGate.resolve();

    const first = await firstResultPromise;
    const second = await gen.next();
    expect([first.value?.event, second.value?.event]).toEqual([
      {
        type: "tool_result",
        toolName: "safe_throw",
        toolCallId: "throwing",
        result: "safe boom",
        isError: true,
      },
      {
        type: "tool_result",
        toolName: "safe_sibling",
        toolCallId: "sibling",
        result: "sibling success",
        isError: false,
      },
    ]);
  });

  it("CB-10: normalizes an unexpected helper rejection with attribution and no unhandled rejection", async () => {
    const usage = { inputTokens: 3, outputTokens: 4, cacheReadTokens: 5 };
    let nameReads = 0;
    const schema = z.object({});
    const tool: Tool<typeof schema> = {
      get name() {
        nameReads += 1;
        if (nameReads === 2 || nameReads === 3) throw new Error("unexpected helper rejection");
        return "fragile_safe";
      },
      description: "forces executePrepared to reject",
      inputSchema: schema,
      isConcurrencySafe: () => true,
      call: async (_input, _platform, context) => {
        context.emitEvent?.({ type: "text_delta", text: "buffered child event" });
        context.reportUsage?.(usage);
        return "unreachable success envelope";
      },
    };
    const unhandled = vi.fn();
    const nodeProcess = Reflect.get(globalThis, "process") as NodeJS.Process;
    nodeProcess.on("unhandledRejection", unhandled);

    try {
      const executions = await collect(runTools(
        [{ id: "fragile-id", name: "fragile_safe", input: {} }],
        makeRegistry([tool]),
        new MockPlatform(),
        {},
      ));
      await new Promise<void>((resolve) => { setImmediate(resolve); });

      expect(executions).toEqual([{
        event: {
          type: "tool_result",
          toolName: "fragile_safe",
          toolCallId: "fragile-id",
          result: "unexpected helper rejection",
          isError: true,
        },
        childEvents: [{ type: "text_delta", text: "buffered child event" }],
        reportedUsage: [usage],
      }]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      nodeProcess.off("unhandledRejection", unhandled);
    }
  });

  it("CB-19: starts more than eight safe calls before any is resolved", async () => {
    const count = 12;
    const gates = Array.from({ length: count }, () => deferred());
    const latch = makeStartedLatch(count);
    const started: number[] = [];
    const tool = defineTool({
      name: "uncapped_safe",
      description: "proves the batch is not capped",
      inputSchema: z.object({ index: z.number().int().min(0).max(count - 1) }),
      isConcurrencySafe: () => true,
      call: async ({ index }) => {
        started.push(index);
        latch.started();
        await gates[index]!.promise;
        return index;
      },
    });

    const collecting = collect(runTools(
      Array.from({ length: count }, (_, index) => ({
        id: `call-${index}`,
        name: tool.name,
        input: { index },
      })),
      makeRegistry([tool]),
      new MockPlatform(),
      {},
    ));

    await latch.allStarted;
    expect(started).toEqual(Array.from({ length: count }, (_, index) => index));
    for (const gate of gates) gate.resolve();
    const executions = await collecting;
    expect(executions.map(({ event }) => event.toolCallId)).toEqual(
      Array.from({ length: count }, (_, index) => `call-${index}`),
    );
  });

  it("CB-4: marks exactly read_file, ls, glob, and grep safe among built-ins", () => {
    const taskTool = createTaskTool({
      resolveChild: () => { throw new Error("not invoked by marker inspection"); },
    });

    for (const tool of [readFileTool, lsTool, globTool, grepTool]) {
      expect(tool.isConcurrencySafe?.({} as never), tool.name).toBe(true);
    }
    for (const tool of [writeFileTool, editFileTool, bashTool, taskTool]) {
      expect(tool.isConcurrencySafe, tool.name).toBeUndefined();
    }
  });
});

describe("runTools — cancellation", () => {
  const cancellation = (id: string, name: string) => ({
    type: "tool_result" as const,
    toolName: name,
    toolCallId: id,
    result: `Tool '${name}': call cancelled before start`,
    isError: true,
  });

  it("CB-17: a pre-aborted run skips lookup, classification, approval, and calls while preserving every provider entry", async () => {
    const controller = new AbortController();
    controller.abort();
    const classifier = vi.fn(() => true);
    const call = vi.fn().mockResolvedValue("must not run");
    const approval = vi.fn().mockResolvedValue("allow");
    const tool = defineTool({
      name: "known",
      description: "known safe tool",
      inputSchema: z.object({}),
      isConcurrencySafe: classifier,
      call,
    });
    const registry = makeRegistry([tool]);
    const lookup = vi.spyOn(registry, "findByName");

    const executions = await collect(runTools(
      [
        { id: "known-id", name: "known", input: {} },
        { id: "missing-id", name: "missing", input: {}, parseError: true },
      ],
      registry,
      new MockPlatform(),
      { signal: controller.signal },
      approval,
    ));

    expect(executions.map(({ event }) => event)).toEqual([
      cancellation("known-id", "known"),
      cancellation("missing-id", "missing"),
    ]);
    expect(lookup).not.toHaveBeenCalled();
    expect(classifier).not.toHaveBeenCalled();
    expect(approval).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("CB-18: abort during serial approval cancels the approved-but-unstarted call and all remaining calls", async () => {
    const controller = new AbortController();
    const approvalStarted = deferred();
    const approvalDecision = deferred<"allow">();
    const firstCall = vi.fn().mockResolvedValue("must not run");
    const laterClassifier = vi.fn(() => true);
    const laterCall = vi.fn().mockResolvedValue("must not run");
    const first = defineTool({
      name: "approval_wait",
      description: "approval waits",
      inputSchema: z.object({}),
      isConcurrencySafe: () => true,
      call: firstCall,
    });
    const later = defineTool({
      name: "later",
      description: "must remain untouched",
      inputSchema: z.object({}),
      isConcurrencySafe: laterClassifier,
      call: laterCall,
    });
    const registry = makeRegistry([first, later]);
    const lookup = vi.spyOn(registry, "findByName");
    const approval = vi.fn(async () => {
      approvalStarted.resolve();
      return approvalDecision.promise;
    });
    const collecting = collect(runTools(
      [
        { id: "approved", name: first.name, input: {} },
        { id: "later-id", name: later.name, input: {} },
      ],
      registry,
      new MockPlatform(),
      { signal: controller.signal },
      approval,
    ));

    await approvalStarted.promise;
    controller.abort();
    approvalDecision.resolve("allow");
    const executions = await collecting;

    expect(executions.map(({ event }) => event)).toEqual([
      cancellation("approved", "approval_wait"),
      cancellation("later-id", "later"),
    ]);
    expect(lookup.mock.calls.map(([name]) => name)).toEqual(["approval_wait"]);
    expect(approval).toHaveBeenCalledOnce();
    expect(firstCall).not.toHaveBeenCalled();
    expect(laterClassifier).not.toHaveBeenCalled();
    expect(laterCall).not.toHaveBeenCalled();
  });

  it("CB-16: aborts an active safe batch honestly, awaits all starts, and never crosses the following barrier", async () => {
    const controller = new AbortController();
    const gates = [deferred(), deferred()];
    const latch = makeStartedLatch(2);
    const seenContexts: ToolCallContext[] = [];
    const safe = defineTool({
      name: "active_safe",
      description: "controlled active work",
      inputSchema: z.object({ index: z.number() }),
      isConcurrencySafe: () => true,
      call: async ({ index }, _platform, context) => {
        seenContexts.push(context);
        latch.started();
        await gates[index]!.promise;
        expect(context.signal?.aborted).toBe(true);
        return `active-${index}`;
      },
    });
    const barrierClassifier = vi.fn(() => false);
    const barrierCall = vi.fn().mockResolvedValue("must not run");
    const barrier = defineTool({
      name: "following_barrier",
      description: "must not start",
      inputSchema: z.object({}),
      isConcurrencySafe: barrierClassifier,
      call: barrierCall,
    });
    const untouchedClassifier = vi.fn(() => true);
    const untouchedCall = vi.fn().mockResolvedValue("must not run");
    const untouched = defineTool({
      name: "remaining_safe",
      description: "must not be inspected",
      inputSchema: z.object({}),
      isConcurrencySafe: untouchedClassifier,
      call: untouchedCall,
    });
    const registry = makeRegistry([safe, barrier, untouched]);
    const lookup = vi.spyOn(registry, "findByName");
    let settled = false;
    const collecting = collect(runTools(
      [
        { id: "active-a", name: safe.name, input: { index: 0 } },
        { id: "active-b", name: safe.name, input: { index: 1 } },
        { id: "barrier", name: barrier.name, input: {} },
        { id: "remaining", name: untouched.name, input: {} },
      ],
      registry,
      new MockPlatform(),
      { signal: controller.signal },
    )).finally(() => { settled = true; });

    await latch.allStarted;
    controller.abort();
    gates[1]!.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    gates[0]!.resolve();
    const executions = await collecting;

    expect(seenContexts).toHaveLength(2);
    expect(seenContexts[0]).not.toBe(seenContexts[1]);
    expect(seenContexts[0]?.signal).toBe(controller.signal);
    expect(seenContexts[1]?.signal).toBe(controller.signal);
    expect(executions.map(({ event }) => event)).toEqual([
      expect.objectContaining({ toolCallId: "active-a", result: "active-0", isError: false }),
      expect.objectContaining({ toolCallId: "active-b", result: "active-1", isError: false }),
      cancellation("barrier", "following_barrier"),
      cancellation("remaining", "remaining_safe"),
    ]);
    expect(lookup.mock.calls.map(([name]) => name)).toEqual([
      "active_safe",
      "active_safe",
      "following_barrier",
    ]);
    expect(barrierClassifier).toHaveBeenCalledOnce();
    expect(barrierCall).not.toHaveBeenCalled();
    expect(untouchedClassifier).not.toHaveBeenCalled();
    expect(untouchedCall).not.toHaveBeenCalled();
  });

  it("PT-12: pre-aborted read_file and ls do not invoke Platform methods", async () => {
    const controller = new AbortController();
    controller.abort();
    const read = vi.fn().mockResolvedValue("content");
    const list = vi.fn().mockResolvedValue([]);

    const executions = await collect(runTools(
      [
        { id: "read-id", name: "read_file", input: { path: "/f" } },
        { id: "list-id", name: "ls", input: { path: "/d" } },
      ],
      makeRegistry([readFileTool, lsTool]),
      new MockPlatform({ readFile: read, listDir: list }),
      { signal: controller.signal },
    ));

    expect(executions.map(({ event }) => event)).toEqual([
      cancellation("read-id", "read_file"),
      cancellation("list-id", "ls"),
    ]);
    expect(read).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("PT-12: active read_file and ls see abort but settle only with their deferred Platform promises", async () => {
    const controller = new AbortController();
    const readResult = deferred<string>();
    const listResult = deferred<DirEntry[]>();
    const bothStarted = makeStartedLatch(2);
    const read = vi.fn(() => {
      bothStarted.started();
      return readResult.promise;
    });
    const list = vi.fn(() => {
      bothStarted.started();
      return listResult.promise;
    });
    let settled = false;
    const collecting = collect(runTools(
      [
        { id: "read-id", name: "read_file", input: { path: "/f" } },
        { id: "list-id", name: "ls", input: { path: "/d" } },
      ],
      makeRegistry([readFileTool, lsTool]),
      new MockPlatform({ readFile: read, listDir: list }),
      { signal: controller.signal },
    )).finally(() => { settled = true; });

    await bothStarted.allStarted;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    readResult.resolve("file contents");
    await Promise.resolve();
    expect(settled).toBe(false);
    listResult.reject(new Error("list finished after abort"));

    const executions = await collecting;
    expect(executions.map(({ event }) => event)).toEqual([
      {
        type: "tool_result",
        toolName: "read_file",
        toolCallId: "read-id",
        result: { content: "file contents" },
        isError: false,
      },
      {
        type: "tool_result",
        toolName: "ls",
        toolCallId: "list-id",
        result: "list finished after abort",
        isError: true,
      },
    ]);
    expect(read).toHaveBeenCalledOnce();
    expect(list).toHaveBeenCalledOnce();
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

import { describe, it, expect } from "vitest";
import { z } from "zod";

import { runTools } from "../loop/runTools.js";
import { ToolRegistry } from "../tools/registry.js";
import { defineTool } from "../types/tool.js";
import type { Tool, ToolCallContext } from "../types/tool.js";
import type { Platform, ExecResult, ExecOptions } from "../types/platform.js";
import type { AgentEvent } from "../types/events.js";

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
}

function makeRegistry(tools: Tool[]): ToolRegistry {
  return new ToolRegistry(tools);
}

const ctx: ToolCallContext = {};

/** Drive the runTools generator to completion, collecting all events. */
async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** Assert an event exists at `index` and is a tool_result, returning it narrowed. */
function toolResultAt(
  events: AgentEvent[],
  index: number,
): Extract<AgentEvent, { type: "tool_result" }> {
  const ev = events[index];
  if (!ev) throw new Error(`no event at index ${index}`);
  if (ev.type !== "tool_result") throw new Error(`event ${index} is ${ev.type}, not tool_result`);
  return ev;
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
      type: "tool_result",
      toolName: "no_such_tool",
      toolCallId: "1",
      result: "Unknown tool: 'no_such_tool'",
      isError: true,
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
      type: "tool_result",
      toolName: "echo_ok",
      toolCallId: "42",
      result: { ok: true },
      isError: false,
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
    expect(events.map((e) => (e.type === "tool_result" ? e.toolName : e.type))).toEqual([
      "first",
      "second",
    ]);
    expect(events.map((e) => (e.type === "tool_result" ? e.toolCallId : ""))).toEqual([
      "1",
      "2",
    ]);
  });
});

/**
 * Smoke tests for task-02-core-types.
 *
 * Primary goal: verify the one runtime value (defineTool) and the public
 * export surface. Type-level correctness is guarded by the typecheck step;
 * here we confirm the runtime shapes are intact and that defineTool's generic
 * inference is working (exercised via a @ts-expect-error sentinel below).
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTool } from "../index.js";

import type {
  Message,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ContentBlock,
} from "../types/messages.js";

import type {
  Platform,
  ExecOptions,
  ExecResult,
} from "../types/platform.js";

import type {
  ToolCallContext,
} from "../types/tool.js";

import type {
  ToolSchema,
  ProviderRequest,
  ProviderEvent,
  LogEntry,
  Logger,
} from "../types/provider.js";

import type {
  AgentEvent,
  Terminal,
} from "../types/events.js";

// ─── Type inference sentinel (catches broken generics at typecheck time) ─────
//
// If defineTool's generic inference were broken (e.g. TInput collapsed to the
// base ZodType), `input` inside `call` would be typed as `z.infer<ZodType>`
// (which might be `any`). The sentinel below guards against that:
//
//   1. `const _p: string = input.path` — compiles iff TypeScript infers the
//      input as `{ path: string }`. If inference is broken and input is `any`,
//      this still compiles (assigning `any` to `string` is allowed).
//
//   2. `@ts-expect-error` on `const _mustFail: number = input.path` —
//      TypeScript must flag this as an error (string not assignable to number).
//      If inference breaks and `input` becomes `any`, the assignment compiles
//      and tsc reports "Unused '@ts-expect-error' directive", failing typecheck.
//      The two guards together catch regressions in opposite directions.

const _inferenceCheck = defineTool({
  name: "_inference_check",
  description: "Type inference sentinel — not called at runtime.",
  inputSchema: z.object({ path: z.string() }),
  call: async (input) => {
    const _p: string = input.path; // must compile: path is string
    // @ts-expect-error — string is not assignable to number; guard for generic inference
    const _n: number = input.path; // must error: string ≠ number
    return _p + String(_n);
  },
});
void _inferenceCheck;

// ─── defineTool: runtime passthrough ────────────────────────────────────────

describe("defineTool", () => {
  it("is a function", () => {
    expect(typeof defineTool).toBe("function");
  });

  it("returns the exact same object reference that was passed in", () => {
    const schema = z.object({ path: z.string() });
    const def = {
      name: "read_file",
      description: "Read a file from disk.",
      inputSchema: schema,
      call: async ({ path }: { path: string }) => path,
    };
    const tool = defineTool(def);
    expect(tool).toBe(def);
  });

  it("preserves name and description on the returned object", () => {
    const tool = defineTool({
      name: "my_tool",
      description: "Does something useful.",
      inputSchema: z.object({ value: z.string() }),
      call: async ({ value }) => value,
    });
    expect(tool.name).toBe("my_tool");
    expect(tool.description).toBe("Does something useful.");
  });

  it("preserves the inputSchema so Zod validation works at runtime", () => {
    const tool = defineTool({
      name: "greet",
      description: "Greets a user by name.",
      inputSchema: z.object({ name: z.string(), age: z.number().optional() }),
      call: async ({ name }) => `Hello, ${name}!`,
    });

    const valid = tool.inputSchema.safeParse({ name: "Alice" });
    expect(valid.success).toBe(true);

    const invalid = tool.inputSchema.safeParse({ name: 42 });
    expect(invalid.success).toBe(false);
  });

  it("supports an optional isConcurrencySafe hint", () => {
    const tool = defineTool({
      name: "safe_tool",
      description: "A concurrency-safe tool.",
      inputSchema: z.object({ path: z.string() }),
      isConcurrencySafe: () => true,
      call: async ({ path }) => path,
    });
    expect(tool.isConcurrencySafe).toBeDefined();
    expect(tool.isConcurrencySafe!({ path: "/tmp/foo" })).toBe(true);
  });
});

// ─── Public export surface smoke tests ──────────────────────────────────────
//
// These tests construct plain object literals that satisfy each exported type
// (or discriminated-union variant) and confirm no runtime errors occur. Because
// TypeScript erases types at runtime, the real value here is that the file
// *compiles* with these usages — catching missing or renamed exports, and
// verifying each discriminant string is correct.

describe("messages.ts type shapes", () => {
  it("TextBlock has type='text' and text field", () => {
    const block: TextBlock = { type: "text", text: "hello" };
    expect(block.type).toBe("text");
    expect(block.text).toBe("hello");
  });

  it("ToolUseBlock has type='tool_use', id, name, input", () => {
    const block: ToolUseBlock = { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "/tmp" } };
    expect(block.type).toBe("tool_use");
    expect(block.id).toBe("tu_1");
  });

  it("ToolResultBlock has type='tool_result', tool_use_id, content", () => {
    const block: ToolResultBlock = { type: "tool_result", tool_use_id: "tu_1", content: "file contents" };
    expect(block.type).toBe("tool_result");
    expect(block.content).toBe("file contents");
  });

  it("ToolResultBlock accepts optional is_error", () => {
    const block: ToolResultBlock = { type: "tool_result", tool_use_id: "tu_1", content: "err", is_error: true };
    expect(block.is_error).toBe(true);
  });

  it("ContentBlock is the union of all three block types (discriminated by type)", () => {
    const blocks: ContentBlock[] = [
      { type: "text", text: "hi" },
      { type: "tool_use", id: "x", name: "tool", input: {} },
      { type: "tool_result", tool_use_id: "x", content: "ok" },
    ];
    expect(blocks).toHaveLength(3);
  });

  it("Message supports user and assistant roles", () => {
    const user: Message = { role: "user", content: "Hello" };
    const assistant: Message = { role: "assistant", content: [{ type: "text", text: "Hi" }] };
    expect(user.role).toBe("user");
    expect(assistant.role).toBe("assistant");
  });
});

describe("platform.ts type shapes", () => {
  it("ExecOptions fields are all optional (empty object is valid)", () => {
    const opts: ExecOptions = {};
    expect(opts).toBeDefined();
    const full: ExecOptions = { cwd: "/tmp", timeout: 5000, env: { PATH: "/usr/bin" } };
    expect(full.timeout).toBe(5000);
  });

  it("ExecResult has stdout, stderr, exitCode", () => {
    const res: ExecResult = { stdout: "ok", stderr: "", exitCode: 0 };
    expect(res.exitCode).toBe(0);
  });

  it("Platform interface shape compiles when implemented inline", () => {
    // Confirm the shape compiles as an object literal assigned to Platform
    const platform: Platform = {
      cwd: () => "/workspace",
      readFile: async () => "",
      writeFile: async () => {},
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    };
    expect(platform.cwd()).toBe("/workspace");
  });
});

describe("provider.ts type shapes", () => {
  it("ToolSchema has name, description, inputSchema with type='object'", () => {
    const schema: ToolSchema = {
      name: "read_file",
      description: "Read a file.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    };
    expect(schema.inputSchema.type).toBe("object");
  });

  it("ProviderRequest has systemPrompt, messages, tools", () => {
    const req: ProviderRequest = {
      systemPrompt: "You are helpful.",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    };
    expect(req.systemPrompt).toBe("You are helpful.");
  });

  it("ProviderEvent covers text_delta, tool_use, message_stop variants", () => {
    const events: ProviderEvent[] = [
      { type: "text_delta", text: "Hello" },
      { type: "tool_use", id: "t1", name: "read_file", input: {} },
      { type: "message_stop", stopReason: "end_turn" },
    ];
    expect(events[0]!.type).toBe("text_delta");
    expect(events[1]!.type).toBe("tool_use");
    expect(events[2]!.type).toBe("message_stop");
  });

  it("LogEntry covers info/request_sent, info/retry_attempt, error/request_failed", () => {
    const entries: LogEntry[] = [
      {
        level: "info",
        event: "request_sent",
        request: { systemPrompt: "hi", messages: [], tools: [] },
      },
      {
        level: "info",
        event: "retry_attempt",
        attempt: 1,
        delayMs: 1000,
        error: new Error("rate limited"),
      },
      {
        level: "error",
        event: "request_failed",
        error: new Error("server error"),
      },
    ];
    expect(entries[0]!.level).toBe("info");
    expect(entries[1]!.event).toBe("retry_attempt");
    expect(entries[2]!.level).toBe("error");
  });

  it("Logger is a function type accepting LogEntry", () => {
    const logs: LogEntry[] = [];
    const logger: Logger = (entry) => { logs.push(entry); };
    logger({ level: "error", event: "request_failed", error: new Error("oops") });
    expect(logs).toHaveLength(1);
  });
});

describe("events.ts type shapes", () => {
  it("AgentEvent covers all seven variants", () => {
    const msgs: Message[] = [{ role: "user", content: "hi" }];
    const events: AgentEvent[] = [
      { type: "text_delta", text: "Hello" },
      { type: "tool_use_start", toolName: "read_file", toolInput: { path: "/tmp" } },
      { type: "tool_result", toolName: "read_file", toolCallId: "tc1", result: "data", isError: false },
      { type: "turn_complete", turnIndex: 0 },
      { type: "agent_done", messages: msgs },
      { type: "max_turns_exceeded", turnsUsed: 10, messages: msgs },
      { type: "agent_error", error: new Error("fail"), messages: msgs },
    ];
    expect(events).toHaveLength(7);
    expect(events[0]!.type).toBe("text_delta");
    expect(events[4]!.type).toBe("agent_done");
    expect(events[6]!.type).toBe("agent_error");
  });

  it("Terminal covers all three reason variants", () => {
    const msgs: Message[] = [{ role: "assistant", content: "done" }];
    const terminals: Terminal[] = [
      { reason: "agent_done", messages: msgs },
      { reason: "max_turns_exceeded", messages: msgs, turnsUsed: 5 },
      { reason: "agent_error", messages: msgs, error: new Error("boom") },
    ];
    expect(terminals[0]!.reason).toBe("agent_done");
    expect(terminals[1]!.reason).toBe("max_turns_exceeded");
    expect(terminals[2]!.reason).toBe("agent_error");
  });
});

describe("tool.ts type shapes", () => {
  it("Tool fields are all present after defineTool", () => {
    const tool = defineTool({
      name: "list_files",
      description: "List files in a directory.",
      inputSchema: z.object({ dir: z.string() }),
      call: async ({ dir }) => [dir],
    });
    expect(tool.name).toBe("list_files");
    expect(tool.description).toBe("List files in a directory.");
    expect(tool.inputSchema).toBeDefined();
    expect(typeof tool.call).toBe("function");
  });

  it("ToolCallContext is assignable from an empty object literal (interface merging baseline)", () => {
    // ToolCallContext must remain an open interface (empty body).
    // Assigning {} to it confirms it has no required fields.
    const ctx: ToolCallContext = {};
    expect(ctx).toBeDefined();
  });
});

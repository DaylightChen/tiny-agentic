import { describe, it, expect } from "vitest";

import {
  mapRequest,
  mapTools,
  ToolCallAccumulator,
  translateChunk,
} from "../providers/openai-mapper.js";
import type { Message } from "../types/messages.js";
import type { ProviderEvent, ProviderRequest, ToolSchema } from "../types/provider.js";

/**
 * Drive a sequence of raw (OpenAI-shaped) stream chunks through translateChunk
 * against a single shared ToolCallAccumulator, then flush at stream end — exactly
 * how the live provider consumes the SDK stream (the for-await loop yields
 * translateChunk events, then yields accumulator.flush() after the loop ends).
 * Chunks are plain object literals: translateChunk takes `unknown`, so no real
 * SDK objects are needed.
 */
function run(chunks: unknown[]): ProviderEvent[] {
  const acc = new ToolCallAccumulator();
  const streamed = chunks.flatMap((c) => translateChunk(c, acc));
  return [...streamed, ...acc.flush()];
}

const sampleTool: ToolSchema = {
  name: "read",
  description: "Read a file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

// ---------------------------------------------------------------------------
// Request side: mapTools
// ---------------------------------------------------------------------------

describe("mapTools", () => {
  it("maps a ToolSchema to the OpenAI function-tool shape with inputSchema → parameters", () => {
    const tools = mapTools([sampleTool]);
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.type).toBe("function");
    expect(tool.function.name).toBe("read");
    expect(tool.function.description).toBe("Read a file");
    // parameters deep-equals the original inputSchema, passed through unchanged.
    expect(tool.function.parameters).toEqual(sampleTool.inputSchema);
  });

  it("maps multiple schemas preserving order", () => {
    const second: ToolSchema = {
      name: "write",
      description: "Write a file",
      inputSchema: { type: "object", properties: { file: { type: "string" } } },
    };
    const tools = mapTools([sampleTool, second]);
    expect(tools.map((t) => t.function.name)).toEqual(["read", "write"]);
  });
});

// ---------------------------------------------------------------------------
// Request side: mapRequest — max tokens, system, empty tools
// ---------------------------------------------------------------------------

describe("mapRequest — body shape", () => {
  it("emits max_completion_tokens (NOT max_tokens) from the provider default when maxTokens absent", () => {
    const request: ProviderRequest = {
      systemPrompt: "s",
      messages: [],
      tools: [],
    };
    const params = mapRequest(request, "gpt-4o", 32000);
    expect(params.max_completion_tokens).toBe(32000);
    // Hard constraint: max_tokens must be absent (reasoning models reject it).
    expect("max_tokens" in params).toBe(false);
  });

  it("prefers request.maxTokens over the provider default when present", () => {
    const request: ProviderRequest = {
      systemPrompt: "s",
      messages: [],
      tools: [],
      maxTokens: 100,
    };
    const params = mapRequest(request, "gpt-4o", 32000);
    expect(params.max_completion_tokens).toBe(100);
    expect("max_tokens" in params).toBe(false);
  });

  it("does not set a stream flag (the provider adds that)", () => {
    const request: ProviderRequest = { systemPrompt: "s", messages: [], tools: [] };
    const params = mapRequest(request, "gpt-4o", 32000);
    expect("stream" in params).toBe(false);
  });

  it("Transform 1: prepends exactly { role: 'system', content: <systemPrompt> } as the first message", () => {
    const request: ProviderRequest = {
      systemPrompt: "You are a helpful assistant.",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    };
    const params = mapRequest(request, "gpt-4o", 32000);
    expect(params.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant.",
    });
  });

  it("includes the tools key with mapped tools when request.tools is non-empty", () => {
    const request: ProviderRequest = {
      systemPrompt: "s",
      messages: [],
      tools: [sampleTool],
    };
    const params = mapRequest(request, "gpt-4o", 32000);
    expect(params.tools).toHaveLength(1);
    expect(params.tools?.[0]?.function.parameters).toEqual(sampleTool.inputSchema);
  });

  it("omits the tools key entirely when request.tools is empty (no empty array)", () => {
    const request: ProviderRequest = { systemPrompt: "s", messages: [], tools: [] };
    const params = mapRequest(request, "gpt-4o", 32000);
    expect("tools" in params).toBe(false);
  });

  it("always includes stream_options: { include_usage: true } regardless of request shape", () => {
    const request: ProviderRequest = { systemPrompt: "s", messages: [], tools: [] };
    const params = mapRequest(request, "gpt-4o", 32000);
    expect(params.stream_options).toEqual({ include_usage: true });
  });
});

// ---------------------------------------------------------------------------
// Request side: message transforms (the highest-risk piece)
// ---------------------------------------------------------------------------

describe("mapRequest — plain string messages pass through", () => {
  it("maps a plain-string user message and a plain-string assistant message straight through", () => {
    const request: ProviderRequest = {
      systemPrompt: "s",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
      tools: [],
    };
    const params = mapRequest(request, "gpt-4o", 32000);
    // index 0 is the system message.
    expect(params.messages[1]).toEqual({ role: "user", content: "hello" });
    expect(params.messages[2]).toEqual({ role: "assistant", content: "hi there" });
  });
});

describe("mapRequest — Transform 2: assistant ContentBlock[] split", () => {
  it("flattens text into content and maps tool_use → tool_calls with JSON-stringified arguments", () => {
    const request: ProviderRequest = {
      systemPrompt: "s",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "hi" },
            { type: "tool_use", id: "call_1", name: "read", input: { path: "x" } },
          ],
        },
      ],
      tools: [],
    };
    const params = mapRequest(request, "gpt-4o", 32000);
    const msg = params.messages[1]!;

    expect(msg.role).toBe("assistant");
    expect(msg).toEqual({
      role: "assistant",
      content: "hi",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: "x" }) },
        },
      ],
    });

    // arguments is a STRING equal to JSON.stringify(input), not an object.
    const assistant = msg as Extract<typeof msg, { role: "assistant" }>;
    const args = assistant.tool_calls?.[0]?.function.arguments;
    expect(typeof args).toBe("string");
    expect(args).toBe(JSON.stringify({ path: "x" }));
  });

  it("concatenates multiple text blocks into a single content string", () => {
    const request: ProviderRequest = {
      systemPrompt: "s",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "foo " },
            { type: "text", text: "bar" },
            { type: "tool_use", id: "call_1", name: "read", input: {} },
          ],
        },
      ],
      tools: [],
    };
    const params = mapRequest(request, "gpt-4o", 32000);
    const assistant = params.messages[1] as Extract<
      (typeof params.messages)[number],
      { role: "assistant" }
    >;
    expect(assistant.content).toBe("foo bar");
  });

  it("sets content: null for an assistant message with only tool_use blocks (no text)", () => {
    const request: ProviderRequest = {
      systemPrompt: "s",
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "x" } }],
        },
      ],
      tools: [],
    };
    const params = mapRequest(request, "gpt-4o", 32000);
    const assistant = params.messages[1] as Extract<
      (typeof params.messages)[number],
      { role: "assistant" }
    >;
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls).toHaveLength(1);
  });
});

describe("mapRequest — Transform 3: batched tool_result explode (1 → N)", () => {
  it("explodes one user tool-result message into N role:'tool' messages with matching ids in order", () => {
    const toolResultMessage: Message = {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "A" },
        { type: "tool_result", tool_use_id: "call_2", content: "B" },
      ],
    };
    const request: ProviderRequest = {
      systemPrompt: "s",
      messages: [toolResultMessage],
      tools: [],
    };
    const params = mapRequest(request, "gpt-4o", 32000);
    // index 0 is system; the single user message exploded into two tool messages.
    expect(params.messages).toHaveLength(3);
    expect(params.messages[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: "A" });
    expect(params.messages[2]).toEqual({ role: "tool", tool_call_id: "call_2", content: "B" });
  });

  it("preserves order across three tool results without reordering", () => {
    const request: ProviderRequest = {
      systemPrompt: "s",
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "c1", content: "1" },
            { type: "tool_result", tool_use_id: "c2", content: "2" },
            { type: "tool_result", tool_use_id: "c3", content: "3" },
          ],
        },
      ],
      tools: [],
    };
    const params = mapRequest(request, "gpt-4o", 32000);
    const toolMsgs = params.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => (m as { tool_call_id: string }).tool_call_id)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
  });
});

describe("mapRequest — Transform 4: drop is_error, no 'Error: ' prefix", () => {
  it("maps an error tool_result to role:'tool' with content unchanged and no is_error field", () => {
    const request: ProviderRequest = {
      systemPrompt: "s",
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_1", content: "boom", is_error: true }],
        },
      ],
      tools: [],
    };
    const params = mapRequest(request, "gpt-4o", 32000);
    const msg = params.messages[1] as Record<string, unknown>;
    expect(msg.content).toBe("boom");
    expect("is_error" in msg).toBe(false);
    // No synthesized "Error: " prefix.
    expect(String(msg.content).startsWith("Error: ")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Streaming side
// ---------------------------------------------------------------------------

function asToolUse(e: ProviderEvent | undefined): Extract<ProviderEvent, { type: "tool_use" }> {
  expect(e?.type).toBe("tool_use");
  return e as Extract<ProviderEvent, { type: "tool_use" }>;
}

describe("translateChunk — text streaming", () => {
  it("emits one text_delta per non-empty content fragment in order; flush yields one message_stop", () => {
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "Hello, " }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];

    const out = run(chunks);

    expect(out).toEqual([
      { type: "text_delta", text: "Hello, " },
      { type: "text_delta", text: "world" },
      { type: "message_stop", stopReason: "end_turn" },
    ]);
    expect(out.some((e) => e.type === "tool_use")).toBe(false);
    expect(out.filter((e) => e.type === "message_stop")).toHaveLength(1);
  });

  it("treats an empty content fragment as no text_delta", () => {
    // Only the leading empty-content delta + finish; expect just message_stop.
    const out = run([{ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] }]);
    expect(out).toEqual([{ type: "message_stop", stopReason: "end_turn" }]);
  });
});

describe("translateChunk — reasoning streaming (OpenAI-compat extensions)", () => {
  it("maps DeepSeek's reasoning_content delta to a reasoning_delta", () => {
    const chunks = [
      { choices: [{ index: 0, delta: { reasoning_content: "step 1 " }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { reasoning_content: "step 2" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] },
    ];

    // Reasoning arrives before content and surfaces as reasoning_delta, in order.
    expect(run(chunks)).toEqual([
      { type: "reasoning_delta", text: "step 1 " },
      { type: "reasoning_delta", text: "step 2" },
      { type: "text_delta", text: "done" },
      { type: "message_stop", stopReason: "end_turn" },
    ]);
  });

  it("maps OpenRouter's normalized `reasoning` delta to a reasoning_delta", () => {
    const out = run([{ choices: [{ index: 0, delta: { reasoning: "thinking" }, finish_reason: "stop" }] }]);
    expect(out).toEqual([
      { type: "reasoning_delta", text: "thinking" },
      { type: "message_stop", stopReason: "end_turn" },
    ]);
  });

  it("emits no reasoning_delta for vanilla OpenAI deltas (neither field present)", () => {
    const out = run([{ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }]);
    expect(out.some((e) => e.type === "reasoning_delta")).toBe(false);
    expect(out).toEqual([
      { type: "text_delta", text: "hi" },
      { type: "message_stop", stopReason: "end_turn" },
    ]);
  });
});

describe("translateChunk — single tool call", () => {
  it("yields no events during the stream; flush yields the parsed tool_use then one message_stop", () => {
    const chunks = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }, finish_reason: null },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] }, finish_reason: null },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];

    const acc = new ToolCallAccumulator();
    const streamed = chunks.flatMap((c) => translateChunk(c, acc));
    // No events emitted from translateChunk for a pure tool-call turn.
    expect(streamed).toEqual([]);

    const flushed = acc.flush();
    expect(flushed).toEqual([
      { type: "tool_use", id: "call_1", name: "read", input: { path: "x" } },
      { type: "message_stop", stopReason: "tool_use" },
    ]);
    expect(asToolUse(flushed[0]).inputParseError).toBeUndefined();
  });
});

describe("translateChunk — multiple concurrent tool calls", () => {
  it("flushes both tool_use events in ascending index order under interleaved deltas", () => {
    const chunks = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_a", type: "function", function: { name: "read", arguments: "" } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 1, id: "call_b", type: "function", function: { name: "write", arguments: "" } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      // interleaved arg fragments
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"file":' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '"b.txt"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];

    const out = run(chunks);

    expect(out).toEqual([
      { type: "tool_use", id: "call_a", name: "read", input: { path: "a.txt" } },
      { type: "tool_use", id: "call_b", name: "write", input: { file: "b.txt" } },
      { type: "message_stop", stopReason: "tool_use" },
    ]);
  });

  it("orders by ascending index even when the higher index is delivered first", () => {
    const chunks = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 1, id: "call_b", type: "function", function: { name: "write", arguments: '{"file":"b"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_a", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ];

    const out = run(chunks);
    const toolUses = out.filter((e) => e.type === "tool_use") as Extract<
      ProviderEvent,
      { type: "tool_use" }
    >[];
    expect(toolUses.map((e) => e.id)).toEqual(["call_a", "call_b"]);
  });
});

describe("translateChunk — large argument JSON across many chunks", () => {
  it("reassembles a long arguments string split across 6 deltas into the fully parsed object", () => {
    const big = { path: "x".repeat(50), nested: { a: 1, b: [1, 2, 3, 4, 5], c: "value" }, flag: true };
    const full = JSON.stringify(big);
    // Split into 6 fragments.
    const fragments: string[] = [];
    const size = Math.ceil(full.length / 6);
    for (let i = 0; i < full.length; i += size) {
      fragments.push(full.slice(i, i + size));
    }
    expect(fragments.length).toBeGreaterThanOrEqual(5);

    const chunks: unknown[] = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "edit", arguments: "" } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      ...fragments.map((frag) => ({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: frag } }] }, finish_reason: null },
        ],
      })),
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];

    const out = run(chunks);
    const toolUse = asToolUse(out[0]);
    expect(toolUse.input).toEqual(big);
    expect(toolUse.inputParseError).toBeUndefined();
  });
});

describe("translateChunk — malformed JSON arguments", () => {
  it("emits inputParseError:true with input deep-equal {} (never null)", () => {
    const chunks = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_bad", type: "function", function: { name: "read", arguments: "{bad " } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "json" } }] }, finish_reason: "tool_calls" }] },
    ];

    const out = run(chunks);
    const toolUse = asToolUse(out[0]);
    expect(toolUse.id).toBe("call_bad");
    expect(toolUse.name).toBe("read");
    expect(toolUse.inputParseError).toBe(true);
    expect(toolUse.input).toEqual({});
    expect(toolUse.input).not.toBeNull();
  });
});

describe("translateChunk — no-arg / empty arguments", () => {
  it("treats an empty arguments buffer as input {} with no parse error", () => {
    const chunks = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_noarg", type: "function", function: { name: "ping", arguments: "" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ];

    const out = run(chunks);
    const toolUse = asToolUse(out[0]);
    expect(toolUse.input).toEqual({});
    expect(toolUse.inputParseError).toBeUndefined();
  });

  it("treats a tool call that never sends an arguments fragment as input {}", () => {
    const chunks = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: "call_noarg", type: "function", function: { name: "ping" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ];

    const out = run(chunks);
    const toolUse = asToolUse(out[0]);
    expect(toolUse.input).toEqual({});
    expect(toolUse.inputParseError).toBeUndefined();
  });
});

describe("translateChunk — finish_reason mapping", () => {
  it("maps 'tool_calls' → 'tool_use'", () => {
    const out = run([{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }]);
    expect(out).toEqual([{ type: "message_stop", stopReason: "tool_use" }]);
  });

  it("maps 'stop' → 'end_turn'", () => {
    const out = run([{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]);
    expect(out).toEqual([{ type: "message_stop", stopReason: "end_turn" }]);
  });

  it("maps 'length' → 'max_tokens'", () => {
    const out = run([{ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }]);
    expect(out).toEqual([{ type: "message_stop", stopReason: "max_tokens" }]);
  });

  it("passes 'content_filter' through unchanged", () => {
    const out = run([{ choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] }]);
    expect(out).toEqual([{ type: "message_stop", stopReason: "content_filter" }]);
  });
});

describe("translateChunk — no finish_reason (abort/disconnect)", () => {
  it("still flushes the accumulated tool_use plus one message_stop defaulting to 'end_turn'", () => {
    const chunks = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"x"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      // Stream simply ends — no finish_reason chunk follows.
    ];

    const out = run(chunks);
    expect(out).toEqual([
      { type: "tool_use", id: "call_1", name: "read", input: { path: "x" } },
      { type: "message_stop", stopReason: "end_turn" },
    ]);
  });
});

describe("translateChunk — exactly one message_stop across a long mixed stream", () => {
  it("yields exactly one message_stop and the include_usage chunk produces zero events", () => {
    const usageChunk = { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    expect(translateChunk(usageChunk, new ToolCallAccumulator())).toEqual([]);

    const chunks = [
      { choices: [{ index: 0, delta: { content: "thinking " }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "out loud" }, finish_reason: null }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_a", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 1, id: "call_b", type: "function", function: { name: "write", arguments: '{"file":"b"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      usageChunk, // include_usage final chunk — must produce zero events.
    ];

    const out = run(chunks);
    expect(out.filter((e) => e.type === "message_stop")).toHaveLength(1);
    expect(out.filter((e) => e.type === "tool_use")).toHaveLength(2);
    expect(out.filter((e) => e.type === "text_delta")).toHaveLength(2);
    // The message_stop is last and reflects the tool_calls finish reason.
    // After the usage-capture restructure, flush() includes usage from the usageChunk.
    expect(out[out.length - 1]).toEqual({
      type: "message_stop",
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
    });
  });
});

describe("translateChunk — empty turn", () => {
  it("yields no events during the stream and exactly one message_stop with no tool_use", () => {
    const out = run([{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]);
    expect(out).toEqual([{ type: "message_stop", stopReason: "end_turn" }]);
    expect(out.some((e) => e.type === "tool_use")).toBe(false);
  });

  it("an entirely empty stream still flushes exactly one message_stop (default end_turn)", () => {
    const out = run([]);
    expect(out).toEqual([{ type: "message_stop", stopReason: "end_turn" }]);
  });
});

describe("translateChunk — malformed / non-record chunks", () => {
  it("returns [] for non-record / malformed chunks without throwing", () => {
    const acc = new ToolCallAccumulator();
    expect(translateChunk(null, acc)).toEqual([]);
    expect(translateChunk(undefined, acc)).toEqual([]);
    expect(translateChunk(42, acc)).toEqual([]);
    expect(translateChunk({}, acc)).toEqual([]);
    expect(translateChunk({ choices: [] }, acc)).toEqual([]);
    expect(translateChunk({ choices: [null] }, acc)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Usage capture (task-06)
// ---------------------------------------------------------------------------

describe("translateChunk — usage capture", () => {
  it("(a) usage chunk returns [] from translateChunk; flush emits message_stop with usage", () => {
    const acc = new ToolCallAccumulator();
    const result = translateChunk(
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } },
      acc,
    );
    // Return value is [] — usage-only chunks never produce stream events.
    expect(result).toEqual([]);

    const flushed = acc.flush();
    const stop = flushed.find((e) => e.type === "message_stop");
    expect(stop).toBeDefined();
    expect((stop as Extract<typeof stop, { type: "message_stop" }>)?.usage).toEqual({
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 0,
    });

    // Invariant: OpenAI never produces cacheWriteTokens — the key must be absent.
    expect("cacheWriteTokens" in ((stop as Extract<typeof stop, { type: "message_stop" }>)?.usage ?? {})).toBe(false);
  });

  it("(b) usage: null on non-final chunk — accumulator not updated; flush message_stop has no usage key", () => {
    const acc = new ToolCallAccumulator();
    translateChunk({ choices: [{ delta: {}, finish_reason: null }], usage: null }, acc);
    const flushed = acc.flush();
    const stop = flushed.find((e) => e.type === "message_stop");
    expect(stop).toBeDefined();
    // isRecord(null) is false → usage branch skipped → no usage key on message_stop.
    expect("usage" in stop!).toBe(false);
  });

  it("(c) prompt_tokens_details.cached_tokens maps to cacheReadTokens", () => {
    const acc = new ToolCallAccumulator();
    translateChunk(
      {
        choices: [],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: 15 },
        },
      },
      acc,
    );
    const flushed = acc.flush();
    const stop = flushed.find((e) => e.type === "message_stop");
    expect(stop).toBeDefined();
    expect((stop as Extract<typeof stop, { type: "message_stop" }>)?.usage).toEqual({
      inputTokens: 30,
      outputTokens: 8,
      cacheReadTokens: 15,
    });
  });

  it("(d) absent prompt_tokens_details defaults cacheReadTokens to 0", () => {
    const acc = new ToolCallAccumulator();
    translateChunk(
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
      acc,
    );
    const flushed = acc.flush();
    const stop = flushed.find((e) => e.type === "message_stop");
    expect((stop as Extract<typeof stop, { type: "message_stop" }>)?.usage?.cacheReadTokens).toBe(0);
  });

  it("(e) fresh accumulator with no usage chunk — flush message_stop has no usage key", () => {
    const acc = new ToolCallAccumulator();
    const flushed = acc.flush();
    const stop = flushed.find((e) => e.type === "message_stop");
    expect(stop).toBeDefined();
    // setUsage was never called → chunkUsage is undefined → conditional spread omits usage.
    expect("usage" in stop!).toBe(false);
  });

  it("(f) mapRequest always includes stream_options: { include_usage: true }", () => {
    // Verified separately in the mapRequest describe block; cross-check here with tools present.
    const request: ProviderRequest = {
      systemPrompt: "s",
      messages: [],
      tools: [sampleTool],
    };
    const params = mapRequest(request, "gpt-4o-mini", 16000);
    expect(params.stream_options).toEqual({ include_usage: true });
    // stream flag is still absent (the provider adds it, not mapRequest).
    expect("stream" in params).toBe(false);
  });
});

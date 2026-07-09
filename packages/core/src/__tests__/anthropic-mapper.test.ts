import { describe, it, expect } from "vitest";

import {
  mapRequest,
  mapTools,
  InputAccumulator,
  translateStreamEvent,
} from "../providers/anthropic-mapper.js";
import type { ProviderEvent, ProviderRequest, ToolSchema } from "../types/provider.js";

/**
 * Drive a sequence of raw (Anthropic-shaped) stream events through
 * translateStreamEvent against a single shared accumulator and return the flat
 * list of ProviderEvents produced — mirroring how the live provider consumes the
 * SDK stream. Events are plain object literals: translateStreamEvent takes
 * `unknown`, so no real SDK objects are needed.
 */
function run(events: unknown[]): ProviderEvent[] {
  const acc = new InputAccumulator();
  return events.flatMap((e) => translateStreamEvent(e, acc));
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

describe("mapTools", () => {
  it("emits snake_case input_schema (not inputSchema)", () => {
    const tools = mapTools([sampleTool]);
    expect(tools).toHaveLength(1);
    // mapTools returns the custom-tool shape (has name/description/input_schema).
    const tool = tools[0] as { name: string; description?: string; input_schema: unknown };
    expect(tool.name).toBe("read");
    expect(tool.description).toBe("Read a file");
    // The Anthropic shape is input_schema; the canonical ToolSchema is inputSchema.
    expect(tool.input_schema).toEqual(sampleTool.inputSchema);
    expect("inputSchema" in tool).toBe(false);
  });
});

describe("mapRequest", () => {
  it("builds streaming params with model, system, stream:true and snake_case tool schema", () => {
    const request: ProviderRequest = {
      systemPrompt: "You are a helpful assistant.",
      messages: [{ role: "user", content: "hi" }],
      tools: [sampleTool],
    };

    const params = mapRequest(request, "claude-opus-4", 4096);

    expect(params.model).toBe("claude-opus-4");
    expect(params.system).toBe("You are a helpful assistant.");
    expect(params.stream).toBe(true);
    expect(params.messages).toEqual([{ role: "user", content: "hi" }]);
    const tool = params.tools?.[0] as { input_schema: unknown };
    expect(tool.input_schema).toEqual(sampleTool.inputSchema);
    // Refined contract: snake_case, never inputSchema.
    expect("inputSchema" in (params.tools?.[0] ?? {})).toBe(false);
  });

  it("uses the provider default max_tokens when request.maxTokens is absent", () => {
    const request: ProviderRequest = {
      systemPrompt: "s",
      messages: [],
      tools: [],
    };
    const params = mapRequest(request, "m", 4096);
    expect(params.max_tokens).toBe(4096);
  });

  it("prefers request.maxTokens over the provider default when present", () => {
    const request: ProviderRequest = {
      systemPrompt: "s",
      messages: [],
      tools: [],
      maxTokens: 100,
    };
    const params = mapRequest(request, "m", 4096);
    expect(params.max_tokens).toBe(100);
  });
});

describe("translateStreamEvent — text streaming", () => {
  it("emits one text_delta per delta and no tool_use across a text block", () => {
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello, " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } },
      { type: "content_block_stop", index: 0 },
    ];

    const out = run(events);

    expect(out).toEqual([
      { type: "text_delta", text: "Hello, " },
      { type: "text_delta", text: "world" },
    ]);
    expect(out.some((e) => e.type === "tool_use")).toBe(false);
  });
});

describe("translateStreamEvent — thinking (reasoning) streaming", () => {
  it("maps a thinking_delta to a single reasoning_delta carrying the .thinking text", () => {
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me " } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reason…" } },
      { type: "content_block_stop", index: 0 },
    ];

    const out = run(events);

    expect(out).toEqual([
      { type: "reasoning_delta", text: "Let me " },
      { type: "reasoning_delta", text: "reason…" },
    ]);
  });

  it("preserves order when thinking precedes text (reasoning_delta before text_delta)", () => {
    const events = [
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } },
    ];

    expect(run(events)).toEqual([
      { type: "reasoning_delta", text: "think" },
      { type: "text_delta", text: "answer" },
    ]);
  });
});

describe("translateStreamEvent — single tool use", () => {
  it("accumulates input_json_delta chunks and emits a tool_use at content_block_stop", () => {
    const events = [
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "read" },
      },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"pat' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'h":"x"}' } },
      { type: "content_block_stop", index: 1 },
    ];

    const out = run(events);

    expect(out).toEqual([
      { type: "tool_use", id: "toolu_1", name: "read", input: { path: "x" } },
    ]);
    // No parse error on well-formed JSON.
    const toolUse = out[0] as Extract<ProviderEvent, { type: "tool_use" }>;
    expect(toolUse.inputParseError).toBeUndefined();
  });
});

describe("translateStreamEvent — multi-block accumulation (engineering spec §10.2)", () => {
  it("keeps two concurrent tool-use blocks separate under interleaved deltas", () => {
    const events = [
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_a", name: "read" },
      },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_b", name: "write" },
      },
      // Interleaved partials for the two open blocks.
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"file":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a.txt"}' } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"b.txt"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_stop", index: 2 },
    ];

    const out = run(events);

    expect(out).toEqual([
      { type: "tool_use", id: "toolu_a", name: "read", input: { path: "a.txt" } },
      { type: "tool_use", id: "toolu_b", name: "write", input: { file: "b.txt" } },
    ]);
  });
});

describe("translateStreamEvent — malformed JSON (edge case §6.1)", () => {
  it("emits inputParseError:true with input deep-equal {} (no null sentinel)", () => {
    const events = [
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_bad", name: "read" },
      },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{bad " } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "json" } },
      { type: "content_block_stop", index: 1 },
    ];

    const out = run(events);
    expect(out).toHaveLength(1);
    const toolUse = out[0] as Extract<ProviderEvent, { type: "tool_use" }>;

    expect(toolUse.type).toBe("tool_use");
    expect(toolUse.id).toBe("toolu_bad");
    expect(toolUse.name).toBe("read");
    expect(toolUse.inputParseError).toBe(true);
    // Serializable placeholder, NOT null.
    expect(toolUse.input).toEqual({});
    expect(toolUse.input).not.toBeNull();
  });

  it("finishBlock returns { kind: 'parse_error' } for unparseable accumulated JSON", () => {
    const acc = new InputAccumulator();
    acc.startBlock(1, "toolu_bad", "read");
    acc.appendJson(1, "{bad json");
    const result = acc.finishBlock(1);

    expect(result).toEqual({ kind: "parse_error", id: "toolu_bad", name: "read" });
  });
});

describe("translateStreamEvent — stop_reason caching", () => {
  it("emits the stop_reason cached from message_delta on the following message_stop", () => {
    const events = [
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ];

    const out = run(events);

    expect(out).toEqual([{ type: "message_stop", stopReason: "tool_use" }]);
  });

  it("defaults stopReason to 'end_turn' when no message_delta preceded message_stop", () => {
    const out = run([{ type: "message_stop" }]);
    expect(out).toEqual([{ type: "message_stop", stopReason: "end_turn" }]);
  });

  it("message_delta itself emits nothing (the reason surfaces on message_stop)", () => {
    const out = run([{ type: "message_delta", delta: { stop_reason: "tool_use" } }]);
    expect(out).toEqual([]);
  });
});

describe("translateStreamEvent — empty-input no-arg tool", () => {
  it("treats a tool_use block with zero input_json_delta as input {} with no parse error", () => {
    const events = [
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_noarg", name: "ping" },
      },
      { type: "content_block_stop", index: 1 },
    ];

    const out = run(events);
    expect(out).toEqual([{ type: "tool_use", id: "toolu_noarg", name: "ping", input: {} }]);

    const toolUse = out[0] as Extract<ProviderEvent, { type: "tool_use" }>;
    expect(toolUse.input).toEqual({});
    expect(toolUse.inputParseError).toBeUndefined();
  });

  it("finishBlock returns kind 'ok' with input {} for an empty buffer", () => {
    const acc = new InputAccumulator();
    acc.startBlock(0, "toolu_noarg", "ping");
    const result = acc.finishBlock(0);
    expect(result).toEqual({ kind: "ok", id: "toolu_noarg", name: "ping", input: {} });
  });
});

describe("translateStreamEvent — ignored / unknown events", () => {
  it("ignores message_start and unknown event types", () => {
    expect(run([{ type: "message_start", message: {} }])).toEqual([]);
    expect(run([{ type: "ping" }])).toEqual([]);
    expect(run([{ type: "totally_unknown" }])).toEqual([]);
  });

  it("returns [] for non-record / malformed events without throwing", () => {
    const acc = new InputAccumulator();
    expect(translateStreamEvent(null, acc)).toEqual([]);
    expect(translateStreamEvent(undefined, acc)).toEqual([]);
    expect(translateStreamEvent(42, acc)).toEqual([]);
    expect(translateStreamEvent({}, acc)).toEqual([]);
  });
});

describe("translateStreamEvent — usage capture", () => {
  // a. message_start with cacheWriteTokens > 0 → usage attached to message_stop
  it("message_start(input=100, cache_creation=7, cache_read=0) + message_stop → usage with cacheWriteTokens", () => {
    const events = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 0,
            cache_creation_input_tokens: 7,
            cache_read_input_tokens: 0,
          },
        },
      },
      { type: "message_stop" },
    ];

    const out = run(events);
    expect(out).toHaveLength(1);
    const stop = out[0] as Extract<ProviderEvent, { type: "message_stop" }>;
    expect(stop.type).toBe("message_stop");
    expect(stop.usage).toEqual({
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 7,
    });
  });

  // b. cache_creation_input_tokens: null → cacheWriteTokens key absent
  it("message_start with cache_creation_input_tokens:null → no cacheWriteTokens key on usage", () => {
    const events = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 50,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: 0,
          },
        },
      },
      { type: "message_stop" },
    ];

    const out = run(events);
    expect(out).toHaveLength(1);
    const stop = out[0] as Extract<ProviderEvent, { type: "message_stop" }>;
    expect(stop.usage).toBeDefined();
    expect("cacheWriteTokens" in (stop.usage ?? {})).toBe(false);
    expect(stop.usage?.inputTokens).toBe(50);
    expect(stop.usage?.outputTokens).toBe(0);
    expect(stop.usage?.cacheReadTokens).toBe(0);
  });

  // c. message_delta adds outputTokens; inputTokens from message_start survives (mergeUsage >0 guard)
  it("message_start(input=100) + message_delta(output=25, cache_read=0) + message_stop → merged usage", () => {
    const events = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 100,
            output_tokens: 0,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: 0,
          },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 25, cache_read_input_tokens: 0 },
      },
      { type: "message_stop" },
    ];

    const out = run(events);
    expect(out).toHaveLength(1);
    const stop = out[0] as Extract<ProviderEvent, { type: "message_stop" }>;
    expect(stop.usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 0,
    });
    // cacheWriteTokens was null at start → absent
    expect("cacheWriteTokens" in (stop.usage ?? {})).toBe(false);
  });

  // d. Full sequence with cacheRead on message_delta → cacheReadTokens from delta used; inputTokens preserved
  it("full sequence: message_start cache_read=0 + message_delta cache_read=5 → cacheReadTokens=5, inputTokens preserved", () => {
    const events = [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 200,
            output_tokens: 0,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 0,
          },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 50, cache_read_input_tokens: 5 },
      },
      { type: "message_stop" },
    ];

    const out = run(events);
    expect(out).toHaveLength(1);
    const stop = out[0] as Extract<ProviderEvent, { type: "message_stop" }>;
    // cacheReadTokens: mergeUsage >0 guard: delta has 5, so 5 wins over start's 0
    expect(stop.usage?.cacheReadTokens).toBe(5);
    // inputTokens from message_start preserved (delta sends 0, mergeUsage keeps 200)
    expect(stop.usage?.inputTokens).toBe(200);
    // outputTokens from message_delta
    expect(stop.usage?.outputTokens).toBe(50);
    // cacheWriteTokens from message_start (10 > 0)
    expect(stop.usage?.cacheWriteTokens).toBe(10);
  });

  // e. Bare message_stop with no preceding usage events → no `usage` field at all
  it("bare message_stop (no preceding usage events) → no usage field on emitted event", () => {
    const events = [{ type: "message_stop" }];
    const out = run(events);
    expect(out).toHaveLength(1);
    const evt = out[0]!;
    expect(evt).toEqual({ type: "message_stop", stopReason: "end_turn" });
    expect("usage" in evt).toBe(false);
  });

  // f. InputAccumulator unit tests
  describe("InputAccumulator — usage methods", () => {
    it("setUsage then takeUsage returns the set value", () => {
      const acc = new InputAccumulator();
      acc.setUsage({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 7 });
      expect(acc.takeUsage()).toEqual({
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 7,
      });
    });

    it("mergeInUsage after setUsage merges correctly — outputTokens added, inputTokens preserved", () => {
      const acc = new InputAccumulator();
      acc.setUsage({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 0 });
      acc.mergeInUsage({ inputTokens: 0, outputTokens: 25, cacheReadTokens: 0 });
      const usage = acc.takeUsage();
      expect(usage?.inputTokens).toBe(100);
      expect(usage?.outputTokens).toBe(25);
      expect(usage?.cacheReadTokens).toBe(0);
    });

    it("fresh accumulator with no usage calls → takeUsage() returns undefined", () => {
      const acc = new InputAccumulator();
      expect(acc.takeUsage()).toBeUndefined();
    });
  });
});

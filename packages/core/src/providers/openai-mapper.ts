import type { ContentBlock, Message } from "../types/messages.js";
import type { ProviderEvent, ProviderRequest, StopReason, ToolSchema } from "../types/provider.js";
import type { Usage } from "../types/usage.js";

// Malformed streamed tool input (§6.1) is signalled provider-agnostically by the
// optional `inputParseError: true` boolean on a tool_use ProviderEvent, with
// `input` set to a valid placeholder {}. The OpenAI path carries this contract
// over unchanged from the Anthropic mapper (provider.ts:33-42).

/**
 * Structural OpenAI Chat Completions params shapes. Defined locally rather than
 * imported from the `openai` SDK so the mapper stays both SDK-runtime-free and
 * resolvable when the optional peer dependency is not installed. These mirror the
 * subset of `ChatCompletionCreateParams` this feature produces; the provider adds
 * the `stream: true` flag and spreads the rest into `chat.completions.create`.
 */
export type OpenAIChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenAIFunctionTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolSchema["inputSchema"];
  };
};

export type OpenAIChatCompletionParams = {
  model: string;
  max_completion_tokens: number;
  messages: OpenAIChatMessage[];
  tools?: OpenAIFunctionTool[];
  stream_options: { include_usage: true };
};

/** Map serialized ToolSchemas to OpenAI function tools (inputSchema → parameters). */
export function mapTools(schemas: ToolSchema[]): OpenAIFunctionTool[] {
  return schemas.map((s) => ({
    type: "function",
    function: {
      name: s.name,
      description: s.description,
      parameters: s.inputSchema,
    },
  }));
}

/**
 * Map canonical Messages to OpenAI chat messages. This is the real translation the
 * Anthropic mapper gets away with casting (anthropic-mapper.ts:12-14):
 *  - assistant ContentBlock[] → flatten text into `content` (null if none) + tool_calls
 *    with JSON-stringified `arguments` (Transform 2).
 *  - user ContentBlock[] → the batched tool_result message; explode into N role:"tool"
 *    messages in order, dropping `is_error` (Transforms 3 & 4).
 */
function mapMessages(messages: Message[]): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        out.push({ role: "user", content: message.content });
      } else {
        // A user message with ContentBlock[] content is always the batched
        // tool-result message (the only way the loop produces block-array user
        // content). Explode it into N role:"tool" messages, preserving order so
        // the OpenAI pairing invariant the loop already satisfies is not broken.
        for (const block of message.content) {
          if (block.type === "tool_result") {
            out.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content: block.content,
            });
          }
        }
      }
      continue;
    }

    // role === "assistant"
    if (typeof message.content === "string") {
      out.push({ role: "assistant", content: message.content });
      continue;
    }

    const text = collectText(message.content);
    const toolCalls = collectToolCalls(message.content);
    const assistant: OpenAIChatMessage =
      toolCalls.length > 0
        ? { role: "assistant", content: text, tool_calls: toolCalls }
        : { role: "assistant", content: text };
    out.push(assistant);
  }
  return out;
}

/** Concatenate the text of all `text` blocks; null if there are none. */
function collectText(blocks: ContentBlock[]): string | null {
  let text: string | null = null;
  for (const block of blocks) {
    if (block.type === "text") {
      text = (text ?? "") + block.text;
    }
  }
  return text;
}

/** Map `tool_use` blocks to OpenAI tool_calls with JSON-stringified arguments. */
function collectToolCalls(blocks: ContentBlock[]): OpenAIToolCall[] {
  const calls: OpenAIToolCall[] = [];
  for (const block of blocks) {
    if (block.type === "tool_use") {
      calls.push({
        id: block.id,
        type: "function",
        // arguments is a JSON-encoded STRING, not an object — this is what OpenAI wants.
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      });
    }
  }
  return calls;
}

/** ProviderRequest → OpenAI Chat Completions params (no `stream` flag; the provider adds it). */
export function mapRequest(
  request: ProviderRequest,
  model: string,
  defaultMaxTokens: number,
): OpenAIChatCompletionParams {
  return {
    model,
    // Transform: emit max_completion_tokens (NOT max_tokens) — reasoning models
    // reject max_tokens; classic models accept this as an alias. Precedence:
    // per-request override → provider default.
    max_completion_tokens: request.maxTokens ?? defaultMaxTokens,
    messages: [
      // Transform 1: OpenAI has no top-level system field; prepend a system message.
      { role: "system", content: request.systemPrompt },
      ...mapMessages(request.messages),
    ],
    // Omit `tools` entirely when empty — some models reject an empty array.
    ...(request.tools.length > 0 ? { tools: mapTools(request.tools) } : {}),
    stream_options: { include_usage: true as const },
  };
}

/**
 * Stateful accumulator for streamed tool_call arguments. OpenAI streams a flat
 * sequence of chunks: the first delta for a given tool_calls[].index carries
 * id + function.name, later deltas for that index carry only function.arguments
 * fragments — so accumulation keys on `index`, not `id`. OpenAI has no per-block
 * stop and no terminal event, so the accumulated tool calls and the single
 * message_stop are emitted at stream end via flush(). One instance per
 * provider.stream() call.
 */
export class ToolCallAccumulator {
  // keyed by tool_calls[].index
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();
  private finishReason: string | undefined;
  private refusalObserved = false;
  private chunkUsage: Usage | undefined;

  /**
   * Apply one chunk's `choices[0].delta`: emit any reasoning fragment as
   * reasoning_delta[] (before text, matching stream order), emit any text
   * fragment as text_delta[], capture id/name on first sight of each
   * tool_calls[].index, and append function.arguments fragments onto that
   * index's buffer.
   */
  applyDelta(delta: unknown): { type: "text_delta" | "reasoning_delta"; text: string }[] {
    if (!isRecord(delta)) return [];

    const events: { type: "text_delta" | "reasoning_delta"; text: string }[] = [];

    // Reasoning-token streaming is not part of vanilla OpenAI Chat Completions,
    // but OpenAI-compatible endpoints expose it on the delta: DeepSeek as
    // `reasoning_content`, OpenRouter (and passthroughs) as `reasoning`. Both
    // arrive before the answer's `content`. Surface either as observation-only
    // reasoning_delta; the loop never threads it back into history. Absent on
    // vanilla OpenAI, so this is a no-op there.
    const reasoning = asString(delta.reasoning_content) || asString(delta.reasoning);
    if (reasoning.length > 0) {
      events.push({ type: "reasoning_delta", text: reasoning });
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      events.push({ type: "text_delta", text: delta.content });
    }

    if (typeof delta.refusal === "string" && delta.refusal.trim().length > 0) {
      this.refusalObserved = true;
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const entry of delta.tool_calls) {
        if (!isRecord(entry)) continue;
        const index = asNumber(entry.index);
        let call = this.calls.get(index);
        if (!call) {
          const fn = isRecord(entry.function) ? entry.function : undefined;
          call = {
            id: asString(entry.id),
            name: fn ? asString(fn.name) : "",
            args: "",
          };
          this.calls.set(index, call);
        }
        const fn = isRecord(entry.function) ? entry.function : undefined;
        if (fn && typeof fn.arguments === "string") {
          call.args += fn.arguments;
        }
      }
    }

    return events;
  }

  /** Cache the finish_reason seen on a chunk's choices[0]. */
  setFinishReason(reason: string): void {
    this.finishReason = reason;
  }

  /** Called when the final usage-only chunk is seen (chunk.choices === []). */
  setUsage(u: Usage): void {
    this.chunkUsage = u;
  }

  /**
   * Called once at stream end. Returns the accumulated tool_use events in
   * ascending index order, then EXACTLY ONE message_stop. An empty argument
   * buffer is treated as {} (no-arg call); unparseable JSON yields a {}
   * placeholder + inputParseError: true — never a null sentinel — so the
   * persisted assistant turn stays JSON-serializable.
   */
  flush(): ProviderEvent[] {
    const events: ProviderEvent[] = [];
    const indices = [...this.calls.keys()].sort((a, b) => a - b);
    for (const index of indices) {
      const call = this.calls.get(index)!;
      const raw = call.args.trim();
      try {
        const input: unknown = raw === "" ? {} : JSON.parse(raw);
        events.push({ type: "tool_use", id: call.id, name: call.name, input });
      } catch {
        events.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: {},
          inputParseError: true,
        });
      }
    }
    events.push({
      type: "message_stop",
      stopReason: normalizeStopReason(this.finishReason, this.refusalObserved),
      ...(this.chunkUsage !== undefined ? { usage: this.chunkUsage } : {}),
    });
    return events;
  }
}

function normalizeStopReason(reason: string | undefined, refusalObserved: boolean): StopReason {
  if (refusalObserved && (reason === "stop" || reason === undefined)) {
    return { kind: "refusal", raw: reason ?? null };
  }

  switch (reason) {
    case "stop":
      return { kind: "end_turn", raw: reason };
    case "tool_calls":
    case "function_call":
      return { kind: "tool_use", raw: reason };
    case "length":
      return { kind: "max_tokens", raw: reason };
    case "content_filter":
      return { kind: "content_filter", raw: reason };
    case undefined:
      return { kind: "other", raw: null };
    default:
      return { kind: "other", raw: reason };
  }
}

/**
 * Translate one raw OpenAI chunk into zero or more text_delta events, threading
 * tool-call and finish_reason state through the accumulator. Chunks are passed
 * as `unknown` and narrowed with local type guards so the contract is stable
 * regardless of SDK type churn. tool_use and message_stop come from
 * accumulator.flush() (called by the provider after the stream ends), never here.
 */
export function translateChunk(
  chunk: unknown,
  accumulator: ToolCallAccumulator,
): ProviderEvent[] {
  if (!isRecord(chunk)) return [];

  // Capture usage from the final usage-only chunk (choices: [], usage: {...}).
  // Must happen BEFORE the choices.length === 0 early-return.
  // isRecord already excludes null — no separate != null guard needed.
  if (isRecord(chunk.usage)) {
    const u = chunk.usage;
    const ptDetails = isRecord(u.prompt_tokens_details) ? u.prompt_tokens_details : undefined;
    accumulator.setUsage({
      inputTokens: asNumber(u.prompt_tokens),
      outputTokens: asNumber(u.completion_tokens),
      cacheReadTokens: ptDetails !== undefined ? asNumber(ptDetails.cached_tokens) : 0,
    });
  }

  const choices = chunk.choices;
  if (!Array.isArray(choices) || choices.length === 0) return [];

  const choice = choices[0];
  if (!isRecord(choice)) return [];

  if (typeof choice.finish_reason === "string") {
    accumulator.setFinishReason(choice.finish_reason);
  }

  return accumulator.applyDelta(choice.delta);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "../types/messages.js";
import type { ProviderEvent, ProviderRequest, ToolSchema } from "../types/provider.js";
import { type Usage, mergeUsage, EMPTY_USAGE } from "../types/usage.js";

// Malformed streamed tool input (§6.1) is signalled provider-agnostically by the
// optional `inputParseError: true` boolean on a tool_use ProviderEvent, with
// `input` set to a valid placeholder {}. runTools detects the flag before Zod and
// emits §6.1's message. No sentinel value is placed in `input`, so the assistant
// turn the loop persists stays JSON-serializable when threaded into the next request.

/** Map canonical Messages to Anthropic MessageParams (structurally compatible). */
export function mapMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages as Anthropic.MessageParam[];
}

/** Map serialized ToolSchemas to Anthropic Tools (inputSchema → input_schema). */
export function mapTools(schemas: ToolSchema[]): Anthropic.Tool[] {
  return schemas.map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: s.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

/** ProviderRequest → Anthropic streaming params. */
export function mapRequest(
  request: ProviderRequest,
  model: string,
  defaultMaxTokens: number,
): Anthropic.MessageCreateParamsStreaming {
  return {
    model,
    // ProviderRequest.maxTokens is optional; the provider always sends a concrete
    // value because the Anthropic API requires max_tokens. Precedence: per-request
    // override (request.maxTokens) → provider default (defaultMaxTokens).
    max_tokens: request.maxTokens ?? defaultMaxTokens,
    system: request.systemPrompt,
    messages: mapMessages(request.messages),
    tools: mapTools(request.tools),
    stream: true,
  };
}

/** Discriminated result of finishing a streamed content block. */
type FinishResult =
  | { kind: "ok"; id: string; name: string; input: unknown }
  | { kind: "parse_error"; id: string; name: string };

/**
 * Stateful accumulator for streamed tool_use input. The Anthropic stream sends a
 * tool_use block's arguments as a sequence of input_json_delta chunks that must be
 * concatenated and parsed once at content_block_stop. One instance per
 * provider.stream() call; tracks every concurrent block by index. It also caches
 * the stop_reason — which arrives on message_delta but must be emitted on the
 * later message_stop event — since translateStreamEvent holds no other cross-event
 * state.
 */
export class InputAccumulator {
  private readonly blocks = new Map<number, { id: string; name: string; json: string }>();
  private stopReason: string | undefined;
  private turnUsage: Usage | undefined;

  /** Cache the stop_reason seen on a message_delta event. */
  setStopReason(reason: string): void {
    this.stopReason = reason;
  }

  /** Return the cached stop_reason at message_stop, defaulting to "end_turn". */
  takeStopReason(): string {
    return this.stopReason ?? "end_turn";
  }

  /** Initialize usage from message_start fields. Overwrites any prior usage for this turn. */
  setUsage(u: Usage): void {
    this.turnUsage = u;
  }

  /** Merge delta usage (message_delta fields) into the accumulated turn usage. */
  mergeInUsage(delta: Usage): void {
    this.turnUsage = mergeUsage(this.turnUsage ?? EMPTY_USAGE, delta);
  }

  /**
   * Return the accumulated turn usage for this stream, or undefined if no
   * usage-bearing event was seen. No reset is needed — InputAccumulator is
   * instantiated fresh per provider.stream() call (one accumulator = one turn).
   */
  takeUsage(): Usage | undefined {
    return this.turnUsage;
  }

  /** Called at content_block_start for a tool_use block. */
  startBlock(index: number, id: string, name: string): void {
    this.blocks.set(index, { id, name, json: "" });
  }

  /** Called for each input_json_delta on a block. */
  appendJson(index: number, partialJson: string): void {
    const block = this.blocks.get(index);
    if (block) block.json += partialJson;
  }

  /**
   * Called at content_block_stop. Returns `null` for a non-tracked (text) block,
   * `{ kind: "ok", input }` with the parsed input, or `{ kind: "parse_error" }`
   * when the accumulated JSON is unparseable. The caller maps "parse_error" to a
   * tool_use event with `input: {}` and `inputParseError: true` — the boolean flag,
   * not a value in `input`, carries the signal, so runTools can tell a genuine
   * parse failure apart from a tool that legitimately takes `{}` while keeping
   * `input` JSON-serializable. An empty buffer is treated as `{}` (Anthropic emits
   * no input_json_delta for a no-arg call).
   */
  finishBlock(index: number): FinishResult | null {
    const block = this.blocks.get(index);
    if (!block) return null;
    this.blocks.delete(index);
    const raw = block.json.trim();
    try {
      const input: unknown = raw === "" ? {} : JSON.parse(raw);
      return { kind: "ok", id: block.id, name: block.name, input };
    } catch {
      return { kind: "parse_error", id: block.id, name: block.name };
    }
  }
}

/**
 * Translate one Anthropic stream event into zero or more ProviderEvents, threading
 * per-block and stop_reason state through the accumulator. Events are narrowed with
 * type guards: the live SDK objects are passed through here untyped (`unknown`) so
 * the contract stays stable regardless of SDK type churn.
 */
export function translateStreamEvent(
  event: unknown,
  accumulator: InputAccumulator,
): ProviderEvent[] {
  if (!isRecord(event) || typeof event.type !== "string") return [];

  switch (event.type) {
    case "content_block_start": {
      const block = event.content_block;
      if (isRecord(block) && block.type === "tool_use") {
        accumulator.startBlock(
          asNumber(event.index),
          asString(block.id),
          asString(block.name),
        );
      }
      return [];
    }
    case "content_block_delta": {
      const delta = event.delta;
      if (!isRecord(delta)) return [];
      if (delta.type === "text_delta") {
        return [{ type: "text_delta", text: asString(delta.text) }];
      }
      if (delta.type === "input_json_delta") {
        accumulator.appendJson(asNumber(event.index), asString(delta.partial_json));
      }
      return [];
    }
    case "content_block_stop": {
      const finish = accumulator.finishBlock(asNumber(event.index));
      if (finish === null) return []; // non-tracked (text) block
      if (finish.kind === "ok") {
        return [{ type: "tool_use", id: finish.id, name: finish.name, input: finish.input }];
      }
      // parse_error → placeholder {} input + inputParseError flag; runTools emits
      // the dedicated §6.1 message. `input` stays JSON-serializable for history.
      return [{ type: "tool_use", id: finish.id, name: finish.name, input: {}, inputParseError: true }];
    }
    case "message_start": {
      const msg = event.message;
      if (!isRecord(msg)) return [];
      const usage = msg.usage;
      if (!isRecord(usage)) return [];

      const inputTokens = asNumber(usage.input_tokens);
      const cacheRead = asNullableNumber(usage.cache_read_input_tokens) ?? 0;
      const cacheWrite = asNullableNumber(usage.cache_creation_input_tokens);

      const initialUsage: Usage = {
        inputTokens,
        outputTokens: 0,
        cacheReadTokens: cacheRead,
        ...(cacheWrite != null && cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
      };
      accumulator.setUsage(initialUsage);
      return [];
    }
    case "message_delta": {
      // stop_reason lives on the message_delta; cache it for the message_stop below.
      const delta = event.delta;
      if (isRecord(delta) && typeof delta.stop_reason === "string") {
        accumulator.setStopReason(delta.stop_reason);
      }
      // Capture output tokens and cache-read tokens from this event.
      const deltaUsage = event.usage; // top-level 'usage' on message_delta, not delta.usage
      if (isRecord(deltaUsage)) {
        const outputTokens = asNumber(deltaUsage.output_tokens);
        const cacheRead = asNullableNumber(deltaUsage.cache_read_input_tokens) ?? 0;
        accumulator.mergeInUsage({ inputTokens: 0, outputTokens, cacheReadTokens: cacheRead });
      }
      return [];
    }
    case "message_stop": {
      const u = accumulator.takeUsage();
      return [{
        type: "message_stop",
        stopReason: accumulator.takeStopReason(),
        ...(u !== undefined ? { usage: u } : {}),
      }];
    }
    default:
      return []; // ping, etc. — ignored
  }
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

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

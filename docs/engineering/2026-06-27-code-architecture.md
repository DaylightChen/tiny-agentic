# tiny-agentic — Code Architecture

**Date:** 2026-06-27
**Milestone:** 1 — the `tiny-agentic` core package
**Status:** Concrete type definitions and module skeletons for the planner. Read the canonical spec first (`2026-06-27-engineering-spec.md`).

These are the actual TypeScript types and class skeletons the planner will reference when writing task briefs. They are definitive — implementation tasks produce exactly these shapes (or note a deviation in their completion doc).

---

## `packages/core/src/types/messages.ts`

```ts
// Canonical message types. Structurally compatible with Anthropic MessageParam.
// No imports from @anthropic-ai/sdk.

export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type Message =
  | { role: "user";      content: string | ContentBlock[] }
  | { role: "assistant"; content: string | ContentBlock[] };
```

---

## `packages/core/src/types/platform.ts`

```ts
export type ExecOptions = {
  cwd?: string;
  timeout?: number;   // milliseconds
  env?: Record<string, string>;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export interface Platform {
  /** Return the current working directory. The only place process.cwd() is called is NodePlatform. */
  cwd(): string;
  readFile(path: string, encoding?: "utf-8"): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}
```

---

## `packages/core/src/types/tool.ts`

```ts
import type { ZodType, z } from "zod";
import type { Platform } from "./platform.js";

/**
 * Extensible context object passed to every Tool.call invocation.
 * Empty in M1. The SDK widens this via TypeScript declaration merging
 * to add skillRegistry, commandRegistry, etc.
 *
 * Declared as an interface (not type) to enable declaration merging.
 * Do not add fields here without a corresponding SDK-layer need.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- intentional open extension point; the SDK widens it via declaration merging
export interface ToolCallContext {
  // Reserved for SDK extension.
}

/**
 * A tool that can be called by the model.
 *
 * @template TInput - Zod schema type for the tool's input. Inferred in practice.
 */
export interface Tool<TInput extends ZodType = ZodType> {
  /** Unique name. Used by the model to call the tool. Must be stable. */
  name: string;

  /** One-to-two sentence description sent to the model. Keep concise. */
  description: string;

  /**
   * Zod schema for validated input. Required — serialized to JSON Schema for
   * the model request and used for pre-call runtime validation.
   */
  inputSchema: TInput;

  /**
   * Execute the tool. Called only after successful Zod validation.
   *
   * @param input - Validated, typed input from the model.
   * @param platform - Injected environment capability (filesystem, exec, etc.).
   * @param context - Extensible SDK context. Ignore if unused.
   * @returns Any JSON-serializable value. Sent to the model as tool_result content.
   *          Throw to indicate an error — the framework catches and feeds the
   *          error message back to the model as a tool_result error.
   */
  call(
    input: z.infer<TInput>,
    platform: Platform,
    context: ToolCallContext,
  ): Promise<unknown>;

  /**
   * Optional concurrency hint. When present and returns true, the tool is
   * safe to run concurrently with other concurrency-safe tools in the same turn.
   * Unused in M1 (all tools run sequentially). Hook for M2.
   */
  isConcurrencySafe?(input: z.infer<TInput>): boolean;
}

/**
 * Type-safe tool authoring helper.
 *
 * Use this instead of annotating `const myTool: Tool = { ... }`.
 * Annotating `: Tool` (without the generic) collapses TInput to ZodType,
 * making `input` in `call` typed as `unknown`. `defineTool` lets TypeScript
 * infer TInput from the literal `inputSchema` you provide, so `input` in
 * `call` is fully typed.
 *
 * A specific `Tool<S>` is assignable to `Tool<ZodType>` (and therefore to
 * `Tool[]`) because `call` uses method syntax (bivariant parameter positions
 * in TypeScript). Do not "fix" this by converting to function-property syntax
 * (`call: (input) => ...`) — that would make the assignment fail.
 *
 * Raw object literals annotated `: Tool` still compile and work correctly at
 * runtime; they just lose the narrowed `input` type inside `call`.
 *
 * @example
 * export const myTool = defineTool({
 *   name: "my_tool",
 *   inputSchema: z.object({ value: z.string() }),
 *   call: async ({ value }, platform) => { ... }, // `value` is string, not unknown
 * });
 */
export function defineTool<S extends ZodType>(t: Tool<S>): Tool<S> {
  return t;
}
```

---

## `packages/core/src/types/provider.ts`

```ts
import type { Message } from "./messages.js";

/**
 * Serialized tool schema sent in a ProviderRequest.
 * Produced by ToolRegistry from a Tool's Zod inputSchema via zod-to-json-schema.
 * The openApi3 target is used for compatibility with both Anthropic and OpenAI.
 */
export type ToolSchema = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
};

/** Data sent to the provider on each model call. Pure data — no signals or callbacks. */
export type ProviderRequest = {
  systemPrompt: string;
  messages: Message[];
  tools: ToolSchema[];
  maxTokens?: number;
};

/** Canonical streaming events yielded by a provider. Provider-agnostic. */
export type ProviderEvent =
  | { type: "text_delta";   text: string }
  | { type: "tool_use";     id: string; name: string; input: unknown; inputParseError?: boolean }
  | { type: "message_stop"; stopReason: "end_turn" | "tool_use" | "max_tokens" | string };

// Malformed streamed tool input (§6.1) is signalled by the optional
// `inputParseError: true` boolean on a tool_use event, NOT by a sentinel value
// in `input`. When the accumulated argument chunks are not valid JSON, the
// provider's stream mapper sets `input: {}` (a valid, JSON-serializable
// placeholder) and `inputParseError: true`. `runTools` checks the flag — before
// Zod validation — and emits the dedicated "Tool '<name>': could not parse tool
// input as JSON" tool-result error, distinct from a Zod validation failure.
// Keeping `input` a normal JSON value (never a symbol) means the assistant
// turn the loop persists stays serializable when threaded back into the next
// request, and no internal sentinel leaks onto the public event surface.

/**
 * Structured log entry passed to the optional logger callback.
 * Extend the union in M2 when cost/token tracking is added.
 */
export type LogEntry =
  | { level: "info";  event: "request_sent";   request: ProviderRequest }
  | { level: "info";  event: "retry_attempt";  attempt: number; delayMs: number; error: Error }
  | { level: "error"; event: "request_failed"; error: Error };

export type Logger = (entry: LogEntry) => void;

/** The provider abstraction. Implement to add a new LLM backend. */
export interface Provider {
  /**
   * Stream a single model call. Yields ProviderEvents until message_stop.
   * Retry logic (on 429/5xx) is the provider's responsibility.
   * Errors that survive retries are thrown; the agent loop catches them.
   *
   * @param request - The model request (system prompt, messages, tools).
   * @param signal - Optional AbortSignal. Abort cancels the in-flight request.
   */
  stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent>;
}
```

---

## `packages/core/src/types/events.ts`

```ts
import type { Message } from "./messages.js";

/**
 * All events yielded by Agent.run().
 * Discriminated by `type`. Handle with a switch statement.
 *
 * Primary events (almost always handled):
 *   text_delta, agent_done, agent_error
 *
 * Secondary events (logging, progress display):
 *   tool_use_start, tool_result
 *
 * Tertiary events (advanced consumers):
 *   turn_complete, max_turns_exceeded
 */
export type AgentEvent =
  | { type: "text_delta";         text: string }
  | { type: "tool_use_start";     toolName: string; toolInput: unknown }
  | { type: "tool_result";        toolName: string; toolCallId: string; result: unknown; isError: boolean }
  | { type: "turn_complete";      turnIndex: number }
  // Terminal events — the generator exhausts after yielding one of these.
  // Each carries `messages` so a `for await` consumer can thread history
  // without capturing the generator's return value.
  | { type: "agent_done";         messages: Message[] }
  | { type: "max_turns_exceeded"; turnsUsed: number; messages: Message[] }
  | { type: "agent_error";        error: Error; messages: Message[] };

/**
 * The generator's typed return value. Equivalent to the terminal AgentEvent.
 * For `for await` consumers: read the terminal event instead.
 * For `.next()` consumers: read the generator's done.value.
 */
export type Terminal =
  | { reason: "agent_done";         messages: Message[] }
  | { reason: "max_turns_exceeded"; messages: Message[]; turnsUsed: number }
  | { reason: "agent_error";        messages: Message[]; error: Error };
```

---

## `packages/core/src/agent.ts` (skeleton)

```ts
import type { Provider } from "./types/provider.js";
import type { Tool } from "./types/tool.js";
import type { Platform } from "./types/platform.js";
import type { AgentEvent, Terminal } from "./types/events.js";
import type { Message } from "./types/messages.js";
import { ToolRegistry } from "./tools/registry.js";
import { buildEnvContext } from "./env/context.js";
import { agentLoop } from "./loop/loop.js";

export type AgentOptions = {
  provider: Provider;
  tools: Tool[];
  platform: Platform;
  systemPrompt?: string;
  maxTurns?: number;      // default: 25
};

export type RunOptions = {
  messages?: Message[];
};

export class Agent {
  private readonly provider: Provider;
  private readonly tools: Tool[];
  private readonly platform: Platform;
  private readonly systemPrompt: string | undefined;
  private readonly maxTurns: number;

  constructor(options: AgentOptions) {
    this.provider  = options.provider;
    this.tools     = options.tools;
    this.platform  = options.platform;
    this.systemPrompt = options.systemPrompt;
    this.maxTurns  = options.maxTurns ?? 25;
  }

  async *run(
    prompt: string,
    options: RunOptions = {},
  ): AsyncGenerator<AgentEvent, Terminal> {
    const abortCtrl = new AbortController();
    try {
      const registry = new ToolRegistry(this.tools);
      const workingMessages: Message[] = [
        ...(options.messages ?? []),
        { role: "user", content: prompt },
      ];
      const envCtx = await buildEnvContext(this.platform);
      const systemPrompt = this.systemPrompt
        ? `${envCtx}\n\n${this.systemPrompt}`
        : envCtx;

      return yield* agentLoop({
        provider: this.provider,
        registry,
        platform: this.platform,
        messages: workingMessages,
        systemPrompt,
        maxTurns: this.maxTurns,
        signal: abortCtrl.signal,
      });
    } finally {
      abortCtrl.abort();
    }
  }
}
```

---

## `packages/core/src/loop/loop.ts` (skeleton)

```ts
import type { Provider } from "../types/provider.js";
import type { Platform } from "../types/platform.js";
import type { AgentEvent, Terminal } from "../types/events.js";
import type { Message, ContentBlock, ToolUseBlock } from "../types/messages.js";
import type { ToolCallContext } from "../types/tool.js";
import { ToolRegistry } from "../tools/registry.js";
import { runTools } from "./runTools.js";
import { serializeToolResult } from "../utils/serialize.js";

export type LoopParams = {
  provider: Provider;
  registry: ToolRegistry;
  platform: Platform;
  messages: Message[];
  systemPrompt: string;
  maxTurns: number;
  signal: AbortSignal;
};

export async function* agentLoop(
  params: LoopParams,
): AsyncGenerator<AgentEvent, Terminal> {
  const { provider, registry, platform, systemPrompt, maxTurns, signal } = params;
  const workingMessages = params.messages; // mutable local copy
  const context: ToolCallContext = {};
  const toolSchemas = registry.toSchemas();
  let turnIndex = 0;
  let turnsUsed = 0;

  while (true) {
    // Guard
    if (turnsUsed >= maxTurns) {
      const event = { type: "max_turns_exceeded" as const, turnsUsed, messages: workingMessages };
      yield event;
      return { reason: "max_turns_exceeded", turnsUsed, messages: workingMessages };
    }

    // Stream model
    const textChunks: string[] = [];
    const pendingToolUses: Array<{ id: string; name: string; input: unknown; parseError: boolean }> = [];

    try {
      for await (const event of provider.stream(
        { systemPrompt, messages: workingMessages, tools: toolSchemas },
        signal,
      )) {
        if (event.type === "text_delta") {
          textChunks.push(event.text);
          yield { type: "text_delta", text: event.text };
        } else if (event.type === "tool_use") {
          pendingToolUses.push({ id: event.id, name: event.name, input: event.input, parseError: event.inputParseError ?? false });
          yield { type: "tool_use_start", toolName: event.name, toolInput: event.input };
        }
        // message_stop is consumed but not yielded
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const event = { type: "agent_error" as const, error, messages: workingMessages };
      yield event;
      return { reason: "agent_error", error, messages: workingMessages };
    }

    // Accumulate assistant turn
    const assistantContent: ContentBlock[] = [];
    if (textChunks.length > 0) {
      assistantContent.push({ type: "text", text: textChunks.join("") });
    }
    for (const tu of pendingToolUses) {
      // tu.input is always a serializable JSON value ({} on a parse error), never
      // a sentinel — so this assistant turn stays valid when threaded back into a
      // later request. The parse-error signal rides on tu.parseError, consumed by
      // runTools below; it is intentionally NOT persisted into history.
      assistantContent.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
    }
    // Skip empty assistant turns (no text, no tools — e.g. a refusal). Pushing
    // { role: "assistant", content: [] } would make the returned history invalid
    // if the caller threads it into a later run() (the API rejects empty content).
    if (assistantContent.length > 0) {
      workingMessages.push({ role: "assistant", content: assistantContent });
    }

    turnsUsed++;

    // Tool execution
    if (pendingToolUses.length > 0) {
      const toolResultBlocks: ContentBlock[] = [];

      for await (const toolEvent of runTools(pendingToolUses, registry, platform, context)) {
        yield toolEvent;  // { type: "tool_result", ... }
        if (toolEvent.type === "tool_result") {
          // Serialize defensively. A successful tool can still return an
          // unserializable value (circular ref, BigInt), and serializeToolResult
          // would throw. Catch it here so it becomes a recoverable tool error
          // (spec §5.6 — "could not serialize result") rather than an exception
          // thrown to the caller. runTools itself never throws: every tool.call
          // is individually try/caught inside it, so this is the only throw site
          // in the tool-execution phase.
          let content: string;
          let isError = toolEvent.isError;
          try {
            content = serializeToolResult(toolEvent.result);
          } catch (err) {
            content = `Tool '${toolEvent.toolName}': could not serialize result — ${
              err instanceof Error ? err.message : String(err)
            }`;
            isError = true;
          }
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: toolEvent.toolCallId,
            content,
            is_error: isError,
          });
        }
      }

      workingMessages.push({ role: "user", content: toolResultBlocks });

      yield { type: "turn_complete", turnIndex };
      turnIndex++;
      // loop
    } else {
      // Natural completion
      yield { type: "turn_complete", turnIndex };
      const event = { type: "agent_done" as const, messages: workingMessages };
      yield event;
      return { reason: "agent_done", messages: workingMessages };
    }
  }
}
```

---

## `packages/core/src/loop/runTools.ts` (skeleton)

```ts
import type { AgentEvent } from "../types/events.js";
import type { Platform } from "../types/platform.js";
import type { ToolCallContext } from "../types/tool.js";
import { ToolRegistry } from "../tools/registry.js";

type ToolUseEntry = { id: string; name: string; input: unknown; parseError?: boolean };

/**
 * Sequential tool execution for M1.
 * Yields tool_result AgentEvents as each tool completes.
 * M2: add isConcurrencySafe() batching here without changing the call site.
 */
export async function* runTools(
  toolUses: ToolUseEntry[],
  registry: ToolRegistry,
  platform: Platform,
  context: ToolCallContext,
): AsyncGenerator<AgentEvent> {
  for (const tu of toolUses) {
    const tool = registry.findByName(tu.name);

    if (tool === undefined) {
      yield {
        type: "tool_result",
        toolName: tu.name,
        toolCallId: tu.id,
        result: `Unknown tool: '${tu.name}'`,
        isError: true,
      };
      continue;
    }

    // Malformed streamed tool input (§6.1). The mapper could not JSON.parse the
    // accumulated input_json_delta and flagged this entry with parseError: true
    // (its `input` is a placeholder {}). Detect it BEFORE Zod so the model gets
    // the dedicated parse-error message, not an ambiguous Zod validation failure.
    if (tu.parseError) {
      yield {
        type: "tool_result",
        toolName: tool.name,
        toolCallId: tu.id,
        result: `Tool '${tool.name}': could not parse tool input as JSON`,
        isError: true,
      };
      continue;
    }

    const parseResult = tool.inputSchema.safeParse(tu.input);
    if (!parseResult.success) {
      yield {
        type: "tool_result",
        toolName: tool.name,
        toolCallId: tu.id,
        result: `Tool '${tool.name}': invalid input — ${parseResult.error.message}`,
        isError: true,
      };
      continue;
    }

    try {
      const result = await tool.call(parseResult.data, platform, context);
      yield {
        type: "tool_result",
        toolName: tool.name,
        toolCallId: tu.id,
        result,
        isError: false,
      };
    } catch (err) {
      yield {
        type: "tool_result",
        toolName: tool.name,
        toolCallId: tu.id,
        result: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  }
}
```

---

## `packages/core/src/tools/registry.ts` (skeleton)

```ts
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "../types/tool.js";
import type { ToolSchema } from "../types/provider.js";

export class ToolRegistry {
  private readonly byName: Map<string, Tool>;

  constructor(tools: Tool[]) {
    this.byName = new Map(tools.map(t => [t.name, t]));
  }

  findByName(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  toSchemas(): ToolSchema[] {
    return Array.from(this.byName.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema, {
        target: "openApi3",
        $refStrategy: "none",  // inline all refs for Anthropic compatibility
      }) as ToolSchema["inputSchema"],
    }));
  }
}
```

---

## `packages/core/src/env/context.ts` (skeleton)

```ts
import type { Platform } from "../types/platform.js";

/**
 * Build the env context block prepended to the system prompt.
 * Calls platform.exec() for git information; failures are silently omitted (§6.15).
 * Called once per agent.run() invocation; not memoized at the core level.
 */
export async function buildEnvContext(platform: Platform): Promise<string> {
  const lines: string[] = [];

  // Working directory — obtained via platform.cwd() so this module stays
  // environment-agnostic (no process reference allowed outside platform/node.ts).
  lines.push(`Working directory: ${platform.cwd()}`);

  // Date (always present; new Date() is universal, not Node-specific)
  lines.push(`Date: ${new Date().toISOString().slice(0, 10)}`);

  // Git branch (omit on failure)
  try {
    const branchResult = await platform.exec("git rev-parse --abbrev-ref HEAD");
    if (branchResult.exitCode === 0) {
      lines.push(`Git branch: ${branchResult.stdout.trim()}`);
    }
  } catch {
    // not a git repo or git not installed — silently omit
  }

  // Git status summary (omit on failure)
  try {
    const statusResult = await platform.exec("git status --short");
    if (statusResult.exitCode === 0) {
      const statusLines = statusResult.stdout.trim().split("\n").filter(Boolean);
      if (statusLines.length > 0) {
        lines.push(`Git status: ${statusLines.length} file(s) modified`);
      } else {
        lines.push("Git status: clean");
      }
    }
  } catch {
    // silently omit
  }

  return lines.join("\n");
}
```

---

## `packages/core/src/utils/serialize.ts`

```ts
/**
 * Serialize a tool call result to a string for inclusion in a tool_result message.
 * If the value is already a string, returns it as-is.
 * Otherwise JSON.stringify. Throws if serialization fails — caller should catch.
 */
export function serializeToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}
```

---

## `packages/core/src/utils/collect.ts`

```ts
import type { AgentEvent, Terminal } from "../types/events.js";

/**
 * Collect all text_delta events into a single string.
 * Drives the generator to completion. Discards the Terminal return value.
 * Use for simple one-shot non-streaming callers.
 */
export async function collectText(
  gen: AsyncGenerator<AgentEvent, Terminal>,
): Promise<string> {
  const chunks: string[] = [];
  for await (const event of gen) {
    if (event.type === "text_delta") chunks.push(event.text);
  }
  return chunks.join("");
}

/**
 * Collect all events into an array. Also returns the Terminal.
 * Use in tests to assert exact event sequences.
 */
export async function collectEvents(
  gen: AsyncGenerator<AgentEvent, Terminal>,
): Promise<{ events: AgentEvent[]; terminal: Terminal }> {
  const events: AgentEvent[] = [];
  let terminal!: Terminal;
  let result: IteratorResult<AgentEvent, Terminal>;

  const iterator = gen[Symbol.asyncIterator]();
  while (true) {
    result = await iterator.next();
    if (result.done) {
      terminal = result.value;
      break;
    }
    events.push(result.value);
  }

  return { events, terminal };
}
```

---

## `packages/core/src/providers/anthropic-mapper.ts` (skeleton)

```ts
import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderRequest, ProviderEvent, ToolSchema } from "../types/provider.js";

// Malformed streamed tool input (§6.1) is signalled provider-agnostically by the
// optional `inputParseError: true` boolean on a tool_use ProviderEvent, with
// `input` set to a valid placeholder {}. runTools detects the flag before Zod and
// emits §6.1's message. No sentinel value is placed in `input`, so the assistant
// turn the loop persists stays JSON-serializable when threaded into the next request.

/** ProviderRequest → Anthropic streaming params. */
export function mapRequest(
  request: ProviderRequest,
  model: string,
  defaultMaxTokens: number,
): Anthropic.Messages.MessageCreateParamsStreaming {
  return {
    model,
    // ProviderRequest.maxTokens is optional; the provider always sends a concrete
    // value because the Anthropic API requires max_tokens. Precedence here:
    // per-request override (request.maxTokens) → provider default (defaultMaxTokens,
    // which the provider resolved as options.maxTokens ?? 32000 at construction).
    max_tokens: request.maxTokens ?? defaultMaxTokens,
    system: request.systemPrompt,
    messages: request.messages as Anthropic.MessageParam[], // structurally compatible
    tools: mapTools(request.tools),
    stream: true,
  };
}

function mapTools(schemas: ToolSchema[]): Anthropic.Tool[] {
  return schemas.map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: s.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

/**
 * Stateful accumulator for streamed tool_use input. The Anthropic stream sends
 * a tool_use block's arguments as a sequence of input_json_delta chunks that
 * must be concatenated and parsed once at content_block_stop. One instance per
 * provider.stream() call; tracks every concurrent block by index.
 */
type FinishResult =
  | { kind: "ok";          id: string; name: string; input: unknown }
  | { kind: "parse_error"; id: string; name: string };

export class InputAccumulator {
  private readonly blocks = new Map<number, { id: string; name: string; json: string }>();
  private stopReason: string | undefined;

  /** Cache the stop_reason seen on a message_delta event. */
  setStopReason(reason: string): void {
    this.stopReason = reason;
  }

  /** Return the cached stop_reason at message_stop, defaulting to "end_turn". */
  takeStopReason(): string {
    return this.stopReason ?? "end_turn";
  }

  /** Called at content_block_start for a tool_use block. */
  startBlock(index: number, id: string, name: string): void {
    this.blocks.set(index, { id, name, json: "" });
  }

  /** Called for each input_json_delta on a block. */
  appendDelta(index: number, partialJson: string): void {
    const block = this.blocks.get(index);
    if (block) block.json += partialJson;
  }

  /**
   * Called at content_block_stop. Returns a discriminated result: "ok" with the
   * parsed input, or "parse_error" when the accumulated JSON is unparseable.
   * The caller (translateStreamEvent) maps "parse_error" to a tool_use event with
   * `input: {}` and `inputParseError: true` — the boolean flag, not a value in
   * `input`, carries the signal, so runTools can tell a genuine parse failure
   * apart from a tool that legitimately takes `{}`/null while keeping `input`
   * JSON-serializable.
   * An empty buffer is treated as `{}` (Anthropic emits no deltas for a no-arg call).
   */
  finishBlock(index: number): FinishResult {
    const block = this.blocks.get(index);
    if (!block) return { kind: "parse_error", id: "", name: "" };
    this.blocks.delete(index);
    const raw = block.json.trim();
    try {
      const input = raw === "" ? {} : JSON.parse(raw);
      return { kind: "ok", id: block.id, name: block.name, input };
    } catch {
      return { kind: "parse_error", id: block.id, name: block.name };
    }
  }
}

/**
 * Translate one Anthropic stream event into zero or more ProviderEvents,
 * threading per-block state through the accumulator.
 */
export function* translateStreamEvent(
  event: Anthropic.MessageStreamEvent,
  acc: InputAccumulator,
): Generator<ProviderEvent> {
  switch (event.type) {
    case "content_block_start":
      if (event.content_block.type === "tool_use") {
        acc.startBlock(event.index, event.content_block.id, event.content_block.name);
      }
      return;
    case "content_block_delta":
      if (event.delta.type === "text_delta") {
        yield { type: "text_delta", text: event.delta.text };
      } else if (event.delta.type === "input_json_delta") {
        acc.appendDelta(event.index, event.delta.partial_json);
      }
      return;
    case "content_block_stop": {
      const finish = acc.finishBlock(event.index);
      if (!finish.id) return; // not a tool_use block (text block stop)
      if (finish.kind === "ok") {
        yield { type: "tool_use", id: finish.id, name: finish.name, input: finish.input };
      } else {
        // parse_error → placeholder {} input + inputParseError flag; runTools emits
        // the dedicated §6.1 message. `input` stays JSON-serializable for history.
        yield { type: "tool_use", id: finish.id, name: finish.name, input: {}, inputParseError: true };
      }
      return;
    }
    case "message_delta":
      // stop_reason lives on the message_delta; cache it for message_stop below.
      if (event.delta?.stop_reason) acc.setStopReason(event.delta.stop_reason);
      return;
    case "message_stop":
      yield { type: "message_stop", stopReason: acc.takeStopReason() };
      return;
    default:
      return; // message_start, ping, etc. — ignored in M1
  }
}
```

> Note: `content_block_stop` does not carry the block type, so `finishBlock` returns an empty `id` for non-tool (text) blocks — the caller skips emitting a `tool_use` for those. The real `stop_reason` is cached on the `InputAccumulator` from `message_delta` (`setStopReason`) and emitted on the `message_stop` ProviderEvent (`takeStopReason`, defaulting to `"end_turn"` if no delta carried one). This stateful per-block accumulation is the highest-risk module in M1 and has its own task + test file (`anthropic-mapper.test.ts`); see `docs/decisions.md` "Anthropic mapper is its own task".

---

## `packages/core/src/providers/anthropic.ts` (skeleton)

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { Provider, ProviderRequest, ProviderEvent, Logger } from "../types/provider.js";
import { mapRequest, translateStreamEvent, InputAccumulator } from "./anthropic-mapper.js";
// withRetry is NOT imported here. The Anthropic SDK retries internally via maxRetries.

export type AnthropicProviderOptions = {
  apiKey: string;
  model: string;
  maxRetries?: number;   // default: 3; delegated to the SDK's built-in retry
  baseURL?: string;
  maxTokens?: number;    // default: 32000
  logger?: Logger;
};

export class AnthropicProvider implements Provider {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly maxTokens: number;
  private readonly logger?: Logger;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey) {
      throw new Error("AnthropicProvider: ANTHROPIC_API_KEY is required");
    }
    this.maxRetries = options.maxRetries ?? 3;
    this.maxTokens = options.maxTokens ?? 32000;
    this.logger = options.logger;
    this.model = options.model;
    // exactOptionalPropertyTypes: baseURL must be spread conditionally to avoid
    // passing `undefined` where the Anthropic SDK expects string | omitted.
    this.client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: this.maxRetries,  // SDK owns retry — backoff+jitter on 429/5xx/connection
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  async *stream(
    request: ProviderRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    const params = mapRequest(request, this.model, this.maxTokens);
    this.logger?.({ level: "info", event: "request_sent", request });

    const accumulator = new InputAccumulator();

    // The SDK retries transient errors (429/5xx/connection) internally per maxRetries.
    // No withRetry wrapper — wrapping only stream construction would leave iteration
    // errors unhandled; SDK retry covers both.
    const rawStream = this.client.messages.stream(params, { signal });

    for await (const event of rawStream) {
      for (const providerEvent of translateStreamEvent(event, accumulator)) {
        yield providerEvent;
      }
    }
  }
}
```

---

## `packages/core/src/providers/retry.ts` (skeleton)

```ts
import type { Logger } from "../types/provider.js";
// No @anthropic-ai/sdk import — this module is provider-agnostic.

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS  = 30_000;

function defaultDelayMs(attempt: number): number {
  const base = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * BASE_DELAY_MS;
  return Math.min(base + jitter, MAX_DELAY_MS);
}

/**
 * Generic transient-error retry with exponential backoff + jitter.
 *
 * NOT used by AnthropicProvider in M1 — the Anthropic SDK retries internally
 * via the `maxRetries` constructor option (equivalent policy: backoff+jitter on
 * 429/5xx/connection, honors Retry-After). OpenAI SDK (M2) will do the same.
 *
 * Provided as a documented fallback for any future provider whose backend lacks
 * built-in retry. The caller supplies `isRetryable` to classify vendor-specific
 * error shapes — this utility has no knowledge of any SDK's error types.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries: number;
    isRetryable: (error: unknown) => boolean;
    delayMs?: (attempt: number) => number;
    logger?: Logger;
  },
): Promise<T> {
  const computeDelay = options.delayMs ?? defaultDelayMs;
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (!options.isRetryable(err) || attempt === options.maxRetries) break;
      const delay = computeDelay(attempt);
      options.logger?.({
        level: "info",
        event: "retry_attempt",
        attempt: attempt + 1,
        delayMs: delay,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      await new Promise(res => setTimeout(res, delay));
    }
  }
  const finalError = lastError instanceof Error ? lastError : new Error(String(lastError));
  options.logger?.({ level: "error", event: "request_failed", error: finalError });
  throw finalError;
}
```

---

## `packages/core/src/platform/node.ts` (skeleton)

```ts
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Platform, ExecOptions, ExecResult } from "../types/platform.js";

const execFileAsync = promisify(execFile);

/**
 * Node.js implementation of the Platform interface.
 * The ONLY module in the core package that imports Node built-ins or references
 * `process`. Any use of `process`, `fs`, or `child_process` outside this file
 * is a lint error.
 * Exported from tiny-agentic/platform/node (separate entry point).
 */
export class NodePlatform implements Platform {
  /** Returns the current working directory. Only place process.cwd() is called. */
  cwd(): string {
    return process.cwd();
  }

  async readFile(path: string, _encoding: "utf-8" = "utf-8"): Promise<string> {
    return readFile(path, "utf-8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await writeFile(path, content, "utf-8");
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    // Split command into program + args. Simple split; no shell expansion.
    // For shell commands with pipes/redirects, use /bin/sh -c.
    const [program, ...args] = command.split(" ");
    try {
      const { stdout, stderr } = await execFileAsync(program!, args, {
        cwd: options.cwd,
        timeout: options.timeout,
        env: options.env ? { ...process.env, ...options.env } : undefined,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: execErr.stdout ?? "",
        stderr: execErr.stderr ?? "",
        exitCode: execErr.code ?? 1,
      };
    }
  }
}
```

Note: the `exec` implementation above uses simple space-split. The env context builder calls `platform.exec("git rev-parse --abbrev-ref HEAD")` which splits cleanly. For more complex shell commands (pipes, redirects), callers should pass `"/bin/sh -c 'actual command'"`. The built-in tools in M1 (`read_file`, `write_file`) do not use `exec`; only the env context builder uses it.

---

## `packages/core/src/tools/builtin/readFile.ts`

```ts
import { z } from "zod";
import { defineTool } from "../../types/tool.js";

export const readFileTool = defineTool({
  name: "read_file",
  description: "Read a file at the given path and return its contents as a string.",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative path to the file."),
  }),
  // `path` is typed as string (inferred from the Zod schema), not unknown.
  call: async ({ path }, platform) => ({
    content: await platform.readFile(path),
  }),
});
```

---

## `packages/core/src/tools/builtin/writeFile.ts`

```ts
import { z } from "zod";
import { defineTool } from "../../types/tool.js";

export const writeFileTool = defineTool({
  name: "write_file",
  description: "Write content to a file at the given path. Creates the file if it does not exist; overwrites if it does.",
  inputSchema: z.object({
    path:    z.string().describe("Absolute or relative path to the file."),
    content: z.string().describe("Content to write."),
  }),
  // `path` and `content` are typed as string (inferred from the Zod schema).
  call: async ({ path, content }, platform) => {
    await platform.writeFile(path, content);
    return { written: true, path };
  },
});
```

---

## `packages/core/src/index.ts`

```ts
// Public surface of tiny-agentic (core package)
// Import from sub-entries for provider and platform:
//   import { AnthropicProvider } from "tiny-agentic/providers/anthropic"
//   import { NodePlatform } from "tiny-agentic/platform/node"
//   import { collectText } from "tiny-agentic/utils"

export { Agent } from "./agent.js";
export type { AgentOptions, RunOptions } from "./agent.js";

export type { AgentEvent, Terminal } from "./types/events.js";
export type { Message, ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock } from "./types/messages.js";
export type { Tool, ToolCallContext } from "./types/tool.js";
export { defineTool } from "./types/tool.js";
export type { Provider, ProviderRequest, ProviderEvent, ToolSchema, Logger, LogEntry } from "./types/provider.js";
export type { Platform, ExecOptions, ExecResult } from "./types/platform.js";

export { readFileTool } from "./tools/builtin/readFile.js";
export { writeFileTool } from "./tools/builtin/writeFile.js";
```

---

## `packages/core/package.json` (key fields)

```json
{
  "name": "tiny-agentic",
  "version": "0.1.0",
  "description": "Headless agentic engine: agent loop, tools, provider abstraction, typed event stream.",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22.0.0" },
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./providers/anthropic": {
      "import": "./dist/providers/anthropic.js",
      "types": "./dist/providers/anthropic.d.ts"
    },
    "./platform/node": {
      "import": "./dist/platform/node.js",
      "types": "./dist/platform/node.d.ts"
    },
    "./utils": {
      "import": "./dist/utils/collect.js",
      "types": "./dist/utils/collect.d.ts"
    }
  },
  "scripts": {
    "build":     "tsup",
    "typecheck": "tsc --noEmit",
    "test":      "vitest run",
    "test:watch":"vitest"
  },
  "dependencies": {
    "zod-to-json-schema": "^3.23.0"
  },
  "peerDependencies": {
    "zod": "^3.22.0",
    "@anthropic-ai/sdk": "^0.52.0"
  },
  "peerDependenciesMeta": {
    "@anthropic-ai/sdk": { "optional": true }
  },
  "devDependencies": {
    "@anthropic-ai/sdk": "^0.52.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "tsup": "^8.0.0",
    "vitest": "^3.0.0"
  }
}
```

Note: `@anthropic-ai/sdk` is an **optional peer dependency** (`peerDependenciesMeta.optional: true`) — a consumer who uses `AnthropicProvider` installs it themselves; the core entry point never imports it, so an OpenAI-only consumer is unaffected and gets no install warning. It is also in `devDependencies` for local development and tests. `zod` is a (required) peer dependency because consumers author tool schemas with it directly.

`@types/node` is a **devDependency pinned to the runtime floor** (`^22`, matching `engines.node` `>=22.0.0`). It supplies the ambient `AbortSignal` type used in `Provider.stream(request, signal?)` (absent from `lib: ["ES2022"]`), and pinning it to the supported Node major keeps the core typed against the runtime it actually targets rather than a newer Node. It is intentionally **not** a runtime `dependency` — it contributes only types, stripped at build. The matching `skipLibCheck: true` in `tsconfig.base.json` (above) is what makes `pnpm -r typecheck` pass with this runtime-accurate version: it prevents `tsc` from type-checking unrelated third-party `.d.ts` (e.g. vite's, pulled via vitest) that reference globals only present in a newer `@types/node`.

---

## `packages/core/tsup.config.ts`

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index:               "src/index.ts",
    "providers/anthropic": "src/providers/anthropic.ts",
    "platform/node":     "src/platform/node.ts",
    "utils/collect":     "src/utils/collect.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
});
```

---

## Root `pnpm-workspace.yaml`

```yaml
packages:
  - "packages/*"
```

---

## Root `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "Node16",
    "moduleResolution": "Node16",
    "types": ["node"],
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

**`skipLibCheck: true` (and `types: ["node"]`).** The core needs `@types/node` to type `AbortSignal` (used in `Provider.stream(req, signal?)`), which is absent from `lib: ["ES2022"]`. `@types/node` is pinned to the **runtime floor** (`^22`, see below). With `skipLibCheck: false`, `tsc` also type-checks third-party bundled `.d.ts` pulled in transitively (e.g. vite's declarations via vitest, which reference the `WebSocket` global): a runtime-accurate `@types/node@22` then fails on globals that only exist in newer `@types/node`, while a too-new `@types/node` would type the core against a Node newer than the supported runtime. `skipLibCheck: true` is the idiomatic setting for a TypeScript library — third-party `.d.ts` files are not ours to type-check, and `tsc` still fully type-checks **our own** `src/`. Verified: `tsc --noEmit --skipLibCheck` passes cleanly with a runtime-accurate `@types/node`. `types: ["node"]` keeps the ambient global set explicit (only Node globals, not every installed `@types/*`). See `docs/decisions.md` "skipLibCheck + @types/node pinned to the runtime floor".

---

## ESLint — boundary & purity enforcement

These configs make the "no UI imports" (success criterion 7.11), "no core filesystem imports" (7.12), and one-way-dependency (§1.4) rules machine-checked. Flat config (`eslint.config.js`), ESLint 9+.

### Root `eslint.config.js`

```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/*.config.ts", "**/*.config.js"] },
  ...tseslint.configs.recommended,
  // Core package: no UI deps, no Node built-ins / `process` outside platform/node.ts.
  {
    files: ["packages/core/src/**/*.ts"],
    ignores: ["packages/core/src/platform/node.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "tiny-agentic-sdk", message: "core must not import the SDK layer (one-way deps: UI → SDK → core)." },
          { name: "tiny-agentic-ui",  message: "core must not import the UI layer (one-way deps: UI → SDK → core)." },
          { name: "fs",               message: "core is filesystem-free; use the injected Platform. fs is allowed only in platform/node.ts." },
          { name: "node:fs",          message: "core is filesystem-free; use the injected Platform." },
          { name: "fs/promises",      message: "core is filesystem-free; use the injected Platform." },
          { name: "node:fs/promises", message: "core is filesystem-free; use the injected Platform." },
          { name: "child_process",    message: "core is shell-free; use platform.exec." },
          { name: "node:child_process", message: "core is shell-free; use platform.exec." },
        ],
        patterns: [
          { group: ["react", "react-dom", "ink", "chalk", "ora"], message: "core is UI-free (success criterion 7.11)." },
        ],
      }],
      // Block bare `process` references in core (success criterion 7.12 extension).
      "no-restricted-globals": ["error", { name: "process", message: "core must not reference `process`; cwd comes from platform.cwd(). Allowed only in platform/node.ts." }],
    },
  },
  // SDK package: may import core, not UI.
  {
    files: ["packages/sdk/src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{ name: "tiny-agentic-ui", message: "SDK must not import the UI layer." }],
      }],
    },
  },
);
```

This is belt-and-suspenders on top of the structural enforcement (pnpm has no symlink from core → sdk/ui, and core's `tsconfig.json` has no `references` to them). The lint layer additionally catches *intra-monorepo deep imports* and Node-builtin usage that the package graph alone would not.

---

*Code architecture complete. The planner can reference these skeletons directly when writing task briefs. Implementations should match these signatures exactly; deviations require a note in the task's completion doc.*

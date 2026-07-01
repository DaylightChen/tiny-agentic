import type { ZodType, z } from "zod";
import type { Platform } from "./platform.js";
import type { Usage } from "./usage.js";
import type { SubagentChildEvent } from "./events.js";

/**
 * Extensible context object passed to every Tool.call invocation.
 * Declared as an interface (not type) to enable declaration merging.
 *
 * Two kinds of fields live here:
 *   - Core-layer fields (e.g. `signal`) — populated by agentLoop inside the
 *     core package. Add these here when the core loop needs to thread data
 *     into tools.
 *   - SDK-layer fields (e.g. skillRegistry, commandRegistry) — added via
 *     declaration merging in the SDK package, populated by the SDK runtime.
 *     Do not add SDK-layer fields here.
 */
export interface ToolCallContext {
  signal?: AbortSignal;  // populated by agentLoop; tools forward to Platform.exec
  /** Report token usage consumed by work a tool performed out-of-band (e.g. a
   *  child Agent run). agentLoop folds this into the run's cumulative usage
   *  after the tool batch. Safe to call multiple times; each call accumulates. */
  reportUsage?: (usage: Usage) => void;
  /** Emit a sanitized child event onto the parent's stream from inside a tool.
   *  Used by the task tool to surface the child's lifecycle. In v1 the loop
   *  buffers these and yields them (wrapped as `subagent_event`) immediately
   *  before the tool's `tool_result`. Never carries child `messages`. */
  emitEvent?: (event: SubagentChildEvent) => void;
  /** The tool-use id of the call currently executing. Populated by the loop per
   *  tool-use so a tool can correlate emitted events / logs to its own call
   *  (the task tool uses it as `taskId`). Absent for tools that don't need it. */
  toolCallId?: string;
}

/**
 * Decision returned by an ApprovalHandler.
 */
export type ApprovalDecision = 'allow' | 'deny';

/**
 * Optional callback injected into AgentOptions. Called before every tool.call,
 * after Zod validation. Return 'allow' to proceed or 'deny' to block. If this
 * callback throws, the tool call is blocked and the error message is returned
 * to the model.
 *
 * If not provided, all tool calls are allowed (blanket allow default).
 */
export type ApprovalHandler = (
  toolName: string,
  input: unknown,
) => Promise<ApprovalDecision>;

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

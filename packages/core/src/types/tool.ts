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
   *  child Agent run). Each call's isolated context appends to that call's
   *  envelope; the loop folds only that usage after yielding and serializing
   *  the envelope's result. Safe to call multiple times within the call. */
  reportUsage?: (usage: Usage) => void;
  /** Emit a sanitized child event from inside a tool. Each call's isolated
   *  context buffers events in that call's envelope; the loop yields them
   *  (wrapped as `subagent_event`) immediately before the same envelope's
   *  `tool_result`. Never carries child `messages`. */
  emitEvent?: (event: SubagentChildEvent) => void;
  /** The tool-use id attributed to this isolated call context. `runTools` sets
   *  it on a fresh shallow clone for each executable call, so sibling and base
   *  contexts do not share the per-call property. The task tool uses it as
   *  `taskId`; envelope ordering does not depend on later context mutation. */
  toolCallId?: string;
  /** Current sub-agent recursion depth: 0 at the top level, incremented by one
   *  for each nested `Agent.run`. Seeded by `agentLoop` from `RunOptions.depth`.
   *  The `task` tool reads it to enforce its `maxDepth` backstop against runaway
   *  nested spawning, and passes `depth + 1` to the child it drives. */
  depth?: number;
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
   * Synchronous concurrency classifier invoked once after successful validation
   * and before approval. It must be pure, deterministic, and side-effect-free.
   * Returning true certifies that this call may overlap other safe calls without
   * violating the tool or Platform contract, including access to referenced
   * declaration-merged state in the shallow-copied context. Absence or false
   * makes the call a sequential barrier. Throwing produces an error barrier and
   * skips approval and execution.
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

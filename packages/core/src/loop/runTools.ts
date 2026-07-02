import type { AgentEvent } from "../types/events.js";
import type { Platform } from "../types/platform.js";
import type { ApprovalDecision, ApprovalHandler, ToolCallContext } from "../types/tool.js";
import { ToolRegistry } from "../tools/registry.js";

type ToolUseEntry = { id: string; name: string; input: unknown; parseError?: boolean };

/**
 * Sequential tool execution for M1.
 * Yields tool_result AgentEvents as each tool completes.
 * M2: add isConcurrencySafe() batching here — check tool.isConcurrencySafe?.(input)
 * and run safe calls via Promise.all — without changing this call site.
 */
export async function* runTools(
  toolUses: ToolUseEntry[],
  registry: ToolRegistry,
  platform: Platform,
  context: ToolCallContext,
  approvalHandler?: ApprovalHandler,
): AsyncGenerator<AgentEvent> {
  for (const tu of toolUses) {
    // Correlation id for the currently-executing call (a tool reads it as its
    // own tool-use id, e.g. the task tool's `taskId`). Set per tool-use and
    // cleared in the finally so the early-return branches below (unknown tool,
    // parse failure, validation failure, denied approval) cannot leak this id
    // into a later call's context.
    context.toolCallId = tu.id;
    try {
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

      // Approval gate — runs after Zod validation, before tool.call
      if (approvalHandler !== undefined) {
        let decision: ApprovalDecision;
        try {
          decision = await approvalHandler(tool.name, parseResult.data);
        } catch (err) {
          yield {
            type: "tool_result",
            toolName: tool.name,
            toolCallId: tu.id,
            result: `Tool '${tool.name}': approval check failed — ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
          continue;
        }
        if (decision !== 'allow') {
          yield {
            type: "tool_result",
            toolName: tool.name,
            toolCallId: tu.id,
            result: `Tool '${tool.name}': call denied by approvalHandler`,
            isError: true,
          };
          continue;
        }
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
    } finally {
      delete context.toolCallId;
    }
  }
}

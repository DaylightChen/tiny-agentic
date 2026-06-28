import type { AgentEvent } from "../types/events.js";
import type { Platform } from "../types/platform.js";
import type { ToolCallContext } from "../types/tool.js";
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

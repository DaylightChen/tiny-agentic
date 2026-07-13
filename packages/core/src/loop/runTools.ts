import type { AgentEvent, SubagentChildEvent } from "../types/events.js";
import type { Platform } from "../types/platform.js";
import type { ApprovalDecision, ApprovalHandler, Tool, ToolCallContext } from "../types/tool.js";
import type { Usage } from "../types/usage.js";
import { ToolRegistry } from "../tools/registry.js";

type ToolUseEntry = {
  id: string;
  name: string;
  input: unknown;
  parseError?: boolean;
};

type ToolResultEvent = Extract<AgentEvent, { type: "tool_result" }>;

type ToolExecution = {
  event: ToolResultEvent;
  childEvents: SubagentChildEvent[];
  reportedUsage: Usage[];
};

function emptyExecution(event: ToolResultEvent): ToolExecution {
  return { event, childEvents: [], reportedUsage: [] };
}

async function executeTool(
  toolUse: ToolUseEntry,
  tool: Tool,
  input: unknown,
  platform: Platform,
  context: ToolCallContext,
  childEvents: SubagentChildEvent[],
  reportedUsage: Usage[],
): Promise<ToolExecution> {
  try {
    const result = await tool.call(input, platform, context);
    return {
      event: {
        type: "tool_result",
        toolName: tool.name,
        toolCallId: toolUse.id,
        result,
        isError: false,
      },
      childEvents,
      reportedUsage,
    };
  } catch (err) {
    return {
      event: {
        type: "tool_result",
        toolName: tool.name,
        toolCallId: toolUse.id,
        result: err instanceof Error ? err.message : String(err),
        isError: true,
      },
      childEvents,
      reportedUsage,
    };
  }
}

/**
 * Executes tool calls sequentially and yields one isolated attribution envelope
 * after each call. Safe batching is added by the next scheduler task.
 */
export async function* runTools(
  toolUses: ToolUseEntry[],
  registry: ToolRegistry,
  platform: Platform,
  baseContext: ToolCallContext,
  approvalHandler?: ApprovalHandler,
): AsyncGenerator<ToolExecution> {
  for (const toolUse of toolUses) {
    const tool = registry.findByName(toolUse.name);

    if (tool === undefined) {
      yield emptyExecution({
        type: "tool_result",
        toolName: toolUse.name,
        toolCallId: toolUse.id,
        result: `Unknown tool: '${toolUse.name}'`,
        isError: true,
      });
      continue;
    }

    if (toolUse.parseError) {
      yield emptyExecution({
        type: "tool_result",
        toolName: tool.name,
        toolCallId: toolUse.id,
        result: `Tool '${tool.name}': could not parse tool input as JSON`,
        isError: true,
      });
      continue;
    }

    const parseResult = tool.inputSchema.safeParse(toolUse.input);
    if (!parseResult.success) {
      yield emptyExecution({
        type: "tool_result",
        toolName: tool.name,
        toolCallId: toolUse.id,
        result: `Tool '${tool.name}': invalid input — ${parseResult.error.message}`,
        isError: true,
      });
      continue;
    }

    const childEvents: SubagentChildEvent[] = [];
    const reportedUsage: Usage[] = [];
    const context: ToolCallContext = {
      ...baseContext,
      toolCallId: toolUse.id,
      reportUsage: (usage) => {
        reportedUsage.push(usage);
      },
      emitEvent: (event) => {
        childEvents.push(event);
      },
    };

    if (approvalHandler !== undefined) {
      let decision: ApprovalDecision;
      try {
        decision = await approvalHandler(tool.name, parseResult.data);
      } catch (err) {
        yield {
          event: {
            type: "tool_result",
            toolName: tool.name,
            toolCallId: toolUse.id,
            result: `Tool '${tool.name}': approval check failed — ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          },
          childEvents,
          reportedUsage,
        };
        continue;
      }
      if (decision !== "allow") {
        yield {
          event: {
            type: "tool_result",
            toolName: tool.name,
            toolCallId: toolUse.id,
            result: `Tool '${tool.name}': call denied by approvalHandler`,
            isError: true,
          },
          childEvents,
          reportedUsage,
        };
        continue;
      }
    }

    yield await executeTool(
      toolUse,
      tool,
      parseResult.data,
      platform,
      context,
      childEvents,
      reportedUsage,
    );
  }
}

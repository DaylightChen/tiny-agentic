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

type PreparedExecution = {
  toolUse: ToolUseEntry;
  tool: Tool;
  input: unknown;
  concurrencySafe: boolean;
  context: ToolCallContext;
  childEvents: SubagentChildEvent[];
  reportedUsage: Usage[];
};

function emptyExecution(event: ToolResultEvent): ToolExecution {
  return { event, childEvents: [], reportedUsage: [] };
}

function prepareExecution(
  toolUse: ToolUseEntry,
  tool: Tool,
  input: unknown,
  concurrencySafe: boolean,
  baseContext: ToolCallContext,
): PreparedExecution {
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

  return {
    toolUse,
    tool,
    input,
    concurrencySafe,
    context,
    childEvents,
    reportedUsage,
  };
}

async function approvePrepared(
  prepared: PreparedExecution,
  approvalHandler: ApprovalHandler | undefined,
): Promise<ToolExecution | undefined> {
  if (approvalHandler === undefined) return undefined;

  let decision: ApprovalDecision;
  try {
    decision = await approvalHandler(prepared.tool.name, prepared.input);
  } catch (err) {
    return {
      event: {
        type: "tool_result",
        toolName: prepared.tool.name,
        toolCallId: prepared.toolUse.id,
        result: `Tool '${prepared.tool.name}': approval check failed — ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      },
      childEvents: prepared.childEvents,
      reportedUsage: prepared.reportedUsage,
    };
  }

  if (decision === "allow") return undefined;

  return {
    event: {
      type: "tool_result",
      toolName: prepared.tool.name,
      toolCallId: prepared.toolUse.id,
      result: `Tool '${prepared.tool.name}': call denied by approvalHandler`,
      isError: true,
    },
    childEvents: prepared.childEvents,
    reportedUsage: prepared.reportedUsage,
  };
}

async function executePrepared(
  prepared: PreparedExecution,
  platform: Platform,
): Promise<ToolExecution> {
  try {
    const result = await prepared.tool.call(
      prepared.input,
      platform,
      prepared.context,
    );
    return {
      event: {
        type: "tool_result",
        toolName: prepared.tool.name,
        toolCallId: prepared.toolUse.id,
        result,
        isError: false,
      },
      childEvents: prepared.childEvents,
      reportedUsage: prepared.reportedUsage,
    };
  } catch (err) {
    return {
      event: {
        type: "tool_result",
        toolName: prepared.tool.name,
        toolCallId: prepared.toolUse.id,
        result: err instanceof Error ? err.message : String(err),
        isError: true,
      },
      childEvents: prepared.childEvents,
      reportedUsage: prepared.reportedUsage,
    };
  }
}

function rejectedExecution(
  prepared: PreparedExecution,
  reason: unknown,
): ToolExecution {
  return {
    event: {
      type: "tool_result",
      toolName: prepared.tool.name,
      toolCallId: prepared.toolUse.id,
      result: reason instanceof Error ? reason.message : String(reason),
      isError: true,
    },
    childEvents: prepared.childEvents,
    reportedUsage: prepared.reportedUsage,
  };
}

async function executeBatch(
  batch: PreparedExecution[],
  platform: Platform,
): Promise<ToolExecution[]> {
  const promises = batch.map((prepared) => executePrepared(prepared, platform));
  const settlements = await Promise.allSettled(promises);

  return settlements.map((settlement, index) => {
    if (settlement.status === "fulfilled") return settlement.value;
    const prepared = batch[index]!;
    return rejectedExecution(prepared, settlement.reason);
  });
}

/**
 * Lazily prepares calls in model order, runs maximal approved safe batches, and
 * yields isolated attribution envelopes in input order across every barrier.
 */
export async function* runTools(
  toolUses: ToolUseEntry[],
  registry: ToolRegistry,
  platform: Platform,
  baseContext: ToolCallContext,
  approvalHandler?: ApprovalHandler,
): AsyncGenerator<ToolExecution> {
  let index = 0;
  let safeBatch: PreparedExecution[] = [];

  while (index < toolUses.length) {
    const toolUse = toolUses[index];
    if (toolUse === undefined) break;

    const tool = registry.findByName(toolUse.name);

    if (tool === undefined) {
      if (safeBatch.length > 0) {
        const executions = await executeBatch(safeBatch, platform);
        safeBatch = [];
        for (const execution of executions) yield execution;
      }
      yield emptyExecution({
        type: "tool_result",
        toolName: toolUse.name,
        toolCallId: toolUse.id,
        result: `Unknown tool: '${toolUse.name}'`,
        isError: true,
      });
      index += 1;
      continue;
    }

    if (toolUse.parseError) {
      if (safeBatch.length > 0) {
        const executions = await executeBatch(safeBatch, platform);
        safeBatch = [];
        for (const execution of executions) yield execution;
      }
      yield emptyExecution({
        type: "tool_result",
        toolName: tool.name,
        toolCallId: toolUse.id,
        result: `Tool '${tool.name}': could not parse tool input as JSON`,
        isError: true,
      });
      index += 1;
      continue;
    }

    const parseResult = tool.inputSchema.safeParse(toolUse.input);
    if (!parseResult.success) {
      if (safeBatch.length > 0) {
        const executions = await executeBatch(safeBatch, platform);
        safeBatch = [];
        for (const execution of executions) yield execution;
      }
      yield emptyExecution({
        type: "tool_result",
        toolName: tool.name,
        toolCallId: toolUse.id,
        result: `Tool '${tool.name}': invalid input — ${parseResult.error.message}`,
        isError: true,
      });
      index += 1;
      continue;
    }

    let concurrencySafe: boolean;
    try {
      concurrencySafe = tool.isConcurrencySafe?.(parseResult.data) === true;
    } catch (err) {
      if (safeBatch.length > 0) {
        const executions = await executeBatch(safeBatch, platform);
        safeBatch = [];
        for (const execution of executions) yield execution;
      }
      yield emptyExecution({
        type: "tool_result",
        toolName: tool.name,
        toolCallId: toolUse.id,
        result: `Tool '${tool.name}': concurrency safety check failed — ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      });
      index += 1;
      continue;
    }

    const prepared = prepareExecution(
      toolUse,
      tool,
      parseResult.data,
      concurrencySafe,
      baseContext,
    );

    if (!prepared.concurrencySafe) {
      if (safeBatch.length > 0) {
        const executions = await executeBatch(safeBatch, platform);
        safeBatch = [];
        for (const execution of executions) yield execution;
      }

      const approvalError = await approvePrepared(prepared, approvalHandler);
      if (approvalError !== undefined) {
        yield approvalError;
      } else {
        const executions = await executeBatch([prepared], platform);
        const execution = executions[0];
        if (execution !== undefined) yield execution;
      }
      index += 1;
      continue;
    }

    const approvalError = await approvePrepared(prepared, approvalHandler);
    if (approvalError !== undefined) {
      if (safeBatch.length > 0) {
        const executions = await executeBatch(safeBatch, platform);
        safeBatch = [];
        for (const execution of executions) yield execution;
      }
      yield approvalError;
      index += 1;
      continue;
    }

    safeBatch.push(prepared);
    index += 1;
  }

  if (safeBatch.length > 0) {
    const executions = await executeBatch(safeBatch, platform);
    for (const execution of executions) yield execution;
  }
}

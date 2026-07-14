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

function cancelledExecution(toolUse: ToolUseEntry): ToolExecution {
  return emptyExecution({
    type: "tool_result",
    toolName: toolUse.name,
    toolCallId: toolUse.id,
    result: `Tool '${toolUse.name}': call cancelled before start`,
    isError: true,
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function unstartedCancellations(
  safeBatch: PreparedExecution[],
  toolUses: ToolUseEntry[],
  index: number,
): ToolExecution[] {
  return [
    ...safeBatch.map((prepared) => cancelledExecution(prepared.toolUse)),
    ...toolUses.slice(index).map(cancelledExecution),
  ];
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
  signal: AbortSignal | undefined,
): Promise<ToolExecution[]> {
  const executions: Array<ToolExecution | undefined> = new Array(batch.length);
  const startedIndexes: number[] = [];
  const promises: Promise<ToolExecution>[] = [];
  let cancellationObserved = false;

  for (let index = 0; index < batch.length; index++) {
    const prepared = batch[index]!;
    if (cancellationObserved || isAborted(signal)) {
      cancellationObserved = true;
      executions[index] = cancelledExecution(prepared.toolUse);
      continue;
    }

    startedIndexes.push(index);
    promises.push(executePrepared(prepared, platform));
  }

  const settlements = await Promise.allSettled(promises);
  for (let index = 0; index < settlements.length; index++) {
    const settlement = settlements[index]!;
    const batchIndex = startedIndexes[index]!;
    const prepared = batch[batchIndex]!;
    executions[batchIndex] = settlement.status === "fulfilled"
      ? settlement.value
      : rejectedExecution(prepared, settlement.reason);
  }

  return batch.map((prepared, index) =>
    executions[index] ?? cancelledExecution(prepared.toolUse)
  );
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
    if (isAborted(baseContext.signal)) {
      for (const execution of unstartedCancellations(safeBatch, toolUses, index)) {
        yield execution;
      }
      return;
    }

    const toolUse = toolUses[index];
    if (toolUse === undefined) break;

    const tool = registry.findByName(toolUse.name);
    let preparationError: ToolExecution | undefined;
    let prepared: PreparedExecution | undefined;

    if (tool === undefined) {
      preparationError = emptyExecution({
        type: "tool_result",
        toolName: toolUse.name,
        toolCallId: toolUse.id,
        result: `Unknown tool: '${toolUse.name}'`,
        isError: true,
      });
    } else if (toolUse.parseError) {
      preparationError = emptyExecution({
        type: "tool_result",
        toolName: tool.name,
        toolCallId: toolUse.id,
        result: `Tool '${tool.name}': could not parse tool input as JSON`,
        isError: true,
      });
    } else {
      const parseResult = tool.inputSchema.safeParse(toolUse.input);
      if (!parseResult.success) {
        preparationError = emptyExecution({
          type: "tool_result",
          toolName: tool.name,
          toolCallId: toolUse.id,
          result: `Tool '${tool.name}': invalid input — ${parseResult.error.message}`,
          isError: true,
        });
      } else {
        let concurrencySafe: boolean | undefined;
        try {
          concurrencySafe = tool.isConcurrencySafe?.(parseResult.data) === true;
        } catch (err) {
          preparationError = emptyExecution({
            type: "tool_result",
            toolName: tool.name,
            toolCallId: toolUse.id,
            result: `Tool '${tool.name}': concurrency safety check failed — ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          });
        }

        if (concurrencySafe !== undefined) {
          prepared = prepareExecution(
            toolUse,
            tool,
            parseResult.data,
            concurrencySafe,
            baseContext,
          );
        }
      }
    }

    if (preparationError !== undefined) {
      if (safeBatch.length > 0) {
        if (isAborted(baseContext.signal)) {
          for (const execution of unstartedCancellations(safeBatch, toolUses, index)) {
            yield execution;
          }
          return;
        }

        const batch = safeBatch;
        safeBatch = [];
        const executions = await executeBatch(batch, platform, baseContext.signal);
        for (const execution of executions) yield execution;

        if (isAborted(baseContext.signal)) {
          for (const execution of toolUses.slice(index).map(cancelledExecution)) {
            yield execution;
          }
          return;
        }
      }

      yield preparationError;
      index += 1;
      continue;
    }

    if (prepared === undefined) break;

    if (!prepared.concurrencySafe) {
      if (safeBatch.length > 0) {
        if (isAborted(baseContext.signal)) {
          for (const execution of unstartedCancellations(safeBatch, toolUses, index)) {
            yield execution;
          }
          return;
        }

        const batch = safeBatch;
        safeBatch = [];
        const executions = await executeBatch(batch, platform, baseContext.signal);
        for (const execution of executions) yield execution;

        if (isAborted(baseContext.signal)) {
          for (const execution of toolUses.slice(index).map(cancelledExecution)) {
            yield execution;
          }
          return;
        }
      }

      const approvalError = await approvePrepared(prepared, approvalHandler);
      if (isAborted(baseContext.signal)) {
        for (const execution of toolUses.slice(index).map(cancelledExecution)) {
          yield execution;
        }
        return;
      }

      if (approvalError !== undefined) {
        yield approvalError;
      } else {
        if (isAborted(baseContext.signal)) {
          for (const execution of toolUses.slice(index).map(cancelledExecution)) {
            yield execution;
          }
          return;
        }

        const executions = await executeBatch([prepared], platform, baseContext.signal);
        const execution = executions[0];
        if (execution !== undefined) yield execution;
      }
      index += 1;
      continue;
    }

    const approvalError = await approvePrepared(prepared, approvalHandler);
    if (isAborted(baseContext.signal)) {
      for (const execution of unstartedCancellations(safeBatch, toolUses, index)) {
        yield execution;
      }
      return;
    }

    if (approvalError !== undefined) {
      if (safeBatch.length > 0) {
        if (isAborted(baseContext.signal)) {
          for (const execution of unstartedCancellations(safeBatch, toolUses, index)) {
            yield execution;
          }
          return;
        }

        const batch = safeBatch;
        safeBatch = [];
        const executions = await executeBatch(batch, platform, baseContext.signal);
        for (const execution of executions) yield execution;

        if (isAborted(baseContext.signal)) {
          for (const execution of toolUses.slice(index).map(cancelledExecution)) {
            yield execution;
          }
          return;
        }
      }

      yield approvalError;
      index += 1;
      continue;
    }

    safeBatch.push(prepared);
    index += 1;
  }

  if (safeBatch.length > 0) {
    if (isAborted(baseContext.signal)) {
      for (const execution of safeBatch.map((prepared) => cancelledExecution(prepared.toolUse))) {
        yield execution;
      }
      return;
    }

    const executions = await executeBatch(safeBatch, platform, baseContext.signal);
    for (const execution of executions) yield execution;
  }
}

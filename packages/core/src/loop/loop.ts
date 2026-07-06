import type { Provider } from "../types/provider.js";
import type { Platform } from "../types/platform.js";
import type { AgentEvent, Terminal, SubagentChildEvent } from "../types/events.js";
import type { Message, ContentBlock } from "../types/messages.js";
import type { ApprovalHandler, ToolCallContext } from "../types/tool.js";
import { type Usage, EMPTY_USAGE, accumulateUsage } from "../types/usage.js";
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
  approvalHandler?: ApprovalHandler;
  /** Sub-agent recursion depth for this run (0 at the top level). Seeded onto
   *  `context.depth` so the `task` tool can enforce its `maxDepth` backstop. */
  depth?: number;
};

export async function* agentLoop(params: LoopParams): AsyncGenerator<AgentEvent, Terminal> {
  const { provider, registry, platform, systemPrompt, maxTurns, signal, approvalHandler } = params;
  const workingMessages = params.messages; // mutable local copy
  const context: ToolCallContext = { signal, depth: params.depth ?? 0 };
  const toolSchemas = registry.toSchemas();
  let turnIndex = 0;
  let turnsUsed = 0;
  let cumulativeUsage: Usage = { ...EMPTY_USAGE };

  while (true) {
    let turnUsage: Usage | undefined;

    // Guard
    if (turnsUsed >= maxTurns) {
      const event = { type: "max_turns_exceeded" as const, turnsUsed, messages: workingMessages, usage: cumulativeUsage };
      yield event;
      return { reason: "max_turns_exceeded", turnsUsed, messages: workingMessages, usage: cumulativeUsage };
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
          pendingToolUses.push({
            id: event.id,
            name: event.name,
            input: event.input,
            parseError: event.inputParseError ?? false,
          });
          yield { type: "tool_use_start", toolName: event.name, toolInput: event.input };
        } else if (event.type === "message_stop") {
          if (event.usage !== undefined) {
            turnUsage = event.usage;
          }
        }
        // message_stop is consumed but not yielded
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const event = { type: "agent_error" as const, error, messages: workingMessages, usage: cumulativeUsage };
      yield event;
      return { reason: "agent_error", error, messages: workingMessages, usage: cumulativeUsage };
    }

    if (turnUsage !== undefined) {
      cumulativeUsage = accumulateUsage(cumulativeUsage, turnUsage);
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

      // Per-batch usage sink: tools that perform out-of-band work (e.g. a child
      // Agent run) call context.reportUsage to contribute tokens. Folded into
      // cumulativeUsage once, after the whole batch (see below) — not per call —
      // so a tool erroring after reporting still has its usage counted exactly
      // once (E5: no double-count, no loss-on-error).
      const reportedUsage: Usage[] = [];
      context.reportUsage = (u) => {
        reportedUsage.push(u);
      };

      // Per-call child-event sink. runTools is sequential and yields a tool's
      // tool_result synchronously after its call resolves, before starting the
      // next tool — so at the moment we receive a tool_result, childEvents holds
      // exactly that call's emitted events and nothing from a later tool. We
      // flush them (as subagent_event) immediately before that tool_result, then
      // reset the buffer (R3: batch-before-tool_result ordering).
      let childEvents: SubagentChildEvent[] = [];
      context.emitEvent = (e) => {
        childEvents.push(e);
      };

      for await (const toolEvent of runTools(pendingToolUses, registry, platform, context, approvalHandler)) {
        if (toolEvent.type === "tool_result") {
          // Flush this call's buffered child events BEFORE its tool_result, so
          // they land after the spawning tool_use_start and before the result,
          // correlated by taskId (== the call's tool-use id).
          for (const childEvent of childEvents) {
            yield { type: "subagent_event", taskId: toolEvent.toolCallId, event: childEvent };
          }
          childEvents = [];

          yield toolEvent; // { type: "tool_result", ... }

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

      // Fold tool-reported usage into the RUN's cumulative total exactly once,
      // after the batch. This total surfaces on the terminal event's `usage`
      // (agent_done / max_turns_exceeded / agent_error) — NOT on `turn_complete`,
      // whose `usage` is the parent's own per-turn tokens and never includes
      // child spend. A consumer building a live cost meter must therefore read
      // child cost from each `subagent_event` terminal's `usage`; summing
      // `turn_complete.usage` alone under-counts by the entire child spend.
      // Usage rolls up from reportUsage ONLY; emitted child events are for
      // observation, never accounting (E5).
      for (const u of reportedUsage) {
        cumulativeUsage = accumulateUsage(cumulativeUsage, u);
      }

      // Clear the per-batch sinks now that the batch is drained and folded,
      // mirroring the per-call `delete context.toolCallId` in runTools. Tools
      // call these synchronously within their awaited `call`, so nothing needs
      // them after this point; clearing stops a future fire-and-forget tool that
      // retained `context` from pushing usage/events into a later turn's live
      // buffer (misattributed taskId / double-counted usage).
      delete context.reportUsage;
      delete context.emitEvent;

      yield { type: "turn_complete", turnIndex, ...(turnUsage !== undefined ? { usage: turnUsage } : {}) };
      turnIndex++;
      // loop
    } else {
      // Natural completion
      yield { type: "turn_complete", turnIndex, ...(turnUsage !== undefined ? { usage: turnUsage } : {}) };
      const event = { type: "agent_done" as const, messages: workingMessages, usage: cumulativeUsage };
      yield event;
      return { reason: "agent_done", messages: workingMessages, usage: cumulativeUsage };
    }
  }
}

import type { Provider, StopReason } from "../types/provider.js";
import type { Platform } from "../types/platform.js";
import type { AgentEvent, Terminal } from "../types/events.js";
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
    let turnStopReason: StopReason | undefined;

    // Guard
    if (turnsUsed >= maxTurns) {
      const event = { type: "max_turns_exceeded" as const, turnsUsed, messages: workingMessages, usage: cumulativeUsage };
      yield event;
      return { reason: "max_turns_exceeded", turnsUsed, messages: workingMessages, usage: cumulativeUsage };
    }

    // Stream model
    const textChunks: string[] = [];
    const pendingToolUses: Array<{ id: string; name: string; input: unknown; parseError: boolean }> = [];

    let completedStopReason: StopReason;
    try {
      for await (const event of provider.stream(
        { systemPrompt, messages: workingMessages, tools: toolSchemas },
        signal,
      )) {
        if (event.type === "text_delta") {
          textChunks.push(event.text);
          yield { type: "text_delta", text: event.text };
        } else if (event.type === "reasoning_delta") {
          // Reasoning is observation-only: forward it to the caller so UI can
          // stream a chain-of-thought affordance, but do NOT push into
          // textChunks / assistantContent. Reasoning must not thread back into
          // `messages` on the next model call (DeepSeek explicitly forbids it,
          // and Anthropic/OpenAI reasoning models return reasoning as summary
          // metadata, not as prior-turn assistant text). Keeping it off the
          // history is a hard contract of this event.
          yield { type: "reasoning_delta", text: event.text };
        } else if (event.type === "tool_use") {
          pendingToolUses.push({
            id: event.id,
            name: event.name,
            input: event.input,
            parseError: event.inputParseError ?? false,
          });
          yield { type: "tool_use_start", toolName: event.name, toolInput: event.input };
        } else if (event.type === "message_stop") {
          turnStopReason = event.stopReason;
          turnUsage = event.usage;
        }
        // message_stop is consumed but not yielded
      }
      if (turnStopReason === undefined) {
        throw new Error("Provider stream ended without message_stop");
      }
      completedStopReason = turnStopReason;
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

      for await (const execution of runTools(pendingToolUses, registry, platform, context, approvalHandler)) {
        const toolEvent = execution.event;

        for (const childEvent of execution.childEvents) {
          yield { type: "subagent_event", taskId: toolEvent.toolCallId, event: childEvent };
        }

        yield toolEvent;

        // Serialize defensively. A successful tool can still return an
        // unserializable value (circular ref, BigInt), and serializeToolResult
        // would throw. Catch it here so it becomes a recoverable tool error
        // (spec §5.6 — "could not serialize result") rather than an exception
        // thrown to the caller.
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

        for (const usage of execution.reportedUsage) {
          cumulativeUsage = accumulateUsage(cumulativeUsage, usage);
        }
      }

      workingMessages.push({ role: "user", content: toolResultBlocks });

      yield {
        type: "turn_complete",
        turnIndex,
        stopReason: completedStopReason,
        ...(turnUsage !== undefined ? { usage: turnUsage } : {}),
      };
      turnIndex++;
      // loop
    } else {
      yield {
        type: "turn_complete",
        turnIndex,
        stopReason: completedStopReason,
        ...(turnUsage !== undefined ? { usage: turnUsage } : {}),
      };
      const event = {
        type: "agent_done" as const,
        messages: workingMessages,
        usage: cumulativeUsage,
        stopReason: completedStopReason,
      };
      yield event;
      return {
        reason: "agent_done",
        messages: workingMessages,
        usage: cumulativeUsage,
        stopReason: completedStopReason,
      };
    }
  }
}

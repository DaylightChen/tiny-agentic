import { z } from "zod";
import type { Agent } from "../../agent.js";
import { defineTool, type Tool } from "../../types/tool.js";
import type { AgentEvent, Terminal, SubagentChildEvent } from "../../types/events.js";
import type { Message } from "../../types/messages.js";
import { EMPTY_USAGE } from "../../types/usage.js";

// Model-facing strings. Load-bearing: the model keys off these exact values, so
// they are contracts (spec §Microcopy). Do not change without a decision.
const EMPTY_OUTPUT = "(sub-agent produced no output)";
const TURN_CAP_PREFIX = "[sub-agent stopped at turn cap] ";
const FAILED_PREFIX = "Sub-agent failed: ";
const CONFIG_ERROR_PREFIX = "Sub-agent config error: ";

const TOOL_DESCRIPTION =
  "Delegate a self-contained sub-task to a fresh sub-agent that runs with its own tools and turn budget, and return its final summary. Use for well-scoped work you can describe completely up front. Optionally pick a model or provider for the sub-task. Sub-tasks run one at a time in this version.";

const taskInputSchema = z.object({
  description: z.string().describe("3-5 word summary of the sub-task, for logging."),
  prompt: z.string().describe("The full task for the sub-agent. Must be self-contained — the sub-agent does not see this conversation."),
  subagent_type: z.string().optional().describe("Optional named sub-agent profile to use, if the host registered any."),
  model: z.string().optional().describe("Optional model hint for the sub-task. Interpreted by the host; falls back to the sub-agent profile default, then the runner default."),
  provider: z.string().optional().describe("Optional provider hint for the sub-task. Interpreted by the host; falls back to the sub-agent profile default, then the runner default."),
});

export type ChildSpec = {
  subagentType?: string;   // opaque — interpreted by the host, not core
  model?: string;          // opaque
  provider?: string;       // opaque
  prompt: string;
  signal: AbortSignal;     // linked child signal (parent-abort cascades; child error does not touch parent)
};

export type CreateTaskToolOptions = {
  /** MANDATORY — no core default. The host builds the fully-constructed child
   *  Agent (baking in provider/tools/systemPrompt/maxTurns/approvalHandler and
   *  applying the model/provider/subagent_type fallback chain). Throw to reject
   *  an unhonorable hint; the tool converts the throw to a config-error result.
   *  The host MUST omit the `task` tool from the child's tool set (§Risks R2). */
  resolveChild: (spec: ChildSpec) => Agent | Promise<Agent>;
  /** Optional: override the tool's wire name. Default "task". */
  name?: string;
  // NOTE: no `maxDepth` in v1 — recursion is bounded structurally (resolveChild
  // must omit the `task` tool from the child). See spec §Risks R2.
};

/**
 * Walk `messages` from the end, find the last assistant message, and concatenate
 * its text blocks. Returns EMPTY_OUTPUT when there is no assistant text or it is
 * whitespace-only (E8 — some providers reject an empty tool result).
 */
export function extractResultText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== "assistant") continue;
    let text: string;
    if (typeof message.content === "string") {
      text = message.content;
    } else {
      text = message.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");
    }
    return text.trim().length > 0 ? text : EMPTY_OUTPUT;
  }
  return EMPTY_OUTPUT;
}

/**
 * Map a child Terminal to the parent-facing result string + error flag (E4).
 * A partial turn-cap result may prefix EMPTY_OUTPUT when the child produced no
 * assistant text before hitting the cap — acceptable and consistent.
 */
export function mapChildTerminalToResult(terminal: Terminal): { text: string; isError: boolean } {
  switch (terminal.reason) {
    case "agent_done":
      return { text: extractResultText(terminal.messages), isError: false };
    case "max_turns_exceeded":
      return { text: TURN_CAP_PREFIX + extractResultText(terminal.messages), isError: false };
    case "agent_error":
      return { text: FAILED_PREFIX + terminal.error.message, isError: true };
  }
}

/**
 * The single choke point mapping a raw child AgentEvent to the sanitized
 * SubagentChildEvent union that crosses to the parent stream (E7). Drops
 * `messages` and raw tool-result payloads; the return type makes a transcript
 * leak a compile error. Returns undefined for events not surfaced (turn_complete).
 */
export function sanitizeChildEvent(event: AgentEvent): SubagentChildEvent | undefined {
  switch (event.type) {
    case "text_delta":
      return { type: "text_delta", text: event.text };
    case "tool_use_start":
      return { type: "tool_use_start", toolName: event.toolName, toolInput: event.toolInput };
    case "tool_result":
      return { type: "tool_result", toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError };
    case "agent_done":
      return { type: "terminal", reason: "agent_done", usage: event.usage };
    case "max_turns_exceeded":
      return { type: "terminal", reason: "max_turns_exceeded", usage: event.usage };
    case "agent_error":
      return { type: "terminal", reason: "agent_error", usage: event.usage, errorMessage: event.error.message };
    case "turn_complete":
    case "subagent_event":
      return undefined;
  }
}

export function createTaskTool(options: CreateTaskToolOptions): Tool {
  const tool = defineTool({
    name: options.name ?? "task",
    description: TOOL_DESCRIPTION,
    inputSchema: taskInputSchema,
    call: async (input, _platform, context) => {
      // Linked child signal (E3): parent-abort cascades to the child, but a
      // child-internal failure never touches context.signal (the parent's).
      const childCtrl = new AbortController();
      const linkedSignal = context.signal !== undefined
        ? AbortSignal.any([context.signal, childCtrl.signal])
        : childCtrl.signal;

      // Resolve the child (E6). Pass only defined optional hints
      // (exactOptionalPropertyTypes — never pass `undefined`). A throw here means
      // a bad model/provider/type before any child ran: spend zero child tokens,
      // report no usage, and surface a config error. runTools maps a THROWN Error
      // to { result: err.message, isError: true }, so throwing yields the required
      // isError:true (returning a value would be isError:false).
      let child: Agent;
      try {
        child = await options.resolveChild({
          prompt: input.prompt,
          signal: linkedSignal,
          ...(input.subagent_type !== undefined ? { subagentType: input.subagent_type } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.provider !== undefined ? { provider: input.provider } : {}),
        });
      } catch (err) {
        throw new Error(CONFIG_ERROR_PREFIX + (err instanceof Error ? err.message : String(err)));
      }

      // Drive the child + forward sanitized events. Explicit iterator form so we
      // capture the Terminal return value (a `for await` loop discards it).
      let terminal: Terminal;
      const iter = child.run(input.prompt, { signal: linkedSignal });
      while (true) {
        const step = await iter.next();
        if (step.done) {
          terminal = step.value;
          break;
        }
        const sanitized = sanitizeChildEvent(step.value);
        if (sanitized !== undefined) context.emitEvent?.(sanitized);
      }

      // Roll up the child's usage exactly once (E5), in every non-config-error
      // case — before the branch, so a report-then-throw error path still folds
      // it (the loop accumulates reported usage after the batch).
      context.reportUsage?.(terminal.usage ?? EMPTY_USAGE);

      const mapped = mapChildTerminalToResult(terminal);
      // isError:true requires a throw (the loop only distinguishes error via
      // throw); usage was already reported above, so the throw does not lose it.
      if (mapped.isError) throw new Error(mapped.text);
      return mapped.text;
    },
  });
  return tool;
}

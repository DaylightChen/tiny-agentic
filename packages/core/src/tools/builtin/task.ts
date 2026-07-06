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
// Numeric recursion backstop (D1). Returned as an isError tool result when a
// `task` call is attempted at or beyond the configured maxDepth.
const DEPTH_LIMIT_MESSAGE = (maxDepth: number): string =>
  `Sub-agent depth limit reached (maxDepth=${maxDepth}); refusing to spawn a nested sub-agent.`;

const TOOL_DESCRIPTION =
  "Delegate a self-contained sub-task to a fresh sub-agent that runs with its own tools and turn budget, and return its final summary. Use for well-scoped work you can describe completely up front. Optionally pick a model or provider for the sub-task. Sub-tasks run one at a time in this version.";

const taskInputSchema = z.object({
  prompt: z.string().min(1, "prompt must not be empty").describe("The full task for the sub-agent. Must be self-contained — the sub-agent does not see this conversation."),
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
   *
   *  RECURSION FOOTGUN — READ THIS: the child's tool set MUST NOT include the
   *  `task` tool. A resolver that reuses the parent's tool array (a very natural
   *  thing to write) re-includes `task`, and the sub-agent can then spawn its
   *  own sub-agents. The **structural** bound (omitting `task`) is the primary
   *  protection. Core also enforces a **numeric** backstop (`maxDepth`, default
   *  1) so a misconfigured resolver cannot recurse unboundedly — but do not rely
   *  on it in place of omitting `task`. Build children with a scoped tool set. */
  resolveChild: (spec: ChildSpec) => Agent | Promise<Agent>;
  /** Optional: override the tool's wire name. Default "task". */
  name?: string;
  /** Optional numeric recursion backstop. The maximum depth at which a sub-agent
   *  may be spawned (top-level run = depth 0). A `task` call attempted at
   *  `context.depth >= maxDepth` is refused with an isError result and spends
   *  zero child tokens. Default **1** — one level of sub-agents, matching the
   *  structural depth-1 posture (a sub-agent cannot spawn a sub-agent). Raise it
   *  only if you deliberately want deeper, guarded nesting. This is a second
   *  guard; the primary bound is still `resolveChild` omitting `task`. */
  maxDepth?: number;
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
    default: {
      // Exhaustiveness guard: if a 4th Terminal.reason is ever added, this fails
      // to compile (terminal is `never` here only when all reasons are handled).
      const _exhaustive: never = terminal;
      throw new Error(`Unhandled child terminal reason: ${String((_exhaustive as Terminal).reason)}`);
    }
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
  const maxDepth = options.maxDepth ?? 1;
  const tool = defineTool({
    name: options.name ?? "task",
    description: TOOL_DESCRIPTION,
    inputSchema: taskInputSchema,
    call: async (input, _platform, context) => {
      // Numeric recursion backstop (D1). `depth` is THIS agent's nesting level
      // (0 at the top level), seeded on context by agentLoop. Refuse to spawn at
      // or beyond maxDepth BEFORE resolving or running any child — zero child
      // tokens spent. Throwing yields the required isError:true tool result. This
      // is a second guard behind the structural bound (resolveChild omitting
      // `task`); it bounds a misconfigured resolver that re-includes `task`.
      const depth = context.depth ?? 0;
      if (depth >= maxDepth) {
        throw new Error(DEPTH_LIMIT_MESSAGE(maxDepth));
      }

      // Child signal (E3): parent-abort cascades to the child, while a
      // child-internal failure never touches context.signal (the parent's). No
      // separate linked controller is needed here — the child's own Agent.run
      // re-wraps whatever signal it receives in an AbortSignal.any and aborts
      // only that internal controller on failure, so handing it context.signal
      // gives both properties. context.signal is always set by agentLoop; the
      // fresh fallback only satisfies the required ChildSpec.signal type on the
      // (test-only) no-parent-signal path.
      const childSignal: AbortSignal = context.signal ?? new AbortController().signal;

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
          signal: childSignal,
          ...(input.subagent_type !== undefined ? { subagentType: input.subagent_type } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.provider !== undefined ? { provider: input.provider } : {}),
        });
      } catch (err) {
        throw new Error(CONFIG_ERROR_PREFIX + (err instanceof Error ? err.message : String(err)));
      }

      // Drive the child + forward sanitized events. Explicit iterator form so we
      // capture the Terminal return value (a `for await` loop discards it). The
      // child runs at depth+1, so if a misconfigured host gave it the `task`
      // tool, its own `task` calls see the incremented depth and hit the backstop.
      const iter: AsyncIterator<AgentEvent, Terminal> = child.run(input.prompt, { signal: childSignal, depth: depth + 1 });
      let terminal: Terminal | undefined;
      try {
        while (true) {
          const step = await iter.next();
          if (step.done) {
            terminal = step.value;
            break;
          }
          const sanitized = sanitizeChildEvent(step.value);
          if (sanitized !== undefined) context.emitEvent?.(sanitized);
        }
      } catch (err) {
        // agentLoop is total — it converts internal errors to terminal events and
        // never rejects — so reaching here means child.run() rejected BEFORE the
        // stream (e.g. buildEnvContext / platform.cwd() threw), or a sink threw
        // mid-drive. Tear the child generator down (runs its finally → its own
        // abortCtrl.abort()) and surface via the failed microcopy instead of
        // leaking the raw error string. Pre-stream, so no usage is lost.
        await iter.return?.();
        throw new Error(FAILED_PREFIX + (err instanceof Error ? err.message : String(err)));
      }

      // The drive's only non-throwing exit is `break` after assigning terminal,
      // and the catch above always throws — so terminal is defined here. The
      // explicit check narrows it without a non-null assertion (defensive branch
      // is unreachable in practice).
      if (terminal === undefined) {
        throw new Error(FAILED_PREFIX + "sub-agent ended without a terminal");
      }

      // Roll up the child's usage exactly once (E5), in every non-config-error
      // case. Done AFTER the drive succeeds; the loop folds reported usage after
      // the batch, so a following isError throw does not lose it.
      context.reportUsage?.(terminal.usage ?? EMPTY_USAGE);

      const mapped = mapChildTerminalToResult(terminal);
      // isError:true requires a throw (the loop only distinguishes error via
      // throw). Done AFTER the try/catch so the drive's catch cannot double-prefix
      // a mapped "Sub-agent failed:" message; usage was already reported above.
      if (mapped.isError) throw new Error(mapped.text);
      return mapped.text;
    },
  });
  return tool;
}

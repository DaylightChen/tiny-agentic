import type { Message } from "./messages.js";
import type { Usage } from "./usage.js";

/**
 * Sanitized child-lifecycle union surfaced on the parent stream (wrapped as a
 * `subagent_event` AgentEvent arm) when a tool spawns a sub-agent.
 * Deliberately omits `messages`, `content`/ContentBlock, and any provider-native
 * block, so nothing provider-shaped can cross the parent/child boundary through it.
 * The `tool_result` arm carries metadata only (no `result` payload) — a child's
 * raw tool result can embed provider structures; a consumer that needs full child
 * tool output reads the child Terminal inside its own resolveChild wiring.
 */
export type SubagentChildEvent =
  | { type: "text_delta";     text: string }
  | { type: "tool_use_start"; toolName: string; toolInput: unknown }
  | { type: "tool_result";    toolName: string; toolCallId: string; isError: boolean }
  | { type: "terminal";       reason: "agent_done" | "max_turns_exceeded" | "agent_error"; usage: Usage; errorMessage?: string };

/**
 * All events yielded by Agent.run().
 * Discriminated by `type`. Handle with a switch statement.
 *
 * Primary events (almost always handled):
 *   text_delta, agent_done, agent_error
 *
 * Secondary events (logging, progress display):
 *   tool_use_start, tool_result
 *
 * Tertiary events (advanced consumers):
 *   turn_complete, max_turns_exceeded, subagent_event
 */
export type AgentEvent =
  | { type: "text_delta";         text: string }
  | { type: "tool_use_start";     toolName: string; toolInput: unknown }
  | { type: "tool_result";        toolName: string; toolCallId: string; result: unknown; isError: boolean }
  | { type: "turn_complete";      turnIndex: number; usage?: Usage }
  // Sanitized sub-agent lifecycle event, tagged with the spawning `task` call's
  // tool-use id (`taskId`, sourced from `context.toolCallId` at runtime). Not
  // recursive: the wrapped payload is a `SubagentChildEvent`, which has no
  // `subagent_event` member, so a grandchild's events cannot nest onto the
  // parent stream through this type.
  | { type: "subagent_event";     taskId: string; event: SubagentChildEvent }
  // Terminal events — the generator exhausts after yielding one of these.
  // Each carries `messages` so a `for await` consumer can thread history
  // without capturing the generator's return value.
  | { type: "agent_done";         messages: Message[]; usage: Usage }
  | { type: "max_turns_exceeded"; turnsUsed: number; messages: Message[]; usage: Usage }
  | { type: "agent_error";        error: Error; messages: Message[]; usage: Usage };

/**
 * The generator's typed return value. Equivalent to the terminal AgentEvent.
 * For `for await` consumers: read the terminal event instead.
 * For `.next()` consumers: read the generator's done.value.
 */
export type Terminal =
  | { reason: "agent_done";         messages: Message[]; usage: Usage }
  | { reason: "max_turns_exceeded"; messages: Message[]; turnsUsed: number; usage: Usage }
  | { reason: "agent_error";        messages: Message[]; error: Error; usage: Usage };

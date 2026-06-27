import type { Message } from "./messages.js";

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
 *   turn_complete, max_turns_exceeded
 */
export type AgentEvent =
  | { type: "text_delta";         text: string }
  | { type: "tool_use_start";     toolName: string; toolInput: unknown }
  | { type: "tool_result";        toolName: string; toolCallId: string; result: unknown; isError: boolean }
  | { type: "turn_complete";      turnIndex: number }
  // Terminal events — the generator exhausts after yielding one of these.
  // Each carries `messages` so a `for await` consumer can thread history
  // without capturing the generator's return value.
  | { type: "agent_done";         messages: Message[] }
  | { type: "max_turns_exceeded"; turnsUsed: number; messages: Message[] }
  | { type: "agent_error";        error: Error; messages: Message[] };

/**
 * The generator's typed return value. Equivalent to the terminal AgentEvent.
 * For `for await` consumers: read the terminal event instead.
 * For `.next()` consumers: read the generator's done.value.
 */
export type Terminal =
  | { reason: "agent_done";         messages: Message[] }
  | { reason: "max_turns_exceeded"; messages: Message[]; turnsUsed: number }
  | { reason: "agent_error";        messages: Message[]; error: Error };

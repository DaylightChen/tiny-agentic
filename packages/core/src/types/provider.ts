import type { Message } from "./messages.js";
import type { Usage } from "./usage.js";

/**
 * Serialized tool schema sent in a ProviderRequest.
 * Produced by ToolRegistry from a Tool's Zod inputSchema via zod-to-json-schema.
 * The openApi3 target is used for compatibility with both Anthropic and OpenAI.
 */
export type ToolSchema = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
};

/** Data sent to the provider on each model call. Pure data — no signals or callbacks. */
export type ProviderRequest = {
  systemPrompt: string;
  messages: Message[];
  tools: ToolSchema[];
  maxTokens?: number;
};

/** Canonical streaming events yielded by a provider. Provider-agnostic. */
export type ProviderEvent =
  | { type: "text_delta";   text: string }
  | { type: "tool_use";     id: string; name: string; input: unknown; inputParseError?: boolean }
  | { type: "message_stop"; stopReason: "end_turn" | "tool_use" | "max_tokens" | string; usage?: Usage };

// Malformed streamed tool input (§6.1) is signalled by the optional
// `inputParseError: true` boolean on a tool_use event, NOT by a sentinel value
// in `input`. When the accumulated argument chunks are not valid JSON, the
// provider's stream mapper sets `input: {}` (a valid, JSON-serializable
// placeholder) and `inputParseError: true`. `runTools` checks the flag — before
// Zod validation — and emits the dedicated "Tool '<name>': could not parse tool
// input as JSON" tool-result error, distinct from a Zod validation failure.
// Keeping `input` a normal JSON value (never a symbol) means the assistant
// turn the loop persists stays serializable when threaded back into the next
// request, and no internal sentinel leaks onto the public event surface.

/**
 * Structured log entry passed to the optional logger callback.
 * Extend the union in M2 when cost/token tracking is added.
 */
export type LogEntry =
  | { level: "info";  event: "request_sent";   request: ProviderRequest }
  | { level: "info";  event: "retry_attempt";  attempt: number; delayMs: number; error: Error }
  | { level: "error"; event: "request_failed"; error: Error };

export type Logger = (entry: LogEntry) => void;

/** The provider abstraction. Implement to add a new LLM backend. */
export interface Provider {
  /**
   * Stream a single model call. Yields ProviderEvents until message_stop.
   * Retry logic (on 429/5xx) is the provider's responsibility.
   * Errors that survive retries are thrown; the agent loop catches them.
   *
   * @param request - The model request (system prompt, messages, tools).
   * @param signal - Optional AbortSignal. Abort cancels the in-flight request.
   */
  stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent>;
}

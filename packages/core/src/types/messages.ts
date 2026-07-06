// Canonical message types. Structurally compatible with Anthropic MessageParam.
// No imports from @anthropic-ai/sdk.

export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type Message =
  | { role: "user";      content: string | ContentBlock[] }
  | { role: "assistant"; content: string | ContentBlock[] };

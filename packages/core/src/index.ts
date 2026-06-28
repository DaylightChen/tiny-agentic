// Public surface of tiny-agentic (core package)
// Import from sub-entries for provider and platform:
//   import { AnthropicProvider } from "tiny-agentic/providers/anthropic"
//   import { NodePlatform } from "tiny-agentic/platform/node"
//   import { collectText } from "tiny-agentic/utils"

// Types — fully implemented in task-02
export type { AgentEvent, Terminal } from "./types/events.js";
export type { Message, ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock } from "./types/messages.js";
export type { Tool, ToolCallContext } from "./types/tool.js";
export { defineTool } from "./types/tool.js";
export type { Provider, ProviderRequest, ProviderEvent, ToolSchema, Logger, LogEntry } from "./types/provider.js";
export type { Platform, ExecOptions, ExecResult } from "./types/platform.js";
// Agent, built-in tools, utilities — added in tasks 03–08

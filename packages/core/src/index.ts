// Public surface of tiny-agentic (core package)
// Import from sub-entries for provider and platform:
//   import { AnthropicProvider } from "tiny-agentic/providers/anthropic"
//   import { NodePlatform } from "tiny-agentic/platform/node"
//   import { collectText } from "tiny-agentic/utils"

export { Agent } from "./agent.js";
export type { AgentOptions, RunOptions } from "./agent.js";

export type { AgentEvent, Terminal } from "./types/events.js";
export type { Message, ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock } from "./types/messages.js";
export type { Tool, ToolCallContext } from "./types/tool.js";
export { defineTool } from "./types/tool.js";
export type { Provider, ProviderRequest, ProviderEvent, ToolSchema, Logger, LogEntry } from "./types/provider.js";
export type { Platform, ExecOptions, ExecResult } from "./types/platform.js";

export { readFileTool } from "./tools/builtin/readFile.js";
export { writeFileTool } from "./tools/builtin/writeFile.js";
export { bashTool } from "./tools/builtin/bash.js";
export { editFileTool } from "./tools/builtin/editFile.js";
export type { ApprovalDecision, ApprovalHandler } from "./types/tool.js";

export type { Usage } from "./types/usage.js";
export { EMPTY_USAGE, mergeUsage, accumulateUsage } from "./types/usage.js";

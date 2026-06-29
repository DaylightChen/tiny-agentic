#!/usr/bin/env tsx
/**
 * openai-run.ts — tiny-agentic integration example (OpenAI provider)
 *
 * Run: OPENAI_API_KEY=<key> pnpm tsx examples/openai-run.ts
 *
 * Exercises: tool registration, NodePlatform, event streaming, multi-turn threading.
 * Demonstrates all major AgentEvent types.
 * Not run in CI — requires a real OpenAI API key.
 */

import {
  Agent,
  readFileTool,
  writeFileTool,
  bashTool,
  editFileTool,
  type Message,
  type ApprovalHandler,
} from "tiny-agentic";
import { OpenAIProvider } from "tiny-agentic/providers/openai";
import { NodePlatform } from "tiny-agentic/platform/node";
import { collectText } from "tiny-agentic/utils";

const apiKey = process.env["OPENAI_API_KEY"];
if (!apiKey) {
  console.error("Error: OPENAI_API_KEY environment variable is required.");
  process.exit(1);
}
// Optional: point at an OpenAI-compatible endpoint (e.g. an Azure-style gateway)
// via OPENAI_BASE_URL. Leave unset to use the default OpenAI API.
const baseURL = process.env["OPENAI_BASE_URL"];

const provider = new OpenAIProvider({
  apiKey,
  ...(baseURL ? { baseURL } : {}),
  // Any currently-valid Chat Completions model id works here, including reasoning
  // models (o-series / GPT-5) — `maxTokens` maps to `max_completion_tokens`, which
  // reasoning models require. "gpt-4o-mini" is a cheap choice for a throwaway example.
  model: "gpt-4o-mini",
  logger: (entry) => {
    if (entry.event === "request_sent") {
      console.error(`[provider] request sent (${entry.request.messages.length} messages, ${entry.request.tools.length} tools)`);
    }
  },
});

const agent = new Agent({
  provider,
  tools: [readFileTool, writeFileTool],
  platform: new NodePlatform(),
  systemPrompt: "You are a helpful assistant. Keep responses concise.",
  maxTurns: 10,
});

// --- Turn 1: simple Q&A (no tools needed) ---
console.log("\n=== Turn 1: Simple Q&A ===");
let history: Message[] = [];

for await (const event of agent.run("What is 2 + 2? Reply with just the number.", { messages: history })) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "tool_use_start":
      console.log(`\n[calling tool: ${event.toolName}]`);
      break;
    case "tool_result":
      console.log(`[tool result: isError=${event.isError}, result=${JSON.stringify(event.result).slice(0, 80)}]`);
      break;
    case "agent_done":
      history = event.messages;
      console.log("\n[agent done]");
      break;
    case "agent_error":
      console.error("\n[agent error]", event.error.message);
      process.exit(1);
      break;
    case "max_turns_exceeded":
      console.error("\n[max turns exceeded]");
      process.exit(1);
      break;
  }
}

// --- Turn 2: multi-turn continuation (success criterion 7.9) ---
console.log("\n=== Turn 2: Multi-turn continuation ===");

for await (const event of agent.run("What did I just ask you? Repeat my question back to me.", { messages: history })) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  if (event.type === "agent_done") {
    history = event.messages;
    console.log("\n[agent done, total messages:", history.length, "]");
  }
}

// --- Turn 3: tool use (read this script file) ---
console.log("\n=== Turn 3: Tool use (read_file) ===");

for await (const event of agent.run(
  `Read the file at "examples/openai-run.ts" and tell me what it does in one sentence.`
)) {
  switch (event.type) {
    case "text_delta": process.stdout.write(event.text); break;
    case "tool_use_start": console.log(`\n[calling: ${event.toolName}(${JSON.stringify(event.toolInput)})]`); break;
    case "tool_result": console.log(`[result: isError=${event.isError}]`); break;
    case "turn_complete": console.log(`[turn ${event.turnIndex} complete]`); break;
    case "agent_done": console.log("\n[agent done]"); break;
    case "agent_error": console.error("\n[agent error]", event.error.message); process.exit(1); break;
  }
}

// --- Turn 4: agent tooling (bash + edit_file + permission gate) ---
console.log("\n=== Turn 4: Agent tooling (bash, edit_file, approvalHandler) ===");

// Permission gate: deny destructive shell commands, allow everything else.
// Demonstrates the approvalHandler seam — remove it to let every call through.
const approvalHandler: ApprovalHandler = async (toolName, input) => {
  const command = toolName === "bash" ? String((input as { command?: unknown }).command ?? "") : "";
  if (toolName === "bash" && /\b(rm|sudo|mkfs|dd)\b/.test(command)) {
    console.log(`\n[approvalHandler] DENY ${toolName}: ${command}`);
    return "deny";
  }
  console.log(`\n[approvalHandler] allow ${toolName}`);
  return "allow";
};

const toolAgent = new Agent({
  provider,
  tools: [bashTool, editFileTool, readFileTool, writeFileTool],
  platform: new NodePlatform(),
  systemPrompt:
    "You are a coding assistant. Use the provided tools to complete file and shell tasks. Keep responses concise.",
  maxTurns: 12,
  approvalHandler,
});

const demoFile = "/tmp/tiny-agentic-demo.txt";
for await (const event of toolAgent.run(
  `Complete these steps in order, using your tools:
1. Create the file "${demoFile}" containing exactly: hello
2. Use edit_file to replace "hello" with "hello world" in that file.
3. Run a bash command to print the file's contents.
4. Finally, try to delete it with: rm ${demoFile}
   If that step is denied, report that it was denied and stop.`,
)) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "tool_use_start":
      console.log(`\n[calling: ${event.toolName}(${JSON.stringify(event.toolInput).slice(0, 120)})]`);
      break;
    case "tool_result":
      console.log(`[result: isError=${event.isError}, result=${JSON.stringify(event.result).slice(0, 120)}]`);
      break;
    case "turn_complete":
      console.log(`[turn ${event.turnIndex} complete]`);
      break;
    case "agent_done":
      console.log("\n[agent done]");
      break;
    case "agent_error":
      console.error("\n[agent error]", event.error.message);
      process.exit(1);
      break;
    case "max_turns_exceeded":
      console.error("\n[max turns exceeded]");
      break;
  }
}

// --- collectText convenience (success criterion reference) ---
console.log("\n=== collectText demo ===");
const text = await collectText(agent.run("Say 'hello world' and nothing else."));
console.log("collectText result:", text);

console.log("\n=== All turns complete. Integration example finished. ===");

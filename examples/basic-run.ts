#!/usr/bin/env tsx
/**
 * basic-run.ts — tiny-agentic integration example
 *
 * Run: ANTHROPIC_API_KEY=<key> pnpm tsx examples/basic-run.ts
 *
 * Exercises: tool registration, NodePlatform, event streaming, multi-turn threading.
 * Demonstrates all major AgentEvent types.
 * Not run in CI — requires a real Anthropic API key.
 */

import {
  Agent,
  readFileTool,
  writeFileTool,
  bashTool,
  editFileTool,
  createTaskTool,
  type Message,
  type ChildSpec,
  type ApprovalHandler,
  type Usage,
} from "tiny-agentic";
import { AnthropicProvider } from "tiny-agentic/providers/anthropic";
import { NodePlatform } from "tiny-agentic/platform/node";
import { collectText } from "tiny-agentic/utils";

const apiKey = process.env["ANTHROPIC_API_KEY"];
if (!apiKey) {
  console.error("Error: ANTHROPIC_API_KEY environment variable is required.");
  process.exit(1);
}

function formatUsage(u: Usage): string {
  const cw = u.cacheWriteTokens !== undefined ? `, cacheWrite=${u.cacheWriteTokens}` : "";
  return `in=${u.inputTokens} out=${u.outputTokens} cacheRead=${u.cacheReadTokens}${cw}`;
}

const provider = new AnthropicProvider({
  apiKey,
  // Must be a currently-valid Anthropic model id. The spec standardizes on
  // claude-opus-4-8; for a throwaway example making ~4 calls, a cheaper id
  // such as "claude-haiku-4-5" or "claude-sonnet-4-6" is also fine. Do NOT
  // use "claude-opus-4-5" (not a valid id — the call would 404).
  model: "claude-opus-4-8",
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
  `Read the file at "examples/basic-run.ts" and tell me what it does in one sentence.`
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

// --- Turn 5a: token usage ---
console.log("\n=== Turn 5a: token usage ===");
for await (const event of agent.run("In one sentence, what is an AbortSignal?")) {
  switch (event.type) {
    case "text_delta": process.stdout.write(event.text); break;
    case "turn_complete":
      if (event.usage) console.log(`\n[turn ${event.turnIndex} usage: ${formatUsage(event.usage)}]`);
      break;
    case "agent_done":
      console.log(`\n[done — cumulative usage: ${formatUsage(event.usage)}]`);
      break;
    case "agent_error": console.error("\n[agent error]", event.error.message); break;
    case "max_turns_exceeded": console.error("\n[max turns]"); break;
  }
}

// --- Turn 5b: external AbortSignal (cancel mid-run) ---
console.log("\n=== Turn 5b: external AbortSignal (cancel mid-run) ===");
// Alternative timeout form: agent.run(prompt, { signal: AbortSignal.timeout(2000) })
const controller = new AbortController();
let aborted = false;
for await (const event of agent.run(
  "Write a detailed 5-paragraph essay about distributed systems.",
  { signal: controller.signal },
)) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      if (!aborted) { aborted = true; controller.abort(); } // cancel as soon as output starts
      break;
    case "agent_error":
      console.log(`\n[run cancelled as expected → agent_error: ${event.error.message}]`);
      console.log(`[partial usage at cancel: ${formatUsage(event.usage)}]`);
      break;
    case "agent_done":
      console.log(`\n[completed before abort took effect — usage: ${formatUsage(event.usage)}]`);
      break;
  }
}

// --- Turn 6: Sub-agent delegation (task tool + custom child toolset) ---
console.log("\n=== Turn 6: Sub-agent delegation (task tool) ===");

// resolveChild is the host-owned seam that builds each sub-agent. The child's
// toolset is chosen HERE and can differ from the parent's: this child gets
// read-only file access and deliberately OMITS the `task` tool (the structural
// recursion bound — a sub-agent cannot spawn its own sub-agent). It also runs
// on a cheaper, DIFFERENT model than the parent (per-task model selection).
const CHILD_MODEL = "claude-haiku-4-5";
function resolveChild(spec: ChildSpec): Agent {
  return new Agent({
    provider: new AnthropicProvider({ apiKey: apiKey!, model: spec.model ?? CHILD_MODEL }),
    tools: [readFileTool],
    platform: new NodePlatform(),
    systemPrompt: "You are a focused sub-agent. Do the task and report a short summary.",
    maxTurns: 5,
  });
}

const coordinator = new Agent({
  provider,
  tools: [createTaskTool({ resolveChild })],
  platform: new NodePlatform(),
  systemPrompt:
    "You are a coordinator. Delegate well-scoped sub-tasks with the task tool, then report what came back. Keep responses concise.",
  maxTurns: 8,
});

for await (const event of coordinator.run(
  `Use the task tool to delegate this to a sub-agent (model "${CHILD_MODEL}"): ` +
    `read the file "package.json" and report its "name" and "version" fields, then summarize. ` +
    `Report back what the sub-agent returned.`,
)) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "tool_use_start":
      console.log(`\n[parent calls: ${event.toolName}(${JSON.stringify(event.toolInput).slice(0, 120)})]`);
      break;
    case "subagent_event": {
      // Sanitized child events, tagged by taskId — the child's own text, tool
      // calls, and terminal usage surface here without flattening into the parent stream.
      const c = event.event;
      if (c.type === "text_delta") process.stdout.write(`  [child ${event.taskId}] ${c.text}`);
      else if (c.type === "tool_use_start") console.log(`  [child ${event.taskId}] tool: ${c.toolName}`);
      else if (c.type === "tool_result") console.log(`  [child ${event.taskId}] tool_result (${c.toolName}, isError=${c.isError})`);
      else if (c.type === "terminal") console.log(`  [child ${event.taskId}] terminal: ${c.reason} usage=${formatUsage(c.usage)}`);
      break;
    }
    case "tool_result":
      console.log(`\n[parent tool_result: isError=${event.isError}, result=${JSON.stringify(event.result).slice(0, 160)}]`);
      break;
    case "turn_complete":
      if (event.usage) console.log(`[turn ${event.turnIndex} complete, usage: ${formatUsage(event.usage)}]`);
      break;
    case "agent_done":
      console.log(`\n[agent done — rolled-up usage (incl. child): ${formatUsage(event.usage)}]`);
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

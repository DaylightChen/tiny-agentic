#!/usr/bin/env tsx
/**
 * task-run.ts — tiny-agentic sub-agent (`task` tool) smoke
 *
 * Run: ANTHROPIC_API_KEY=<key> pnpm tsx examples/task-run.ts
 *
 * Exercises the `task` tool end-to-end against a real provider: a parent agent
 * delegates a self-contained sub-task to a child agent running on a DIFFERENT
 * model id (per-task model selection), streams the child's sanitized
 * `subagent_event`s tagged by taskId, and prints the rolled-up parent usage
 * (which includes the child's tokens).
 *
 * Not run in CI — requires a real Anthropic API key. Optionally exercises a
 * cross-provider child (OpenAI) when OPENAI_API_KEY is present; otherwise a
 * `provider: "openai"` hint demonstrates the clean config-error path.
 */

import {
  Agent,
  createTaskTool,
  type ChildSpec,
  type Usage,
} from "tiny-agentic";
import { AnthropicProvider } from "tiny-agentic/providers/anthropic";
import { OpenAIProvider } from "tiny-agentic/providers/openai";
import { NodePlatform } from "tiny-agentic/platform/node";

const apiKey = process.env["ANTHROPIC_API_KEY"];
if (!apiKey) {
  console.error("Error: ANTHROPIC_API_KEY environment variable is required.");
  process.exit(1);
}

const openaiKey = process.env["OPENAI_API_KEY"];

function formatUsage(u: Usage): string {
  const cw = u.cacheWriteTokens !== undefined ? `, cacheWrite=${u.cacheWriteTokens}` : "";
  return `in=${u.inputTokens} out=${u.outputTokens} cacheRead=${u.cacheReadTokens}${cw}`;
}

const PARENT_MODEL = "claude-opus-4-8";
const DEFAULT_CHILD_MODEL = "claude-haiku-4-5"; // a cheaper, DIFFERENT id than the parent

// A real resolveChild: it maps the opaque model/provider hints (task override →
// runner default) to a concrete child Agent. All provider-name knowledge lives
// here in the host, never in core.
function resolveChild(spec: ChildSpec): Agent {
  const model = spec.model ?? DEFAULT_CHILD_MODEL;

  // Cross-provider child is opt-in on OPENAI_API_KEY. If the hint asks for a
  // provider we can't honor, throw — the task tool turns this into a clean
  // "Sub-agent config error: ..." result (zero child tokens spent).
  const wantsOpenAI = spec.provider === "openai";
  if (wantsOpenAI && !openaiKey) {
    throw new Error("unknown provider 'openai' (OPENAI_API_KEY not set)");
  }

  const childProvider =
    wantsOpenAI && openaiKey
      ? new OpenAIProvider({ apiKey: openaiKey, model: spec.model ?? "gpt-4o-mini" })
      : new AnthropicProvider({ apiKey: apiKey!, model });

  return new Agent({
    provider: childProvider,
    // The child's tool set deliberately OMITS the `task` tool — this is the
    // structural recursion bound (a sub-agent cannot spawn a sub-agent).
    tools: [],
    platform: new NodePlatform(),
    systemPrompt: "You are a focused sub-agent. Do the task and report a short summary.",
    maxTurns: 4,
  });
}

const taskTool = createTaskTool({ resolveChild });

const provider = new AnthropicProvider({ apiKey, model: PARENT_MODEL });

const agent = new Agent({
  provider,
  tools: [taskTool],
  platform: new NodePlatform(),
  systemPrompt: "You are a coordinator. Delegate well-scoped sub-tasks with the task tool, then report what came back. Keep responses concise.",
  maxTurns: 8,
});

console.log(`\n=== Sub-agent delegation (parent ${PARENT_MODEL} → child ${DEFAULT_CHILD_MODEL}) ===`);

for await (const event of agent.run(
  "Use the task tool to delegate this to a sub-agent, with model 'claude-haiku-4-5': " +
    "'List three primary colors, one per line.' Then report what it returned.",
)) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "tool_use_start":
      console.log(`\n[parent calls: ${event.toolName}(${JSON.stringify(event.toolInput).slice(0, 120)})]`);
      break;
    case "subagent_event": {
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

console.log("\n=== task-tool smoke complete. ===");

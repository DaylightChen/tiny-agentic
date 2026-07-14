#!/usr/bin/env tsx
/**
 * fs-discovery-run.ts — tiny-agentic filesystem-discovery smoke
 *
 * Run: ANTHROPIC_API_KEY=<key> pnpm example:fs-discovery
 *
 * Demonstrates the feature headline: structured discovery (`ls`/`glob`/`grep`)
 * remains fully usable when the shell is DENIED. The Agent is built with only
 * the three discovery tools — no `bashTool` — and an approvalHandler that would
 * deny `bash` outright, proving a no-`bash` discovery loop over
 * `packages/core/src`.
 *
 * A direct `grepTool.call` is timed FIRST (no API key needed) to surface the
 * §10 non-functional target: a grep over `packages/core/src` completes well
 * under the tool timeout (sub-second for a typical pattern). Then, if a key is
 * present, the full agent discovery loop runs.
 *
 * Not run in CI — the agent loop requires a real Anthropic API key.
 */

import {
  Agent,
  lsTool,
  globTool,
  grepTool,
  type ApprovalHandler,
  type ToolCallContext,
  type StopReason,
  type Usage,
} from "tiny-agentic";
import { AnthropicProvider } from "tiny-agentic/providers/anthropic";
import { NodePlatform } from "tiny-agentic/platform/node";

function formatUsage(u: Usage): string {
  const cw = u.cacheWriteTokens !== undefined ? `, cacheWrite=${u.cacheWriteTokens}` : "";
  return `in=${u.inputTokens} out=${u.outputTokens} cacheRead=${u.cacheReadTokens}${cw}`;
}

function formatStopReason(reason: StopReason): string {
  return reason.kind === "other" ? `other (raw=${JSON.stringify(reason.raw)})` : reason.kind;
}

// --- Keyless: direct grep timing (proves the sub-second target, no tokens) ---
// This runs before the API-key guard so a keyless smoke invocation still
// demonstrates the sub-second grep from §10.
console.log("\n=== Direct grep timing (no API key needed) ===");
{
  const platform = new NodePlatform();
  const controller = new AbortController();
  const context: ToolCallContext = { signal: controller.signal };

  console.time("grep packages/core/src");
  const result = await grepTool.call(
    { pattern: "interface\\s+\\w+", path: "packages/core/src", output_mode: "files_with_matches" },
    platform,
    context,
  );
  console.timeEnd("grep packages/core/src");
  const files = (result as { files: string[] }).files;
  console.log(`[grep matched ${files.length} file(s) under packages/core/src]`);
}

// --- API-key guard: the agent loop below spends tokens, so gate it here ---
const apiKey = process.env["ANTHROPIC_API_KEY"];
if (!apiKey) {
  console.error("Error: ANTHROPIC_API_KEY environment variable is required for the agent loop.");
  process.exit(1);
}

const provider = new AnthropicProvider({
  apiKey,
  model: "claude-opus-4-8",
});

// Permission gate: deny `bash` explicitly, allow everything else. There is no
// `bash` tool registered — this makes the "no shell" point unmistakable: the
// discovery loop below works with the shell affirmatively denied.
const approvalHandler: ApprovalHandler = async (toolName) => {
  if (toolName === "bash") {
    console.log(`\n[approvalHandler] DENY ${toolName}`);
    return "deny";
  }
  console.log(`\n[approvalHandler] allow ${toolName}`);
  return "allow";
};

const agent = new Agent({
  provider,
  tools: [lsTool, globTool, grepTool],
  platform: new NodePlatform(),
  systemPrompt:
    "You are a code-navigation assistant. Use ONLY the provided discovery tools (ls, glob, grep). Keep responses concise.",
  maxTurns: 12,
  approvalHandler,
});

console.log("\n=== Discovery loop (ls / glob / grep, no bash) ===");

for await (const event of agent.run(
  "Find every file under packages/core/src that defines a Platform interface method, " +
    "then list the directory each lives in. Use only the discovery tools.",
)) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "reasoning_delta":
      process.stderr.write(event.text);
      break;
    case "tool_use_start":
      console.log(`\n[calling: ${event.toolName}(${JSON.stringify(event.toolInput).slice(0, 120)})]`);
      break;
    case "tool_result":
      console.log(`[result: isError=${event.isError}, result=${JSON.stringify(event.result).slice(0, 160)}]`);
      break;
    case "turn_complete":
      console.log(`[turn ${event.turnIndex} complete: ${formatStopReason(event.stopReason)}${event.usage ? `, usage: ${formatUsage(event.usage)}` : ""}]`);
      break;
    case "subagent_event": {
      const child = event.event;
      if (child.type === "terminal" && child.reason === "agent_done") {
        console.log(`[child ${event.taskId} done: ${formatStopReason(child.stopReason)}]`);
      } else {
        console.log(`[child ${event.taskId}: ${child.type}]`);
      }
      break;
    }
    case "agent_done":
      console.log(`\n[agent done: ${formatStopReason(event.stopReason)} — usage: ${formatUsage(event.usage)}]`);
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

console.log("\n=== fs-discovery smoke complete. ===");

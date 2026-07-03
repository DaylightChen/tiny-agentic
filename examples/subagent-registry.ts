#!/usr/bin/env tsx
/**
 * subagent-registry.ts — a `subagent_type` → tool-set registry
 *
 * Run: ANTHROPIC_API_KEY=<key> pnpm tsx examples/subagent-registry.ts
 *
 * Makes concrete the pattern the reference (Claude Code) expresses DECLARATIVELY
 * via agent-definition frontmatter (`tools:` / `disallowedTools:`), done here
 * IMPERATIVELY in host code:
 *
 *   1. AGENT_REGISTRY maps each `subagent_type` label to a fixed profile
 *      (tool set + system prompt + optional model).
 *   2. formatAgentCatalog() advertises those types — and the tools each has — to
 *      the parent model in its system prompt (mirrors Claude Code's generated
 *      "Available agent types and the tools they have access to:" section).
 *   3. resolveChild() looks up the label the model chose and builds the child
 *      with that profile's tools. Unknown labels are rejected with a clean,
 *      correctable error.
 *
 * The key property (identical to Claude Code): the LLM only ever passes a
 * `subagent_type` STRING — never a tool array. The model picks a label; the
 * host owns the tools. `task` is deliberately in no profile (recursion bound).
 *
 * Not run in CI — requires a real Anthropic API key.
 */

import {
  Agent,
  createTaskTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  type ChildSpec,
  type Tool,
  type Usage,
} from "tiny-agentic";
import { AnthropicProvider } from "tiny-agentic/providers/anthropic";
import { NodePlatform } from "tiny-agentic/platform/node";

const apiKey = process.env["ANTHROPIC_API_KEY"];
if (!apiKey) {
  console.error("Error: ANTHROPIC_API_KEY environment variable is required.");
  process.exit(1);
}

function formatUsage(u: Usage): string {
  const cw = u.cacheWriteTokens !== undefined ? `, cacheWrite=${u.cacheWriteTokens}` : "";
  return `in=${u.inputTokens} out=${u.outputTokens} cacheRead=${u.cacheReadTokens}${cw}`;
}

// --- The registry: subagent_type label → fixed profile -----------------------
// This is the host-owned config that Claude Code writes as agent-definition
// frontmatter. The model can pick a label but cannot change a profile's tools.
type AgentProfile = {
  /** One line shown to the parent model so it can choose this type. */
  description: string;
  /** The FIXED tool set for this type. Never includes `task` (recursion bound). */
  tools: Tool[];
  systemPrompt: string;
  /** Optional per-type model; falls back to DEFAULT_CHILD_MODEL below. */
  model?: string;
};

const DEFAULT_CHILD_MODEL = "claude-haiku-4-5"; // cheaper than the opus parent

const AGENT_REGISTRY: Record<string, AgentProfile> = {
  researcher: {
    description: "Reads files to answer questions about the repo. Read-only.",
    tools: [readFileTool],
    systemPrompt:
      "You are a research sub-agent. Investigate with your read-only tools and report a concise, factual answer. Do not modify anything.",
  },
  editor: {
    description: "Makes small, well-scoped edits to existing files.",
    tools: [readFileTool, editFileTool, writeFileTool],
    systemPrompt:
      "You are an editing sub-agent. Make the requested change precisely, then report exactly what you changed.",
  },
  writer: {
    description: "Drafts prose from information given in the prompt. No tools.",
    tools: [],
    systemPrompt:
      "You are a writing sub-agent. Produce the requested text from the prompt alone. You have no tools.",
  },
};

// Advertise the menu to the parent model — mirrors Claude Code's generated
// "<agentListSection>". Without this the model has no idea which types exist,
// because the `task` tool's schema only offers an opaque `subagent_type` string.
function formatAgentCatalog(registry: Record<string, AgentProfile>): string {
  const lines = Object.entries(registry).map(([type, profile]) => {
    const toolNames =
      profile.tools.length > 0 ? profile.tools.map((t) => t.name).join(", ") : "(none)";
    return `- ${type}: ${profile.description} Tools: ${toolNames}`;
  });
  return `Available subagent_type values and the tools each has access to:\n${lines.join("\n")}`;
}

// --- resolveChild: label → concrete child Agent ------------------------------
// The model chose a `subagent_type` string; here it becomes a real Agent with
// that profile's fixed tools. This is the imperative equivalent of Claude Code's
// resolveAgentTools() filtering an agent definition's allow/deny lists.
function resolveChild(spec: ChildSpec): Agent {
  const type = spec.subagentType ?? "researcher";
  const profile = AGENT_REGISTRY[type];
  if (profile === undefined) {
    // Throwing yields a clean "Sub-agent config error: ..." tool result (zero
    // child tokens), mirroring Claude Code's "Agent type '...' not found".
    throw new Error(
      `unknown subagent_type '${type}'. Available: ${Object.keys(AGENT_REGISTRY).join(", ")}`,
    );
  }
  return new Agent({
    provider: new AnthropicProvider({
      apiKey: apiKey!,
      model: spec.model ?? profile.model ?? DEFAULT_CHILD_MODEL,
    }),
    tools: profile.tools, // ← the label became a tool set, HERE, in host code
    platform: new NodePlatform(),
    systemPrompt: profile.systemPrompt,
    maxTurns: 6,
  });
}

// --- Parent coordinator ------------------------------------------------------
const provider = new AnthropicProvider({ apiKey, model: "claude-opus-4-8" });

const coordinator = new Agent({
  provider,
  tools: [createTaskTool({ resolveChild })],
  platform: new NodePlatform(),
  systemPrompt:
    "You are a coordinator. Delegate each well-scoped sub-task with the task tool, " +
    "choosing the most appropriate subagent_type.\n\n" +
    formatAgentCatalog(AGENT_REGISTRY) +
    "\n\nYou pick the TYPE; each type's tools are fixed by the host. Keep responses concise.",
  maxTurns: 10,
});

console.log("\n=== subagent_type registry (parent picks a label → host maps label to tools) ===");

for await (const event of coordinator.run(
  "Do these two steps, each delegated to the most appropriate sub-agent type:\n" +
    '1. Find the "name" and "version" fields in the file "package.json".\n' +
    "2. Write a one-sentence release blurb using that name and version.\n" +
    "Report both results and note which subagent_type you used for each.",
)) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "tool_use_start":
      console.log(`\n[parent calls: ${event.toolName}(${JSON.stringify(event.toolInput).slice(0, 160)})]`);
      break;
    case "subagent_event": {
      // Sanitized child events, tagged by taskId. Different sub-tasks resolve to
      // different profiles (researcher → [read_file], writer → []), so the tool
      // lines below differ per child — the registry routing, made visible.
      const c = event.event;
      if (c.type === "text_delta") process.stdout.write(`  [child ${event.taskId}] ${c.text}`);
      else if (c.type === "tool_use_start") console.log(`  [child ${event.taskId}] tool: ${c.toolName}`);
      else if (c.type === "tool_result") console.log(`  [child ${event.taskId}] tool_result (${c.toolName}, isError=${c.isError})`);
      else if (c.type === "terminal") console.log(`  [child ${event.taskId}] terminal: ${c.reason} usage=${formatUsage(c.usage)}`);
      break;
    }
    case "tool_result":
      console.log(`\n[parent tool_result: isError=${event.isError}, result=${JSON.stringify(event.result).slice(0, 200)}]`);
      break;
    case "turn_complete":
      if (event.usage) console.log(`[turn ${event.turnIndex} complete, usage: ${formatUsage(event.usage)}]`);
      break;
    case "agent_done":
      console.log(`\n[agent done — rolled-up usage (incl. children): ${formatUsage(event.usage)}]`);
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

console.log("\n=== registry demo complete. ===");

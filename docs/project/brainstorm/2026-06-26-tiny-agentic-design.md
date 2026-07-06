# tiny-agentic — Product Design Spec

**Date:** 2026-06-26
**Milestone:** 1 — the `tiny-agentic` core package
**Status:** Authoritative input to the engineering phase. Refined in place 2026-06-27 (Opus pass) — see the refinement notes at the end.

---

## 0. Architecture Overview: Three-Package System

Before diving into the M1 product, the overall architecture must be understood, because it determines which features belong to this milestone and which are deferred to a different layer.

The system is decomposed into three packages in a strict one-way dependency hierarchy:

```
UI / TUI package
      │  (imports from)
   Agent SDK
      │  (imports from)
tiny-agentic (core)    ← Milestone 1 deliverable
```

**`tiny-agentic` (core) — this document's subject:**
The headless agentic engine. Agent loop, tool registration and execution, provider abstraction (Anthropic in M1; OpenAI in M2), typed event stream, env-context injection, platform capability interface. Environment-agnostic: no filesystem or shell calls in the core itself. Everything in this document pertains to this package.

**Agent SDK (deferred beyond M1):**
A Claude-Code-like batteries-included layer built on top of core. Adds: customizable built-in tools, skills (loaded from markdown files with frontmatter), slash-command dispatch, session persistence via local JSONL transcripts, richer system-prompt assembly, memory, and a stateful `Session` wrapper. The SDK consumes the core's stateless `Agent.run()` surface and adds state management on top.

**Skill and Command are SDK-layer constructs, not core primitives.** Both reduce to the two primitives the core already has — tools and messages — and the core has zero awareness of either concept. A model-invoked skill reaches the model through a `SkillTool`, which is just a core `Tool` backed by an SDK-loaded registry; the core sees only a tool. A user `/command` is expanded by the SDK/UI layer into a prompt and passed via `agent.run(prompt, { messages })`; the core sees only a prompt and messages. The core's only obligation toward these higher-level constructs is to expose an **extensible tool-call context** — a context object passed to every `Tool.call` that the SDK can widen to carry a skill or command registry. This mirrors the reference's `ToolUseContext`.

**UI / TUI package (deferred beyond M1):**
An interactive front-end: TUI, CLI REPL, or web. A pure consumer of the event stream. Never imported by the layers below it.

**One-way dependency rule:** Lower layers never import higher ones. This is a hard architectural constraint, not a convention.

**Feature assignment across layers:**

| Feature | Layer | Milestone |
|---------|-------|-----------|
| Agent loop, tool execution, provider abstraction | core | M1 |
| Platform capability interface (`Platform`, `NodePlatform`) | core | M1 |
| Env context injection (cwd / date / git) | core | M1 |
| Extensible tool-call context (passed to every `Tool.call`) | core | M1 |
| OpenAI provider | core | M2 |
| Permission seam (the hook point, not the UI) | core | M2 |
| Sub-agent spawning primitive | core | M3+ |
| Skill loading, markdown/frontmatter parsing, skill registry | SDK | deferred |
| Slash-command dispatch and command registry | SDK / UI | deferred |
| Session persistence / transcript resume | SDK | deferred |
| Memory, custom system-prompt assembly | SDK | deferred |
| Stateful `Session` wrapper | SDK | deferred |
| Interactive TUI / CLI REPL / web UI | UI | deferred |

---

## 1. Problem Statement

Building an agent that can reason with a language model, call tools, and loop until completion is deceptively hard. The mechanics — streaming tool-use, collecting results, feeding them back, handling errors, deciding when the loop is done — are the same in every agent, yet every team writes them from scratch.

Existing solutions are either too high-level (LangChain-style orchestrators that hide the mechanics and make learning impossible) or too low-level (raw Anthropic SDK calls that put all the loop logic on the developer). There is no clean, minimal TypeScript library that gives you the agent loop and nothing else, with a first-class streaming API and a genuine provider abstraction.

The secondary problem: the Claude Code source (v2.1.88) is the best publicly available reference for production-grade agentic mechanics, but it is a product, not a library, and it is not written for learning. A faithful reimplementation — minimal, annotated, with the product accretions stripped away — serves both learning and reuse.

**Who has this problem:** TypeScript/Node developers who want to build AI-driven automation, coding assistants, or research tools without wiring the agent loop themselves. Also: the project author, who is learning agentic internals by building.

**What they do today:** inline SDK calls with ad-hoc tool loops; use heavyweight frameworks that obscure the mechanics; copy-paste blog post samples that break on edge cases.

---

## 2. Target Users

### Primary: Framework Consumer (Developer)

A TypeScript developer building a custom agent-powered tool — a file summarizer, a code reviewer, an automated test runner, a personal assistant. They know TypeScript and async/await. They may or may not have used the Anthropic SDK directly. They want to write:

```ts
const agent = new Agent({ provider, tools: [readFileTool, writeFileTool], platform });

for await (const event of agent.run("Summarize ./src/index.ts")) {
  console.log(event);
}
```

(The two built-in tools shipped in M1 are `read_file` and `write_file`; a directory-listing
tool is deferred until the `Platform` interface gains a listing capability in M2.)

...or, for a non-streaming one-shot, use the convenience helper:

```ts
const text = await collectText(agent.run("Summarize all .ts files in ./src"));
```

...and have it work: the model runs, calls the tools they registered, loops, and terminates. They do not want to think about streaming event accumulators, tool-use message formatting, or retry semantics.

**Constraints:** Working in Node >=22 (the supported LTS floor — Node 18 and 20 are both EOL as of mid-2026; see the engineering spec §1.5). May want Anthropic today, OpenAI tomorrow. Probably building a CLI or server, not a browser app. Does not want a peer dependency on React or Ink.

**What they care about:** API clarity (can they read and understand the types?), predictability (does the loop always terminate?), debuggability (can they log what's happening?), extensibility (can they add a tool in 10 lines?).

### Secondary: Framework Author (Project Owner / Learner)

The author of this framework, learning agentic system design by studying and reimplementing Claude Code. Needs each subsystem to be readable and correspond structurally to the reference. The code is the documentation.

**Constraints:** Does not want shortcuts that paper over the interesting parts. Wants every architectural decision to be legible in the code.

**What they care about:** Concept fidelity to the reference; clean subsystem boundaries; clear separation of concerns; no magic.

---

## 3. Core Features (Milestone 1)

Ordered by importance. Features 1–5 are the complete M1 scope (the core package). Features 6–8 are forward-looking primitives that inform the M1 architecture but are not implemented in M1.

### Feature 1: Stateless Async-Generator Agent Loop

**Description:** The central engine, exposed as `Agent.run()`. Given a user prompt and optionally a prior message history, the engine runs the full agent loop: call the model (streaming), accumulate the assistant's response, detect tool-use blocks, execute them, feed results back, and repeat until the model produces a response with no tool calls. The entire execution is surfaced as a typed async generator — one event per meaningful unit of work. The engine is stateless: it holds no memory between calls. Multi-turn conversations are achieved by threading the final message list (carried on the terminal event) into the next call.

**User-visible behavior:**

```ts
import { Agent } from "tiny-agentic";

const agent = new Agent({ provider, tools, platform });

// Single-turn (no history)
for await (const event of agent.run("List the .ts files in src/")) {
  // receives typed AgentEvent values
}

// Multi-turn: read the final messages off the terminal event, thread into the next call
let history: Message[] = [];
for await (const event of agent.run("What files are in src/?", { messages: history })) {
  if (event.type === "agent_done") history = event.messages; // terminal event carries history
}
for await (const event of agent.run("Now summarize the first one.", { messages: history })) {
  if (event.type === "agent_done") history = event.messages;
}
```

The terminal event (`agent_done` | `max_turns_exceeded` | `agent_error`) carries the final in-memory message list, so a plain `for await` loop can thread history forward without capturing the generator's return value. The generator additionally *returns* a `Terminal` (same data) for callers who drive `.next()` manually. The engine never persists anything to disk.

### Feature 2: Tool Interface, Registry, and Platform-Injected Execution

**Description:** A first-class `Tool` type that developers implement to expose capabilities to the model. Every tool has: a name, a Zod schema (`inputSchema`, mandatory — serialized via `zod-to-json-schema`), a description, and a `call` function. The `call` function receives validated arguments, a `Platform` instance, and an extensible tool-call context object, and returns a result.

The **extensible tool-call context** is the seam that lets higher layers (the SDK) inject additional capabilities — such as a skill registry or command registry — into running tools without modifying the core. The core declares `ToolCallContext` as an open `interface`; the SDK widens it via TypeScript interface merging (`declare module 'tiny-agentic'`). For M1 the interface is **empty** — the engine constructs `{}` and passes it to every `Tool.call`, so the third argument exists and is typed but carries no fields yet. This mirrors the reference's `ToolUseContext`. SDK-layer fields (and, later, a sub-agent run handle when sub-agents land) are added without touching core code, and must always be **optional** so existing tools keep compiling.

The `Platform` interface is a capability bundle injected at call time. It provides environment operations (`readFile`, `writeFile`, `exec`, etc.) as abstract methods. The framework ships a `NodePlatform` that implements these with Node.js APIs. A `BrowserPlatform` or a `MockPlatform` (for tests) can be substituted without touching the tool logic. This keeps the core's built-in tools environment-agnostic.

The framework provides a registry that the engine uses to look up and invoke tools by name. Zod validation runs before `call`; if validation fails the error is returned to the model as a tool error (self-correction), not raised to the caller.

**User-visible behavior:**

```ts
import { Tool } from "tiny-agentic";
import { z } from "zod";

// Developer-defined tool (provides its own I/O — no Platform or context needed)
const echoTool: Tool = {
  name: "echo",
  description: "Echo the input back.",
  inputSchema: z.object({ message: z.string() }),
  call: async ({ message }) => ({ echoed: message }),
};

// Built-in tool definition (environment-agnostic; Platform provides I/O)
// call receives: (validatedArgs, platform, context)
// context is extensible — the SDK widens it to add skill/command registries
const readFileTool: Tool = {
  name: "read_file",
  description: "Read a file at the given path.",
  inputSchema: z.object({ path: z.string().describe("Absolute or relative path.") }),
  call: async ({ path }, platform, _ctx) => ({ content: await platform.readFile(path) }),
};

// Wiring: supply a NodePlatform so built-in tools have a concrete backend
const agent = new Agent({ provider, tools: [echoTool, readFileTool], platform: new NodePlatform() });
```

The framework handles: serializing Zod schemas to JSON Schema for the model, validating model-provided arguments before `call`, formatting results as `tool_result` messages, and feeding errors back to the model rather than crashing.

### Feature 3: Anthropic Provider (with Streaming)

**Description:** A concrete provider implementation that calls the Anthropic Messages API, streams the response, and translates Anthropic's streaming event types into the framework's canonical `ProviderEvent` union. The provider accepts an API key, model name, optional `maxRetries`, optional base URL, and an optional logger callback. Retry of transient errors (429, 5xx, connection) is part of the `Provider` contract but is **delegated to the Anthropic SDK** — the provider constructs `new Anthropic({ apiKey, baseURL, maxRetries })` and the SDK applies exponential backoff with jitter and honors `Retry-After` across both stream construction and consumption. (The earlier draft hand-wrapped stream *construction* in a retry helper, which is a no-op because transient errors surface during stream *iteration*; that approach is rejected. See `docs/decisions.md` "Provider contract owns retry".) Retry is a per-provider responsibility expressed through a uniform `maxRetries` option, not a shared core code path.

**User-visible behavior:**

```ts
import { AnthropicProvider } from "tiny-agentic/providers/anthropic";

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-opus-4-8",
  logger: (entry) => console.error("[provider]", entry), // optional; off by default
});
```

Swapping the provider (when OpenAI lands in M2) requires changing only the `provider` argument. The engine and tools are unaffected.

### Feature 4: Environment Context in System Prompt

**Description:** The framework automatically inserts a minimal environment context block into the system prompt: current working directory, current date, git branch and status (if the process is inside a git repo). This mirrors the Claude Code reference's `context.ts`. The env context is computed once per `run()` call and prepended to the developer-supplied system prompt. **All** environment access goes through the injected `Platform` — the working directory via `platform.cwd()` and the git state via `platform.exec("git ...")` — so the core never references a Node global (`process`, `fs`, `child_process`) and remains environment-agnostic. The date is the only piece read from a runtime built-in (`new Date()`), which is universal across environments.

**User-visible behavior:**

The developer passes an optional `systemPrompt` string. The framework prepends the env context block. The combined prompt goes to the model on every turn. No configuration is needed.

```
[Framework-injected env context]
Working directory: /home/user/project
Date: 2026-06-26
Git branch: main
Git status: 2 files modified

[Developer-supplied system prompt]
You are a helpful coding assistant...
```

If git is not installed or the cwd is not a git repo, the git lines are silently omitted.

### Feature 5: Platform Capability Interface

**Description:** An abstract `Platform` interface that decouples tool `call` implementations from the concrete runtime environment. In M1 the interface has exactly four methods: `cwd()` (used by the env-context builder), `readFile`, `writeFile` (backing the two M1 built-in tools), and `exec` (used by the env-context builder for git and available to tools). The framework ships a `NodePlatform` concrete implementation. The core itself imports no `fs`, `child_process`, or other Node-specific modules, and references no Node global (`process`, etc.) outside `platform/node.ts` — it only holds the `Platform` interface type. A test harness, browser polyfill, or mock can be substituted by implementing the four methods. The interface is intentionally narrow; new methods are added in M2 only when a new built-in tool requires one (a breaking change for existing `Platform` implementations, acceptable while the surface is small).

This makes the core package truly environment-agnostic: the same `read_file` tool definition works in Node (via `NodePlatform`) or in a future browser environment (via a different `Platform` implementation), because the tool's `call` function never calls `fs` directly.

**User-visible behavior (developer-facing):**

```ts
import { Platform } from "tiny-agentic";
import { NodePlatform } from "tiny-agentic/platform/node";

// Default: use NodePlatform
const agent = new Agent({ provider, tools, platform: new NodePlatform() });

// Testing: use a mock
class MockPlatform implements Platform {
  cwd() { return "/mock/project"; }
  async readFile(path: string) { return "mock content"; }
  async writeFile(path: string, content: string) {}
  async exec(cmd: string) { return { stdout: "", stderr: "", exitCode: 0 }; }
}
const testAgent = new Agent({ provider: mockProvider, tools, platform: new MockPlatform() });
```

### Feature 6 (Forward-looking, M2): OpenAI Provider

**Description:** A second provider that validates the provider abstraction. Accepts an OpenAI API key and model name. Translates between the framework's canonical request shape and OpenAI's Chat Completions API (different tool-use format, different streaming event types, different role/content shapes). M2 work; must not require breaking API changes to the core.

**Layer:** core (M2).

### Feature 7 (Forward-looking, M2): Permission Seam

**Description:** A hook point for per-tool permission decisions: `allow`, `deny`, or `ask`. In M1 the mode is blanket-allow; the seam exists in the tool execution pipeline so an approval callback can be added in M2 without restructuring the engine. A future SDK or UI layer hooks into the `ask` decision.

**Layer:** core seam (M2); UI approval dialog is UI-layer deferred.

### Feature 8 (Forward-looking, M3+): Sub-Agent Spawning

**Description:** A built-in tool that allows the model to spawn a child agent with its own tool set and prompt scope. The child is a recursive `agent.run()` call (a fresh `Agent`, or a reentrant call into the same loop). The architecture supports this because the loop is reentrant and stateless; no restructuring is required. Not implemented in M1 or M2.

**Layer:** core (M3+).

---

## 4. Out of Scope (Milestone 1)

The following are explicitly not part of milestone 1. Any implementation that touches these is considered scope creep. Where relevant, the appropriate layer is noted.

- **Any UI** — no TUI, no readline REPL, no web UI, no React, no Ink. UI-layer concern. A throwaway `examples/` script exercises the engine.
- **OpenAI provider** — M2 core milestone. The provider abstraction is designed for it; the implementation is not yet built.
- **Permission / approval flow** — blanket-allow in M1. The seam is in M2 core; the approval UI is UI-layer.
- **Sub-agent spawning** — M3+ core. The architecture doesn't block it; the implementation is deferred.
- **Session persistence** — no JSONL transcripts, no resume from disk. SDK-layer concern. The core returns the final message list in-memory; persistence is the SDK's job.
- **Stateful `Session` wrapper** — SDK-layer. The core is stateless by design.
- **Context compaction / summarization** — the message list grows unboundedly in M1. SDK / M2+ concern.
- **Memory system** — no `~/.tiny-agentic/memory/`. SDK-layer concern.
- **Skills** — no markdown skill files, no frontmatter parsing, no conditional activation. SDK-layer. A model-invoked skill reaches the core only as a `Tool`; the skill loading and registry machinery that backs it live entirely in the SDK.
- **Slash-command dispatch** — no `/command` parsing, no command registry, no local or prompt-type command resolution. SDK-layer (and partly UI-layer for the `/` invocation UX). A user command is expanded by the SDK/UI into a plain prompt before being handed to the core.
- **Command registry** — no registry of user-invocable commands in the core. SDK-layer concern.
- **MCP integration** — no Model Context Protocol support. Extensibility concern, deferred.
- **Plugin / hook system** — no pre/post hooks, no plugin registry. Deferred.
- **Config file loading** — settings from code only. Deferred.
- **Cost tracking** — token counting not surfaced in M1 events.
- **Bedrock / Vertex / Foundry providers** — out of scope entirely.
- **Non-streaming fallback** — streaming is assumed available.
- **Streaming tool execution** — tools execute after the full assistant turn, not during streaming.
- **Per-tool timeout** — the developer is responsible for adding timeouts inside `call`. M2 concern.

---

## 5. API Ergonomics and Developer Experience

Because this is a headless library, "UX" means the API surface: how a developer installs, imports, configures, runs, and interprets results. Each subsection below is the library's analogue of the screen/flow sections a GUI product would have.

### 5.1 Primary Flow — End-to-End Developer Journey

**Step 1: Install.**

```
npm install tiny-agentic zod @anthropic-ai/sdk
```

`zod` is a mandatory peer dependency — developers write tool schemas with it directly, and the framework requires it for runtime validation. `@anthropic-ai/sdk` is an optional peer dependency of the Anthropic provider; the framework core imports no SDK.

**Step 2: Define tools.**

The developer creates `Tool` objects. Each has a name, description, Zod schema, and a `call` function. `call` receives three arguments: validated input, a `Platform` instance (for environment I/O), and an extensible tool-call context (for SDK-injected capabilities; ignore it in M1 tools that don't need it). Tools that are self-contained can omit the trailing arguments entirely.

```ts
import { Tool } from "tiny-agentic";
import { z } from "zod";

// Self-contained tool (no platform I/O, context unused)
const getCurrentTime: Tool = {
  name: "get_current_time",
  description: "Return the current UTC time as an ISO string.",
  inputSchema: z.object({}),
  call: async () => ({ time: new Date().toISOString() }),
};

// Platform-using tool (reads from the injected platform; context ignored)
const readFile: Tool = {
  name: "read_file",
  description: "Read a file and return its contents.",
  inputSchema: z.object({
    path: z.string().describe("Absolute or relative path to the file."),
  }),
  call: async ({ path }, platform) => ({ content: await platform.readFile(path) }),
};
```

The tool's `call` return value is serialized to JSON and sent to the model as a `tool_result`. If `call` throws, the error message is sent to the model as a tool error (the model can self-correct).

**Step 3: Create a provider.**

```ts
import { AnthropicProvider } from "tiny-agentic/providers/anthropic";

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: "claude-opus-4-8",
  // logger: (entry) => console.error("[provider]", JSON.stringify(entry)), // optional
});
```

**Step 4: Create an agent and run it.**

```ts
import { Agent } from "tiny-agentic";
import { NodePlatform } from "tiny-agentic/platform/node";

const agent = new Agent({
  provider,
  tools: [getCurrentTime, readFile],
  platform: new NodePlatform(),
  systemPrompt: "You are a helpful coding assistant.",
});

for await (const event of agent.run("Read src/index.ts and explain it.")) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "tool_use_start":
      console.log(`\n[calling ${event.toolName}]`);
      break;
    case "tool_result":
      console.log(`[result: ${JSON.stringify(event.result).slice(0, 80)}]`);
      break;
  }
}
```

`agent.run()` is an `AsyncGenerator<AgentEvent, Terminal>`. The `for await` loop drives the engine. The last event before the loop ends is always a terminal event (`agent_done` | `max_turns_exceeded` | `agent_error`), which carries the stop reason and final message list — this is how a `for await` consumer reads completion. (The same data is also the generator's return value, for callers driving `.next()` manually; see Step 5.)

**Step 5: Capture the final messages and thread history for multi-turn.**

The terminal event carries the final message list. Read it off the event in the same `for await` loop — no need to access the generator's return value.

```ts
let history: Message[] = [];

for await (const event of agent.run("Read src/index.ts and explain it.")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  if (event.type === "agent_done") history = event.messages;
}

// Thread history for a follow-up turn
for await (const event of agent.run("Now show me the exported functions only.", { messages: history })) {
  if (event.type === "agent_done") history = event.messages;
}
```

Advanced callers who drive the generator with `.next()` manually can instead read the same data from the generator's `Terminal` return value; `for await` consumers use the terminal event as shown.

The framework does not persist the message list. The caller holds it in memory and passes it back for continuity. This is an intentional design: persistence (to disk, to a database) belongs to a layer above the core.

**Step 6: Use the convenience utility for non-streaming callers.**

```ts
import { collectText } from "tiny-agentic/utils";
const text = await collectText(agent.run(prompt));
```

This collects all `text_delta` events into a single string. The `Terminal` return value is discarded. A sibling `collectEvents(gen)` collects the full event array for testing.

### 5.2 Secondary Flows

**Flow A: Multi-turn conversation.**

The developer reads the final message list off each turn's terminal event and passes it into the next call. The core is stateless — each `run()` call is independent except for whatever history the caller threads in. There is no session object in M1.

```ts
let history: Message[] = [];
for (const userPrompt of conversationTurns) {
  for await (const event of agent.run(userPrompt, { messages: history })) {
    if (event.type === "text_delta") process.stdout.write(event.text);
    if (event.type === "agent_done") history = event.messages;
  }
}
```

**Flow B: Handling a tool error gracefully.**

The model requests a tool with an invalid argument (e.g., a path that does not exist). The tool's `call` throws. The framework catches the error, formats it as a `tool_result` with `isError: true`, and feeds it back to the model. The engine continues — the model sees the error and may retry with a corrected argument, apologize, or try a different approach. The caller receives a `tool_result` event with `isError: true` so they can log it. The agent does not crash.

**Flow C: Handling an API error.**

The Anthropic API returns a 429 or 5xx. The Anthropic SDK (to which the provider delegates retry) retries with exponential backoff and jitter, up to the configured `maxRetries` (default 3). If all retries are exhausted, the error surfaces out of the provider's stream as a thrown exception; the engine catches it, yields an `agent_error` event, and terminates. The caller inspects `event.error` to get the underlying error.

**Flow D: Detecting when the agent loops without progress.**

The caller passes `maxTurns` to `Agent`. If the engine executes more turns than `maxTurns` without reaching a tool-free turn, the generator's `Terminal` reason is `"max_turns_exceeded"` and the generator terminates. This prevents infinite loops.

```ts
const agent = new Agent({ provider, tools, platform, maxTurns: 10 });
```

**Flow E: Running multiple independent agents concurrently.**

Each `agent.run()` call creates an independent in-memory conversation. Two concurrent calls do not share state. Safe to run in parallel.

```ts
const [r1, r2] = await Promise.all([
  collectText(agentA.run("Summarize README.md")),
  collectText(agentB.run("List all exported functions in src/")),
]);
```

**Flow F: Providing a custom system prompt.**

The developer passes `systemPrompt` at construction. The framework prepends the env context block and passes the combined string to the provider on every turn. If no `systemPrompt` is provided, the framework uses only the env context block.

**Flow G: Using a mock platform for testing.**

The developer implements `Platform` with test stubs and passes it to `Agent`. The agent runs against the mock without touching the filesystem or spawning processes. Combined with a mock provider, the agent loop is fully testable without any real I/O or API calls.

```ts
const agent = new Agent({
  provider: new MockProvider(),
  tools: [readFile],
  platform: new MockPlatform({ "/src/index.ts": "export const x = 1;" }),
});
```

**Flow H: Subscribing to provider-level debug information.**

The developer passes a `logger` callback to `AnthropicProvider`. It receives structured `LogEntry` values at three points — `request_sent` (before each API call), `retry_attempt` (on each SDK retry, if the SDK exposes a hook), and `request_failed` (on final failure). Individual streaming `ProviderEvent` values are **not** logged in M1 (too voluminous). Off by default; no performance cost when absent.

```ts
const provider = new AnthropicProvider({
  apiKey: "...",
  model: "claude-opus-4-8",
  logger: (entry) => fs.appendFile("debug.log", JSON.stringify(entry) + "\n"),
});
```

### 5.3 States Matrix

Because there is no UI, "states" are the conditions the generator is in at each point in the turn cycle. The developer reads these via event types.

| State | Event(s) yielded | What the developer sees |
|-------|-----------------|------------------------|
| **Idle / before first call** | (none) | Generator not started. `agent.run(prompt)` has been called but not yet iterated. |
| **Streaming text** | `text_delta` (one per chunk) | Partial assistant text arriving. `event.text` is the incremental chunk. |
| **Tool invocation start** | `tool_use_start` | Model has emitted a complete tool-use block. `event.toolName` and `event.toolInput` available. |
| **Tool executing** | (no event during execution) | The `call` function is running. No event is yielded during synchronous tool execution. |
| **Tool result** | `tool_result` | Tool finished. `event.toolName`, `event.toolCallId`, `event.result`, `event.isError`. |
| **Turn complete** | `turn_complete` | Model turn (including tool calls in that turn) is fully processed. `event.turnIndex` increments. |
| **Agent done** | `agent_done` (then generator returns `Terminal`) | No tool calls in last turn. Agent naturally completed. Generator exhausts after yielding this event. |
| **Max turns exceeded** | `max_turns_exceeded` (then generator returns `Terminal`) | Safety limit hit. Generator exhausts. `Terminal.reason === "max_turns_exceeded"`. |
| **Provider error (retrying)** | (no event during retry) | Backoff happening silently. A future improvement may add a `provider_retry` event. |
| **Provider error (fatal)** | `agent_error` | All retries exhausted or unretryable error. `event.error` is the underlying Error. |
| **Tool schema validation failure** | `tool_result` (with `isError: true`) | Zod validation failed on model's tool args. Error text fed back to model. Engine continues. |
| **Malformed tool input (unparseable JSON)** | `tool_result` (with `isError: true`) | Accumulated `input_json_delta` did not form valid JSON. Error fed back to model. Engine continues. (§6.1) |
| **Unknown tool** | `tool_result` (with `isError: true`) | Model named a tool not in the registry. No user code runs; error fed back to model. Engine continues. (§6.2) |
| **Tool call execution failure** | `tool_result` (with `isError: true`) | `call` threw or rejected. Error fed back to model. Engine continues. |
| **Run abandoned (caller breaks `for await`)** | (no further events) | The generator's `finally` aborts the in-flight provider stream via `AbortController` and returns. No terminal event is observed by the caller (they have stopped iterating). (§6.9) |

**Empty response state:** If the model returns an empty assistant message (no text, no tools), the engine treats it as a tool-free turn and terminates: `turn_complete` → `agent_done` → generator return. Not an error.

**Offline / no network:** The provider's first API call fails with a connection error. If unretryable, yields `agent_error` with the underlying network error. No special offline state; the retry logic applies.

**Partial history state:** The caller passes a non-empty `messages` array to `run()`. The engine prepends these messages as prior context. If the history is malformed (e.g., ends with an assistant message that already has tool calls but no results), the Anthropic API will reject the request and `agent_error` is yielded. The framework does not validate the history shape — that is the caller's responsibility.

### 5.4 Information Hierarchy

**Primary** (what the developer almost always handles):
- `text_delta` — the assistant's text output
- `agent_done` — completion signal
- `agent_error` — failure signal

**Secondary** (useful for logging, progress display, debugging):
- `tool_use_start` — which tool was called and with what input
- `tool_result` — what the tool returned, whether it errored

**Tertiary** (available for advanced consumers, usually ignored):
- `turn_complete` — turn boundary, useful for turn-count metrics
- `max_turns_exceeded` — safety limit, should be rare in production

**Completion data** (carried on the terminal event — `agent_done` | `max_turns_exceeded` | `agent_error` — and duplicated on the generator's `Terminal` return value):
- the stop reason (the event's `type`, or `terminal.reason`)
- `messages` — the final in-memory message list, for multi-turn threading (on both the terminal event and `Terminal`)
- `error` — present only on `agent_error`

The terminal event is the ergonomic path (works inside `for await`); the `Terminal` return value is equivalent sugar for callers driving `.next()` manually.

**Can safely ignore:** A developer building a simple logging script handles only `text_delta` and `agent_error`. The discriminated `type` field makes filtering a single `switch` statement.

### 5.5 Accessibility

N/A — this is a headless library with no UI surface. There are no visual elements, keyboard navigation surfaces, or color signals to design. Any consumer that renders output (TUI, web, CLI) is responsible for its own accessibility. The framework surfaces a typed event stream; what consumers do with it is out of scope.

### 5.6 Microcopy (Error Messages, Event Shapes, Exported Names)

Because this is a library, "microcopy" means: the exact text of error messages, the names of exported symbols, the shape of event objects, and TypeDoc comments on public APIs.

**Event type names (the literal string values of `event.type`):**

| Event type string | Meaning |
|-------------------|---------|
| `text_delta` | Incremental text chunk from the model |
| `tool_use_start` | Model is about to call a tool |
| `tool_result` | Tool execution complete (success or error) |
| `turn_complete` | One full model turn (text + tool calls) has finished |
| `agent_done` | Agent reached natural completion |
| `max_turns_exceeded` | Safety turn limit hit |
| `agent_error` | Fatal error; agent terminated |

These strings are the developer's primary interface with the event stream. They must be stable across patch versions.

**Terminal type (the generator's return value — optional sugar):**

The same information carried by the terminal *event* is also the generator's `return` value, for callers who drive `.next()` manually rather than using `for await`. Most consumers never need this — they read the final `AgentEvent` instead.

```ts
type Terminal =
  | { reason: "agent_done"; messages: Message[] }
  | { reason: "max_turns_exceeded"; messages: Message[]; turnsUsed: number }
  | { reason: "agent_error"; messages: Message[]; error: Error };
```

Two distinct audiences, two distinct message styles:

1. **Fatal errors** — thrown, or carried in `agent_error.error.message`. Read by the *developer*. Prefixed with the originating component (`AnthropicProvider:` / `Agent:`).
2. **Tool-result errors** — the text of a `tool_result` block with `isError: true`, fed *to the model* for self-correction. No component prefix; written so the model can act on it. The same text is available to the developer on the `tool_result` event for logging.

**Fatal errors (thrown or in `agent_error.error.message`):**

- API key missing: `"AnthropicProvider: ANTHROPIC_API_KEY is required"`
- Model not found: `"AnthropicProvider: model '<name>' not found (HTTP 404)"`
- Rate limit exhausted after retries: `"AnthropicProvider: rate limit exceeded after <maxRetries> retries"`
- Context length exceeded: `"AnthropicProvider: request exceeds the model's context window (HTTP 400)"`
- Max turns: `"Agent: maxTurns (<n>) exceeded; terminating"`

**Tool-result errors (fed to the model as `tool_result` with `isError: true`):**

- Unknown tool: `"Unknown tool: '<name>'"`
- Unparseable tool input: `"Tool '<name>': could not parse tool input as JSON"`
- Zod validation: `"Tool '<name>': invalid input — <Zod error message>"`
- Tool `call` threw: `"Tool '<name>': <error message>"`
- Tool result serialization failure: `"Tool '<name>': could not serialize result — <error>"`

These strings are part of the product contract for the model's self-correction loop and the developer's logs; they should stay stable across patch versions.

**Key exported names:**

- `Agent` — the engine class
- `Tool` — the tool interface type
- `ToolCallContext` — the extensible context object passed as the third argument to every `Tool.call`; minimal in M1, widened by the SDK layer
- `AgentEvent` — the event union type
- `Terminal` — the generator return type (reason + messages)
- `Platform` — the capability interface type
- `NodePlatform` — the Node.js platform implementation (exported from `tiny-agentic/platform/node`)
- `Provider` — the provider interface type
- `AnthropicProvider` — the Anthropic provider class (exported from `tiny-agentic/providers/anthropic`)
- `Message` — the canonical message type
- `collectText(gen)` — utility: collect all `text_delta` into a single string
- `collectEvents(gen)` — utility: collect all events into an array

**Constructor option names (decisive, not placeholder):**

```ts
new Agent({
  provider,          // required: Provider
  tools,             // required: Tool[]
  platform,          // required: Platform (use new NodePlatform() for Node environments)
  systemPrompt,      // optional: string
  maxTurns,          // optional: number, default 25
})

agent.run(prompt, {
  messages,          // optional: Message[] — prior conversation history for multi-turn
})

new AnthropicProvider({
  apiKey,            // required: string
  model,             // required: string
  maxRetries,        // optional: number, default 3
  baseURL,           // optional: string (for proxies)
  logger,            // optional: (entry: LogEntry) => void — off by default
})
```

**TypeDoc on `Agent.run()`:**

```
/**
 * Run the agent on a single user prompt.
 *
 * Yields typed AgentEvents as the agent streams, calls tools, and completes.
 * The final event (agent_done | max_turns_exceeded | agent_error) carries the final
 * message list; pass it as the `messages` option on the next call for multi-turn
 * continuity. The generator also returns an equivalent Terminal for callers driving .next().
 *
 * The agent is stateless: no history is held between calls. The caller is responsible
 * for threading the message list to achieve continuity.
 *
 * @param prompt - The user's message to the agent.
 * @param options.messages - Prior conversation history (optional). Not persisted.
 * @yields AgentEvent
 * @returns Terminal
 */
```

### 5.7 Non-UI Product Specifics

This product has no GUI. The complete API contract for each subsystem:

**Agent loop exit conditions:**

- Natural exit: model turn with no tool-use blocks → `agent_done` event → `Terminal { reason: "agent_done" }` → generator return.
- Turn limit: `turnsUsed >= maxTurns` → `max_turns_exceeded` event → `Terminal { reason: "max_turns_exceeded" }` → generator return.
- Fatal provider error: all retries exhausted → `agent_error` event → `Terminal { reason: "agent_error" }` → generator return.
- Unhandled tool error: `call` throws → error text fed to model as `tool_result` with `isError: true` → engine continues (does not exit on tool errors).
- Unknown tool name: framework generates an error `tool_result` without calling any code → engine continues.

**Tool concurrency:** Sequential in M1. All `tool_use` blocks in a single turn are collected after `message_stop`, then executed one at a time. Their results are bundled into a single user message with multiple `tool_result` content blocks. The `runTools` function is the designated seam where `isConcurrencySafe()` parallelism will be added in a later milestone.

**Output structure (the event union):**

```ts
type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; toolName: string; toolInput: unknown }
  | { type: "tool_result"; toolName: string; toolCallId: string; result: unknown; isError: boolean }
  | { type: "turn_complete"; turnIndex: number }
  // Completion events carry the final message list, so a pure `for await` loop
  // gets both the stop reason AND the history to thread forward — no need to
  // capture the generator's return value.
  | { type: "agent_done"; messages: Message[] }
  | { type: "max_turns_exceeded"; turnsUsed: number; messages: Message[] }
  | { type: "agent_error"; error: Error; messages: Message[] };
```

All fields are typed; no `any` on the public surface. The union is discriminated by `type`. Exactly one terminal event (`agent_done` | `max_turns_exceeded` | `agent_error`) is yielded as the last event before the generator returns.

**Tool result serialization:** the `call` return value is `JSON.stringify`'d and sent to the model. If the return value is a string, it is sent as-is. If it is an object, it is serialized. If serialization fails, the error is sent as a tool error.

**Provider interface (the abstraction seam):**

```ts
interface Provider {
  // The AbortSignal is operational context (created per run() by the engine), not model
  // input — it is a second argument, not a field on ProviderRequest. Matches fetch(url, { signal }).
  stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent>;
}

type ProviderRequest = {
  systemPrompt: string;
  messages: Message[];
  tools: ToolSchema[];
  maxTokens?: number;
};

type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "message_stop"; stopReason: string };
```

The engine calls `provider.stream(request, signal)` and iterates the generator, threading the run's `AbortController.signal` so an abandoned run (§6.9) cancels the in-flight HTTP request. Retry and backoff on transient errors (429, 5xx, connection) are part of the `Provider` contract — expressed uniformly as a `maxRetries` option on each provider — and are delegated by the provider to its vendor SDK (see Feature 3). The engine does not retry. Errors that survive the provider's retries propagate as thrown exceptions; the engine catches them and yields `agent_error`.

**Platform interface (the environment seam):**

```ts
interface Platform {
  cwd(): string;                                              // env-context working directory
  readFile(path: string, encoding?: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  // additional methods added in M2 only as new built-in tools require them
}

type ExecResult = { stdout: string; stderr: string; exitCode: number };
```

The M1 method set is exactly these four (`cwd`, `readFile`, `writeFile`, `exec`), finalized in the engineering phase and driven by what M1 actually needs: `cwd` and `exec` for the env-context builder, `readFile`/`writeFile` for the two built-in tools. The interface is intentionally narrow — only the operations actually needed. Routing `cwd` through the platform (rather than `process.cwd()`) is what keeps the core free of Node globals.

**Tool-call context (the SDK extension seam):**

```ts
// Minimal M1 shape — the SDK widens this via TypeScript interface merging or generics
interface ToolCallContext {
  // Reserved for future use; empty in M1.
  // The SDK adds fields here (e.g., skillRegistry, commandRegistry) without touching core.
}
```

`Tool.call` has the signature `(input: TInput, platform: Platform, context: ToolCallContext) => Promise<unknown>`. Tools that do not need the context simply ignore the third argument. The context object is constructed by the engine per tool-call invocation. The engineering phase has since fixed the extension mechanism as **TypeScript interface merging**: `ToolCallContext` is declared as an `interface` the SDK reopens via `declare module 'tiny-agentic'`, rather than a generic `Tool<TInput, TContext>` (which would force `Agent` to be generic and leak SDK types into the core's public API). The product-level commitment stands: the parameter exists, is typed, and is extensible without breaking existing tool implementations — and the SDK must only ever add **optional** fields (a required field would break tools that do not supply it). See `docs/decisions.md` "ToolCallContext extension mechanism".

---

## 6. Edge Cases

These are the cases that break naive loop implementations. Each has a specified behavior.

**6.1 Model calls a tool with invalid JSON arguments.**

Anthropic streams tool arguments as `input_json_delta`. If the accumulated JSON is malformed (rare but possible), the framework catches the parse error, yields a `tool_result` with `isError: true` and message `"Tool '<name>': could not parse tool input as JSON"`, and continues the loop. The model sees the error and can retry.

**6.2 Model calls a tool whose name is not in the registry.**

The framework does not crash. It yields a `tool_result` with `isError: true` and message `"Unknown tool: '<name>'"`. The model may call a different tool or terminate. This protects against model hallucinations of tool names.

**6.3 Model calls multiple tools in one turn.**

Anthropic can emit multiple `tool_use` blocks in a single assistant message. The framework collects all of them before executing any (wait for `message_stop`). Then it executes them sequentially in M1. All results are bundled into a single user message with multiple `tool_result` blocks before the next model call. This is the required Anthropic API shape. (The `runTools` seam makes parallel execution a drop-in for M2.)

**6.4 Tool `call` throws synchronously or returns a rejected Promise.**

The framework wraps all `call` invocations in `try/catch`. The error message is sent to the model as a `tool_result` error. The framework yields a `tool_result` event with `isError: true`. The agent continues.

**6.5 Tool `call` hangs indefinitely.**

In M1, there is no per-tool timeout. If a tool never resolves, the generator hangs. This is a known M1 limitation. The developer is responsible for adding timeouts inside the `call` function (e.g., `Promise.race` with a deadline). A per-tool `timeoutMs` option is deferred to M2.

**6.6 Very large tool result.**

If the tool returns a value that serializes to a very large string (e.g., reading a 10MB file), the model turn may fail with a context-length error. In M1 the framework does not truncate tool results. The error returns as `agent_error`. Truncation/summarization is deferred.

**6.7 Model response has no tool calls and no text.**

The model produces an empty assistant turn (no text blocks, no tool blocks). The framework treats this as natural completion: `turn_complete` → `agent_done`. No error.

**6.8 Model hits its context limit mid-conversation.**

Anthropic returns a 400 with `context_length_exceeded`. This is not retryable. The framework yields `agent_error` with the error. Context compaction is a deferred M2+ concern.

**6.9 The `for await` caller breaks early (generator abandoned).**

If the caller breaks out of the `for await` loop before `agent_done`, the generator is abandoned. The framework uses `try/finally` in the generator to cancel any in-flight streaming request (via `AbortController`). This prevents dangling HTTP connections.

**6.10 Multi-turn history threading with concurrent calls.**

Each `agent.run()` call is independent. If the caller runs two concurrent turns on the same agent (passing the same prior `messages` array to both), there is no shared mutable state — each call gets its own copy of the working message list. The two resulting `Terminal.messages` arrays will diverge (each reflects one branch of the conversation). The caller is responsible for deciding which history to thread forward. This is expected behavior for a stateless engine.

**6.11 Caller passes a malformed history.**

The developer passes a `messages` array that violates the Anthropic API's message ordering rules (e.g., two consecutive user messages, or an assistant message with unresolved tool calls). The Anthropic API returns a 400 error. The framework yields `agent_error`. The core does not attempt to repair or validate history shape; that is the caller's (or SDK layer's) responsibility.

**6.12 API key invalid or expired.**

The Anthropic SDK returns a 401. This is not retried. The framework yields `agent_error` immediately with a clear message. The developer must check their key.

**6.13 Zod schema and model disagree.**

The framework serializes the Zod schema to JSON Schema via `zod-to-json-schema` and sends it in the request. The model may still call the tool with unexpected shapes. The Zod parse step before `call` catches this and returns the validation error to the model as self-correction input.

**6.14 Tool `description` is very long.**

Tool descriptions are injected into the system prompt. Many tools with long descriptions may push the system prompt toward context limits. In M1 no truncation is applied. The developer is responsible for keeping descriptions concise.

**6.15 Git not installed or not a git repo (env context).**

The env context builder calls `platform.exec("git ...")`. If git is not installed, or the cwd is not a git repo, the exec call fails (non-zero exit code or error). The git lines are silently omitted from the env context block. No error is thrown; the agent run proceeds.

**6.16 Platform operation fails inside a built-in tool.**

The developer passes a `NodePlatform` and a built-in tool calls `platform.readFile(path)` where `path` does not exist. The platform method throws (ENOENT). The framework catches this at the `call` boundary (same as 6.4) and feeds the error back to the model as a tool error. The agent continues.

**6.17 Stream stalls (no chunks arriving).**

The provider's HTTP stream connects but stops emitting chunks (a hung connection). In M1 the framework does not impose its own idle-timeout watchdog; it relies on the underlying vendor SDK's request timeout. If the SDK times out, the error surfaces as a thrown exception and the engine yields `agent_error`. A dedicated stream-idle watchdog (the reference's 90s `STREAM_IDLE_TIMEOUT_MS`) is deferred to M2. This is a known M1 limitation, parallel to the no-per-tool-timeout limitation (§6.5).

**6.18 Abort fires while a tool is executing.**

The caller breaks the `for await` loop (or an external abort triggers) during tool execution rather than during streaming. The engine's `AbortController` aborts the provider seam, but a tool's `call` that ignores cancellation will run to completion before the generator's `finally` returns — the engine does not forcibly interrupt synchronous tool work in M1. The tool's result is discarded (the generator has been abandoned). Threading the `AbortSignal` into `Tool.call` for cooperative cancellation is deferred; M1 only guarantees the in-flight *provider stream* is aborted.

---

## 7. Success Criteria

Milestone 1 is complete when all of the following (1–18) are observable. Criteria 1–14 cover the original behavior set; 15–18 close gaps in git degradation, multi-tool turns, abort cleanup, and incremental streaming.

1. **Basic agent run:** `agent.run("What is 2+2?")` with no tools calls the Anthropic API, streams text, yields `text_delta` events, and terminates with `agent_done`. Observable by running the example script.

2. **Tool use end-to-end:** `agent.run("Read the file ./README.md and summarize it.")` with `read_file` tool registered and `NodePlatform` injected: the model calls the tool, the framework validates args via Zod, calls `platform.readFile`, feeds the result back, the model responds, the generator terminates. Observable: `tool_use_start` and `tool_result` events appear before `agent_done`.

3. **Tool error recovery:** a tool's `call` throws an error. The framework yields `tool_result` with `isError: true`. The generator does not throw; the loop continues and eventually yields `agent_done` or `agent_error`. Observable by registering a tool that throws.

4. **Unknown tool handling:** the model calls a tool not in the registry. The framework yields `tool_result` with `isError: true`. The loop continues. Observable via the event stream.

5. **Max turns safety:** `agent.run(prompt)` with `maxTurns: 2` on a task requiring 5 turns terminates after 2 turns with `max_turns_exceeded`. Observable by counting `turn_complete` events.

6. **API error handling:** an invalid API key causes `agent_error` to be yielded with a clear message. Observable by passing a bad key.

7. **Provider abstraction compile-check:** a mock `Provider` implementation can be passed to `Agent` and compiles and runs. Observable in the test suite.

8. **Platform abstraction compile-check:** a mock `Platform` implementation can be passed to `Agent` and the built-in tools work against it without hitting the filesystem. Observable in the test suite.

9. **Multi-turn threading:** running `agent.run(prompt1)`, taking the final `messages` (from the `agent_done` event, or equivalently the `Terminal`), then passing those to `agent.run(prompt2, { messages })` results in the model receiving the correct prior context. Observable via a mock provider that echoes back the messages it received.

10. **Type safety:** all public exports have TypeScript types. Passing wrong types to `Agent` constructor or consuming events without narrowing produces a compile error. Observable via `tsc --strict`.

11. **No UI imports:** `grep -r "ink\|react\|chalk\|ora"` in `src/` returns nothing. Observable via CI.

12. **No core filesystem imports:** the core package (`src/` excluding `platform/node`) has no direct `import fs` or `import child_process`. All environment I/O is behind the `Platform` interface. Observable via a lint rule or import graph check.

13. **Env context injection:** the system prompt sent to the model (captured via a mock provider) begins with an env-context block containing the cwd (sourced from `platform.cwd()`, verifiable by asserting a mock platform's cwd value appears), the date, and — when `platform.exec("git ...")` returns a zero exit code — the git branch and status. The developer-supplied `systemPrompt` follows the block. When no `systemPrompt` is given, only the env-context block is sent.

14. **Logger is off by default:** `new AnthropicProvider({ apiKey, model })` with no `logger` produces no console output during a run. Observable in the test suite.

15. **Git-absent degradation:** with a mock platform whose `exec("git ...")` returns a non-zero exit code (or throws), the env-context block omits the git lines and the run proceeds normally to `agent_done`. No error is yielded. (§6.15)

16. **Multiple tools in one turn:** when the mock provider emits two `tool_use` blocks in a single assistant turn, both execute, two `tool_result` events are yielded, and both results are bundled into a single user message (one user message with two `tool_result` content blocks) before the next provider call. Observable via the mock provider's received-message assertion. (§6.3)

17. **Abort on abandonment:** breaking out of the `for await` loop mid-stream causes the engine's `finally` to abort the provider stream. Observable with a mock provider that records whether its `AbortSignal` fired. (§6.9)

18. **Streaming surfaces incrementally:** `text_delta` events are yielded as the mock provider emits chunks, not buffered until turn end. Observable by asserting an interleaving of `text_delta` events before `turn_complete` within a single turn.

---

## 8. Open Questions

**No M1-blocking open questions remain.** All open questions from the initial draft have been resolved — see `docs/decisions.md` entries "Milestone-1 open questions resolved" and "Three-package architecture" for the binding decisions.

Several questions that were open at first draft have since been **answered by the engineering phase** and folded into this refined spec (see `docs/decisions.md`): the `Platform` M1 method set is `cwd`/`readFile`/`writeFile`/`exec`; the repo is a pnpm-workspace monorepo; `ToolCallContext` is widened via TypeScript interface merging; `ToolSchema` is `zod-to-json-schema` with `target: "openApi3"`; the `AbortSignal` is a second argument to `Provider.stream`; and retry is delegated to the vendor SDK. This refined brainstorm now describes those resolved choices rather than leaving them open.

**Deferred-to-M2 items surfaced during this refinement** (documented in the edge cases; flagged here so they are not forgotten — none blocks M1):
- **Stream-idle watchdog** (§6.17) — M1 relies on the vendor SDK's request timeout; no dedicated idle watchdog. The reference uses a 90s `STREAM_IDLE_TIMEOUT_MS`.
- **Cooperative tool cancellation** (§6.18) — M1 aborts only the provider stream; `Tool.call` does not receive the `AbortSignal`. If desired, threading the signal into the tool-call context is a small, non-breaking M2 addition.
- **Per-tool timeout** (§6.5) and **tool-result truncation** (§6.6) — already noted as M2 deferrals.

These are M2 scope, not M1 open questions. The engineering phase may still surface lower-level questions (the exact serialized `ToolSchema` field names, the precise `ExecOptions` shape), which it owns.

---

*Spec complete. This document is the authoritative product design for tiny-agentic milestone 1 (the core package). The engineering phase produces architecture and interface decisions on top of this spec. Locked decisions in `docs/decisions.md` take precedence where they overlap.*

---

## Refinement notes (Opus pass — 2026-06-27)

This pass refined the spec in place for clarity, completeness, and consistency with the engineering decisions that were locked *after* the original brainstorm draft. No locked product decision was reversed. The brainstorm intentionally pre-dated several engineering decisions; the largest category of change is **bringing the spec into alignment with those already-approved decisions** so the brainstorm and `docs/decisions.md` no longer contradict each other.

### (a) Material changes made, and why

- **Retry ownership corrected (Feature 3, Flow C, §5.7 Provider interface).** The original spec said the Anthropic provider "includes basic retry logic (exponential backoff on 429 and 5xx)." The locked decision "Provider contract owns retry; SDKs delegate" rejected the hand-rolled wrapper (it only wrapped stream *construction*, a no-op, since transient errors surface during stream *iteration*). Rewrote to: retry is a `Provider` contract expressed as a uniform `maxRetries` option, **delegated to the Anthropic SDK** via `new Anthropic({ maxRetries })`.
- **`AbortSignal` added to the `Provider` interface (§5.7).** The interface showed `stream(request)`; the locked decision threads the signal as a second argument: `stream(request, signal?)`. This also makes edge case 6.9 (abandoned generator → abort the stream) coherent with the interface.
- **`Platform.cwd()` added (Feature 4, Feature 5, §5.7).** The locked decision "`Platform` gains `cwd()`; env context never touches `process`" added a fourth method and forbade Node globals in the core outside `platform/node.ts`. The `Platform` interface, the `MockPlatform` example (which was missing `cwd()` and would not have compiled), and the Feature 4 env-context prose now reflect this.
- **Built-in tool set pinned to `read_file` + `write_file`.** The opening code example used `listFilesTool` / `read_file, list_files`, but no listing capability exists on the M1 `Platform`. Replaced with `readFileTool` / `writeFileTool` and an explicit note that directory listing is deferred to M2.
- **`ToolCallContext` reconciled to "empty `{}` in M1" (Feature 2, §5.7).** Feature 2 previously implied the context "carries the current `Agent` run handle"; the locked decision makes M1's interface empty (the SDK widens it via interface merging) and requires SDK-added fields to be optional. Aligned the prose and named the mechanism.
- **Error-message microcopy split by audience (§5.6).** The original list mixed developer-facing fatal errors with model-facing tool-result errors, and the unknown-tool string was inconsistent between §5.6 (`"Agent: model called unknown tool..."`) and §6.2 (`"Unknown tool: '<name>'"`). Reorganized into two tables — **fatal errors** (component-prefixed, in `agent_error.error`) and **tool-result errors** (clean, fed to the model) — and standardized on `"Unknown tool: '<name>'"`. Genericized `maxTurns (10)` → `maxTurns (<n>)` and `3 retries` → `<maxRetries> retries`. Added a context-length fatal message.

### (b) Gaps closed

- **States matrix** gained explicit rows for malformed tool input, unknown tool, and run-abandonment/abort — previously only described in scattered prose.
- **Edge cases** gained §6.17 (stream stalls / idle — M1 relies on the SDK timeout, no watchdog) and §6.18 (abort fires during tool execution — only the provider stream is aborted; tools are not cooperatively cancelled in M1).
- **Success criteria** extended from 14 to 18: added git-absent degradation (15), multiple-tools-in-one-turn bundling (16), abort-on-abandonment (17), and incremental-streaming (18). Tightened criterion 13 (env context) to assert the cwd comes from `platform.cwd()` and that the git block is conditional on a zero exit code — making it verifiable with a mock platform.
- **Open questions (§8)** rewritten: it now records which first-draft questions the engineering phase has since answered (and which this spec now folds in) and lists the M2 deferrals surfaced here, so they are not lost.

### (c) Proposals / open items for the downstream engineering refine

None of these change M1 scope; they are flags for the engineering refine to confirm or schedule:

1. **Stream-idle watchdog (M2).** M1 leans entirely on the vendor SDK's request timeout. If a provider/SDK ever lacks a usable idle timeout, an engine-level watchdog (reference: 90s) becomes necessary. Engineering should confirm the Anthropic SDK's default timeout is acceptable for M1 and note where a watchdog would attach.
2. **Cooperative tool cancellation (M2).** M1 aborts only the provider stream. Threading the run's `AbortSignal` into `Tool.call` (most naturally via the already-existing `ToolCallContext`, since it is the SDK-extensible seam — or as a fourth `call` argument) is a clean, non-breaking addition. Worth deciding the shape now so the seam is reserved, even if unused in M1.
3. **`provider_retry` event.** The states matrix notes retries happen "silently" and a future `provider_retry` event "may" be added. Because retry is now delegated to the vendor SDK, surfacing retry attempts as engine events would require the SDK to expose a retry hook. Engineering should confirm whether the Anthropic SDK exposes one; if not, this event is not feasible in M1 and the matrix note should be downgraded from "future improvement" to "not available while retry is SDK-delegated."
4. **`maxTokens` default.** `ProviderRequest.maxTokens` is optional with no stated default. The Anthropic Messages API *requires* `max_tokens`. Engineering must define the provider's default `max_tokens` (the reference escalates to 64k on the non-streaming fallback, which M1 omits). This is an engineering-phase detail but currently has no home in either the spec or the decisions log.

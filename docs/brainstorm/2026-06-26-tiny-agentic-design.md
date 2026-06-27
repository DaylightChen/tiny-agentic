# tiny-agentic — Product Design Spec

**Date:** 2026-06-26
**Milestone:** 1 — the `tiny-agentic` core package
**Status:** Authoritative input to the engineering phase. Supersedes the original draft of the same name.

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
const agent = new Agent({ provider, tools: [readFileTool, listFilesTool], platform });

for await (const event of agent.run("Summarize all .ts files in ./src")) {
  console.log(event);
}
```

...or, for a non-streaming one-shot, use the convenience helper:

```ts
const text = await collectText(agent.run("Summarize all .ts files in ./src"));
```

...and have it work: the model runs, calls the tools they registered, loops, and terminates. They do not want to think about streaming event accumulators, tool-use message formatting, or retry semantics.

**Constraints:** Working in Node >=18. May want Anthropic today, OpenAI tomorrow. Probably building a CLI or server, not a browser app. Does not want a peer dependency on React or Ink.

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

The **extensible tool-call context** is the seam that lets higher layers (the SDK) inject additional capabilities — such as a skill registry or command registry — into running tools without modifying the core. The core defines the context object with a minimal set of fields for M1 and allows the SDK to widen it. This mirrors the reference's `ToolUseContext`. For M1, the context carries only what the core itself needs (e.g., the current `Agent` run handle for future sub-agent use); SDK-layer fields are added by the SDK without touching core code.

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

**Description:** A concrete provider implementation that calls the Anthropic Messages API, streams the response, and translates Anthropic's streaming event types into the framework's canonical `ProviderEvent` union. The provider accepts an API key, model name, optional retry count, optional base URL, and an optional logger callback. Basic retry logic (exponential backoff on 429 and 5xx) is included.

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

**Description:** The framework automatically inserts a minimal environment context block into the system prompt: current working directory, current date, git branch and status (if the process is inside a git repo). This mirrors the Claude Code reference's `context.ts`. The env context is computed once per `run()` call and prepended to the developer-supplied system prompt. Env context collection uses the injected `Platform` (e.g., `platform.exec("git status")`) so the core remains environment-agnostic.

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

**Description:** An abstract `Platform` interface that decouples tool `call` implementations from the concrete runtime environment. The interface defines the operations that built-in tools need: `readFile`, `writeFile`, `exec`, and similar. The framework ships a `NodePlatform` concrete implementation. The core itself imports no `fs`, `child_process`, or other Node-specific modules — it only holds the `Platform` interface type. A test harness, browser polyfill, or mock can be substituted by implementing the interface.

This makes the core package truly environment-agnostic: the same `read_file` tool definition works in Node (via `NodePlatform`) or in a future browser environment (via a different `Platform` implementation), because the tool's `call` function never calls `fs` directly.

**User-visible behavior (developer-facing):**

```ts
import { Platform } from "tiny-agentic";
import { NodePlatform } from "tiny-agentic/platform/node";

// Default: use NodePlatform
const agent = new Agent({ provider, tools, platform: new NodePlatform() });

// Testing: use a mock
class MockPlatform implements Platform {
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

The Anthropic API returns a 429 or 5xx. The provider retries with exponential backoff (up to a configured `maxRetries`, defaulting to 3). If all retries fail, the generator yields an `agent_error` event and terminates. The caller inspects `event.error` to get the underlying error.

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

The developer passes a `logger` callback to `AnthropicProvider`. It receives structured log entries (request sent, events received, retries attempted). Off by default; no performance cost when absent.

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
| **Tool call execution failure** | `tool_result` (with `isError: true`) | `call` threw. Error fed back to model. Engine continues. |

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

**Error messages (thrown or in `agent_error.error`):**

- API key missing: `"AnthropicProvider: ANTHROPIC_API_KEY is required"`
- Model not found: `"AnthropicProvider: model '<name>' not found (HTTP 404)"`
- Rate limit exhausted after retries: `"AnthropicProvider: rate limit exceeded after 3 retries"`
- Tool not found: `"Agent: model called unknown tool '<name>'; returning error to model"`
- Max turns: `"Agent: maxTurns (10) exceeded; terminating"`
- Zod validation: `"Tool '<name>': invalid input — <Zod error message>"`
- Tool result serialization failure: `"Tool '<name>': could not serialize result — <error>"`

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
  stream(request: ProviderRequest): AsyncGenerator<ProviderEvent>;
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

The engine calls `provider.stream(request)` and iterates the generator. Retry and backoff on transient errors (429, 5xx) are the **provider's** responsibility (see Feature 3) — the engine does not retry. Errors that survive the provider's retries propagate as thrown exceptions; the engine catches them and yields `agent_error`.

**Platform interface (the environment seam):**

```ts
interface Platform {
  readFile(path: string, encoding?: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  // additional methods added as built-in tools require them
}

type ExecResult = { stdout: string; stderr: string; exitCode: number };
```

The exact set of methods is finalized in the engineering phase, driven by which built-in tools land in M1. The interface is intentionally narrow — only the operations actually needed.

**Tool-call context (the SDK extension seam):**

```ts
// Minimal M1 shape — the SDK widens this via TypeScript interface merging or generics
interface ToolCallContext {
  // Reserved for future use; empty in M1.
  // The SDK adds fields here (e.g., skillRegistry, commandRegistry) without touching core.
}
```

`Tool.call` has the signature `(input: TInput, platform: Platform, context: ToolCallContext) => Promise<unknown>`. Tools that do not need the context simply ignore the third argument. The context object is constructed by the engine per tool-call invocation; the exact mechanism (interface merging vs. generic parameter) is an engineering-phase decision. The product-level commitment is: the parameter exists, is typed, and is extensible without breaking existing tool implementations.

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

---

## 7. Success Criteria

Milestone 1 is complete when all of the following are observable:

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

13. **Env context injection:** the system prompt sent to the model (via mock provider or debug logger) contains the cwd, date, and git status block.

14. **Logger is off by default:** `new AnthropicProvider({ apiKey, model })` with no `logger` produces no console output during a run. Observable in the test suite.

---

## 8. Open Questions

None. All open questions from the initial draft have been resolved. See `docs/decisions.md` entries "Milestone-1 open questions resolved" and "Three-package architecture" for the binding decisions.

The engineering phase may surface new architectural questions (e.g., exact `Platform` method signatures beyond the three listed above, monorepo vs. single-package layout for M1, the precise TypeScript mechanism for widening `ToolCallContext` in the SDK, and the exact shape of the serialized `ToolSchema` passed to providers). Those are engineering-phase concerns; this spec does not pre-answer them.

---

*Spec complete. This document is the authoritative product design for tiny-agentic milestone 1 (the core package). The engineering phase produces architecture and interface decisions on top of this spec. Locked decisions in `docs/decisions.md` take precedence where they overlap.*

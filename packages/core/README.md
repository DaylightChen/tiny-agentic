# tiny-agentic

> Headless agentic engine for TypeScript/Node: a stateless agent loop, tool execution, a provider abstraction, and a typed event stream — with zero UI dependencies.

`tiny-agentic` gives you the mechanics of an agent — stream the model, run the tools it calls, feed results back, loop until it stops — exposed as a typed `AsyncGenerator`. It imports no React/Ink/CLI code; you consume the event stream however you like.

## Install

```bash
npm install tiny-agentic zod @anthropic-ai/sdk
```

- `zod` is a **required** peer dependency — you author tool schemas with it.
- `@anthropic-ai/sdk` is an **optional** peer dependency — needed only if you use the built-in Anthropic provider.
- Requires **Node >= 22**. ESM only.

## Quick start

```ts
import { Agent, readFileTool, writeFileTool, type Message } from "tiny-agentic";
import { AnthropicProvider } from "tiny-agentic/providers/anthropic";
import { NodePlatform } from "tiny-agentic/platform/node";

const agent = new Agent({
  provider: new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: "claude-opus-4-8",
  }),
  tools: [readFileTool, writeFileTool],
  platform: new NodePlatform(),
  systemPrompt: "You are a helpful assistant.", // optional
  maxTurns: 25,                                  // optional (default 25)
});

for await (const event of agent.run("Read ./package.json and tell me the version.")) {
  switch (event.type) {
    case "text_delta":      process.stdout.write(event.text); break;
    case "tool_use_start":  console.log(`\n[tool: ${event.toolName}]`); break;
    case "tool_result":     console.log(`[result: isError=${event.isError}]`); break;
    case "agent_done":      console.log("\n[done]"); break;
    case "agent_error":     console.error(event.error.message); break;
  }
}
```

## Entry points

The package ships several entry points so an OpenAI-only consumer never loads the Anthropic SDK, etc.:

| Import | Exports |
|--------|---------|
| `tiny-agentic` | `Agent`, `defineTool`, `readFileTool`, `writeFileTool`, and all types (`Tool`, `ToolCallContext`, `Provider`, `ProviderRequest`, `ProviderEvent`, `ToolSchema`, `Logger`, `LogEntry`, `Platform`, `ExecOptions`, `ExecResult`, `Message` + content blocks, `AgentEvent`, `Terminal`, `AgentOptions`, `RunOptions`) |
| `tiny-agentic/providers/anthropic` | `AnthropicProvider` |
| `tiny-agentic/platform/node` | `NodePlatform` |
| `tiny-agentic/utils` | `collectText`, `collectEvents` |

## Core concepts

### Agent (stateless)

`new Agent({ provider, tools, platform, systemPrompt?, maxTurns? })`, then `agent.run(prompt, { messages? })`. `run()` returns `AsyncGenerator<AgentEvent, Terminal>`. The agent holds **no** state between calls — for multi-turn, thread the final message list forward:

```ts
let history: Message[] = [];
for await (const event of agent.run("What files are in src/?")) {
  if (event.type === "agent_done") history = event.messages; // terminal events carry the history
}
for await (const event of agent.run("Summarize the first one.", { messages: history })) {
  if (event.type === "agent_done") history = event.messages;
}
```

### Event stream (`AgentEvent`)

A discriminated union (switch on `type`):

| Event | Fields | Meaning |
|-------|--------|---------|
| `text_delta` | `text` | Incremental assistant text |
| `tool_use_start` | `toolName`, `toolInput` | Model is calling a tool |
| `tool_result` | `toolName`, `toolCallId`, `result`, `isError` | A tool finished (success or error) |
| `turn_complete` | `turnIndex` | One model turn (text + tools) finished |
| `agent_done` | `messages` | Natural completion (no more tool calls) |
| `max_turns_exceeded` | `turnsUsed`, `messages` | Safety limit hit |
| `agent_error` | `error`, `messages` | Fatal error; loop terminated |

The three terminal events carry `messages` so a plain `for await` loop can thread history. The generator also *returns* an equivalent `Terminal` for callers driving `.next()` manually.

### Tools

A `Tool` has a `name`, `description`, a Zod `inputSchema`, and a `call(input, platform, context)`. Use `defineTool` so `input` is fully typed:

```ts
import { defineTool } from "tiny-agentic";
import { z } from "zod";

const greet = defineTool({
  name: "greet",
  description: "Return a greeting for a name.",
  inputSchema: z.object({ name: z.string() }),
  call: async ({ name }) => ({ greeting: `Hello, ${name}!` }),
});
```

The framework serializes the Zod schema to JSON Schema for the model, validates the model's arguments **before** calling `call`, and feeds validation/throw errors back to the model as a `tool_result` (self-correction) rather than crashing. `ToolCallContext` is an empty, extensible interface (an SDK-layer seam).

### Built-in tools

- **`read_file`** — `{ path, offset?, limit? }`. Returns `{ content }` for the whole file, or `{ content, offset, lineCount, totalLines, truncated }` for a line range (`offset` is 1-based, `limit` is max lines) — handy for large files.
- **`write_file`** — `{ path, content, offset?, limit? }`. Without `offset`, overwrites the whole file (creating it). With `offset` (and optional `limit`, default through EOF, `0` = insert), it replaces that line range via read-modify-write.

### Provider

`AnthropicProvider` calls the Anthropic Messages API and translates its streaming events into the canonical `ProviderEvent` shape. Retry of transient errors (429/5xx) is delegated to the Anthropic SDK via `maxRetries`.

```ts
new AnthropicProvider({
  apiKey,                 // required
  model,                  // required
  maxRetries,             // optional (default 3)
  baseURL,                // optional
  maxTokens,              // optional (default 32000)
  logger,                 // optional: (entry: LogEntry) => void — off by default
});
```

Implement the `Provider` interface (`stream(request, signal?): AsyncGenerator<ProviderEvent>`) to add another backend.

### Platform

`Platform` is the environment seam (`cwd`, `readFile`, `writeFile`, `exec`). `NodePlatform` implements it with Node APIs and is the **only** module that touches `fs`/`process`/`child_process`. Supply a mock in tests:

```ts
class MockPlatform implements Platform {
  cwd() { return "/project"; }
  async readFile(p: string) { return "..."; }
  async writeFile() {}
  async exec() { return { stdout: "", stderr: "", exitCode: 0 }; }
}
```

### Convenience utilities

```ts
import { collectText, collectEvents } from "tiny-agentic/utils";
const text = await collectText(agent.run("Say hi."));            // joins all text_delta
const { events, terminal } = await collectEvents(agent.run("…")); // full event array + Terminal
```

## What this package is not (M1 scope)

No permissions/approval flow, sub-agents, skills, slash-commands, session persistence, OpenAI provider, or UI — those are future milestones or separate layers. The agent loop is sequential (tools run one at a time) with a seam for future concurrency.

## License

MIT

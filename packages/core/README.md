# tiny-agentic

> Headless agentic engine for TypeScript/Node: a stateless agent loop, tools, provider abstraction, typed events, and zero UI dependencies.

`tiny-agentic` streams model output, executes tools, feeds ordered results back to the model, and loops until completion. The core is UI-free; CLIs, web apps, and other interfaces consume its `AsyncGenerator` event stream.

## Install

```bash
npm install tiny-agentic zod @anthropic-ai/sdk
```

Install `openai` instead of, or alongside, `@anthropic-ai/sdk` when using `OpenAIProvider`. `zod` is required; provider SDK peers are optional. The package is ESM-only and requires Node 22 or later.

## Quick start

```typescript
import { Agent, readFileTool } from "tiny-agentic";
import { AnthropicProvider } from "tiny-agentic/providers/anthropic";
import { NodePlatform } from "tiny-agentic/platform/node";

const agent = new Agent({
  provider: new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: "claude-opus-4-8",
  }),
  tools: [readFileTool],
  platform: new NodePlatform(),
  systemPrompt: "Answer concisely.",
  maxTurns: 25,
  approvalHandler: async (toolName, input) => {
    console.log("approve", toolName, input);
    return "allow";
  },
});

for await (const event of agent.run("Read package.json and report its version.")) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "reasoning_delta":
      break;
    case "tool_use_start":
      console.log(`calling ${event.toolName}`);
      break;
    case "tool_result":
      console.log(event.toolName, event.isError);
      break;
    case "turn_complete":
      console.log("turn stop", event.stopReason.kind);
      break;
    case "subagent_event":
      console.log("child", event.taskId, event.event.type);
      break;
    case "agent_done":
      console.log("final stop", event.stopReason.kind);
      if (event.stopReason.kind === "other") console.log("raw", event.stopReason.raw);
      break;
    case "max_turns_exceeded":
      console.error("turn limit", event.turnsUsed);
      break;
    case "agent_error":
      console.error(event.error);
      break;
  }
}
```

## Entry points

Provider and Node implementations use separate entry points so the main model-facing graph remains provider-SDK-neutral and Node-built-in-free.

| Import | Exports |
|---|---|
| `tiny-agentic` | Values: `Agent`, `defineTool`, `readFileTool`, `writeFileTool`, `bashTool`, `editFileTool`, `lsTool`, `globTool`, `grepTool`, `createTaskTool`, `EMPTY_USAGE`, `mergeUsage`, `accumulateUsage`. Types: `AgentOptions`, `RunOptions`, `AgentEvent`, `SubagentChildEvent`, `Terminal`, `Message`, `ContentBlock`, `TextBlock`, `ToolUseBlock`, `ToolResultBlock`, `Tool`, `ToolCallContext`, `ApprovalDecision`, `ApprovalHandler`, `Provider`, `ProviderRequest`, `ProviderEvent`, `StopReasonKind`, `StopReason`, `ToolSchema`, `Logger`, `LogEntry`, `Platform`, `ExecOptions`, `ExecResult`, `DirEntry`, `GlobOptions`, `GlobResult`, `GrepMatch`, `GrepOptions`, `GrepPlatformResult`, `Usage`, `CreateTaskToolOptions`, `ChildSpec`. |
| `tiny-agentic/providers/anthropic` | Value `AnthropicProvider`; type `AnthropicProviderOptions`. |
| `tiny-agentic/providers/openai` | Value `OpenAIProvider`; type `OpenAIProviderOptions`. |
| `tiny-agentic/platform/node` | `NodePlatform`. |
| `tiny-agentic/utils` | `collectText`, `collectEvents`. |

## Agent and run options

`new Agent({ provider, tools, platform, systemPrompt?, maxTurns?, approvalHandler? })` creates a stateless agent. `maxTurns` defaults to 25. The optional asynchronous `approvalHandler(toolName, validatedInput)` returns `"allow"` or `"deny"`; omission means blanket allow. A denial, or an approval callback failure, becomes an ordered tool error rather than crashing the run.

`agent.run(prompt, { messages?, signal? })` returns `AsyncGenerator<AgentEvent, Terminal>`. Pass the prior terminal's `messages` to continue a conversation. `signal` cancels externally. `RunOptions.depth` exists only for internal Task recursion accounting; top-level consumers should omit it.

```typescript
import type { Message } from "tiny-agentic";

let messages: Message[] = [];
for await (const event of agent.run("First question")) {
  if (event.type === "agent_done") messages = event.messages;
}
for await (const event of agent.run("Follow-up", { messages })) {
  if (event.type === "agent_done") messages = event.messages;
}
```

## Events, terminals, and stop reasons

`AgentEvent` is discriminated by `type`.

| Event | Fields | Meaning |
|---|---|---|
| `text_delta` | `text` | Incremental assistant text. |
| `reasoning_delta` | `text` | Observation-only reasoning text; it is not written into conversation history. |
| `tool_use_start` | `toolName`, `toolInput` | A provider requested a tool call. |
| `tool_result` | `toolName`, `toolCallId`, `result`, `isError` | One ordered tool outcome. |
| `turn_complete` | `turnIndex`, `stopReason`, `usage?` | A completed provider turn; usage is for that provider turn. |
| `subagent_event` | `taskId`, `event` | A sanitized child event attributed to its spawning Task call. |
| `agent_done` | `messages`, `usage`, `stopReason` | Successful terminal event with cumulative usage. |
| `max_turns_exceeded` | `turnsUsed`, `messages`, `usage` | Engine turn limit; no provider stop reason. |
| `agent_error` | `error`, `messages`, `usage` | Provider/runtime/cancellation failure; no provider stop reason. |

The generator returns a matching `Terminal` for manual `.next()` consumers. `agent_done` is the only successful terminal arm and carries the final provider `stopReason`; error and max-turn arms do not invent one.

`StopReason.kind` is a closed normalized union: `end_turn`, `tool_use`, `max_tokens`, `stop_sequence`, `pause_turn`, `refusal`, `content_filter`, `model_context_window_exceeded`, or `other`. Every arm also has required `raw: string | null`. For `other`, inspect `raw` to retain an unknown native value or distinguish a stream that exposed none. Every `turn_complete` has its own reason, including turns that continue into tool execution.

`SubagentChildEvent` contains `text_delta`, `reasoning_delta`, `tool_use_start`, metadata-only `tool_result`, and three `terminal` reasons. A child `agent_done` terminal includes `stopReason`; child max-turn/error terminals do not. Child messages and raw tool-result payloads never cross this boundary.

## Tools

A `Tool` has `name`, `description`, a Zod `inputSchema`, `call(input, platform, context)`, and an optional synchronous `isConcurrencySafe(input)` classifier. `defineTool` preserves the schema-inferred input type.

```typescript
import { defineTool } from "tiny-agentic";
import { z } from "zod";

const greet = defineTool({
  name: "greet",
  description: "Return a greeting.",
  inputSchema: z.object({ name: z.string() }),
  call: async ({ name }, _platform, context) => ({
    greeting: `Hello, ${name}!`,
    toolCallId: context.toolCallId,
  }),
});
```

Schemas are serialized as JSON Schema 7 and validated before classification, approval, or execution. Unknown tools, malformed JSON, invalid input, classifier failures, approval failures/denials, and thrown calls become call-local `tool_result` event errors. If a successful result cannot be serialized, the yielded event retains its original `isError` value while only the provider-facing `ToolResultBlock` becomes `is_error: true` with the serialization error message.

`ToolCallContext` is extensible through declaration merging and currently carries `signal?`, per-call `toolCallId?`, `emitEvent?`, `reportUsage?`, and recursion `depth?`. The runtime shallow-clones it for each executable call and isolates core attribution buffers. Custom declaration-merged referenced objects are not deep-cloned.

A concurrency classifier is called after validation and before approval. It must be pure, deterministic, synchronous, and side-effect-free. Returning `true` certifies that the call can overlap other marked-safe calls, including use of referenced context state and the injected Platform. Missing/`false` is a sequential barrier. Throwing produces an error barrier and skips approval and execution.

### Built-ins

| Export / wire name | Behavior | Initially concurrency-safe |
|---|---|---|
| `readFileTool` / `read_file` | Read a whole file or a 1-based `offset`/`limit` line range. | Yes |
| `writeFileTool` / `write_file` | Replace a file or a line range. | No |
| `bashTool` / `bash` | Execute a shell command with timeout and cancellation forwarding. | No |
| `editFileTool` / `edit_file` | Exact unique replacement, optional `replace_all`, or create with empty `old_string`. | No |
| `lsTool` / `ls` | List immediate directory entries, capped at 250 by default. | Yes |
| `globTool` / `glob` | Discover files with hidden/gitignore controls and a default 250 cap. | Yes |
| `grepTool` / `grep` | Regex search in files, content, or count mode with context and output caps. | Yes |
| `createTaskTool(...)` / `task` | Build a host-configured child Agent and return its summary. | No; always sequential |

### Task factory

`createTaskTool({ resolveChild, name?, maxDepth? })` creates a Task tool. `resolveChild(spec)` is mandatory and owns the child provider, model, tools, prompt, approval policy, Platform, and turn budget. Omit Task from child tool sets as the primary recursion bound; `maxDepth` defaults to 1 as a numeric backstop. Child events are sanitized, buffered, and emitted before that Task call's result, and child usage is rolled into the parent terminal usage.

Task calls remain sequential. Concurrent Task requires a separate design for real-time child events, usage attribution, and cancellation behavior; marking Task safe is not supported by the built-in factory.

## Platform

`Platform` is the environment and path-grammar boundary. The main entry imports no Node built-ins; import `NodePlatform` explicitly from `tiny-agentic/platform/node` for Node applications.

```typescript
interface Platform {
  resolvePath(path: string): string;
  formatPath(path: string): string;
  cwd(): string;
  readFile(path: string, encoding?: "utf-8"): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  listDir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<DirEntry>;
  glob(pattern: string, options?: GlobOptions): Promise<GlobResult>;
  grep(pattern: string, flags: string, options?: GrepOptions): Promise<GrepPlatformResult>;
}
```

`ExecOptions` supports `cwd`, `timeout`, `env`, `shell`, and `signal`; `ExecResult` is `{ stdout, stderr, exitCode }`. Discovery types are `DirEntry`, `GlobOptions`/`GlobResult`, and `GrepOptions`/`GrepPlatformResult` with `GrepMatch`.

Path grammar belongs to each Platform, not to core. `resolvePath` interprets model paths against that Platform's cwd. `formatPath` emits `.` for cwd, a cwd-relative value for descendants, and the canonical absolute form outside cwd. `ls`, `glob`, and `grep` delegate resolution and formatting rather than parsing paths themselves.

Platform also owns discovery order. `listDir` entries and `glob` paths are already in display order; `grep` files follow that order and matches are grouped by file then ascending line. Tools preserve the supplied order while formatting and capping. `NodePlatform` uses native host path semantics, modification-time-descending production order with ascending code-unit tie-breaks, and deterministic ascending name/path order under `NODE_ENV=test`.

## Safe batches, barriers, and ordering

Within one model turn, maximal contiguous groups of approved calls whose classifiers return `true` start together. There is no framework concurrency cap in this release. Approvals remain serial and in model order. The runtime waits for every started sibling to settle, then yields child events, tool results, serialized result blocks, and reported usage in original model-call order, regardless of completion order.

Unknown, malformed, invalid, classifier-failed, denied, approval-failed, unmarked, and explicitly unsafe calls are barriers. All preceding safe work settles and is yielded before a barrier runs or yields; no following call is prepared or started until the barrier is complete. `write_file`, `edit_file`, `bash`, and Task therefore never overlap adjacent batches.

## Usage

`Usage` always includes `inputTokens`, `outputTokens`, and `cacheReadTokens`; `cacheWriteTokens` is optional. `turn_complete.usage`, when present, describes that provider turn. Terminal event/`Terminal` usage is cumulative and includes usage reported by child Task runs. Child usage is also available on child terminal events; provider semantics can differ when a child uses another provider.

`EMPTY_USAGE` is an immutable zero value. `mergeUsage` combines partial usage events for one model response; `accumulateUsage` sums completed usage into a run total.

## Cancellation

Pass `agent.run(prompt, { signal })`. Breaking a `for await` loop aborts the run's internal controller at the next generator suspension point; use the external signal when prompt interruption of an awaited tool or Task child is required.

After abort is observed, no new tool work starts. Every active call receives the shared signal through its isolated context, all already-started calls are awaited, and every remaining provider tool-use receives an ordered cancellation result so message pairing stays valid. `glob`, `grep`, `bash`, and providers can forward or cooperatively check the signal. The `Platform.readFile` and `Platform.listDir` signatures are signal-free, so an in-flight `read_file` or `ls` syscall may finish before settling. Cancellation does not create a stop reason; subsequent aborted provider work follows `agent_error` behavior.

## Utilities

```typescript
import { collectEvents, collectText } from "tiny-agentic/utils";

const text = await collectText(agent.run("Say hi."));
const { events, terminal } = await collectEvents(agent.run("Say hi."));
```

## Scope

The core intentionally has no UI, sessions, memory, skills, MCP integration, sandbox policy engine, or rich permission-rule language. These belong in packages layered over the typed core contracts.

## License

MIT

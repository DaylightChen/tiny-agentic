# tiny-agentic — Engineering Spec

**Date:** 2026-06-27
**Milestone:** 1 — the `tiny-agentic` core package
**Status:** Canonical engineering spec. Input to the planning phase.

---

## 1. Repository / Monorepo Layout

### 1.1 Workspace tooling

**Choice: pnpm workspaces** (no Turborepo or Nx in M1).

Justification: pnpm workspaces give strict package isolation (symlinked node_modules that cannot accidentally traverse packages), enforce the one-way dependency rule via declared `dependencies` in each `package.json`, run faster than npm workspaces for the same graph, and require zero additional tooling for M1's two-package build. Turborepo/Nx would add config overhead with no payback until there are parallel multi-package builds (M2+). Yarn Classic is deprecated; Yarn Berry requires `.yarnrc.yml` ceremony. pnpm is the lowest-friction choice that still enforces hard boundaries.

### 1.2 Root layout

```
tiny-agentic/                      ← repo root
  pnpm-workspace.yaml              ← declares packages: ['packages/*']
  package.json                     ← root (private: true, scripts: build/test/lint/typecheck)
  tsconfig.base.json               ← shared TS base (strict, ESM, Node >= 22 target, skipLibCheck:true)
  .node-version                    ← 22.x (Active/Maintenance LTS floor; also .nvmrc alias)
  .npmrc                           ← shamefully-hoist=false (strict isolation)

  packages/
    core/                          ← tiny-agentic (M1 — fully implemented)
    sdk/                           ← agent-sdk (M1 — empty placeholder)
    ui/                            ← tiny-agentic-ui (M1 — empty placeholder)

  examples/                        ← throwaway driver scripts (not published)
  docs/                            ← project docs (not published)
```

### 1.3 Package identity

| Directory | `name` in package.json | `version` | M1 state |
|-----------|------------------------|-----------|-----------|
| `packages/core` | `tiny-agentic` | `0.1.0` | fully implemented |
| `packages/sdk` | `tiny-agentic-sdk` | `0.0.0` | placeholder (`index.ts` with one `// TODO` comment) |
| `packages/ui` | `tiny-agentic-ui` | `0.0.0` | placeholder |

### 1.4 One-way dependency enforcement

Package `package.json` `dependencies` are the only mechanism:

- `packages/sdk/package.json` lists `"tiny-agentic": "workspace:*"` as a dependency.
- `packages/ui/package.json` lists `"tiny-agentic-sdk": "workspace:*"` as a dependency.
- `packages/core/package.json` lists **no** workspace dependencies.

pnpm's module resolution will prevent `packages/core` from importing `packages/sdk` at runtime (no symlink exists), and TypeScript project references (`references` in `tsconfig.json`) are set up to match — the core's `tsconfig.json` has no `references` entry pointing to sdk or ui.

A lint rule provides a lint-time check on top of the structural enforcement: the core package emits an error if it imports from `tiny-agentic-sdk` / `tiny-agentic-ui`, or from a Node built-in / bare `process` outside `platform/node.ts`. The concrete flat-config `eslint.config.js` (root + per-package `no-restricted-imports` / `no-restricted-globals` rules) is given in the code-architecture doc (§ "ESLint — boundary & purity enforcement"); it backs success criteria 7.11 and 7.12.

### 1.5 Node version and module system

- **Node:** `>=22.0.0` (required in `packages/core/package.json` `engines` field). Node 18 (EOL April 2025) and Node 20 (EOL April 2026) are both end-of-life as of this spec's date (2026-06); Node 22 is the lowest LTS line still receiving security support, so it is the M1 floor. See `docs/decisions.md` "skipLibCheck + @types/node pinned to the runtime floor".
- **Module system:** ESM throughout. `"type": "module"` in every `package.json`. All imports use the `.js` extension (TypeScript's ESM transpile convention). No CommonJS.
- **TypeScript `target`:** `ES2022` (Node 22 supports all ES2022 features natively; async generators and `using` declarations are not needed from `lib` polyfills).
- **`moduleResolution`:** `Node16` (validates `.js` extension in imports, required for ESM/TS correctness).
- **`@types/node`:** pinned to `^22` (the runtime floor) as a devDependency. Supplies the ambient `AbortSignal` type used by `Provider.stream(request, signal?)`, which is not in `lib: ["ES2022"]`.
- **`skipLibCheck: true`** in `tsconfig.base.json` — idiomatic for a TS library: `tsc` fully checks our own `src/` but does not type-check third-party bundled `.d.ts` (e.g. vite's, pulled transitively via vitest, which reference globals absent from a runtime-accurate `@types/node@22`). Without it, a correct `@types/node@22` fails typecheck on those foreign declarations while a too-new `@types/node` would type the core against a Node newer than the supported runtime. This is what makes `pnpm -r typecheck` pass with a runtime-accurate `@types/node`. See the decision log entry above.

### 1.6 Build tool

**Choice: `tsup`** (esbuild-backed).

Justification: `tsup` produces both declaration files (`.d.ts`) and compiled output in one command, handles multiple entry points (the `exports` map) without manual esbuild config, and is the standard tool for TypeScript library packaging. Raw `tsc` produces no bundles and is slow for watch mode; raw esbuild requires manual `.d.ts` generation. Rollup adds plugin complexity with no benefit at this scale.

Each package runs `tsup` from its own directory. The root `package.json` has a `build` script that calls `pnpm -r build` (recursive).

**Shared tsconfig:**

```
tsconfig.base.json (root)
  └── packages/core/tsconfig.json   (extends ../../tsconfig.base.json)
  └── packages/sdk/tsconfig.json    (extends ../../tsconfig.base.json)
  └── packages/ui/tsconfig.json     (extends ../../tsconfig.base.json)
```

The base sets: `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`, `"target": "ES2022"`, `"module": "Node16"`, `"moduleResolution": "Node16"`, `"types": ["node"]`, `"skipLibCheck": true`, `"declaration": true`, `"declarationMap": true`, `"sourceMap": true`, `"outDir": "dist"`. (`skipLibCheck: true` and the `@types/node@22` pin are explained in §1.5; the full base config is in the code-architecture doc.)

**`exactOptionalPropertyTypes` ergonomics:** With this flag enabled, TypeScript distinguishes between a property being absent and a property being explicitly set to `undefined`. Where a callee's interface declares an optional property as `T` (not `T | undefined`), you cannot pass `key: undefined` — even if `key` is typed as `T | undefined`. The safe pattern is conditional spread: `...(value !== undefined ? { key: value } : {})`. This appears in the codebase wherever an optional value is forwarded to a third-party API (e.g., `baseURL` in `AnthropicProvider`, `cwd`/`env` in `ExecOptions`). Implementers must use the conditional-spread pattern rather than `key: optionalValue` for any optional field.

### 1.7 Test runner

**Choice: Vitest.**

Justification: Vitest runs TypeScript natively via Vite's transform pipeline (no separate `ts-node` or `tsx` invocation), supports ESM modules without the `--experimental-vm-modules` flag ceremony that Jest requires, and has a Jest-compatible assertion API for low migration cost later. The watch mode and parallel-by-default execution make feedback fast. `ts-jest` is not needed.

Test files live in `packages/core/src/**/*.test.ts`. The `vitest.config.ts` in `packages/core/` enables `globals: false` (explicit imports) and sets `testEnvironment: 'node'`.

---

## 2. Core Package Internal Architecture

### 2.1 Module map

```
packages/core/
  src/
    index.ts                    ← public re-exports (Agent, Tool, ToolCallContext,
    |                              defineTool, AgentEvent, Terminal, Platform, Provider,
    |                              Message, collectText, collectEvents,
    |                              readFileTool, writeFileTool)
    |
    agent.ts                    ← Agent class (constructor + run() generator)
    |
    loop/
      loop.ts                   ← agentLoop() — the inner turn-loop generator (yield* from run())
      runTools.ts                ← runTools() — sequential tool execution, the concurrency seam
    |
    types/
      events.ts                  ← AgentEvent union + Terminal type
      messages.ts                ← Message type (canonical; maps to Anthropic message shape)
      tool.ts                    ← Tool<TInput> interface + ToolCallContext interface
      provider.ts                ← Provider interface + ProviderRequest + ProviderEvent + ToolSchema
      platform.ts                ← Platform interface + ExecOptions + ExecResult
    |
    providers/
      anthropic.ts               ← AnthropicProvider class
      anthropic-mapper.ts        ← maps ProviderRequest → Anthropic API params;
      |                              maps Anthropic stream events → ProviderEvent
      retry.ts                   ← exponential backoff + error classification (shared util)
    |
    platform/
      node.ts                    ← NodePlatform class (implements Platform)
    |
    env/
      context.ts                 ← buildEnvContext(platform) → string (cwd, date, git)
    |
    tools/
      registry.ts                ← ToolRegistry class (lookup by name, serialize to ToolSchema[])
    |
    utils/
      collect.ts                 ← collectText(gen), collectEvents(gen)
      serialize.ts               ← serializeToolResult(result): string
    |
    __tests__/                   ← test files (*.test.ts)
      agent.test.ts
      loop.test.ts
      runTools.test.ts
      anthropic-mapper.test.ts
      env-context.test.ts
      collect.test.ts

  package.json
  tsconfig.json
  tsup.config.ts
  vitest.config.ts
```

### 2.2 Exports map (`packages/core/package.json` `exports` field)

```json
{
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./providers/anthropic": {
      "import": "./dist/providers/anthropic.js",
      "types": "./dist/providers/anthropic.d.ts"
    },
    "./platform/node": {
      "import": "./dist/platform/node.js",
      "types": "./dist/platform/node.d.ts"
    },
    "./utils": {
      "import": "./dist/utils/collect.js",
      "types": "./dist/utils/collect.d.ts"
    }
  }
}
```

### 2.3 Module dependency direction

The internal modules form a strict DAG. No cycles are permitted. The allowed edges are:

```
index.ts
  → agent.ts
  → types/*
  → utils/collect.ts

agent.ts
  → loop/loop.ts
  → types/*
  → tools/registry.ts
  → env/context.ts

loop/loop.ts
  → loop/runTools.ts
  → types/*

loop/runTools.ts
  → types/tool.ts
  → types/messages.ts
  → utils/serialize.ts

tools/registry.ts
  → types/tool.ts
  → types/provider.ts   (for ToolSchema serialization)

env/context.ts
  → types/platform.ts

providers/anthropic.ts
  → providers/anthropic-mapper.ts
  → types/provider.ts
  (retry.ts is NOT imported by anthropic.ts — retry is handled by the SDK)

providers/retry.ts
  → types/provider.ts  (for Logger type only)

platform/node.ts
  → types/platform.ts

(types/* modules have no intra-package imports beyond other types/*)
```

No module in `src/` (except `platform/node.ts`) imports `fs`, `path`, `child_process`, or any Node built-in, or references `process`. The `platform/node.ts` module is the sole location where Node-specific APIs and globals are used.

---

## 3. Public Interfaces

All types below are definitive. These are the contracts that the planning phase will implement.

### 3.1 `Message` — canonical message type

```ts
// types/messages.ts

export type TextBlock = {
  type: "text";
  text: string;
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

// A single content block in any message
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

// Canonical message shape — isomorphic with Anthropic's MessageParam
// but expressed in our own types (no @anthropic-ai/sdk dependency in core types)
export type Message =
  | { role: "user";      content: string | ContentBlock[] }
  | { role: "assistant"; content: string | ContentBlock[] };
```

The `Message` type is intentionally shaped to be structurally compatible with Anthropic's `MessageParam` — the `anthropic-mapper.ts` can cast without transformation. OpenAI's chat messages differ in role names (`assistant` vs `user` are shared, but tool roles differ); the mapper is responsible for the translation when OpenAI lands in M2.

### 3.2 `Platform` — the environment capability interface

```ts
// types/platform.ts

export type ExecOptions = {
  cwd?: string;
  timeout?: number;  // milliseconds; no default in M1
  env?: Record<string, string>;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export interface Platform {
  /** Returns the current working directory. The only place process.cwd() is called is NodePlatform. */
  cwd(): string;
  readFile(path: string, encoding?: "utf-8"): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}
```

This is the complete M1 method set: `cwd`, `readFile`, `writeFile`, `exec`. `cwd()` is required by `buildEnvContext` to obtain the working directory without touching `process`; `exec` is used by the same function for git commands; `readFile` and `writeFile` back the two built-in tools shipped in M1. Additional methods (`glob`, `listDir`, etc.) are added in M2 as more built-in tools are defined; the interface is additive (implementing classes will need to add methods — this is acceptable because `NodePlatform` is the only implementation in M1, and mock implementations in tests implement the interface directly and will break compile if the interface changes, which is the desired early-warning signal).

`NodePlatform` (in `platform/node.ts`) implements these with:
- `cwd` → `process.cwd()` (the only place `process` appears in the entire core)
- `readFile` → `fs/promises.readFile`
- `writeFile` → `fs/promises.writeFile`
- `exec` → `node:child_process` `execFile` wrapped with Promise, respecting `timeout`

### 3.3 `ToolCallContext` — the SDK extension seam

**Resolution: TypeScript interface merging.**

The context object is defined as an interface (not a type alias) in `types/tool.ts`. The SDK layer adds its own fields by placing a `declare module 'tiny-agentic'` block in its package that reopens the interface:

```ts
// types/tool.ts  (in core)
export interface ToolCallContext {
  // Empty in M1. Reserved for the SDK to extend.
  // The interface is deliberately open — the SDK merges fields here.
}
```

Why interface merging over a generic parameter:

- A generic `Tool<TInput, TContext extends ToolCallContext>` would require every `Tool[]` array at the call site to share the same `TContext` bound, forcing the `Agent` class to be generic over the context type too — which bleeds the SDK type into the core's `Agent` constructor and breaks the one-way dependency.
- Interface merging lets the SDK widen `ToolCallContext` globally without any core type change. The core constructs a `{}` object cast to `ToolCallContext` and passes it to `call`; the SDK fields are not present in M1 but the type is compatible (the SDK's tools will declare them as optional or with defaults).
- The downside (interface merging is ambient, not scoped) is acceptable: `ToolCallContext` is the only interface we intentionally open; we document it as a stable extension point.

The engine constructs `ToolCallContext` as a plain object per tool call. In M1, it is `{}`. The SDK is responsible for constructing a richer object when it wraps `Agent`.

### 3.4 `Tool` — the tool interface

```ts
// types/tool.ts

import type { ZodType, z } from "zod";
import type { Platform } from "./platform.js";

export interface ToolCallContext {
  // Intentionally empty in M1.
  // SDK extends this via TypeScript declaration merging.
}

export interface Tool<TInput extends ZodType = ZodType> {
  name: string;
  description: string;
  inputSchema: TInput;
  call(
    input: z.infer<TInput>,
    platform: Platform,
    context: ToolCallContext,
  ): Promise<unknown>;
  // Reserved for M2 concurrency optimization — not called in M1
  isConcurrencySafe?(input: z.infer<TInput>): boolean;
}
```

The generic `TInput` is bounded by `ZodType`. The `inputSchema` is the Zod schema that the registry serializes and that the engine validates against before calling `call`. `zod` is a peer dependency of `tiny-agentic`; it is not bundled.

The `call` signature has `platform` and `context` as required parameters. Tool authors that do not need them can name them `_platform` and `_context` (TypeScript does not require using all parameters). Making them required rather than optional means the type system enforces that a tool author was at least aware of them — a form of documentation.

**`defineTool` helper — type-safe tool authoring.** Writing `const myTool: Tool = { ... }` collapses `TInput` to `ZodType`, making `input` inside `call` typed as `unknown`. The `defineTool<S extends ZodType>(t: Tool<S>): Tool<S>` helper (exported from the main entry point) lets TypeScript infer `S` from the literal `inputSchema`, so `input` in `call` is fully typed. A specific `Tool<S>` remains assignable to `Tool[]` (and thus to `Tool<ZodType>`) because `call` uses method syntax which TypeScript treats bivariantly — do not rewrite builtins to function-property syntax or this assignment will fail. A raw object literal annotated `: Tool` still compiles and works correctly at runtime; it only loses the narrowed `input` type. The two built-in tools (`readFileTool`, `writeFileTool`) use `defineTool` as the canonical example.

### 3.5 `ToolSchema` — the serialized tool shape sent to providers

```ts
// types/provider.ts

// The serialized shape sent in a ProviderRequest.
// Produced by the ToolRegistry from a Tool's Zod inputSchema (via zod-to-json-schema).
// The provider adapters translate this to the API-specific wire format.
export type ToolSchema = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;  // allows JSON Schema extensions
  };
};
```

`ToolSchema.inputSchema` is the JSON Schema output of `zodToJsonSchema(tool.inputSchema, { target: "openApi3", $refStrategy: "none" })`. Using `openApi3` target produces cleaner schemas than the JSON Schema 7 default and is accepted by both Anthropic and OpenAI APIs without modification. `$refStrategy: "none"` inlines all `$ref` definitions so providers receive a self-contained schema — providers do not resolve `$ref`s.

### 3.6 `ProviderRequest`, `ProviderEvent`, `Provider`

```ts
// types/provider.ts

export type ProviderRequest = {
  systemPrompt: string;
  messages: Message[];
  tools: ToolSchema[];
  maxTokens?: number;         // defaults to 32000 in AnthropicProvider if not set
};

export type ProviderEvent =
  | { type: "text_delta";    text: string }
  | { type: "tool_use";      id: string; name: string; input: unknown; inputParseError?: boolean }
  | { type: "message_stop";  stopReason: "end_turn" | "tool_use" | "max_tokens" | string };

export interface Provider {
  /**
   * Stream a single model call. Yields ProviderEvents until message_stop.
   * Retry logic (on 429/5xx) is the provider's responsibility.
   * Errors that survive retries are thrown; the agent loop catches them.
   *
   * @param request - The model request (system prompt, messages, tools). Pure data.
   * @param signal - Optional AbortSignal. Abort cancels the in-flight request.
   *                 Passed as a second argument (not part of ProviderRequest) to
   *                 keep ProviderRequest a pure, serializable data type.
   */
  stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent>;
}
```

The `Provider` interface uses `AsyncGenerator<ProviderEvent>` with no return type (the `void` default). The engine collects events and does not need a typed return from the provider generator. The `AbortSignal` is the second argument — not a field on `ProviderRequest` — because it is operational context created per `run()` call, not part of the model's input. This matches the browser `fetch(url, { signal })` convention.

`stopReason` is a string to accommodate provider-specific values without forcing the core to know about them. The engine checks only `=== "tool_use"` vs. anything else to decide whether to loop; no other `stopReason` affects the loop logic.

### 3.7 `AgentEvent` union

```ts
// types/events.ts

import type { Message } from "./messages.js";

export type AgentEvent =
  | { type: "text_delta";         text: string }
  | { type: "tool_use_start";     toolName: string; toolInput: unknown }
  | { type: "tool_result";        toolName: string; toolCallId: string; result: unknown; isError: boolean }
  | { type: "turn_complete";      turnIndex: number }
  | { type: "agent_done";         messages: Message[] }
  | { type: "max_turns_exceeded"; turnsUsed: number; messages: Message[] }
  | { type: "agent_error";        error: Error; messages: Message[] };
```

The union is discriminated by `type`. The three terminal events (`agent_done`, `max_turns_exceeded`, `agent_error`) all carry `messages: Message[]` so that a `for await` consumer can thread history without capturing the generator's return value.

### 3.8 `Terminal` — generator return type

```ts
// types/events.ts

import type { Message } from "./messages.js";

export type Terminal =
  | { reason: "agent_done";         messages: Message[] }
  | { reason: "max_turns_exceeded"; messages: Message[]; turnsUsed: number }
  | { reason: "agent_error";        messages: Message[]; error: Error };
```

The generator `run()` has signature `AsyncGenerator<AgentEvent, Terminal>`. The `Terminal` carries the same data as the terminal `AgentEvent` — yielding the terminal event first, then returning the equivalent `Terminal`, ensures both `for await` consumers and `.next()`-driving consumers get the information.

### 3.9 `Agent` class

```ts
// agent.ts

import type { Provider } from "./types/provider.js";
import type { Tool } from "./types/tool.js";
import type { Platform } from "./types/platform.js";
import type { AgentEvent, Terminal } from "./types/events.js";
import type { Message } from "./types/messages.js";

export type AgentOptions = {
  provider: Provider;
  tools: Tool[];
  platform: Platform;
  systemPrompt?: string;    // developer-supplied portion; env context prepended by engine
  maxTurns?: number;        // default: 25
};

export type RunOptions = {
  messages?: Message[];     // prior conversation history; not mutated
};

export class Agent {
  constructor(options: AgentOptions);

  /**
   * Run the agent on a single user prompt.
   *
   * Yields typed AgentEvents as the agent streams, calls tools, and completes.
   * The final event (agent_done | max_turns_exceeded | agent_error) carries the
   * final message list; pass it as the `messages` option on the next call for
   * multi-turn continuity. The generator also returns an equivalent Terminal for
   * callers driving .next().
   *
   * The agent is stateless: no history is held between calls. The caller is
   * responsible for threading the message list to achieve continuity.
   *
   * @param prompt - The user's message to the agent.
   * @param options.messages - Prior conversation history (optional). Not persisted.
   * @yields AgentEvent
   * @returns Terminal
   */
  run(prompt: string, options?: RunOptions): AsyncGenerator<AgentEvent, Terminal>;
}
```

`run()` is an `async function*` method. The `AgentOptions` are captured at construction; each `run()` call is independent and creates its own working copy of the message list.

### 3.10 `collectText` and `collectEvents`

```ts
// utils/collect.ts

import type { AgentEvent, Terminal } from "../types/events.js";

/**
 * Collect all text_delta events into a single string.
 * Drives the generator to completion and discards the Terminal return.
 */
export async function collectText(
  gen: AsyncGenerator<AgentEvent, Terminal>,
): Promise<string>;

/**
 * Collect all events into an array, in order.
 * Returns both the events and the Terminal.
 */
export async function collectEvents(
  gen: AsyncGenerator<AgentEvent, Terminal>,
): Promise<{ events: AgentEvent[]; terminal: Terminal }>;
```

### 3.11 `LogEntry` — provider logger type

```ts
// types/provider.ts

export type LogEntry =
  | { level: "info";  event: "request_sent";   request: ProviderRequest }
  | { level: "info";  event: "retry_attempt";  attempt: number; delayMs: number; error: Error }
  | { level: "error"; event: "request_failed"; error: Error };

export type Logger = (entry: LogEntry) => void;
```

### 3.12 `AnthropicProvider` — class signature

```ts
// providers/anthropic.ts

import type { Provider } from "../types/provider.js";
import type { Logger } from "../types/provider.js";

export type AnthropicProviderOptions = {
  apiKey: string;
  model: string;
  maxRetries?: number;   // default: 3
  baseURL?: string;
  maxTokens?: number;    // default: 32000; overridden per-request by ProviderRequest.maxTokens
  logger?: Logger;
};

export class AnthropicProvider implements Provider {
  constructor(options: AnthropicProviderOptions);
  stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent>;
}
```

`AnthropicProvider` imports `@anthropic-ai/sdk` internally. The `@anthropic-ai/sdk` package is an **optional peer dependency** of `packages/core` (`peerDependencies` + `peerDependenciesMeta.optional: true`) — see the package.json in the code-architecture doc. The core `index.ts` does NOT import from `providers/anthropic.ts` — consumers import it from `tiny-agentic/providers/anthropic` directly. This keeps the main entry point free of the Anthropic SDK import, so an OpenAI-only consumer is unaffected and gets no install warning.

---

## 4. Agent Loop Control Flow

The following is a precise step-by-step description of one `run(prompt, { messages? })` invocation. This maps 1:1 to the implementation in `agent.ts` and `loop/loop.ts`.

### 4.1 Setup (in `agent.ts`, before the loop)

```
1. Create AbortController (abortCtrl).
2. Build the working message list:
     workingMessages = [...(options.messages ?? []),
                        { role: "user", content: prompt }]
3. Build the env context string:
     envCtx = await buildEnvContext(this.platform)
       // calls platform.exec("git rev-parse ...") etc.; failures silently omitted
4. Build the combined system prompt:
     systemPrompt = envCtx + (this.systemPrompt ? "\n\n" + this.systemPrompt : "")
5. Build the ToolRegistry from this.tools.
6. Serialize tools to ToolSchema[]:
     toolSchemas = registry.toSchemas()
7. Initialize: turnIndex = 0, turnsUsed = 0
8. Wrap the generator body in try/finally:
     finally: abortCtrl.abort()   // cancels any in-flight stream on abandonment (6.9)
```

### 4.2 Turn loop (in `loop/loop.ts`, via `yield*`)

The outer generator (`agent.ts`) delegates to `agentLoop()` via `yield*`. This mirrors the reference's `query()` → `queryLoop()` delegation pattern.

The `ToolCallContext` is constructed once at the start of the loop (`context: ToolCallContext = {}`) and passed to every `runTools` call in the same `run()` invocation.

```
// context is constructed once per run(), before the while(true) loop:
context: ToolCallContext = {}

LOOP:
  // Guard
  if turnsUsed >= maxTurns:
    yield { type: "max_turns_exceeded", turnsUsed, messages: workingMessages }
    return { reason: "max_turns_exceeded", turnsUsed, messages: workingMessages }

  // API call
  textChunks = []
  pendingToolUses = []    // accumulated during streaming

  try:
    for await event of provider.stream(
      { systemPrompt, messages: workingMessages, tools: toolSchemas },
      signal,
    ):
      if event.type === "text_delta":
        textChunks.push(event.text)
        yield { type: "text_delta", text: event.text }

      else if event.type === "tool_use":
        pendingToolUses.push({ id: event.id, name: event.name, input: event.input })
        yield { type: "tool_use_start", toolName: event.name, toolInput: event.input }

      // message_stop consumed but not yielded

  catch err:
    yield { type: "agent_error", error: err, messages: workingMessages }
    return { reason: "agent_error", error: err, messages: workingMessages }

  // Accumulate assistant turn into working messages
  assistantContent = []
  if textChunks.length > 0:
    assistantContent.push({ type: "text", text: textChunks.join("") })
  for tu of pendingToolUses:
    assistantContent.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input })
  // Skip empty assistant turns (no text, no tools — e.g. a refusal): pushing
  // { content: [] } would make the returned history invalid if the caller
  // threads it into a later run() (the API rejects empty content arrays).
  if assistantContent.length > 0:
    workingMessages.push({ role: "assistant", content: assistantContent })

  turnsUsed++

  // Tool execution
  if pendingToolUses.length > 0:
    toolResultBlocks = []
    for await toolResultEvent of runTools(pendingToolUses, registry, platform, context):
      yield toolResultEvent   // { type: "tool_result", ... }
      if toolResultEvent.type === "tool_result":
        // Serialize defensively: a successful tool may return an unserializable
        // value (circular ref, BigInt). Catch here so it becomes a recoverable
        // tool error (§5.6) rather than a throw out of the generator. runTools
        // itself never throws (each tool.call is individually try/caught), so
        // this is the only throw site in the tool-execution phase.
        try:
          content = serializeToolResult(toolResultEvent.result)
          isError = toolResultEvent.isError
        catch err:
          content = `Tool '${toolResultEvent.toolName}': could not serialize result — ${err.message}`
          isError = true
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: toolResultEvent.toolCallId,
          content,
          is_error: isError
        })

    // Bundle all tool results as a user message (Anthropic API requires this shape)
    workingMessages.push({ role: "user", content: toolResultBlocks })

    yield { type: "turn_complete", turnIndex }
    turnIndex++
    // loop back to LOOP
  else:
    // Natural completion — no tool calls in this turn
    yield { type: "turn_complete", turnIndex }
    yield { type: "agent_done", messages: workingMessages }
    return { reason: "agent_done", messages: workingMessages }
```

### 4.3 `runTools()` — sequential tool execution

Located in `loop/runTools.ts`. This is an async generator that yields `AgentEvent` tool_result events.

```
async function* runTools(
  toolUseBlocks: { id: string; name: string; input: unknown }[],
  registry: ToolRegistry,
  platform: Platform,
  context: ToolCallContext,
): AsyncGenerator<AgentEvent>

FOR EACH toolUseBlock in toolUseBlocks (sequential — M1):

  tool = registry.findByName(toolUseBlock.name)
  if tool === undefined:
    yield {
      type: "tool_result",
      toolName: toolUseBlock.name,
      toolCallId: toolUseBlock.id,
      result: `Unknown tool: '${toolUseBlock.name}'`,
      isError: true
    }
    continue

  // Zod validation
  parseResult = tool.inputSchema.safeParse(toolUseBlock.input)
  if !parseResult.success:
    yield {
      type: "tool_result",
      toolName: tool.name,
      toolCallId: toolUseBlock.id,
      result: `Tool '${tool.name}': invalid input — ${parseResult.error.message}`,
      isError: true
    }
    continue

  // Execute
  try:
    result = await tool.call(parseResult.data, platform, context)
    yield {
      type: "tool_result",
      toolName: tool.name,
      toolCallId: toolUseBlock.id,
      result,
      isError: false
    }
  catch err:
    yield {
      type: "tool_result",
      toolName: tool.name,
      toolCallId: toolUseBlock.id,
      result: err instanceof Error ? err.message : String(err),
      isError: true
    }
```

**The concurrency seam:** In M2, this function will check `tool.isConcurrencySafe?.(input)` and batch the safe calls into a `Promise.all`. In M1, there is no `Promise.all` — everything is `await` in a `for...of` loop. The seam exists because the function is already isolated and the calling code already iterates its yielded results — no loop restructuring is required for M2.

### 4.4 AbortController wiring (edge case 6.9)

The `AbortController` is created in `agent.run()` before the loop. The `abortCtrl.signal` is passed as the second argument to `provider.stream(request, signal)` (see §3.6). The `finally` block in the generator calls `abortCtrl.abort()`. This means:

- If the `for await` caller breaks early (abandons the generator), JavaScript calls `.return()` on the generator, which triggers `finally`.
- `finally` calls `abort()`, which cancels the in-flight HTTP request inside the provider via `AbortSignal`.
- The provider's `stream()` generator detects the abort and exits (the `@anthropic-ai/sdk` stream respects `AbortSignal`).

The `AbortSignal` is the second argument to `stream()`, not a field on `ProviderRequest`, to keep `ProviderRequest` a pure, serializable data type. The signal is operational context created per `run()` call, not part of the model's input.

---

## 5. Anthropic Provider Design

### 5.1 Request mapping (`anthropic-mapper.ts`)

`ProviderRequest` → Anthropic `Messages.MessageCreateParamsStreaming`:

```
// max_tokens precedence: per-request override → provider default → hardcoded floor.
// The provider resolves (options.maxTokens ?? 32000) into `this.maxTokens` at
// construction and passes it to mapRequest as defaultMaxTokens; the mapper then
// applies (request.maxTokens ?? defaultMaxTokens). The Anthropic Messages API
// REQUIRES max_tokens, so ProviderRequest.maxTokens stays optional while the
// provider always sends a concrete value. Default = 32000 (see decisions log
// "maxTokens default = 32000").
anthropicParams = {
  model:      options.model,
  max_tokens: request.maxTokens ?? this.maxTokens,   // this.maxTokens = options.maxTokens ?? 32000
  system:     request.systemPrompt,
  messages:   mapMessages(request.messages),
  tools:      mapTools(request.tools),
  stream:     true,
}

mapMessages(messages: Message[]): Anthropic.MessageParam[]
  // Message is structurally compatible with MessageParam for user/assistant roles
  // with text blocks. ToolUseBlock and ToolResultBlock map directly.
  // Cast with minor field renaming (is_error → is_error: already matches).

mapTools(schemas: ToolSchema[]): Anthropic.Tool[]
  // ToolSchema.inputSchema → { type: "object", ... } maps to Anthropic's
  // input_schema: { type: "object", ... } directly.
  return schemas.map(s => ({
    name: s.name,
    description: s.description,
    input_schema: s.inputSchema,
  }))
```

### 5.2 Stream event translation (`anthropic-mapper.ts`)

```
Anthropic stream event → ProviderEvent:

message_start          → (ignored; could extract usage in M2 for cost tracking)
content_block_start    → if type=tool_use: begin accumulating tool input for this id
content_block_delta:
  text_delta           → ProviderEvent { type: "text_delta", text: delta.text }
  input_json_delta     → accumulate into currentToolInput[blockIndex]
content_block_stop:
  if block was tool_use:
    finish = accumulator.finishBlock(index)   // discriminated result
    if finish.kind === "ok":
      yield ProviderEvent { type: "tool_use", id, name, input: finish.input }
    else: // finish.kind === "parse_error"
      yield ProviderEvent { type: "tool_use", id, name, input: {}, inputParseError: true }
        // input is a serializable placeholder {}; the parse-error signal rides on
        // the inputParseError boolean (see below)
message_delta          → if delta.stop_reason: accumulator.setStopReason(delta.stop_reason)
message_stop           → yield ProviderEvent { type: "message_stop", stopReason: accumulator.takeStopReason() }
                          // takeStopReason() returns the cached reason, defaulting to "end_turn"
```

The `input_json_delta` accumulation is done per content block index, since a single turn can have multiple tool_use blocks streaming concurrently. The `InputAccumulator` maintains a `Map<number, { id, name, json }>` (block index → tool identity + accumulated JSON string) and flushes at `content_block_stop` via `finishBlock(index)`, which returns a **discriminated result**. The same accumulator also **caches the `stop_reason`**: it reads `stop_reason` off the `message_delta` event (`setStopReason`) and emits it on the `message_stop` ProviderEvent (`takeStopReason`), defaulting to `"end_turn"` when no `message_delta` carried one. (`stop_reason` arrives on `message_delta`, never on `message_stop` itself, so it must be cached across the two events.)

```ts
type FinishResult =
  | { kind: "ok";          id: string; name: string; input: unknown }
  | { kind: "parse_error"; id: string; name: string };  // accumulated JSON was unparseable
```

**Malformed JSON is signalled by a dedicated boolean flag, not by a value placed in `input`.** When the accumulated `input_json_delta` string does not `JSON.parse`, `finishBlock` returns `{ kind: "parse_error" }`. The mapper still yields a `tool_use` ProviderEvent (so the loop sees the call and pairs a `tool_result` to its `tool_use_id`, keeping the Anthropic message shape valid), but sets the event's `input` to an empty object `{}` (a valid, JSON-serializable placeholder) and flags the failure with **`inputParseError: true`** — an optional boolean on the provider-agnostic `tool_use` ProviderEvent. The loop carries that flag onto its `pendingToolUses` entry (`parseError`) and into `runTools`, which checks `tu.parseError` **before Zod validation** and emits the exact tool-result error `"Tool '<name>': could not parse tool input as JSON"` (product spec §6.1, §5.6) — distinct from, and not conflated with, the Zod `"... invalid input — <zod message>"` path. The model sees a clear parse-failure message and can retry.

Keeping the signal off `input` (rather than on it, as an earlier design did with a `unique symbol` sentinel) is load-bearing: the assistant turn the loop persists into history embeds `input` verbatim, and a symbol is **not** JSON-serializable — `JSON.stringify` silently drops a symbol-valued property, so threading that turn back into the next request would produce a `tool_use` block with no `input`, an Anthropic 400, and a killed run a turn after the parse error. An empty-object `input` plus a boolean flag keeps history valid on every turn and keeps the internal signal off the public event surface (`tool_use_start.toolInput` is the serializable `{}`, never a sentinel). (Two earlier designs are rejected: injecting `input: null` to fail Zod produced the wrong message; placing a `PARSE_ERROR` symbol in `input` corrupted threaded history. See `docs/decisions.md`.)

### 5.3 Retry and backoff (`retry.ts`)

**Model: the provider contract owns retry; SDK-backed providers delegate to their SDK.**

Every provider exposes a `maxRetries` option and is contractually responsible for retrying transient errors (429, 5xx, connection). `AnthropicProvider` fulfills this by passing `maxRetries` to `new Anthropic({ maxRetries })` — the SDK implements equivalent policy: exponential backoff + jitter, retry on 429/5xx/connection, honors `Retry-After`. In M2, `OpenAIProvider` will do the same with `new OpenAI({ maxRetries })`.

`AnthropicProvider.stream()` does NOT wrap the `client.messages.stream()` call in `withRetry`. The old design wrapped only stream *construction*, which means errors surfacing during stream *iteration* (the common case for 429 during streaming) were never retried — the wrap was effectively a no-op. The SDK's built-in retry correctly handles both construction and iteration errors.

**`withRetry` as a generic fallback.** The `retry.ts` module remains in the codebase as a generic, provider-agnostic helper:

```ts
async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries: number;
    isRetryable: (error: unknown) => boolean;  // caller-supplied; no SDK-specific code here
    delayMs?: (attempt: number) => number;     // default: exponential backoff + jitter
    logger?: Logger;
  },
): Promise<T>
```

`withRetry` has no import of `@anthropic-ai/sdk` or any vendor SDK — the caller supplies `isRetryable` to classify vendor-specific error shapes. Default `delayMs` implements:

```
delayMs(attempt) = min(BASE_DELAY_MS * 2^attempt + jitter, MAX_DELAY_MS)
  BASE_DELAY_MS = 500
  MAX_DELAY_MS  = 30_000
  jitter        = Math.random() * BASE_DELAY_MS  // avoids thundering herd
```

This utility is available for any future provider whose backend lacks built-in retry. It is unit-tested in isolation. It is NOT wired into `AnthropicProvider` in M1.

Errors that survive the provider's retry budget propagate as thrown exceptions. The agent loop catches them and yields `agent_error`; the loop does not itself retry.

### 5.4 The logger hook

The `logger` callback (if present) is called at these points:

- Before each API call: `{ level: "info", event: "request_sent", request }`
- On each retry attempt: `{ level: "info", event: "retry_attempt", attempt, delayMs, error }`
- On final failure: `{ level: "error", event: "request_failed", error }`

**`retry_attempt` is best-effort in M1.** Because `AnthropicProvider` delegates retry to the Anthropic SDK (decision "Provider contract owns retry"), and the SDK exposes no public per-retry hook, the `retry_attempt` entry fires **only** from the `withRetry` utility — which is not wired into `AnthropicProvider` in M1. In practice no `retry_attempt` log is emitted during an M1 Anthropic run; the SDK retries silently. The `LogEntry` union nonetheless keeps the variant so the shape is stable when a hand-rolled-retry provider (or a vendor that exposes a hook) lands. This is the same reason the product spec's states-matrix `provider_retry` event is "not available while retry is SDK-delegated" rather than a future improvement (see §10.1).

For streaming events, individual `ProviderEvent` values are NOT logged in M1 — the `LogEntry` union is exactly `request_sent | retry_attempt | request_failed`, with no per-`ProviderEvent` variant (too voluminous, and per the brainstorm Flow H correction). A `verbose` flag and an `event_received` log entry could be added in M2 if needed.

---

## 6. Error Handling and Edge Case Ownership

Each edge case from §6 of the product spec maps to a concrete module.

| Edge case | Owning module | Mechanism |
|-----------|---------------|-----------|
| 6.1 Malformed JSON tool input | `providers/anthropic.ts` (mapper) + `loop/runTools.ts` | `InputAccumulator.finishBlock` returns `{ kind: "parse_error" }` on unparseable JSON → mapper yields a `tool_use` event with `input: {}` and `inputParseError: true` → loop threads the flag onto its `pendingToolUses` entry → `runTools` checks `tu.parseError` **before** Zod and emits `"Tool '<name>': could not parse tool input as JSON"` |
| 6.2 Unknown tool name | `loop/runTools.ts` | `registry.findByName()` returns `undefined` → error `tool_result` |
| 6.3 Multiple tools in one turn | `loop/loop.ts` | All `tool_use` events buffered before calling `runTools`; results bundled into one user message |
| 6.4 Tool `call` throws | `loop/runTools.ts` | `try/catch` around `await tool.call()`; error fed back as tool error |
| 6.5 Tool hangs indefinitely | none (M1 known gap) | Documented; developer adds `Promise.race` in their `call` |
| 6.6 Very large tool result | `utils/serialize.ts` | `JSON.stringify` → string; no truncation; `agent_error` if model rejects |
| 6.7 Empty assistant turn | `loop/loop.ts` | `pendingToolUses.length === 0` → natural completion path |
| 6.8 Context length exceeded | `providers/anthropic.ts` | 400 not retried → thrown → loop catches → `agent_error` |
| 6.9 Generator abandoned | `agent.ts` | `try/finally` → `abortCtrl.abort()` cancels the in-flight stream. M1 limitation: a tool already mid-`call()` is NOT cancelled (no signal is threaded to tools yet — M2); the generator finalizes once that tool resolves. Documented; per-tool timeouts are the developer's responsibility (6.5). |
| 6.10 Concurrent calls on same agent | `agent.ts` | Each `run()` constructs its own `workingMessages` copy — no shared state |
| 6.11 Malformed history | `providers/anthropic.ts` | 400 from API → not retried → `agent_error` |
| 6.12 API key invalid | `providers/anthropic.ts` | 401 → not retried → `agent_error` with `"AnthropicProvider: authentication failed (HTTP 401)"` |
| 6.13 Zod/model schema mismatch | `loop/runTools.ts` | `tool.inputSchema.safeParse()` catches → error `tool_result` for self-correction |
| 6.14 Very long tool descriptions | none | M1 no truncation; documented limit; developer responsibility |
| 6.15 Git not installed/not a repo | `env/context.ts` | `try/catch` around `platform.exec("git ...")`; exec failure → omit git lines |
| 6.16 Platform op fails in built-in tool | `loop/runTools.ts` | Same as 6.4 — `call` throws → caught → error `tool_result` |

### Error message format

All error strings produced by the framework follow the product spec's §5.6 format:

- Unknown tool: `"Unknown tool: '<name>'"`
- Unparseable tool input: `"Tool '<name>': could not parse tool input as JSON"` (the `inputParseError` flag path; emitted before Zod, distinct from the Zod path below)
- Zod validation: `"Tool '<name>': invalid input — <zod message>"`
- Serialization failure: `"Tool '<name>': could not serialize result — <error message>"`
- API key: `"AnthropicProvider: ANTHROPIC_API_KEY is required"`
- Rate limit exhausted: `"AnthropicProvider: rate limit exceeded after <n> retries"`
- Max turns: `"Agent: maxTurns (<n>) exceeded; terminating"`

These are the literal strings that appear in `isError: true` tool results or `agent_error.error.message`. They are stable across patch versions.

---

## 7. State Management

### 7.1 Where state lives

The `Agent` class itself holds only construction-time configuration (immutable after construction):

```
agent.provider        — Provider instance (immutable)
agent.tools           — Tool[] (immutable; ToolRegistry constructed per run)
agent.platform        — Platform instance (immutable)
agent.systemPrompt    — string | undefined (immutable)
agent.maxTurns        — number (immutable)
```

All per-run mutable state is local to each `run()` generator invocation:

```
workingMessages  — Message[] (local copy, grows during the run)
turnIndex        — number (counter)
turnsUsed        — number (counter)
abortCtrl        — AbortController (created per run)
```

There is no shared mutable state between concurrent `run()` calls. The `ToolRegistry` is reconstructed from `this.tools` at the start of each `run()` call — it is a lightweight lookup table (a `Map<string, Tool>`) and construction is O(n) on tool count.

### 7.2 Message list threading

The `options.messages` array passed to `run()` is spread (not mutated). The `workingMessages` array is the local working copy. On each turn, new messages are pushed to `workingMessages`. At termination, `workingMessages` is carried on the terminal event. The caller's `options.messages` reference is never modified.

### 7.3 Env context caching

`buildEnvContext(platform)` is called once per `run()` invocation. It is not memoized at the class level — this ensures that if the user changes directories between runs, the correct cwd is reflected. The git status commands are fast enough that once-per-run is acceptable for M1. Memoization across a session is an SDK-layer concern (the SDK can cache across its `Session` wrapper's lifetime).

---

## 8. Testing Strategy

### 8.1 MockProvider

```ts
// In test files (not shipped in dist):
class MockProvider implements Provider {
  private responses: ProviderEvent[][];

  constructor(responses: ProviderEvent[][]) {
    // each inner array is one "turn" of events
    this.responses = responses;
  }

  async *stream(request: ProviderRequest, _signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
    const turn = this.responses.shift();
    if (!turn) throw new Error("MockProvider: no more responses");
    for (const event of turn) yield event;
  }
}
```

This allows tests to script exact sequences of events without any network access.

### 8.2 MockPlatform

```ts
class MockPlatform implements Platform {
  private files: Record<string, string>;
  execResponses: ExecResult[];
  private fakeCwd: string;

  constructor(
    files: Record<string, string> = {},
    execResponses: ExecResult[] = [],
    cwd: string = "/mock/cwd",
  ) {
    this.files = files;
    this.execResponses = execResponses;
    this.fakeCwd = cwd;
  }

  cwd(): string {
    return this.fakeCwd;
  }

  async readFile(path: string): Promise<string> {
    if (!(path in this.files)) throw new Error(`ENOENT: ${path}`);
    return this.files[path]!;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files[path] = content;
  }

  async exec(): Promise<ExecResult> {
    return this.execResponses.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
  }
}
```

### 8.3 Test coverage map (success criteria → tests)

| Success criterion (§7) | Test file | Test approach |
|------------------------|-----------|---------------|
| 7.1 Basic agent run (no tools) | `agent.test.ts` | MockProvider yields text_delta + message_stop(end_turn). Assert events: text_delta*, agent_done. |
| 7.2 Tool use end-to-end | `loop.test.ts` | MockProvider yields tool_use + message_stop(tool_use), then text_delta + message_stop(end_turn). MockPlatform with file. Assert: tool_use_start, tool_result (not error), agent_done. |
| 7.3 Tool error recovery | `runTools.test.ts` | Tool whose call() throws. Assert: tool_result with isError=true. Loop continues. |
| 7.4 Unknown tool handling | `runTools.test.ts` | MockProvider requests unknown tool name. Assert: tool_result with isError=true, loop continues. |
| 7.5 Max turns safety | `loop.test.ts` | MockProvider always returns tool_use. maxTurns: 2. Assert: max_turns_exceeded after 2 turn_complete events. |
| 7.6 API error handling | `agent.test.ts` | MockProvider.stream() throws. Assert: agent_error yielded, generator exhausts. |
| 7.7 Provider abstraction compile-check | `agent.test.ts` | MockProvider passed to Agent — TypeScript compiles (static check). |
| 7.8 Platform abstraction compile-check | `agent.test.ts` | MockPlatform passed to Agent — TypeScript compiles (static check). |
| 7.9 Multi-turn threading | `agent.test.ts` | Two sequential runs. Second run's MockProvider asserts the request.messages includes prior turn. |
| 7.10 Type safety | CI `tsc --noEmit --strict` | No compile errors on `packages/core/src`. |
| 7.11 No UI imports | CI lint | `eslint no-restricted-imports` rule in core package config. |
| 7.12 No core fs/process imports | CI lint | Same lint rule; blocks `import fs`, `import child_process`, and any bare `process` reference in core src except `platform/node.ts`. `platform/node.ts` is the sole permitted location for Node globals. |
| 7.13 Env context injection | `env-context.test.ts` | MockPlatform with scripted exec responses. Assert buildEnvContext() output contains cwd, date, git branch. |
| 7.14 Logger off by default | `agent.test.ts` | AnthropicProvider with no logger; mock the console; assert no output during run (requires an integration test or mock SDK). |
| 7.15 Git-absent degradation (§6.15) | `env-context.test.ts` | MockPlatform whose `exec("git ...")` returns `exitCode !== 0` (or whose `exec` throws). Assert buildEnvContext() omits the `Git branch`/`Git status` lines but still returns cwd + date, and that a full `agent.run()` over a MockProvider reaches `agent_done` with no `agent_error`. |
| 7.16 Multiple tools in one turn (§6.3) | `loop.test.ts` | MockProvider emits two `tool_use` events + `message_stop(tool_use)` in one turn, then a tool-free turn. Assert: two `tool_result` events yielded, and the NEXT request the MockProvider receives has the prior assistant message (two `tool_use` blocks) followed by ONE user message containing two `tool_result` content blocks. |
| 7.17 Abort on abandonment (§6.9) | `agent.test.ts` | MockProvider records its `AbortSignal` and yields slowly; the test `break`s out of the `for await` mid-stream. Assert the recorded signal's `aborted === true` after the loop exits (the generator's `finally` fired `abortCtrl.abort()`). |
| 7.18 Streaming surfaces incrementally (§5.3 states) | `loop.test.ts` | MockProvider emits several `text_delta` events before `message_stop` within one turn. Assert the collected event order interleaves multiple `text_delta` events ahead of `turn_complete` (i.e. deltas are yielded as they arrive, not buffered to turn end). |
| 7.x Malformed tool input (§6.1) | `anthropic-mapper.test.ts` + `runTools.test.ts` | Mapper: feed `input_json_delta` chunks forming invalid JSON; assert `finishBlock` returns `{ kind: "parse_error" }` and `translateStreamEvent` yields a `tool_use` event whose `inputParseError === true` and whose `input` deep-equals `{}`. runTools: pass a tool_use entry with `parseError: true`; assert the `tool_result` carries exactly `"Tool '<name>': could not parse tool input as JSON"` and `isError: true`, emitted without invoking Zod. |

**Note for the plan refine — task ownership of the new criteria.** Criteria 7.15–7.18 and the §6.1 malformed-input case map onto existing tasks; they add assertions, not new modules:

- **7.15 git-absent degradation** → the env-context task (the task that owns `env/context.ts` + `env-context.test.ts`). 6.15 behavior already exists in the skeleton; 7.15 just adds the negative-path assertion. Already partly covered by the original 7.13 test's scaffolding.
- **7.16 multiple-tools-in-one-turn** → the loop task (`loop/loop.ts` + `loop.test.ts`). The bundling logic exists; this was **not explicitly tested before** — the plan must add a two-`tool_use` fixture and a received-message assertion.
- **7.17 abort-on-abandonment** → the agent task (`agent.ts` + `agent.test.ts`), since the `try/finally` + `abortCtrl.abort()` lives in `Agent.run`. The MockProvider must be extended to record its `AbortSignal`. **Not explicitly tested before.**
- **7.18 incremental streaming** → the loop task (`loop.test.ts`). Asserts deltas interleave ahead of `turn_complete`. **Not explicitly tested before.**
- **§6.1 malformed tool input (the `inputParseError` flag path)** → split across the mapper task (`anthropic-mapper.test.ts`: `finishBlock` returns `parse_error`, event has `inputParseError === true` and `input` deep-equals `{}`) and the runTools task (`runTools.test.ts`: a tool_use entry with `parseError: true` → exact `"could not parse tool input as JSON"` message, no Zod call). The mapper task already exists (decisions: "Anthropic mapper is its own task"); both gain one assertion.

### 8.4 Unit vs integration boundary

- **Unit:** everything driven by `MockProvider` + `MockPlatform`. No network, no filesystem. These are the primary tests.
- **Integration:** a single `examples/` script that hits the real Anthropic API with `ANTHROPIC_API_KEY`. Not run in CI by default (requires a secret). Run manually by the developer to verify end-to-end.
- **No browser tests in M1.** The platform abstraction is tested via `MockPlatform`; `NodePlatform` is not unit-tested in M1 (integration-tested via the example script).

---

## 9. Non-Goals (Architectural Choices Explicitly Rejected)

1. **EventEmitter as the engine surface.** Rejected in the decisions log — lacks backpressure and clean completion semantics. The async generator is the canonical surface.

2. **RxJS / reactive streams.** Rejected — heavy dependency, obscures the mechanics this project exists to learn.

3. **Stateful `Agent` class (session-level message accumulation).** Rejected — the core is stateless by decision. A stateful `Session` wrapper is an SDK-layer concern.

4. **Generic `Agent<TContext>` to type `ToolCallContext`.** Rejected in §3.3 in favor of interface merging. A generic `Agent` type would pollute the core API with the SDK's type parameters.

5. **Streaming tool execution (tools execute during model streaming, before `message_stop`).** Rejected for M1 — the reference's `StreamingToolExecutor` is product polish. All tool execution happens after `message_stop` to keep the loop simple and correct.

6. **Bundling `@anthropic-ai/sdk` into the core package.** Rejected — consumers who use only `tiny-agentic` without `AnthropicProvider` would import the SDK unnecessarily. The SDK is an optional peer dependency, used by the `providers/anthropic` entry point only.

7. **Monolithic single-file architecture.** Rejected — each module (events, messages, platform, tool, provider) has a single responsibility. This mirrors the reference's subsystem separation and makes the code legible.

8. **npm workspaces.** Rejected in favor of pnpm for strict dependency isolation and performance.

9. **Jest as test runner.** Rejected in favor of Vitest for native ESM support and TypeScript integration without `--experimental-vm-modules`.

10. **`zod-to-json-schema` at tool-call time (lazily, inside the provider).** Rejected — schemas are serialized once at `run()` start by the `ToolRegistry`, not on every API call. This is consistent and eliminates per-call overhead.

---

## 10. Open Engineering Questions

All significant questions have been resolved in this spec. The following is the complete list; none require user input before implementation begins:

1. **`AbortSignal` threading to `platform.exec`.** The `NodePlatform.exec` implementation should accept an `AbortSignal` from `ExecOptions` and use it to kill the child process. This is important for responsiveness but is not required for correctness in M1 (tools run to completion even if the loop is abandoned). The `ExecOptions` type already includes a `timeout` field; the planner should note this as a sub-task in the `NodePlatform` implementation task.

2. **`tool_use` input accumulation in the mapper.** The Anthropic streaming API sends `input_json_delta` events that must be concatenated into a complete JSON string before parsing. The mapper accumulates these per content block index. The planner should ensure this is explicitly tested in `anthropic-mapper.test.ts` with a multi-block streaming fixture.

3. **`zod-to-json-schema` target and options.** Using `openApi3` target with `$refStrategy: "none"` is specified in §3.5. The package `zod-to-json-schema` must be added as a direct dependency of `packages/core` (not a peer dependency — consumers do not call it directly). The planner should include this in the `ToolRegistry` implementation task.

4. **`@anthropic-ai/sdk` dependency placement — RESOLVED.** Listed as an **optional peer dependency** of `packages/core` (`peerDependencies` + `peerDependenciesMeta.optional: true`), per the package.json in the code-architecture doc. Consumers who use `AnthropicProvider` install it; OpenAI-only consumers do not (and get no install warning). Also kept in `devDependencies` for local development/tests.

5. **`@types/node` / `skipLibCheck` / Node floor — RESOLVED.** `skipLibCheck: true` in `tsconfig.base.json`; `@types/node` pinned to `^22` (devDependency, matching the `engines.node >=22.0.0` floor). This makes `pnpm -r typecheck` pass with a runtime-accurate `@types/node` (without it, vitest-transitive vite `.d.ts` referencing `WebSocket`/newer globals breaks a `@types/node@22` build under `skipLibCheck: false`). Node 18 and 20 are both EOL as of 2026-06; 22 is the lowest supported LTS. See §1.5 and the decision-log entry.

### 10.1 Confirmed M2 deferrals (from the brainstorm refine; none block M1)

The brainstorm refine surfaced three forward items for the engineering refine to confirm or schedule. All are M2; the seams are noted so M1 does not foreclose them:

1. **Stream-idle watchdog (§6.17).** M1 relies entirely on the Anthropic SDK's built-in request timeout (the SDK applies a default per-request timeout and aborts on it); the engine adds **no** dedicated idle watchdog. This is acceptable for M1 — the SDK timeout bounds a hung stream. If a future provider/SDK lacks a usable idle timeout, an engine-level watchdog (the reference's 90s `STREAM_IDLE_TIMEOUT_MS`) would attach inside the `for await` over `provider.stream(...)` in `loop/loop.ts` (a `Promise.race` between `iterator.next()` and a reset-on-event timer). Deferred to M2.

2. **Cooperative tool cancellation seam (§6.18).** M1 aborts only the in-flight provider stream; `Tool.call` does not receive the `AbortSignal`, so a tool already executing runs to completion before the generator's `finally` returns. **Decision on where to reserve the seam: thread the signal as an optional field on `ToolCallContext`, not as a fourth `call` argument.** `ToolCallContext` is already the SDK-extensible, optional-by-contract seam (interface merging; all fields optional), so adding `signal?: AbortSignal` there in M2 is non-breaking and keeps `Tool.call`'s positional arity stable at three. A fourth positional argument would change every tool signature and is rejected. No M1 code change — flagged so the seam is reserved.

3. **`provider_retry` event feasibility.** Because retry is delegated to the Anthropic SDK (decision "Provider contract owns retry"), surfacing each retry as an engine event would require the SDK to expose a per-retry hook. The `@anthropic-ai/sdk` does **not** expose a public retry callback while it owns retry internally — so a `ProviderEvent`/`AgentEvent` `provider_retry` is **not feasible in M1** while retry is SDK-delegated. Consequently the `LogEntry` `retry_attempt` entry is **best-effort**: it fires only on the `withRetry` code path (unused by `AnthropicProvider` in M1), so in practice no `retry_attempt` log is emitted during M1 Anthropic runs. The product spec's states-matrix `provider_retry` note should be read as "not available while retry is SDK-delegated," not "future improvement." If retry is ever hand-rolled (the deliberate-learning task, not M1) or a vendor exposes a hook, the event becomes feasible.

---

## 11. M1 Built-in Tools

The core package ships exactly two built-in tools in M1. They are defined in `src/tools/builtin/` and exported from `src/index.ts`. Both use `defineTool` so that `input` in `call` is typed (not `unknown`):

```ts
// src/tools/builtin/readFile.ts
export const readFileTool = defineTool({ ... })

// src/tools/builtin/writeFile.ts
export const writeFileTool = defineTool({ ... })
```

These are the only tools that use `Platform` methods. All other tools a developer registers are either self-contained or also use `Platform`; the same three-argument `call` signature handles both.

**Line-range support (large files).** Both tools accept optional line-range parameters so the model need not read or rewrite an entire large file:

- `read_file` — `{ path, offset?, limit? }`. With no range, returns `{ content }` (whole file). With `offset` (1-based start line) and/or `limit` (max lines), returns `{ content, offset, lineCount, totalLines, truncated }` for that slice (read full via `platform.readFile`, then slice lines — no new `Platform` method).
- `write_file` — `{ path, content, offset?, limit? }`. With no `offset`, full overwrite (creates if missing) returning `{ written, path }`. With `offset` (1-based) and optional `limit` (lines to replace, default through EOF; `0` = insert), it does a read-modify-write splice of that line range, returning `{ written, path, replacedFrom, replacedLines }`; range mode requires an existing file (`platform.readFile` throws → caught and fed back as a tool error). Full content overwrite remains the default; partial *content* edits beyond line-range replacement (e.g. find/replace) are a future `Edit` tool, out of M1 scope.

The exact `defineTool` definitions are in the code-architecture doc. See `docs/decisions.md` "Built-in file tools gain optional line-range parameters".

Exported from `tiny-agentic` (main entry point) as two separate exports:
```ts
export { readFileTool } from "./tools/builtin/readFile.js";
export { writeFileTool } from "./tools/builtin/writeFile.js";
```

Developers can use them out of the box:
```ts
import { Agent, readFileTool, writeFileTool } from "tiny-agentic";
import { NodePlatform } from "tiny-agentic/platform/node";

const agent = new Agent({
  provider,
  tools: [readFileTool, writeFileTool],
  platform: new NodePlatform(),
});
```

---

*Spec complete. This document is the authoritative engineering design for tiny-agentic milestone 1. The planning phase breaks it into sequential implementation tasks.*

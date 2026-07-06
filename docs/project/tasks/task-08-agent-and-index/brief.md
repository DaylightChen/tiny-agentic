# Task 08 — Agent Class, Built-in Tools, and Public Index

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Implement the final production modules: `packages/core/src/agent.ts` (the `Agent` class), `packages/core/src/tools/builtin/readFile.ts`, `packages/core/src/tools/builtin/writeFile.ts`, and the complete `packages/core/src/index.ts`. Write `agent.test.ts` covering all remaining success criteria. At the end of this task:

- `new Agent({ provider, tools, platform })` constructs correctly.
- `agent.run(prompt)` is a working `AsyncGenerator<AgentEvent, Terminal>` — tested with `MockProvider` and `MockPlatform`.
- `readFileTool` and `writeFileTool` are exported and work via `defineTool`.
- The public `index.ts` re-exports everything in the spec-defined exports map.
- `pnpm --filter tiny-agentic build` succeeds and all test files pass.

## Context files

- `docs/engineering/2026-06-27-code-architecture.md` — Exact skeleton for `agent.ts`, `tools/builtin/readFile.ts`, `tools/builtin/writeFile.ts`, `index.ts`
- `docs/engineering/2026-06-27-engineering-spec.md` — §3.9 (Agent class), §4.1 (setup steps in agent.ts), §4.4 (AbortController wiring), §8.3 (tests 7.1, 7.7–7.9, 7.14)
- `docs/decisions.md` — "Entry point: Agent class only; completion events carry final messages", "AbortSignal threading"
- `packages/core/src/loop/loop.ts` — `agentLoop`, `LoopParams` (task 07)
- `packages/core/src/tools/registry.ts` — `ToolRegistry` (task 04)
- `packages/core/src/env/context.ts` — `buildEnvContext` (task 04)
- `packages/core/src/types/tool.ts` — `Tool`, `defineTool`
- `packages/core/src/types/platform.ts` — `Platform`
- `packages/core/src/utils/collect.ts` — `collectText`, `collectEvents` (for tests)

## Downstream dependencies

- Task 09 (lint) runs `eslint packages/core/src --max-warnings 0` — all files created in this task must be clean.
- Task 09 runs `pnpm -r typecheck` — the complete package including `index.ts` must typecheck.
- Task 10 (example) imports `Agent` from `"tiny-agentic"`, `readFileTool`/`writeFileTool` from `"tiny-agentic"`, `NodePlatform` from `"tiny-agentic/platform/node"`, `AnthropicProvider` from `"tiny-agentic/providers/anthropic"`, `collectText` from `"tiny-agentic/utils"`. All these must be exported from the correct entry points after `pnpm --filter tiny-agentic build`.

## Steps

1. **Create `packages/core/src/agent.ts`** — implement exactly as in the code-architecture doc skeleton:
   - Class fields: `provider`, `tools`, `platform`, `systemPrompt`, `maxTurns` (all `private readonly`).
   - Constructor sets defaults: `this.maxTurns = options.maxTurns ?? 25`.
   - `async *run(prompt, options = {})`:
     - Create `AbortController`.
     - `try { ... } finally { abortCtrl.abort(); }`.
     - Inside try:
       - `const registry = new ToolRegistry(this.tools);`
       - `const workingMessages: Message[] = [...(options.messages ?? []), { role: "user", content: prompt }];`
       - `const envCtx = await buildEnvContext(this.platform);`
       - `const systemPrompt = this.systemPrompt ? envCtx + "\n\n" + this.systemPrompt : envCtx;`
       - `return yield* agentLoop({ provider: this.provider, registry, platform: this.platform, messages: workingMessages, systemPrompt, maxTurns: this.maxTurns, signal: abortCtrl.signal });`

   Note: the `finally` block calls `abortCtrl.abort()`. If the generator is abandoned (caller breaks out of `for await`), JavaScript calls the generator's `.return()` method, which triggers `finally`. This cancels any in-flight Anthropic SDK stream.

2. **Create `packages/core/src/tools/builtin/readFile.ts`** (with optional line-range — see `docs/decisions.md` "Built-in file tools gain optional line-range parameters" and code-architecture builtin skeleton; implement verbatim):
   ```ts
   import { z } from "zod";
   import { defineTool } from "../../types/tool.js";

   export const readFileTool = defineTool({
     name: "read_file",
     description:
       "Read a file at the given path. By default returns the whole file; pass offset/limit to read only a line range (useful for large files).",
     inputSchema: z.object({
       path: z.string().describe("Absolute or relative path to the file."),
       offset: z.number().int().positive().optional().describe("1-based line number to start reading from."),
       limit: z.number().int().positive().optional().describe("Maximum number of lines to read starting at offset."),
     }),
     call: async ({ path, offset, limit }, platform) => {
       const full = await platform.readFile(path);
       if (offset === undefined && limit === undefined) return { content: full };
       const lines = full.split("\n");
       const start = offset !== undefined ? offset - 1 : 0;
       const end = limit !== undefined ? start + limit : lines.length;
       const slice = lines.slice(start, end);
       return { content: slice.join("\n"), offset: start + 1, lineCount: slice.length, totalLines: lines.length, truncated: slice.length < lines.length };
     },
   });
   ```

3. **Create `packages/core/src/tools/builtin/writeFile.ts`** (with optional range-replace mode; implement verbatim):
   ```ts
   import { z } from "zod";
   import { defineTool } from "../../types/tool.js";

   export const writeFileTool = defineTool({
     name: "write_file",
     description:
       "Write content to a file. Without offset, replaces the whole file (creating it if needed). With offset (1-based) and optional limit, replaces that line range in an existing file with the given content (read-modify-write).",
     inputSchema: z.object({
       path: z.string().describe("Absolute or relative path to the file."),
       content: z.string().describe("Content to write (or to substitute into the line range)."),
       offset: z.number().int().positive().optional().describe("1-based start line. If set, replace a line range instead of the whole file."),
       limit: z.number().int().nonnegative().optional().describe("Number of lines to replace starting at offset (default: through end of file). 0 inserts without deleting."),
     }),
     call: async ({ path, content, offset, limit }, platform) => {
       if (offset === undefined) {
         await platform.writeFile(path, content);
         return { written: true, path };
       }
       const existing = await platform.readFile(path); // throws if missing → caught by loop as tool error
       const lines = existing.split("\n");
       const start = offset - 1;
       const deleteCount = Math.max(0, limit !== undefined ? limit : lines.length - start); // clamp: offset past EOF appends, replacedLines never negative
       lines.splice(start, deleteCount, ...content.split("\n"));
       await platform.writeFile(path, lines.join("\n"));
       return { written: true, path, replacedFrom: offset, replacedLines: deleteCount };
     },
   });
   ```

4. **Update `packages/core/src/index.ts`** — replace the partial stub (from task 02) with the complete re-exports as in the code-architecture doc:
   ```ts
   export { Agent } from "./agent.js";
   export type { AgentOptions, RunOptions } from "./agent.js";
   export type { AgentEvent, Terminal } from "./types/events.js";
   export type { Message, ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock } from "./types/messages.js";
   export type { Tool, ToolCallContext } from "./types/tool.js";
   export { defineTool } from "./types/tool.js";
   export type { Provider, ProviderRequest, ProviderEvent, ToolSchema, Logger, LogEntry } from "./types/provider.js";
   export type { Platform, ExecOptions, ExecResult } from "./types/platform.js";
   export { readFileTool } from "./tools/builtin/readFile.js";
   export { writeFileTool } from "./tools/builtin/writeFile.js";
   ```
   Note: `collectText` and `collectEvents` are exported from `"tiny-agentic/utils"` (the `utils/collect` entry point), NOT from the main `index.ts`. `NodePlatform` is from `"tiny-agentic/platform/node"`. `AnthropicProvider` is from `"tiny-agentic/providers/anthropic"`. These secondary entry points are handled by tsup's multiple entry config (already set in task 01). Do not re-export them from `index.ts`.

5. **Create `packages/core/src/__tests__/agent.test.ts`** — write Vitest tests. Reuse or co-define `MockProvider` and `MockPlatform` in this file (same shapes as task 07):

   Test cases:
   - **Basic run (success criterion 7.1):** MockProvider yields `[text_delta("hello"), message_stop("end_turn")]`. Use `collectEvents(agent.run("test"))`. Assert events contain `{ type: "text_delta", text: "hello" }` and terminal event `{ type: "agent_done" }`. Assert `terminal.reason === "agent_done"`.
   - **API error (success criterion 7.6):** MockProvider.stream throws immediately. Use `collectEvents`. Assert events contain `{ type: "agent_error" }`. Assert `terminal.reason === "agent_error"`.
   - **Multi-turn threading (success criterion 7.9):** Two sequential `agent.run` calls. First returns `agent_done` with messages. Second run constructed with `{ messages: history }`. Validate that the second MockProvider receives a `request.messages` array that includes messages from the first run. Assert the request passed to MockProvider's `stream()` on the second call contains the prior assistant message. (Use a request-capturing `MockProvider` variant that records each `request` it receives — the task-07 `MockProvider` ignores `_req`, so extend it to store requests for this assertion.)
   - **Env context injected into the system prompt (success criterion 7.13, end-to-end):** the task-04 `env-context.test.ts` checks `buildEnvContext` output in isolation; here, assert the *injection*. Use a request-capturing `MockProvider` and a `MockPlatform` whose `cwd()` returns a known sentinel (e.g. `/test/cwd`). Run the agent, then assert the captured `request.systemPrompt` contains `Working directory: /test/cwd`. With a `systemPrompt` option set, also assert the developer prompt is appended after the env block (env context first, then `\n\n`, then the custom prompt).
   - **Provider abstraction compile-check (success criterion 7.7):** MockProvider (typed as `Provider`) passed to `Agent` — this is a static check. Confirmed by `tsc --noEmit` passing.
   - **Platform abstraction compile-check (success criterion 7.8):** MockPlatform (typed as `Platform`) passed to `Agent` — static check. Confirmed by `tsc --noEmit` passing.
   - **Logger off by default (success criterion 7.14):** verified in task 06's `anthropic.test.ts` (mock-SDK test: no logger → zero console output when `stream()` runs). Do NOT re-test it here — `agent.test.ts` uses `MockProvider`, which has no logger hook, so it cannot exercise the provider's logger behavior. No action in this task beyond noting the coverage lives in task 06.
   - **Abort on abandonment (success criterion 7.17, edge case 6.9):** a `MockProvider` whose `stream(req, signal)` captures the `signal`, yields one `text_delta`, then awaits the abort before returning (deterministic, no timer): `await new Promise<void>((res) => signal!.addEventListener("abort", () => res(), { once: true }))`. Drive `agent.run(...)` with `for await` and `break` immediately after the first event. After the loop, assert the captured `signal.aborted === true` — the agent's `finally { abortCtrl.abort() }` fired on the early break, cancelling the in-flight provider stream. (The mock resolves only once aborted, so the test neither hangs nor needs a real timer.)

6. **Run `pnpm --filter tiny-agentic build`** — all four entry points build successfully. Verify `dist/` contains: `index.js`, `index.d.ts`, `providers/anthropic.js`, `providers/anthropic.d.ts`, `platform/node.js`, `platform/node.d.ts`, `utils/collect.js`, `utils/collect.d.ts`.

7. **Run `pnpm --filter tiny-agentic test`** — all tests (collect, env-context, anthropic-mapper, retry, runTools, loop, agent) pass.

8. **Run `pnpm --filter tiny-agentic typecheck`** — no errors.

## Acceptance criteria

- [ ] `pnpm --filter tiny-agentic test` passes with all `agent.test.ts` tests green, plus all prior tests.
- [ ] `pnpm --filter tiny-agentic typecheck` exits with code 0.
- [ ] `pnpm --filter tiny-agentic build` exits with code 0; `dist/` contains all four entry point JS + d.ts pairs.
- [ ] Success criterion 7.1 (basic agent run) covered in `agent.test.ts`.
- [ ] Success criterion 7.7 (provider abstraction compile-check) verified by typecheck passing.
- [ ] Success criterion 7.8 (platform abstraction compile-check) verified by typecheck passing.
- [ ] Success criterion 7.9 (multi-turn threading) covered in `agent.test.ts`.
- [ ] Success criterion 7.13 (env context injection) covered end-to-end in `agent.test.ts`: captured `request.systemPrompt` contains the env block and, when a custom `systemPrompt` is set, the custom text follows it.
- [ ] Success criterion 7.17 (abort on abandonment) covered in `agent.test.ts`: the captured `AbortSignal` is `aborted` after the caller breaks the `for await` loop early.
- [ ] `packages/core/src/index.ts` exports `Agent`, `defineTool`, `readFileTool`, `writeFileTool` as values; all type exports present.
- [ ] Manually confirm: `readFileTool` and `writeFileTool` are typed such that `input` inside `call` is fully typed (not `unknown`) — a consequence of using `defineTool`.

## Output files

- Created: `packages/core/src/agent.ts`
- Created: `packages/core/src/tools/builtin/readFile.ts`
- Created: `packages/core/src/tools/builtin/writeFile.ts`
- Modified: `packages/core/src/index.ts` (replaced partial exports with full exports)
- Created: `packages/core/src/__tests__/agent.test.ts`

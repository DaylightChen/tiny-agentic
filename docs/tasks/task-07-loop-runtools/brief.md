# Task 07 — agentLoop and runTools

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Implement the two core execution modules: `packages/core/src/loop/runTools.ts` (sequential tool execution) and `packages/core/src/loop/loop.ts` (`agentLoop` generator). Write comprehensive unit tests in `runTools.test.ts` and `loop.test.ts`. At the end of this task:

- `runTools` correctly handles: unknown tool, Zod validation failure, successful tool call, `call` throwing. All four paths yield the correct `tool_result` event shape.
- `agentLoop` correctly handles: the max-turns guard, text streaming, tool-use buffering, tool-result bundling, natural completion (no tools in turn), and API error (`agent_error`).
- All tests in `runTools.test.ts` and `loop.test.ts` pass with `MockProvider` and `MockPlatform`.

This is the heart of the agentic engine. Getting it right here — before the `Agent` shell wraps it — means any issue is isolated to the loop itself.

## Context files

- `docs/engineering/2026-06-27-code-architecture.md` — Exact skeletons for `loop/runTools.ts` and `loop/loop.ts`. Implement verbatim; these are the complete implementations, not just shells.
- `docs/engineering/2026-06-27-engineering-spec.md` — §4.2 (full loop pseudocode), §4.3 (runTools pseudocode), §6.2–§6.4, §6.7, §6.13 (edge cases owned by this module), §8.1 (MockProvider), §8.2 (MockPlatform), §8.3 (tests 7.2–7.5)
- `packages/core/src/types/events.ts` — `AgentEvent`
- `packages/core/src/types/messages.ts` — `Message`, `ContentBlock`, `ToolUseBlock`
- `packages/core/src/types/tool.ts` — `ToolCallContext`
- `packages/core/src/types/provider.ts` — `Provider`, `ProviderRequest`, `ProviderEvent`
- `packages/core/src/tools/registry.ts` — `ToolRegistry`
- `packages/core/src/utils/serialize.ts` — `serializeToolResult`
- `packages/core/src/utils/collect.ts` — `collectEvents`, `collectText` (for tests)

## Downstream dependencies

- Task 08 (`agent.ts`) calls `yield* agentLoop(params)` and imports `LoopParams` from `"./loop/loop.js"`. The `LoopParams` type must be exported and stable.
- Task 08 tests use `MockProvider` and `MockPlatform` — define these in the test files (not as production code). The loop tests serve as the model for the agent tests.
- Task 10 (integration example) exercises the real loop end-to-end via the Agent — no direct dependency on loop internals.

## Steps

1. **Create `packages/core/src/loop/runTools.ts`** — implement exactly as in the code-architecture doc. Key points:
   - Accepts `(toolUses, registry, platform, context)`.
   - For each tool use block (sequential `for...of`):
     a. `registry.findByName(tu.name)` — if undefined, yield unknown-tool error event and `continue`.
     b. `tool.inputSchema.safeParse(tu.input)` — if failure, yield Zod validation error event and `continue`.
     c. `await tool.call(parseResult.data, platform, context)` — in try/catch: yield success event on success, yield error event on catch.
   - Error strings: `"Unknown tool: '<name>'"`, `"Tool '<name>': invalid input — <zod message>"`, caught error message (`err instanceof Error ? err.message : String(err)`).
   - This generator never throws — every error path is caught and yielded as `tool_result`.
   - **M2 concurrency seam comment:** add a comment before the `for...of` noting that M2 will check `tool.isConcurrencySafe?.(input)` and batch safe calls via `Promise.all`.

2. **Create `packages/core/src/loop/loop.ts`** — implement exactly as in the code-architecture doc. Key points:
   - Export `LoopParams` type and `agentLoop` generator function.
   - Before the `while(true)` loop: construct `context: ToolCallContext = {}` (once per run), call `registry.toSchemas()` for `toolSchemas` (once per run).
   - Inside the loop: check `turnsUsed >= maxTurns` first.
   - Streaming: `for await (const event of provider.stream({ systemPrompt, messages: workingMessages, tools: toolSchemas }, signal))` — in `try/catch`. On catch, yield `agent_error` and return the error Terminal.
   - After streaming: build `assistantContent[]`, push to `workingMessages` only if non-empty (skip empty assistant turns — avoid API rejection of `{ content: [] }`).
   - Increment `turnsUsed`.
   - Tool execution: `for await` over `runTools(...)`, yield each event, accumulate `toolResultBlocks`. After the loop, push `{ role: "user", content: toolResultBlocks }` to `workingMessages`.
   - **Serialization error catch (spec §4.2):** inside the `for await` over runTools, when building `toolResultBlocks`, wrap `serializeToolResult(toolResultEvent.result)` in try/catch — catch converts to `"Tool '<name>': could not serialize result — <msg>"` with `isError: true`.
   - Yield `turn_complete`, increment `turnIndex`, continue.
   - Natural completion: yield `turn_complete`, yield `agent_done` with `workingMessages`, return `{ reason: "agent_done", messages: workingMessages }`.

3. **Create `packages/core/src/__tests__/runTools.test.ts`** — tests for `runTools`:

   Define `MockPlatform` inline (same shape as engineering spec §8.2):
   ```ts
   class MockPlatform implements Platform { ... }
   ```

   Define `MockRegistry` inline (or just use a real `ToolRegistry` with test tools):
   ```ts
   function makeRegistry(tools: Tool[]): ToolRegistry { return new ToolRegistry(tools); }
   ```

   Test cases:
   - **Unknown tool:** `runTools([{ id: "1", name: "no_such_tool", input: {} }], registry, platform, {})` → assert event `{ type: "tool_result", toolName: "no_such_tool", isError: true, result: "Unknown tool: 'no_such_tool'" }`.
   - **Zod validation failure:** tool with `z.object({ n: z.number() })`, input `{ n: "not-a-number" }` → assert `isError: true`, result contains `"invalid input"`.
   - **Successful call:** tool that returns `{ ok: true }` → assert `isError: false`, `result === { ok: true }`.
   - **Tool `call` throws:** tool whose `call` throws `new Error("boom")` → assert `isError: true`, `result === "boom"`.
   - **Built-in platform op fails (edge case 6.16):** a tool whose `call` does `await platform.readFile(path)` against a `MockPlatform` configured to throw (e.g. `readFile` rejects with `new Error("ENOENT: /nope")`) → assert `isError: true`, `result` contains the platform error message. This proves a `Platform` failure surfacing through a tool is caught and fed back as a recoverable `tool_result` (structurally the same path as 6.4, but exercised through the platform seam so it has CI coverage rather than relying on the task-10 example).
   - **Two tools in sequence:** two tool entries; assert two events yielded in order.
   - (Success criteria 7.3 and 7.4, and edge cases 6.4/6.16, are covered here.)

4. **Create `packages/core/src/__tests__/loop.test.ts`** — tests for `agentLoop`:

   Define `MockProvider` inline:
   ```ts
   class MockProvider implements Provider {
     private responses: ProviderEvent[][];
     constructor(responses: ProviderEvent[][]) { this.responses = responses; }
     async *stream(_req: ProviderRequest, _signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
       const turn = this.responses.shift();
       if (!turn) throw new Error("MockProvider: no more responses");
       for (const e of turn) yield e;
     }
   }
   ```

   Helper to build a minimal `LoopParams`:
   ```ts
   function makeParams(provider: Provider, registry: ToolRegistry, overrides?: Partial<LoopParams>): LoopParams {
     return {
       provider,
       registry,
       platform: new MockPlatform(),
       messages: [{ role: "user", content: "hello" }],
       systemPrompt: "sys",
       maxTurns: 10,
       signal: new AbortController().signal,
       ...overrides,
     };
   }
   ```

   Test cases:
   - **Basic run (no tools):** MockProvider yields `[{ type: "text_delta", text: "hi" }, { type: "message_stop", stopReason: "end_turn" }]`. Use `collectEvents(agentLoop(params))`. Assert events include `text_delta` and terminal event `agent_done`. Assert `terminal.reason === "agent_done"`.
   - **Tool use then completion:** two turns. Turn 1: MockProvider yields `tool_use + message_stop(tool_use)`. Turn 2: MockProvider yields `text_delta + message_stop(end_turn)`. Assert events: `tool_use_start`, `tool_result` (not error), `turn_complete`, `text_delta`, `turn_complete`, `agent_done`. (Success criterion 7.2.)
   - **Max turns exceeded:** MockProvider always returns a tool-use turn. `maxTurns: 2`. Assert that after 2 `turn_complete` events, `max_turns_exceeded` is yielded with `turnsUsed: 2`. `terminal.reason === "max_turns_exceeded"`. (Success criterion 7.5.)
   - **API error:** MockProvider throws on `stream()`. Assert `agent_error` event is yielded; `terminal.reason === "agent_error"`. Generator exhausts. (Success criterion 7.6.)
   - **Empty assistant turn:** MockProvider yields only `message_stop(end_turn)` (no text, no tools). Assert: no assistant message pushed to workingMessages (cannot push empty content), `turn_complete` then `agent_done` emitted.

5. **Run `pnpm --filter tiny-agentic test`** — all tests pass (collect, env-context, anthropic-mapper, retry, runTools, loop).

6. **Run `pnpm --filter tiny-agentic typecheck`** — no errors.

## Acceptance criteria

- [ ] `pnpm --filter tiny-agentic test` passes with all `runTools.test.ts` and `loop.test.ts` tests green, plus all prior tests.
- [ ] `pnpm --filter tiny-agentic typecheck` exits with code 0.
- [ ] Success criterion 7.2 (tool use end-to-end) covered by `loop.test.ts` test.
- [ ] Success criterion 7.3 (tool error recovery) covered by `runTools.test.ts` test.
- [ ] Success criterion 7.4 (unknown tool handling) covered by `runTools.test.ts` test.
- [ ] Success criterion 7.5 (max turns safety) covered by `loop.test.ts` test.
- [ ] Success criterion 7.6 (API error handling) covered by `loop.test.ts` test.
- [ ] `LoopParams` is exported from `loop/loop.ts` (task 08 depends on it).
- [ ] `runTools` never throws — verify by reading the code: every `await tool.call(...)` is inside `try/catch`.

## Output files

- Created: `packages/core/src/loop/runTools.ts`
- Created: `packages/core/src/loop/loop.ts`
- Created: `packages/core/src/__tests__/runTools.test.ts`
- Created: `packages/core/src/__tests__/loop.test.ts`

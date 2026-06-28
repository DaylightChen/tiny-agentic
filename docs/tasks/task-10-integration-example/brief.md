# Task 10 — Integration Example

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Write a runnable example script (`examples/basic-run.ts`) that exercises the entire `tiny-agentic` core package against the real Anthropic API. At the end of this task:

- `examples/basic-run.ts` can be run with `ANTHROPIC_API_KEY=<key> pnpm tsx examples/basic-run.ts` and produces streaming text output from the model.
- The script demonstrates: tool registration (readFileTool + writeFileTool), NodePlatform, event streaming to stdout, multi-turn history threading.
- All 14 success criteria have a described observation path (either the test suite, lint/typecheck checks, or this example).

This is the final validation layer — the unit test suite exercises mocked paths; this script exercises the real Anthropic SDK path end-to-end. It is not published or run in CI (requires `ANTHROPIC_API_KEY`); it is a developer-run integration check.

## Context files

- `docs/brainstorm/2026-06-26-tiny-agentic-design.md` — §7 (all 14 success criteria to verify)
- `docs/engineering/2026-06-27-engineering-spec.md` — §8.4 (unit vs integration boundary), §11 (built-in tools)
- `packages/core/package.json` — exports map (which import paths to use)
- `packages/core/src/index.ts` (task 08) — what `"tiny-agentic"` exports
- `packages/core/src/platform/node.ts` (task 03) — what `"tiny-agentic/platform/node"` exports
- `packages/core/src/providers/anthropic.ts` (task 06) — what `"tiny-agentic/providers/anthropic"` exports
- `packages/core/src/utils/collect.ts` (task 03) — what `"tiny-agentic/utils"` exports

## Downstream dependencies

None — this is the final task. The example is a throwaway driver, not depended on by any other package.

## Steps

   **Prerequisite (already done in task 01):** `examples/` is a workspace package (`examples/package.json` with `"dependencies": { "tiny-agentic": "workspace:*" }`, and `examples` listed in `pnpm-workspace.yaml`). This is what makes the bare `import { ... } from "tiny-agentic"` specifiers below resolve — pnpm symlinks the core package into `examples/node_modules`. If for any reason that wiring is missing, fix it in task 01's outputs (do not work around it with deep `dist/` relative imports).

1. **Add `tsx` as a root devDependency** (or use `--import tsx` with Node — check current Node 22 support for TypeScript execution). The recommended approach for running TypeScript scripts directly in a pnpm workspace:
   - Add `"tsx": "^4.0.0"` to root `package.json` `devDependencies`.
   - Run `pnpm install` to resolve it.
   - Add a root script: `"example": "tsx examples/basic-run.ts"`.

   The example imports `tiny-agentic` via its public `exports` map, which points at `dist/`. So the core package must be built first (`pnpm --filter tiny-agentic build`, see step 5) before the example runs — `tsx` does not transpile the dependency, only the example file itself.

2. **Write `examples/basic-run.ts`:**

   ```ts
   #!/usr/bin/env tsx
   /**
    * basic-run.ts — tiny-agentic integration example
    *
    * Run: ANTHROPIC_API_KEY=<key> pnpm tsx examples/basic-run.ts
    *
    * Exercises: tool registration, NodePlatform, event streaming, multi-turn threading.
    * Demonstrates all major AgentEvent types.
    * Not run in CI — requires a real Anthropic API key.
    */

   import { Agent, readFileTool, writeFileTool, type Message } from "tiny-agentic";
   import { AnthropicProvider } from "tiny-agentic/providers/anthropic";
   import { NodePlatform } from "tiny-agentic/platform/node";
   import { collectText } from "tiny-agentic/utils";

   const apiKey = process.env["ANTHROPIC_API_KEY"];
   if (!apiKey) {
     console.error("Error: ANTHROPIC_API_KEY environment variable is required.");
     process.exit(1);
   }

   const provider = new AnthropicProvider({
     apiKey,
     // Must be a currently-valid Anthropic model id. The spec standardizes on
     // claude-opus-4-8; for a throwaway example making ~4 calls, a cheaper id
     // such as "claude-haiku-4-5" or "claude-sonnet-4-6" is also fine. Do NOT
     // use "claude-opus-4-5" (not a valid id — the call would 404).
     model: "claude-opus-4-8",
     logger: (entry) => {
       if (entry.event === "request_sent") {
         console.error(`[provider] request sent (${entry.request.messages.length} messages, ${entry.request.tools.length} tools)`);
       }
     },
   });

   const agent = new Agent({
     provider,
     tools: [readFileTool, writeFileTool],
     platform: new NodePlatform(),
     systemPrompt: "You are a helpful assistant. Keep responses concise.",
     maxTurns: 10,
   });

   // --- Turn 1: simple Q&A (no tools needed) ---
   console.log("\n=== Turn 1: Simple Q&A ===");
   let history: Message[] = [];

   for await (const event of agent.run("What is 2 + 2? Reply with just the number.", { messages: history })) {
     switch (event.type) {
       case "text_delta":
         process.stdout.write(event.text);
         break;
       case "tool_use_start":
         console.log(`\n[calling tool: ${event.toolName}]`);
         break;
       case "tool_result":
         console.log(`[tool result: isError=${event.isError}, result=${JSON.stringify(event.result).slice(0, 80)}]`);
         break;
       case "agent_done":
         history = event.messages;
         console.log("\n[agent done]");
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

   // --- Turn 2: multi-turn continuation (success criterion 7.9) ---
   console.log("\n=== Turn 2: Multi-turn continuation ===");

   for await (const event of agent.run("What did I just ask you? Repeat my question back to me.", { messages: history })) {
     if (event.type === "text_delta") process.stdout.write(event.text);
     if (event.type === "agent_done") {
       history = event.messages;
       console.log("\n[agent done, total messages:", history.length, "]");
     }
   }

   // --- Turn 3: tool use (read this script file) ---
   console.log("\n=== Turn 3: Tool use (read_file) ===");

   for await (const event of agent.run(
     `Read the file at "examples/basic-run.ts" and tell me what it does in one sentence.`
   )) {
     switch (event.type) {
       case "text_delta": process.stdout.write(event.text); break;
       case "tool_use_start": console.log(`\n[calling: ${event.toolName}(${JSON.stringify(event.toolInput)})]`); break;
       case "tool_result": console.log(`[result: isError=${event.isError}]`); break;
       case "turn_complete": console.log(`[turn ${event.turnIndex} complete]`); break;
       case "agent_done": console.log("\n[agent done]"); break;
       case "agent_error": console.error("\n[agent error]", event.error.message); process.exit(1); break;
     }
   }

   // --- collectText convenience (success criterion reference) ---
   console.log("\n=== collectText demo ===");
   const text = await collectText(agent.run("Say 'hello world' and nothing else."));
   console.log("collectText result:", text);

   console.log("\n=== All turns complete. Integration example finished. ===");
   ```

   Important notes:
   - The script uses top-level `await`, which requires ES-module context. `examples/package.json` (created in task 01) already sets `"type": "module"`, and modern `tsx` handles top-level await in `.ts` files.
   - Import paths use the public entry points from `"tiny-agentic"` (resolved via the workspace symlink), not deep `src`/`dist` relative imports.

3. **Confirm `examples/package.json` exists** (created in task 01) with `"type": "module"`, `"private": true`, and `"dependencies": { "tiny-agentic": "workspace:*" }`. If it is missing the `tiny-agentic` dependency, add it and re-run `pnpm install` — without it the bare import will not resolve.

4. **Add tsx to root devDependencies and run `pnpm install`.**

5. **Build the core package** (`pnpm --filter tiny-agentic build`) so the exports map resolves correctly when `tsx` imports from `"tiny-agentic"`. Alternatively, configure the example to use the workspace link via pnpm's resolution.

6. **Run the example** with a real API key:
   ```bash
   ANTHROPIC_API_KEY=<your-key> pnpm tsx examples/basic-run.ts
   ```

   Verify:
   - Turn 1: model responds with "4" (or similar), `agent_done` fires.
   - Turn 2: model echoes back the previous question — confirms multi-turn threading works (history was passed).
   - Turn 3: `tool_use_start` event fires for `read_file`, `tool_result` fires (not error), model describes what the file does.
   - `collectText` returns "hello world" (or similar).

7. **Verify all 14 success criteria are now observable:**
   - 7.1 Basic run: Turn 1 above.
   - 7.2 Tool use end-to-end: Turn 3 above.
   - 7.3 Tool error recovery: covered by runTools.test.ts.
   - 7.4 Unknown tool handling: covered by runTools.test.ts.
   - 7.5 Max turns safety: covered by loop.test.ts.
   - 7.6 API error handling: covered by agent.test.ts / try with bad key.
   - 7.7 Provider abstraction compile-check: typecheck passes.
   - 7.8 Platform abstraction compile-check: typecheck passes.
   - 7.9 Multi-turn threading: Turn 2 above confirms history was threaded.
   - 7.10 Type safety: `pnpm -r typecheck` passes (task 09).
   - 7.11 No UI imports: lint passes (task 09).
   - 7.12 No core fs/process imports: lint passes (task 09).
   - 7.13 Env context injection: logger output in Turn 1 shows request sent; env-context.test.ts covers content.
   - 7.14 Logger off by default: no console output during run when no logger is passed.

## Acceptance criteria

- [ ] `pnpm tsx examples/basic-run.ts` (with valid `ANTHROPIC_API_KEY`) exits with code 0 and produces streaming output.
- [ ] Turn 1 output: model responds to "What is 2 + 2?" with text, followed by `[agent done]`.
- [ ] Turn 2 output: model references the question from Turn 1 — confirms history threading works.
- [ ] Turn 3 output: `[calling: read_file(...)]` appears before the model's response — confirms tool invocation.
- [ ] `collectText` result is printed and is a non-empty string.
- [ ] `pnpm -r build` exits with code 0 (the core package builds; `sdk`/`ui` have no build script and are skipped by `pnpm -r` — this is expected).
- [ ] `pnpm -r test` exits with code 0 (all unit tests pass).
- [ ] `pnpm -r typecheck` exits with code 0 (core, sdk, ui — all three have a `typecheck` script).
- [ ] `pnpm lint` exits with code 0.

## Output files

- Created: `examples/basic-run.ts`
- Modified: `examples/package.json` (created in task 01; only touched here if the `tiny-agentic` dependency or `"type": "module"` needs correcting)
- Modified: root `package.json` (add `tsx` devDependency, add `example` script)

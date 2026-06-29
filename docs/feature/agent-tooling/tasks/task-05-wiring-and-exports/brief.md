# Task 05 — Wiring, Exports, and Integration

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Connect all prior tasks into a working whole: populate `context.signal` in `agentLoop`, thread `approvalHandler` from `Agent` through `agentLoop` to `runTools`, export `bashTool`, `editFileTool`, `ApprovalDecision`, and `ApprovalHandler` from the public `index.ts` entry point, and add an end-to-end abort-propagation integration test that proves the full signal chain works.

After this task, the feature is complete. A consumer can:
1. Import `bashTool`, `editFileTool`, `ApprovalDecision`, `ApprovalHandler` from `"tiny-agentic"`.
2. Construct `new Agent({ ..., approvalHandler })` and have the handler gate every tool call.
3. Break out of `agent.run()` (or call `.return()`) and have any in-flight `bash` shell process receive SIGTERM.

This is the integration capstone. Every individual piece was built and tested in tasks 01–04; this task wires them and adds the end-to-end test.

## Context files

- `packages/core/src/loop/loop.ts` — current state after task-04: `LoopParams` has `approvalHandler?` but `agentLoop` does not yet use it; `context` is constructed as `{}` (no `signal`). Both must be fixed here.
- `packages/core/src/agent.ts` — current state after task-04: stores `this.approvalHandler` but does not pass it to `agentLoop`. Must be fixed here.
- `packages/core/src/index.ts` — current state: exports `readFileTool`, `writeFileTool` but not `bashTool`/`editFileTool`/approval types. Must be extended.
- `packages/core/src/tools/builtin/bash.ts` — built in task-02; to be re-exported.
- `packages/core/src/tools/builtin/editFile.ts` — built in task-03; to be re-exported.
- `packages/core/src/types/tool.ts` — has `ApprovalDecision` and `ApprovalHandler` (task-04); to be re-exported.
- `packages/core/src/__tests__/agent.test.ts` — existing agent integration tests; must still pass. Read this to understand the mock pattern for `Agent` tests.
- `docs/feature/agent-tooling/engineering/2026-06-29-agent-tooling-engineering.md` — §8.4 (full signal chain diagram), §6.1 (module change summary), §11 (success criteria), §12 (integration test strategy: abort propagation)
- `docs/feature/agent-tooling/decisions.md` — OQ-7 (`context.signal` lifetime), OQ-8 (export names)

## Downstream dependencies

This is the last task; there are no downstream tasks. This task's outputs are the public surface of the feature:
- `"tiny-agentic"` now exports `bashTool`, `editFileTool`, `ApprovalDecision`, `ApprovalHandler`.
- The abort propagation chain is live end-to-end.

## Steps

1. **Edit `packages/core/src/loop/loop.ts`** — two changes:

   **a. Populate `context.signal`** — change the context construction line from:
   ```ts
   const context: ToolCallContext = {};
   ```
   to:
   ```ts
   const { ..., signal } = params;  // signal is already destructured; just add it to context
   const context: ToolCallContext = { signal };
   ```
   The `signal` is already destructured from `params` at the top of `agentLoop`. Simply include it in the context literal.

   **b. Thread `approvalHandler` into `runTools`** — extract `approvalHandler` from `params` (it is already on `LoopParams` from task-04), and pass it as the fifth argument to `runTools`:
   ```ts
   const { provider, registry, platform, systemPrompt, maxTurns, signal, approvalHandler } = params;
   ```
   And in the `runTools` call:
   ```ts
   for await (const toolEvent of runTools(pendingToolUses, registry, platform, context, approvalHandler)) {
   ```

2. **Edit `packages/core/src/agent.ts`** — pass `approvalHandler` to `agentLoop` in the `run()` method:
   ```ts
   return yield* agentLoop({
     provider: this.provider,
     registry,
     platform: this.platform,
     messages: workingMessages,
     systemPrompt,
     maxTurns: this.maxTurns,
     signal: abortCtrl.signal,
     approvalHandler: this.approvalHandler,  // NEW
   });
   ```

3. **Edit `packages/core/src/index.ts`** — add four new exports:
   ```ts
   export { bashTool } from "./tools/builtin/bash.js";
   export { editFileTool } from "./tools/builtin/editFile.js";
   export type { ApprovalDecision, ApprovalHandler } from "./types/tool.js";
   ```
   Place these after the existing `writeFileTool` export. Also re-export `approvalHandler` from `AgentOptions` — the type is already re-exported transitively through `AgentOptions`; confirm `ApprovalHandler` is independently importable from `"tiny-agentic"`.

4. **Add an abort-propagation integration test** — add a new test file `packages/core/src/__tests__/agent-tooling-integration.test.ts` (or extend `agent.test.ts` if preferred — a new file is cleaner).

   The integration test validates the full signal chain: `Agent.run()` → abort → `context.signal` fires → `platform.exec` receives the signal → shell process terminated.

   Since live `child_process` in a test is slow and platform-dependent, use a mock platform whose `exec` inspects the passed `signal` and simulates an abort:

   ```ts
   it("forwards context.signal to platform.exec when the run is aborted", async () => {
     // A mock platform whose exec captures the signal and resolves normally
     let capturedSignal: AbortSignal | undefined;
     const mockPlatform: Platform = {
       cwd: () => "/work",
       readFile: () => Promise.reject(new Error("not used")),
       writeFile: () => Promise.resolve(),
       exec: async (cmd, opts) => {
         capturedSignal = opts?.signal;
         return { stdout: "done", stderr: "", exitCode: 0 };
       },
     };

     // A mock provider that immediately returns a tool_use for bash
     // (reuse the mock provider pattern from agent.test.ts)

     const agent = new Agent({
       provider: mockProvider,
       tools: [bashTool],
       platform: mockPlatform,
     });

     for await (const event of agent.run("run a command")) {
       if (event.type === "tool_result") break; // stop after tool executes
     }

     expect(capturedSignal).toBeDefined();
     expect(capturedSignal).toBeInstanceOf(AbortSignal);
   });
   ```

   Additionally, add an `approvalHandler` end-to-end test using the same pattern:
   ```ts
   it("approvalHandler can deny a bash call end-to-end", async () => {
     const agent = new Agent({
       provider: mockProvider, // returns bash tool_use
       tools: [bashTool],
       platform: mockPlatform,
       approvalHandler: async () => "deny",
     });

     const events: AgentEvent[] = [];
     for await (const event of agent.run("run a command")) {
       events.push(event);
     }

     const toolResult = events.find(e => e.type === "tool_result");
     expect(toolResult).toBeDefined();
     expect((toolResult as Extract<AgentEvent, {type: "tool_result"}>).isError).toBe(true);
     expect(String((toolResult as Extract<AgentEvent, {type: "tool_result"}>).result))
       .toContain("call denied by approvalHandler");
   });
   ```

   Read `packages/core/src/__tests__/agent.test.ts` before writing this test — it shows the exact mock provider pattern to reuse.

5. **Run the full test suite**:
   ```
   cd packages/core && pnpm test
   ```
   Expected: all prior tests pass (140) plus new integration test(s).

6. **Run typecheck** and lint:
   ```
   cd packages/core && pnpm typecheck
   cd packages/core && pnpm lint
   ```
   Both must pass with zero errors.

7. **Verify export surface** — confirm the new symbols are accessible:
   ```ts
   // In a temp file or in the test:
   import { bashTool, editFileTool, ApprovalDecision, ApprovalHandler } from "tiny-agentic";
   ```
   `pnpm typecheck` will catch any missing or mis-spelled export.

8. **Verify no new Node built-in imports outside `platform/node.ts`**:
   ```
   grep -rn "child_process\|from 'fs'\|from \"fs\"\|process\.env\|process\.cwd" \
     packages/core/src --include="*.ts" | grep -v "platform/node.ts" | grep -v "__tests__"
   ```
   Expected: no matches.

## Acceptance criteria

- [ ] `pnpm test` (in `packages/core`) passes: all 140 prior tests plus new integration tests.
- [ ] `pnpm typecheck` reports zero errors.
- [ ] `pnpm lint` reports zero errors.
- [ ] `context.signal` is set to the run's `AbortSignal` inside `agentLoop` — verified by the integration test asserting `capturedSignal` is defined and is an `AbortSignal`.
- [ ] `approvalHandler` returning `'deny'` end-to-end (via `new Agent({..., approvalHandler})`) produces an `isError: true` tool_result with `"call denied by approvalHandler"` — verified by integration test.
- [ ] `bashTool` is importable from `"tiny-agentic"` (verified by `pnpm typecheck`).
- [ ] `editFileTool` is importable from `"tiny-agentic"` (verified by `pnpm typecheck`).
- [ ] `ApprovalDecision` and `ApprovalHandler` types are importable from `"tiny-agentic"` (verified by `pnpm typecheck`).
- [ ] No new `child_process`/`fs`/`process` imports outside `platform/node.ts` (verified by grep in step 8).
- [ ] Constructing `new Agent({...})` without `approvalHandler` still works, all prior agent tests pass (regression gate).

## Output files

- Modified: `packages/core/src/loop/loop.ts`
- Modified: `packages/core/src/agent.ts`
- Modified: `packages/core/src/index.ts`
- Created: `packages/core/src/__tests__/agent-tooling-integration.test.ts`

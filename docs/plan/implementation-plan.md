# Implementation Plan — tiny-agentic Milestone 1 (Core Package)

> Written in the plan phase by the `planner` agent. Lives at `docs/plan/implementation-plan.md`.

## Goal

Build the `tiny-agentic` core package end-to-end: a headless, UI-free TypeScript agentic engine that runs a stateless agent loop, executes tools, streams events, and terminates cleanly. When every task in this plan is committed, a developer can `npm install tiny-agentic zod @anthropic-ai/sdk`, point the library at a real Anthropic API key, register Zod-typed tools, and run a multi-turn agent via `for await (const event of agent.run(prompt))`. The monorepo skeleton (pnpm workspaces, shared tsconfig, ESLint boundary rules) is wired from task 1. The two placeholder packages (`tiny-agentic-sdk`, `tiny-agentic-ui`) exist as stubs. The core package contains: all shared types, the Platform interface and NodePlatform implementation, the ToolRegistry, env-context builder, Anthropic provider (mapper + streaming + retry utility), the agent loop (agentLoop + runTools), the Agent class, built-in tools (readFileTool, writeFileTool), collect utilities, and a public index. Every unit is tested with MockProvider/MockPlatform. An integration example script proves the end-to-end path against the real Anthropic API.

---

## Task list

1. **task-01-repo-scaffold** — Set up the pnpm monorepo skeleton: workspace config, root tsconfig base, root ESLint config, .node-version, package.json scripts, and the three placeholder packages (core as stub, sdk and ui as empty placeholders). Verify `pnpm install` succeeds and the boundary lint rules compile.

2. **task-02-core-types** — Implement all shared types in `packages/core/src/types/`: `messages.ts`, `platform.ts`, `tool.ts` (with `defineTool`), `provider.ts` (ToolSchema, ProviderRequest, ProviderEvent, Provider, LogEntry, Logger), and `events.ts` (AgentEvent, Terminal). Add core-package build config (tsup, vitest, package.json exports map). Verify `tsc --noEmit` is clean.

3. **task-03-platform-node** — Implement `packages/core/src/platform/node.ts` (`NodePlatform` class: `cwd`, `readFile`, `writeFile`, `exec`). Implement `packages/core/src/utils/serialize.ts` (`serializeToolResult`). Implement `packages/core/src/utils/collect.ts` (`collectText`, `collectEvents`). Write unit tests for `serialize.ts` and `collect.ts`. Verify build and typecheck pass.

4. **task-04-tool-registry-and-env-context** — Implement `packages/core/src/tools/registry.ts` (`ToolRegistry` class with `findByName` and `toSchemas` via `zod-to-json-schema`). Implement `packages/core/src/env/context.ts` (`buildEnvContext`). Write `env-context.test.ts` with `MockPlatform`. Verify all tests pass.

5. **task-05-anthropic-mapper** — Implement `packages/core/src/providers/anthropic-mapper.ts`: `mapRequest` (ProviderRequest → Anthropic params), `InputAccumulator` (per-block `input_json_delta` accumulation), and `translateStreamEvent` (Anthropic stream event → ProviderEvent[]). Write `anthropic-mapper.test.ts` covering text streaming, tool-use streaming with multi-block accumulation, JSON parse error sentinel, and message_stop. Verify all tests pass.

6. **task-06-anthropic-provider-and-retry** — Implement `packages/core/src/providers/retry.ts` (`withRetry` generic utility). Implement `packages/core/src/providers/anthropic.ts` (`AnthropicProvider` class: constructor with validation, `stream()` delegating to Anthropic SDK with `AbortSignal`, logger hook). Verify `tsc --noEmit` is clean; verify retry utility unit tests pass.

7. **task-07-loop-runtools** — Implement `packages/core/src/loop/runTools.ts` (sequential tool execution, unknown-tool and Zod-validation error paths, try/catch around `tool.call`). Implement `packages/core/src/loop/loop.ts` (`agentLoop` generator: max-turns guard, streaming turn, assistant-message accumulation, tool-result bundling, natural completion, error path). Write `runTools.test.ts` and `loop.test.ts`. Verify all tests pass.

8. **task-08-agent-and-index** — Implement `packages/core/src/agent.ts` (`Agent` class: constructor, `run()` generator with AbortController wiring and `yield* agentLoop`). Implement `packages/core/src/tools/builtin/readFile.ts` and `writeFile.ts`. Implement `packages/core/src/index.ts` (public re-exports). Write `agent.test.ts` covering: basic run, multi-turn threading, API error, provider/platform abstraction compile-check, logger-off-by-default. Verify all tests pass and `pnpm -r build` succeeds.

9. **task-09-lint-and-boundary-verification** — Wire the ESLint boundary rules fully across the workspace (no-restricted-imports for core, sdk boundary). Run `eslint packages/core/src --max-warnings 0` and fix any violations. Run `tsc --noEmit` across all packages. Run the full test suite. Confirm success criteria 7.10, 7.11, 7.12 are all machine-verified.

10. **task-10-integration-example** — Write `examples/basic-run.ts`: a runnable driver script that calls the real Anthropic API with `readFileTool` and `writeFileTool`, streams events to stdout, and demonstrates multi-turn history threading. Write instructions in a top-level README (or inline script header) on how to run it with `ANTHROPIC_API_KEY`. Confirm the script runs end-to-end against the real API and all 14 success criteria are verifiable.

---

## Dependency rationale

### Vertical slice first

Task 1 (repo-scaffold) is the vertical slice: it creates the pnpm workspace, the shared tsconfig base, the ESLint config file, and all three package stubs. Any toolchain incompatibility (pnpm version, Node version, tsup/vitest resolution) surfaces before any feature work. A broken scaffold in task 1 costs nothing; discovering it in task 7 unwinds six committed tasks.

### Foundation before features

**Types before everything (task 2).** Every module in the core — loop, provider, tools, agent — imports from `types/`. These types are the contracts. They must be committed before any downstream implementation can be compiled or tested. Task 2 also wires the build tooling (tsup, vitest.config, package.json exports map), so every later task can run `pnpm build` and `pnpm test` in the same session.

**Platform utilities before higher-level modules (task 3).** `NodePlatform` implements the `Platform` interface (used by tools and the loop). `serializeToolResult` is used by `loop/loop.ts`. `collectText`/`collectEvents` are used in tests from task 7 onward. Getting these right early means every later test can rely on them.

**Registry and env context before loop (task 4).** `ToolRegistry` is constructed in `agent.run()` (task 8) and consumed in `agentLoop` (task 7). `buildEnvContext` is called in `agent.run()`. Both must be stable before the agent and loop are implemented.

**Mapper before provider (task 5 before 6).** `AnthropicProvider` imports the mapper. Testing the mapper in isolation (with fixture streaming event sequences) is far easier and more precise than testing it through the full provider. The mapper is also the most complex algorithmic piece (per-block JSON accumulation state machine); putting it in its own task with targeted tests reduces risk.

**Provider before loop (task 6 before 7).** The loop's test suite uses `MockProvider`, not the real `AnthropicProvider`. However, the loop type-checks against the `Provider` interface, and the loop brief references provider types. Having the provider committed (even if unused in tests) means the interface is real rather than described by comments.

**Loop before Agent (task 7 before 8).** `agent.ts` delegates to `agentLoop` via `yield*`. The Agent is a thin shell around the loop; it cannot be implemented or meaningfully tested until the loop is real.

**Agent and index before lint/boundary check (task 8 before 9).** The lint check is meaningful only when the full module graph exists. Running it on a partial codebase gives false confidence.

**Lint and boundary before integration example (task 9 before 10).** The integration example is the final validation layer. It should run against a fully verified, clean codebase.

### Risk-ordered

The **Anthropic mapper** (task 5) is the highest-risk piece: stateful per-block streaming accumulation, JSON parse error handling, and precise translation of a third-party SDK's streaming protocol. By placing it at task 5 (not task 8 or 9), any discovery about the SDK's actual streaming event shapes (vs. what the spec documents) has two tasks of buffer before the loop depends on it.

The **loop control flow** (task 7) is the second-highest-risk piece: the interplay of `yield*`, `try/catch` around streaming, tool-result bundling, and the AbortController wiring. Placing it at task 7 (after types, platform, registry, mapper, provider are all real) means the loop implementer is coding against committed interfaces, not assumptions.

### Non-obvious ordering choices

- `serialize.ts` is placed in task 3 (with platform/node) rather than task 7 (with the loop that uses it) because it is also used as a test utility from task 7 onward and belongs with the other small utility modules.
- `retry.ts` is placed in task 6 (with the provider) rather than task 4 (with other utilities) because its only purpose is provider-related and it must be tested alongside the provider module.
- Built-in tools (`readFile.ts`, `writeFile.ts`) are placed in task 8 (with the Agent and index) rather than an earlier task because they are simple wrappers over `defineTool` + `Platform` — they add no testing complexity to the Agent task — and their correct wiring is verified by the integration example in task 10.
- ESLint boundary verification is task 9 (its own task) rather than folded into task 1 because the boundary rules can only be meaningfully validated when the full import graph exists. Task 1 creates the config file; task 9 runs the check against real code.
- The `tsup` config declares four entry points (`index`, `providers/anthropic`, `platform/node`, `utils/collect`) from task 1, but three of those files are not implemented until tasks 3 and 6. Because tsup/esbuild hard-errors on a missing entry, task 1 creates all three as `export {}` stubs (replaced in place by tasks 3 and 6). This keeps `pnpm build` green at every task rather than only from task 6 onward.
- `examples/` is a workspace package (declared in `pnpm-workspace.yaml`, created in task 1) with a `tiny-agentic` workspace dependency, so the task-10 integration script can resolve the public `"tiny-agentic"` bare specifier via a pnpm symlink. `examples/` sits outside `packages/*` and pnpm does not hoist workspace packages to the repo root, so this explicit membership is required.

---

## Coverage check

### Coverage by upstream section

#### Product spec (brainstorm: `docs/brainstorm/2026-06-26-tiny-agentic-design.md`)

| Product spec section | Task(s) | Notes |
|---|---|---|
| Feature 1 — Stateless async-generator agent loop | task-07, task-08 | agentLoop + Agent.run() |
| Feature 2 — Tool interface, registry, platform-injected execution | task-02 (types), task-04 (registry), task-03 (platform), task-08 (built-ins) | |
| Feature 2 — Extensible ToolCallContext (SDK seam) | task-02 | Interface declared empty in M1, open for merging |
| Feature 3 — Anthropic provider with streaming | task-05, task-06 | Mapper + provider |
| Feature 4 — Env context in system prompt | task-04 | buildEnvContext |
| Feature 5 — Platform capability interface + NodePlatform | task-02 (interface), task-03 (implementation) | |
| §5.1 Primary flow (install → define tools → run) | task-08, task-10 | index.ts + example |
| §5.2 Flow A — Multi-turn threading | task-08 (agent.test.ts) | |
| §5.2 Flow B — Tool error graceful recovery | task-07 (runTools.test.ts) | |
| §5.2 Flow C — API error handling (retry + agent_error) | task-06, task-07 | |
| §5.2 Flow D — Max turns exceeded | task-07 (loop.test.ts) | |
| §5.2 Flow E — Concurrent independent runs | task-08 (type-level, stateless per-run) | |
| §5.2 Flow F — Custom system prompt | task-08 (agent.ts concatenation) | |
| §5.2 Flow G — Mock platform for testing | task-03, task-07, task-08 (MockPlatform in tests) | |
| §5.2 Flow H — Logger callback | task-06 (provider logger hook) | |
| §5.3 States matrix — text streaming, tool invocation, tool result, turn complete, agent done, max turns, provider error, schema validation failure | task-07, task-08 | All states exercised in loop + agent tests |
| §5.6 Microcopy — error message strings | task-06, task-07, task-08 | Exact strings per spec §6 error format |
| §5.6 Microcopy — exported symbol names | task-08 (index.ts) | |
| §5.7 Loop exit conditions | task-07, task-08 | |
| §5.7 Tool concurrency seam (isConcurrencySafe hook) | task-07 | Sequential M1; seam documented in runTools |

#### Engineering spec (§1–§11)

| Engineering spec section | Task(s) | Notes |
|---|---|---|
| §1 — Monorepo layout (pnpm, packages/, workspace config) | task-01 | |
| §1.1 — pnpm workspaces | task-01 | pnpm-workspace.yaml |
| §1.2 — Root layout (pnpm-workspace.yaml, tsconfig.base.json, .node-version, .npmrc) | task-01 | |
| §1.3 — Package identity (core 0.1.0, sdk/ui 0.0.0 placeholders) | task-01 | |
| §1.4 — One-way dependency enforcement (package.json deps + lint rule) | task-01, task-09 | Structural in task 01; lint verified in task 09 |
| §1.5 — Node >=18, ESM, module:Node16 | task-01, task-02 | tsconfig.base + package.json engines |
| §1.6 — Build tool (tsup), shared tsconfig | task-01 (root tsconfig), task-02 (tsup config per package) | |
| §1.7 — Test runner (Vitest) | task-02 (vitest.config.ts) | |
| §2.1 — Module map (all files in packages/core/src/) | task-02 through task-08 | Each task creates its slice |
| §2.2 — Exports map (package.json exports field) | task-02 | |
| §2.3 — Module dependency DAG (no cycles) | task-09 (lint check), task-02 through task-08 (structural) | |
| §3.1 — Message types (TextBlock, ToolUseBlock, ToolResultBlock, ContentBlock, Message) | task-02 | |
| §3.2 — Platform interface + ExecOptions + ExecResult | task-02 | |
| §3.3 — ToolCallContext (empty interface, open for merging) | task-02 | |
| §3.4 — Tool interface + defineTool | task-02 | |
| §3.5 — ToolSchema (JSON Schema via zod-to-json-schema, openApi3) | task-02 (type), task-04 (serialization) | |
| §3.6 — ProviderRequest, ProviderEvent, Provider, AbortSignal as 2nd arg | task-02 | |
| §3.7 — AgentEvent union | task-02 | |
| §3.8 — Terminal return type | task-02 | |
| §3.9 — Agent class + AgentOptions + RunOptions | task-08 | |
| §3.10 — collectText, collectEvents | task-03 | |
| §3.11 — LogEntry, Logger | task-02 | |
| §3.12 — AnthropicProvider class signature | task-06 | |
| §4.1 — Loop setup (AbortController, workingMessages, envCtx, systemPrompt, registry) | task-08 | In agent.ts |
| §4.2 — Turn loop control flow (agentLoop) | task-07 | |
| §4.3 — runTools sequential execution | task-07 | |
| §4.4 — AbortController wiring (finally → abort) | task-08 | |
| §5.1 — Request mapping (mapRequest, mapMessages, mapTools) | task-05 | |
| §5.2 — Stream event translation (InputAccumulator, translateStreamEvent) | task-05 | |
| §5.3 — Retry model (withRetry utility; SDK delegates) | task-06 | |
| §5.4 — Logger hook (request_sent, retry_attempt, request_failed) | task-06 | |
| §6 — Edge cases 6.1–6.16 | task-05 (6.1 mapper-half, 6.8, 6.11, 6.12), task-07 (6.1 runTools-half, 6.2, 6.3, 6.4, 6.13, 6.16), task-08 (6.7, 6.9, 6.10), task-03 (6.6 serialize), task-04 (6.15) | 6.1 malformed tool input is split: task-05's mapper sets `input: {}` + `inputParseError: true`; task-07's runTools detects the flag (before Zod) and emits the dedicated message. 6.16 (platform op fails in a built-in tool) is unit-tested in task-07 via a MockPlatform that throws — structurally identical to 6.4 but exercised through the platform seam, so it has CI coverage |
| §6.5 — Tool hang (M1 known gap) | N/A — documented in known-issues | Deferred by design |
| §7 — Success criteria (14 items) | See success-criteria table below | |
| §8 — Testing strategy (MockProvider, MockPlatform, test files) | task-07, task-08 | Mocks defined in test files |
| §9 — Non-goals (EventEmitter, RxJS, stateful Agent, Generic Agent<TContext>, streaming tool exec, bundled SDK, monolith, npm ws, Jest) | N/A | Covered by architectural decisions; no tasks needed |
| §10.1 — AbortSignal threading to platform.exec | task-03 | Noted in NodePlatform implementation step |
| §10.2 — tool_use input_json_delta accumulation test | task-05 | Explicit test in anthropic-mapper.test.ts |
| §10.3 — zod-to-json-schema target + options | task-04 | In ToolRegistry.toSchemas() |
| §11 — Built-in tools (readFileTool, writeFileTool) | task-08 | |

#### Success criteria (§7 of product spec / §8.3 of engineering spec)

| Success criterion | Task(s) | Verification |
|---|---|---|
| 7.1 Basic agent run (no tools) | task-07, task-08, task-10 | MockProvider in agent.test.ts; real API in example |
| 7.2 Tool use end-to-end | task-07, task-08, task-10 | loop.test.ts + example |
| 7.3 Tool error recovery | task-07 | runTools.test.ts |
| 7.4 Unknown tool handling | task-07 | runTools.test.ts |
| 7.5 Max turns safety | task-07 | loop.test.ts |
| 7.6 API error handling | task-07, task-08 | agent.test.ts (MockProvider throws) |
| 7.7 Provider abstraction compile-check | task-08 | agent.test.ts (MockProvider compiles) |
| 7.8 Platform abstraction compile-check | task-08 | agent.test.ts (MockPlatform compiles) |
| 7.9 Multi-turn threading | task-08 | agent.test.ts |
| 7.10 Type safety (`tsc --strict`) | task-09 | CI typecheck across all packages |
| 7.11 No UI imports | task-09 | ESLint no-restricted-imports |
| 7.12 No core fs/process imports | task-09 | ESLint no-restricted-imports + no-restricted-globals |
| 7.13 Env context injection | task-04, task-08 | env-context.test.ts (builder output) + agent.test.ts (end-to-end: env block injected into the request `systemPrompt`) |
| 7.14 Logger off by default | task-06 | anthropic.test.ts (mock-SDK: no logger → zero console output when `stream()` runs; logger set → `request_sent` fires) |
| 7.15 Git-absent degradation | task-04 | env-context.test.ts (exec throws / non-zero exit → git lines omitted, returns normally, no error) |
| 7.16 Multiple tools in one turn | task-07 | loop.test.ts (two `tool_use` blocks → two `tool_result`s bundled into a single user message) |
| 7.17 Abort on abandonment | task-08 | agent.test.ts (break `for await` early → captured `AbortSignal.aborted === true`) |
| 7.18 Incremental streaming | task-07 | loop.test.ts (multiple `text_delta` events surface separately and in order before `turn_complete`) |

> Note: success criteria are now **1–18** (brainstorm) / **7.1–7.18** (engineering §8.3). 7.1–7.14 map 1:1 to the prior set; 7.15–7.18 were added in the Opus refine pass. The §6.1 malformed-tool-input path (mapper `inputParseError` flag → runTools dedicated message) is covered by task-05 (`anthropic-mapper.test.ts`) + task-07 (`runTools.test.ts`).

### Explicit deferrals

- **OpenAI provider** — M2 core work. Provider interface is designed for it; implementation is out of M1 scope. No task created.
- **Permission seam** — M2 core work. Blanket-allow in M1. No task created.
- **Sub-agent spawning** — M3+ core. No task created.
- **Session persistence, stateful Session wrapper, context compaction, memory** — SDK-layer. No task created.
- **TUI / CLI REPL / web UI** — UI-layer. No task created. The `examples/` script is a throwaway driver, not a shipped UI.
- **`packages/sdk` and `packages/ui` implementation** — M1 scope is core only. Both are empty placeholders created in task 1.
- **Per-tool timeout** — M1 known gap (edge case 6.5). Documented in known-issues. No task created.
- **Tool hang handling** — Same as above. Developer adds `Promise.race` in `call`; framework does not provide timeout in M1.
- **NodePlatform unit tests** — Per engineering spec §8.4, NodePlatform is not unit-tested in M1 (integration-tested via the example script). No dedicated test task created.
- **Cost/token tracking (message_start events)** — M2. `message_start` events are consumed but not surfaced by the mapper in M1. No task created.
- **`provider_retry` event** — engineering refine confirms it is **not feasible in M1** while retry is SDK-delegated (the Anthropic SDK exposes no public retry hook); `retry_attempt` logging is best-effort. Not in M1 event union. No task created.
- **Stream-idle watchdog** — edge case 6.17. M1 relies on the vendor SDK's request timeout; no engine-level idle watchdog (the reference's 90s `STREAM_IDLE_TIMEOUT_MS`). M2. Documented in known-issues. No task created.
- **Cooperative tool cancellation** — edge case 6.18. M1 aborts only the provider stream on abandonment; a tool's `call` is not interrupted. The seam is reserved (an optional `signal?` on `ToolCallContext`) but unused in M1. M2. No task created.

---

## Open questions

None. The engineering spec (§10) declares all open engineering questions resolved. This plan is ready for execution.

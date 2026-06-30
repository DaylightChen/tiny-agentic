# Implementation Plan — core-run-controls (feature/core-run-controls)

> Written in the plan phase by the `planner` agent. Lives at `docs/feature/core-run-controls/plan/implementation-plan.md`.
> Source design: `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md`.
> Locked decisions: `docs/feature/core-run-controls/decisions.md` (11 decisions).

## Goal

When every task in this plan is committed, `packages/core` gains two pure-core capabilities: (1) an external `AbortSignal` on `Agent.run()` via `RunOptions.signal?` — composed with the internal controller via `AbortSignal.any`, with a pre-flight guard for already-aborted signals — enabling parent agents, timeouts, and process-signal handlers to cancel an in-flight run; and (2) normalized cross-provider token usage (`Usage`) on every terminal `AgentEvent` (`agent_done`, `max_turns_exceeded`, `agent_error`) and the `Terminal` return value, plus optional per-turn usage on `turn_complete`, enabling the upcoming sub-agent Task tool to roll up child costs. Both providers capture and normalize usage from their native SDK events; the loop accumulates per-turn usage into a run-level total. The 196 existing tests continue to pass (after mechanically adding `usage: EMPTY_USAGE` to the 5 compile-breaking typed literals). All new exports are available from `tiny-agentic`.

## Task list

The order is the execution order. Sequential — each task starts from the committed state of the previous one.

1. **task-01-usage-foundation** — Create `types/usage.ts` (the `Usage` type, `EMPTY_USAGE`, `mergeUsage`, `accumulateUsage`), re-export from `index.ts`, and write a self-contained `usage.test.ts` with full coverage of the helpers.
2. **task-02-type-changes-and-test-fixes** — Update `types/events.ts` (add `usage: Usage` to terminal `AgentEvent` variants and `Terminal`; add `usage?: Usage` to `turn_complete`) and `types/provider.ts` (add `usage?: Usage` to `message_stop`); in the same commit, add `usage: EMPTY_USAGE` to the 5 compile-breaking typed literals in `__tests__/collect.test.ts` (L18/66/82) and `__tests__/types.test.ts` (L65/77) so the build stays green.
3. **task-03-external-abort-signal** — Extend `RunOptions` with `signal?: AbortSignal`, add `AbortSignal.any` composition and pre-flight abort guard in `agent.ts:run()`, and extend `agent.test.ts` with the three AbortSignal scenarios (pre-aborted, mid-run abort, no signal).
4. **task-04-loop-accumulation** — Wire usage accumulation into `agentLoop` in `loop/loop.ts`: declare `cumulativeUsage` at function scope, declare `turnUsage` as the FIRST statement inside `while(true)`, read `event.usage` from `message_stop`, call `accumulateUsage` after the inner `for await`, and attach `usage` to all three terminal event/return pairs and to `turn_complete`. Extend `loop.test.ts` with usage-accumulation scenarios.
5. **task-05-anthropic-usage-capture** — Add `setUsage`/`mergeInUsage`/`takeUsage` to `InputAccumulator` in `anthropic-mapper.ts` and add usage capture to `translateStreamEvent` for `message_start`, `message_delta`, and `message_stop` (conditional emit). Extend `anthropic-mapper.test.ts` with usage capture tests and update any `message_stop` deep-equality assertions affected by the conditional usage field.
6. **task-06-openai-usage-capture** — Add `setUsage`/`chunkUsage` to `ToolCallAccumulator` and restructure `translateChunk` to read `chunk.usage` before the `choices.length === 0` early-return in `openai-mapper.ts`; add `stream_options: { include_usage: true }` to `OpenAIChatCompletionParams` and `mapRequest`. Extend `openai-mapper.test.ts` with usage capture tests and update the `message_stop` deep-equality assertion at L671.

## Dependency rationale

**task-01 first: foundation before features.** The `Usage` type and helpers (`EMPTY_USAGE`, `mergeUsage`, `accumulateUsage`) are imported by every subsequent task — `types/events.ts`, `types/provider.ts`, `loop/loop.ts`, `anthropic-mapper.ts`, `openai-mapper.ts`, and `index.ts` all depend on them. Nothing else can compile until this module exists. `usage.test.ts` validates the helpers in isolation before they are used by the full accumulation chain; any arithmetic edge case (the `> 0` guard in `mergeUsage`, the optional `cacheWriteTokens` handling in `accumulateUsage`) is caught here, not buried in a higher-level test.

**task-02 immediately after: compile-breaking fix must happen before any other code depends on the new types.** Making `usage` non-optional on terminal events (`AgentEvent` variants and `Terminal`) is a breaking type change. The 5 hand-built typed literals in `collect.test.ts` (L18/66/82) and `types.test.ts` (L65/77) that omit `usage` become TS2741 compile errors the moment `events.ts` changes — vitest will not even run. These two concerns (updating `events.ts`/`provider.ts` and fixing the breaking literals) are therefore collapsed into one task. Splitting them would leave the branch in an uncompilable state between tasks, which violates the sequential model's invariant that each committed task produces a green build. After task-02 the type surface is settled and all downstream tasks (03, 04, 05, 06) build against stable types.

**task-03 (AbortSignal) after types, before loop.** The `agent.ts:run()` pre-flight guard yields `{ type: "agent_error", ..., usage: EMPTY_USAGE }`. This requires `EMPTY_USAGE` (task-01) and the updated `AgentEvent` type that includes `usage: Usage` on `agent_error` (task-02). Task-03 is otherwise independent of the usage accumulation wiring — it does not touch `loop.ts` or the providers. Placing it here lets the AbortSignal work be verified cleanly before loop changes add additional complexity.

**task-04 (loop accumulation) after types and signal, before providers.** `agentLoop` reads `event.usage` from `message_stop`, which requires the updated `ProviderEvent.message_stop` type (`usage?: Usage`) from task-02. It also constructs all three terminal event/return pairs with `usage: cumulativeUsage`, which requires the updated `AgentEvent`/`Terminal` types from task-02. Placing loop accumulation before the provider tasks means task-04 tests (with a MockProvider emitting bare `{ type: "message_stop", stopReason: "end_turn" }`) exercise the "no usage captured" path and produce `EMPTY_USAGE` terminals — validating the fallback path before the providers supply real usage.

**task-05 (Anthropic) and task-06 (OpenAI) after loop: both providers are independent of each other; loop must exist first.** The providers emit `message_stop` with `usage` — but only the loop reads that field. Until the loop wiring (task-04) is in place, a `message_stop` with `usage` would be silently dropped. Completing the loop first means task-05/06 can write end-to-end tests that trace usage all the way from a provider event through the loop to the terminal event. Task-05 before task-06 is an arbitrary risk-ordering choice: Anthropic has the more complex accumulation logic (two SDK events, `mergeUsage`, `asNullableNumber` guard, `cacheWriteTokens`) and schedules first.

**No scaffolding task needed.** This is a feature on a mature codebase. The stack is proven. The "prove the stack works" role is served by task-01's `pnpm -r test` run against the 196 existing tests (all of which should pass after task-01's purely additive change).

## Coverage check

### Coverage by engineering-spec section

| Engineering-spec section | Task(s) | Notes |
|---|---|---|
| §1 Goal: external `AbortSignal` on `Agent.run()` | task-03 | |
| §1 Goal: token usage on event stream + `Terminal` | task-01, task-02, task-04, task-05, task-06 | Type in task-01/02; loop in task-04; providers in task-05/06 |
| §3.1 Primary flow: cancellation | task-03 | |
| §3.1 Primary flow: usage reading | task-04, task-05, task-06 | |
| §3.2 States matrix: `agent_done` gains `usage` | task-02 (type), task-04 (wiring) | |
| §3.2 States matrix: `max_turns_exceeded` gains `usage` | task-02 (type), task-04 (wiring) | |
| §3.2 States matrix: `agent_error` gains `usage` | task-02 (type), task-04 (wiring), task-03 (pre-flight) | |
| §3.2 States matrix: `turn_complete` gains `usage?` | task-02 (type), task-04 (wiring) | |
| §3.2 States matrix: `Terminal` return gains `usage` | task-02 (type), task-04 (wiring) | |
| §3.3 Accessibility | N/A — headless library | Confirmed per spec §3.3 |
| §3.4 Edge case: pre-aborted signal | task-03 | Explicit pre-flight guard |
| §3.4 Edge case: signal abort during env-context build | N/A (deferred per spec §3.4) | Fires at first `provider.stream` call; out of scope |
| §3.4 Edge case: no usage on abort | task-04 (EMPTY_USAGE fallback), task-06 (OpenAI conditional flush) | |
| §3.4 Edge case: multi-turn partial usage | task-04 | accumulateUsage across turns |
| §3.4 Edge case: `cacheWriteTokens` absent on OpenAI | task-01 (optional field), task-06 (not set) | |
| §3.5 Microcopy | N/A — headless library | Confirmed per spec §3.5 |
| §6 Module change list: `types/usage.ts` (NEW) | task-01 | |
| §6 Module change list: `types/events.ts` | task-02 | |
| §6 Module change list: `types/provider.ts` | task-02 | |
| §6 Module change list: `agent.ts` | task-03 | |
| §6 Module change list: `loop/loop.ts` | task-04 | |
| §6 Module change list: `providers/anthropic-mapper.ts` | task-05 | |
| §6 Module change list: `providers/openai-mapper.ts` | task-06 | |
| §6 Module change list: `index.ts` | task-01 | Added alongside new module |
| §7 `Usage` type and `EMPTY_USAGE` constant | task-01 | |
| §7 Updated `AgentEvent` terminal variants (usage non-optional) | task-02 | |
| §7 Updated `Terminal` variants (usage non-optional) | task-02 | |
| §7 Updated `ProviderEvent.message_stop` (`usage?`) | task-02 | |
| §7 Updated `OpenAIChatCompletionParams` (`stream_options`) | task-06 | |
| §8 Anthropic provider field mapping | task-05 | `message_start` + `message_delta` |
| §8 OpenAI provider field mapping | task-06 | final chunk `chunk.usage` |
| §9 `types/usage.ts` exports | task-01 | |
| §9 `types/events.ts` changes | task-02 | |
| §9 `types/provider.ts` changes | task-02 | |
| §9 `agent.ts` changes (composite signal, pre-flight guard) | task-03 | |
| §9 `loop/loop.ts` changes (cumulativeUsage, turnUsage, all 3 terminal pairs) | task-04 | |
| §9 `anthropic-mapper.ts` changes (InputAccumulator usage methods, translateStreamEvent) | task-05 | |
| §9 `openai-mapper.ts` changes (ToolCallAccumulator.setUsage, flush, translateChunk, mapRequest) | task-06 | |
| §9 `index.ts` exports | task-01 | |
| §10 Edge case: OpenAI stream interrupted before usage chunk | task-06 (no flush usage), task-04 (EMPTY_USAGE fallback) | |
| §10 Edge case: Anthropic `cache_creation_input_tokens` null | task-05 | |
| §10 Edge case: multi-turn accumulation | task-04 | |
| §10 Edge case: pre-aborted signal, no prior messages | task-03 | `options.messages ?? []` |
| §10 Edge case: `AbortSignal.any` with single source | task-03 | guard `options.signal !== undefined` |
| §11 Risk: compile-breaking `collect.test.ts` (L18/66/82) + `types.test.ts` (L65/77) | task-02 | Fixed in same task as type change |
| §11 Risk: `message_stop` deep-equality in `openai-mapper.test.ts:671` | task-06 | |
| §11 Risk: `message_stop` deep-equality in `anthropic-mapper.test.ts` | task-05 | Scan and update any usage-bearing assertions |
| §11 Risk: `mapRequest` tests may fail on `stream_options` | task-06 | Assert `params.stream_options` |
| §11 Risk: `translateChunk` restructuring / usage-chunk test | task-06 | |
| §12 Success criteria (all functional + non-functional) | tasks 01–06 | Per-task acceptance criteria map each |
| §13 Test strategy: `usage.test.ts` | task-01 | |
| §13 Test strategy: `agent.test.ts` AbortSignal additions | task-03 | |
| §13 Test strategy: `anthropic-mapper.test.ts` usage additions | task-05 | |
| §13 Test strategy: `openai-mapper.test.ts` usage additions | task-06 | |
| §13 Test strategy: `loop.test.ts` accumulation additions | task-04 | |
| §13 AbortSignal composition integration | task-03 | Pre-aborted + mid-run abort via MockProvider |

### Explicit deferrals

Per spec §14 — none of these appear in any task brief:

- **`buildEnvContext` signal threading** — the pre-flight guard covers the already-aborted case; mid-build-abort falls through to the first `provider.stream` call. Deferred by spec as low-impact.
- **Per-tool usage attribution** — requires per-tool turn tracking or provider capabilities not uniformly available. Deferred.
- **OpenAI `prompt_tokens_details` full field set** — only `cached_tokens` is mapped. Deferred.
- **Usage logging via `Logger`** — a `usage_captured` `LogEntry` variant is a future M2 addition. Deferred.
- **Cost calculation in USD** — token counts only; dollar conversion is application-layer. Deferred.
- **`stream_options.include_usage` as a configurable provider option** — always-on by decision. Not deferred; simply not an option.

## Open questions

None. All 8 open questions from research are resolved in `docs/feature/core-run-controls/decisions.md`. All 4 final-review corrections from `docs/feature/core-run-controls/engineering/2026-06-30-spec-review-addendum.md` are folded into the tasks above. No cross-feature decisions arose; `docs/project/decisions.md` is untouched.

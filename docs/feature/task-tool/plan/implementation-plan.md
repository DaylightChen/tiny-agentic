# Implementation Plan — Sub-agent / `task` tool

> Plan phase, feature scope `feature/task-tool`. Author: `planner`, 2026-07-01.
> Upstream (binding): engineering spec at `docs/feature/task-tool/engineering/2026-07-01-task-tool-engineering.md`.
> Decisions: `docs/feature/task-tool/decisions.md` (feature) + `docs/project/decisions.md` (project conventions).
> Follows `docs/methodology/planning-methodology.md`.

## Goal

When every task here is committed, `tiny-agentic` core ships a built-in **`task` tool** (`createTaskTool`) that lets a running agent spawn a **sub-agent** — a nested `Agent.run()` with its own host-resolved tool set, model, provider, and turn budget — and receive the child's final summary back as a single **string** tool result. Three optional, core-populated `ToolCallContext` seams make this possible without widening `Agent.run` or churning existing tool signatures: `reportUsage` (child token roll-up into the parent's `cumulativeUsage`), `emitEvent` (sanitized child-lifecycle events onto the parent stream), and `toolCallId` (correlation id). The parent/child boundary is **compiler-enforced**: the tool result is a `string` and forwarded child events are a closed `SubagentChildEvent` union that by construction carries no `Message`, `ContentBlock`, or `ProviderEvent` — no provider-native block ever crosses. Per-task `model`/`provider`/`subagent_type` are opaque hint strings resolved by a **mandatory** host-supplied `resolveChild`, which returns a fully-built child `Agent` (all provider-name and profile knowledge stays host-side; core stays provider-name-free). Recursion is bounded structurally (a correct `resolveChild` omits the `task` tool from children); the numeric depth guard is deferred. Everything is unit-testable with the existing `MockProvider`/`MockPlatform` harness — no live model required for CI.

## Task list

Sequential, in execution order. Each task starts from the committed state of the previous one.

1. **task-01-types-surface** — Add the type-level surface: `SubagentChildEvent` union + `subagent_event` arm in `types/events.ts`, the three optional fields (`reportUsage?`, `emitEvent?`, `toolCallId?`) in `types/tool.ts`; prove additive back-compat with type tests (T18-T20). No runtime behavior yet.
2. **task-02-loop-seams** — Wire the load-bearing loop seams (R1, risk-first): populate `context.reportUsage`/`emitEvent`/`toolCallId` in `loop/loop.ts` + `loop/runTools.ts` using the collect-then-flush model; fold reported usage into `cumulativeUsage`; yield buffered child events as `subagent_event` before each `tool_result`. Tested end-to-end with stub tools — no child agent (T13-T17).
3. **task-03-task-tool-factory** — Build the `createTaskTool` factory and its pure helpers (`extractResultText`, `mapChildTerminalToResult`, `sanitizeChildEvent`) in `tools/builtin/task.ts` (+ optional `task.internal.ts`); export from `index.ts`. Drive a child via `MockProvider` through `resolveChild`; cover result mapping, config errors, abort cascade, recursion bound, opaque-hint passthrough (T1-T9).
4. **task-04-boundary-guarantee** — Lock the user's hard requirement (E7): a dedicated boundary test file asserting that across a full parent→child→parent run, **nothing provider-native leaks** — result is a `string`, every forwarded `subagent_event` is sanitized (no `messages`/`content`/raw payload), terminals reduced to `{ reason, usage, errorMessage? }` (T10-T12). Exercises the task-02 + task-03 integration.
5. **task-05-smoke-and-docs** — Extend an `examples/*-run.ts` with a real-provider `task` delegation to a second model id (non-CI smoke, per project practice); document the R5 cross-provider usage-fidelity limitation in `docs/project/known-issues.md`. Verifies the mocks against a live provider and records the one accepted limitation.

## Dependency rationale

- **Vertical slice / foundation first (task-01).** The three seams and the sanitized event union are *shared types* every later task codes against. Landing them first — with type tests that compile against the whole existing codebase (`bashTool`, existing `AgentEvent` consumers) — flushes any additive back-compat break (e.g. an exhaustive `switch` that now needs a `default`) before a single line of behavior is written. This is the "foundation before features" rule: `loop.ts` (task-02) and `task.ts` (task-03) both import these types, so they must exist and be stable first. Task-01 has almost no runtime surface by design (it is the type slice), which is the acceptable "does almost nothing functionally" first task.

- **Risk-ordered: the loop seam goes second, not last (task-02).** The engineering spec names usage write-back **R1 — "the load-bearing novel seam"** and explicitly instructs "implement and test this seam **first**, in isolation, with a `MockProvider` child and a fake reporter, before any real child run." `loop.ts` today mutates `cumulativeUsage` in exactly one place (`message_stop`, `loop.ts:75-77`); adding a second accumulation source risks ordering bugs, double-count, and missed-on-error paths (E5). Testing it with *stub tools* that call `context.reportUsage`/`emitEvent` directly — no `task` tool, no child `Agent` — isolates the loop mechanics from the tool mechanics, so a bug here is diagnosed against a five-line stub, not a full child run. If this seam turns out harder than expected, the plan can still adapt before the tool depends on it.

- **The tool builds on real, committed seams (task-03).** `createTaskTool` calls `context.reportUsage`/`emitEvent`/reads `context.toolCallId` — all live and tested after task-02. It codes against the *actual* loop behavior, not an interface sketch (the sequential-execution payoff). Its own novel logic (child-terminal → result mapping, linked abort signal, `resolveChild` throw handling) is orthogonal to the loop and is unit-tested with a `MockProvider` child, so task-03's failures are tool failures, not loop failures.

- **The boundary guarantee is its own task (task-04), after both halves exist.** E7 ("no provider-native block crosses") is the user's stated hard requirement and is a *cross-cutting integration property* of task-02 (what the loop yields) + task-03 (what the tool emits/returns). It can only be asserted end-to-end once both are committed, and it deserves a dedicated review pass focused solely on leak-proofness — hence a separate task and a separate test file (`subagent-boundary.test.ts`) rather than folding it into task-03. The types make a leak a compile error; this task proves the runtime path matches the type-level promise.

- **Smoke + docs last (task-05).** The mocks cannot catch real-provider surprises (a second model on a different provider, real usage-field shapes). This is the project's established "real-API smoke" practice (decision 2026-06-29) and is explicitly **not a phase gate** — it goes last because it needs the whole feature working and touches no production code. The one accepted limitation (R5: rolled-up usage mixes provider semantics) is documented here so it is not lost.

## Coverage check

Every engineering-spec section maps to at least one task. The feature is standard-pipeline (no UX spec), so coverage walks the engineering spec's sections and its User-visible-behavior subsections per planning-methodology §5 and the feature-scope (standard) rules.

### Coverage by engineering-spec section

| Engineering-spec section | Task(s) | Notes |
|---|---|---|
| **Goal** — `task` tool spawns child, returns single string; per-task model/provider; usage roll-up; normalized boundary | task-01 → task-05 | The whole plan realizes the goal; boundary is task-01 (types) + task-04 (proof). |
| **Motivation** — wire the existing `core-run-controls` seams together; add per-task model/provider | task-02 (usage/event seams), task-03 (per-task hints via `resolveChild`) | |
| **User-visible behavior → Primary flow (consumer setup)** — `createTaskTool({ resolveChild })`, register tool, run parent | task-03 (factory + `CreateTaskToolOptions`), task-05 (example wiring) | |
| **User-visible behavior → Primary flow (model invocation)** — tool schema `{ description, prompt, subagent_type?, model?, provider? }`, returns one result | task-03 (input schema + result) | |
| **User-visible behavior → Primary flow (consumer observation)** — batched `subagent_event`s before `tool_result`; usage folded | task-02 (batch-before-`tool_result` + fold), task-03 (tool emits them) | |
| **User-visible behavior → States matrix S1 (tool result)** — Empty / Error / Partial / config-error / offline rows | task-03 (T1-T5: empty→fixed string, error→"Sub-agent failed", partial→turn-cap prefix, config→"config error"); "offline" = child `agent_error` (same as Error, T3) | "Loading" row is `N/A` per spec (a tool result is atomic). |
| **User-visible behavior → States matrix S2 (event stream)** — Empty / Loading / Error / Partial / offline rows | task-02 (ordering + framing), task-04 (sanitized framing incl. empty run terminal, T10-T12); abort-mid-child in task-03 (T8) | "offline" row is `N/A` (in-process stream). |
| **User-visible behavior → Accessibility** — stream legibility via explicit `taskId` (from `context.toolCallId`) | task-01 (`taskId` on the `subagent_event` arm), task-02 (T16 `toolCallId` correlation) | The `N/A` (headless) is honored; the analogue (correlation, not free text) is covered. |
| **User-visible behavior → Edge-case behaviors** — recursion, large output, concurrent, parent-cancel, invalid override | task-03 (T5 config, T8 abort, T9 recursion); large-output = pass-through in `extractResultText` (task-03); concurrent = out of scope (deferral below) | |
| **User-visible behavior → Microcopy** — exact model-facing strings (description, empty, error, turn-cap prefix, config error, field descriptions) | task-03 (baked into `task.ts` + asserted in T2/T3/T4/T5) | Strings are load-bearing; task-03 pins them verbatim. |
| **Out of scope** — type registry, parallel, cache-sharing, sidechain persistence, numeric depth, provider list/default resolver | deferrals below | No task builds these; each has a rationale row. |
| **Architectural fit** — three context seams; `createTaskTool` factory; v1 boundary; placement (core); collect-then-flush mechanism | task-01 (seam types), task-02 (seams wired + collect-then-flush), task-03 (factory, core placement, exports) | |
| **Architectural fit → Existing modules touched** — `types/tool.ts`, `loop/loop.ts`, `loop/runTools.ts`, `types/events.ts`, `index.ts` | `tool.ts`+`events.ts`→task-01; `loop.ts`+`runTools.ts`→task-02; `index.ts`→task-03 | |
| **Architectural fit → New modules** — `tools/builtin/task.ts` (+ optional `task.internal.ts`) | task-03 | |
| **Architectural fit → New interfaces** — `ToolCallContext` fields, `SubagentChildEvent`, `subagent_event` arm, `ChildSpec`, `CreateTaskToolOptions`, `createTaskTool` | context+events types→task-01; tool types+factory→task-03 | |
| **Architectural fit → `tool_result` child event carries no `result`** | task-01 (union shape), task-03 (`sanitizeChildEvent` drops payload), task-04 (T10 asserts absence) | |
| **Architectural fit → Back-compat plan** — `ToolCallContext` additive, `AgentEvent` additive, `Agent`/`RunOptions` unchanged | task-01 (T18-T20 additive/exhaustiveness), task-02 (T17 no-op regression) | |
| **Data model changes** — type-level only; `ToolCallContext` fields; `SubagentChildEvent`; `AgentEvent` arm; `ChildSpec`/`CreateTaskToolOptions`; no migration; normalized-boundary invariant | task-01 (all type additions), task-03 (`ChildSpec`/`CreateTaskToolOptions`), task-04 (invariant proof) | No schema/storage — core is stateless. |
| **Edge cases E1** — unbounded recursion (structural bound) | task-03 (T9) | |
| **Edge cases E2** — deferred numeric depth propagation | deferral below | Recorded as intentionally not built. |
| **Edge cases E3** — child vs parent abort (linked signal) | task-03 (T8) | |
| **Edge cases E4** — child terminal mapping (`agent_done`/`max_turns_exceeded`/`agent_error`) | task-03 (`mapChildTerminalToResult`, T1/T3/T4) | |
| **Edge cases E5** — usage double-count / loss | task-02 (T13, T14) | |
| **Edge cases E6** — unresolvable model/provider (`resolveChild` throws) | task-03 (T5) | |
| **Edge cases E7** — boundary leak | task-01 (closed union), task-04 (T10-T12) | The user's hard requirement. |
| **Edge cases E8** — empty/whitespace child output | task-03 (`extractResultText` fallback, T2) | |
| **Edge cases E9** — consumer breaks mid-child | task-03 (relies on `Agent.run` finally + linked signal; asserted via T8 abort cascade) | Torn-down generator never yields the buffer — no throw/leak. |
| **Risks R1** — usage write-back load-bearing | task-02 (implemented + tested first, in isolation) | Risk-ordered first among behavior tasks. |
| **Risks R2** — numeric depth deferred | deferral below | No code; structural bound only. |
| **Risks R3** — child events not real-time | task-02 (collect-then-flush; T15 ordering) | |
| **Risks R4** — core factory without provider-registry leakage | task-03 (`resolveChild` keeps provider names host-side; T6 asserts core doesn't inspect hints) | |
| **Risks R5** — cross-provider usage semantics mix in the total | task-05 (documented limitation in known-issues) | Accepted; per-child fidelity preserved on each terminal's `usage`. |
| **Risks R6** — sequential-only forecloses parallel spawning | task-03 (tool description notes "one at a time"); deferral below | |
| **Success criteria (Functional, all bullets)** | task-02 (usage bullet), task-03 (spawn/mapping/abort/config/opaque-hint bullets), task-04 (boundary bullet), task-01 (back-compat bullet) | Each functional checkbox maps to a named test T1-T20. |
| **Success criteria (Non-functional)** — optional fields, no-op overhead, `Agent.run` unchanged, unit-testable w/o live model | task-01 (optional fields), task-02 (T17 no-op), task-03 (`MockProvider` child), all (no `Agent.run` change) | |
| **Test plan** — `task-tool.test.ts`, `subagent-boundary.test.ts`, `loop.test.ts` extension, back-compat/type tests, smoke | task-02 (loop extension T13-T17), task-03 (`task-tool.test.ts` T1-T9), task-04 (`subagent-boundary.test.ts` T10-T12), task-01 (type tests T18-T20), task-05 (smoke) | Every T# is assigned; see the per-task briefs. |
| **Resolved engineering decisions for planning** — factory in core; structural recursion bound; batch-before-`tool_result`; host-owned child approval | task-03 (factory/core/approval-via-`resolveChild`), task-02 (batch timing), task-01 (no `maxDepth` in types) | The Rev-3 authorizations are honored, not re-litigated. |

### User-visible-behavior subsection checklist (feature-scope standard, methodology §5 step 2)

The five subsections the `feature-architect` writes, each mapped or `N/A`:

- **Primary flow** → task-03 (setup via `createTaskTool`/`resolveChild`, model invocation via input schema, consumer observation via emitted `subagent_event`s) + task-02 (the observation batch is produced by the loop). Not `N/A`.
- **States matrix** → task-03 (S1 rows T1-T5) + task-02/task-04 (S2 rows: ordering/framing/sanitization). Explicit `N/A` cells (S1 "Loading", S2 "offline") are honored as the spec marks them. Not skipped.
- **Accessibility** → `N/A` for human-UI (headless), but the stated analogue (stream legibility via explicit `taskId`, not free text) is covered by task-01 (arm shape) + task-02 (T16). Not silently dropped.
- **Edge-case behaviors** → task-03 (recursion T9, parent-cancel T8, invalid override T5, large-output pass-through); concurrent sub-agents is an explicit deferral (below).
- **Microcopy** → task-03 (all exact strings baked in and asserted). Not `N/A`.

### Explicit deferrals

Each is out-of-scope by the engineering spec's "Out of scope" section and/or a Risks resolution; none is a coverage gap. Log the runtime-relevant ones in `docs/project/known-issues.md` during task-05.

- **Subagent *type registry* (markdown/frontmatter profiles).** SDK concern (decision 2026-07-01, tool-only core). Core ships only the opaque `subagent_type` string passed to `resolveChild`. No task; not a bug.
- **Parallel / background / `run_in_background` sub-agents (R6).** v1 is sequential to match `runTools`. task-03's tool description states sub-tasks run one at a time so the model does not assume parallelism. The `isConcurrencySafe` seam (`tool.ts:77`) is the future path. → known-issues note in task-05.
- **Prompt-cache sharing / byte-identical prefixes.** Anthropic-specific cost optimization, not a correctness requirement. No task.
- **Sidechain transcript persistence.** Core is stateless; a host can persist the child `Terminal.messages` inside its own `resolveChild`-provided `Agent` wiring, but core never surfaces or persists it. No task.
- **Numeric depth counter / `maxDepth` / multi-level guarded recursion (E2, R2).** Deferred: it would require depth to cross the closed `Agent.run` boundary, which v1 avoids. v1 bounds recursion structurally only (E1). No `maxDepth` in `CreateTaskToolOptions`. → known-issues note in task-05 (the deferred design candidate: seed `context.depth` in the loop) so a later revision has the pointer.
- **Cross-provider usage-total fidelity (R5).** Accepted limitation: the rolled-up parent total sums usage across providers whose token semantics differ (an Anthropic cache-read ≠ an OpenAI one). Per-child fidelity is preserved on each `subagent_event`(terminal)'s `usage`. → documented in known-issues in task-05. No code change.

## Open questions

None. The engineering spec's self-review (Rev 2) and the user's Rev-3 authorization resolved every open confirmation:

- `createTaskTool` exports from core (not SDK).
- Recursion bound is structural-only for v1 (`resolveChild` omits `task`; no `maxDepth`).
- Child events are batched immediately before the parent `tool_result` (no real-time deltas).
- Child approval handling is host-owned via `resolveChild` (no automatic inheritance, no core default).

These are treated as binding inputs, not decisions to revisit during implementation. If an implementer discovers a *contradiction* between this plan and the committed code (e.g. a `loop.ts` line number has drifted), the code is ground truth — re-read the referenced file and adapt; the contracts (types, ordering, string constants) are what must be preserved.

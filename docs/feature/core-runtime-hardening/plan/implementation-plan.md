# Implementation Plan — Core Runtime Hardening

> Plan phase, feature scope `feature/core-runtime-hardening`. Author: `planner`, 2026-07-13.
> Binding input: `docs/feature/core-runtime-hardening/engineering/2026-07-13-core-runtime-hardening-engineering.md`.
> Decisions: `docs/feature/core-runtime-hardening/decisions.md` plus `docs/project/decisions.md`.
> Follows `docs/methodology/planning-methodology.md` and the sequential dev loop in `docs/methodology/execution-methodology.md`.

## Goal

When all eight tasks are committed, `tiny-agentic` exposes required, normalized provider stop reasons through every completed-turn and successful-terminal surface; keeps its main model-facing module graph portable through platform-owned path grammar and ordering; executes maximal contiguous batches of approved read-only filesystem calls concurrently without changing model order, barriers, cancellation pairing, child-event attribution, usage accounting, or result serialization; and accurately documents the resulting API as an unreleased `0.2.0`. The final gate runs tests, typechecks, lint, build/bundle portability proof, and example typechecking on Node 22. No task publishes, tags, or creates a GitHub release, and concurrent `task` calls remain out of scope.

## Execution model and role ownership

Tasks execute strictly in order. Each task ends in a green, reviewable commit and the next task starts from that committed state. Within every task, the **implementer modifies production/configuration/documentation files only and does not write or run tests**; the **tester adds or updates tests and runs the commands**; the reviewer checks the complete task diff against its brief and this plan. Test files listed in a task's output are tester-owned unless explicitly identified as an automated verification script/configuration artifact.

## Dependency graph and order

```mermaid
flowchart LR
  T1[01 Stop-reason provider contract] --> T2[02 Stop-reason loop propagation]
  T2 --> T3[03 Platform path and ordering contract]
  T3 --> T4[04 Portable tools and boundary proof]
  T4 --> T5[05 Per-call attribution envelopes]
  T5 --> T6[06 Safe-batch scheduler]
  T6 --> T7[07 Safe built-ins, loop integration, cancellation]
  T7 --> T8[08 Docs, examples, release readiness]
```

This is intentionally a single chain. The public stop contract is settled before loop propagation; portability is complete before the scheduler relies on read-only filesystem contracts; per-call attribution envelopes land before any overlap is enabled; and docs/version metadata describe only the final tested behavior.

## Task list

1. **task-01-stop-reason-provider-contract** — Atomically introduce/export `StopReasonKind` and `StopReason`, require structured reasons on provider events, update both mappers and all directly affected provider/test fixtures, and prove SR-1–SR-4, SR-12, and mapper/provider parts of SR-13 without leaving a compile break.
2. **task-02-stop-reason-loop-propagation** — Carry required reasons through `turn_complete`, `agent_done`, returned `Terminal`, and sanitized child completion; enforce missing-`message_stop` failure; migrate all terminal consumers; and prove SR-5–SR-11 plus integration completion of SR-13.
3. **task-03-platform-path-ordering-contract** — Add required `Platform.resolvePath`/`formatPath`, update all 11 implementors atomically, implement native Node formatting and complete Node-owned discovery ordering/tie-breaks, and prove PT-3, PT-6–PT-8.
4. **task-04-portable-tools-boundary-proof** — Move `ls`/`glob`/`grep` path behavior fully behind `Platform`, delete `_paths.ts`, replace all forbidden test path imports, add custom-grammar portability coverage, harden ESLint, and add the post-build main-bundle scan proving PT-1, PT-2, PT-4, PT-5, PT-9–PT-11.
5. **task-05-per-call-attribution-envelopes** — Refactor `runTools` and `loop.ts` to use isolated per-call contexts and attributed `ToolExecution` envelopes while execution remains sequential, proving the attribution foundation needed by CB-12–CB-15 and CB-20 before overlap exists.
6. **task-06-safe-batch-scheduler** — Add the exact lazy preparation/barrier scheduler, maximal approved safe batches, `Promise.allSettled`, classifier errors, serial approvals, rejection normalization, and no-cap behavior, proving CB-1–CB-10 and CB-19.
7. **task-07-safe-builtins-loop-cancellation** — Mark `read_file` safe, integrate ordered envelopes with loop serialization/usage/child events, implement cancellation-before-start semantics, and prove PT-12 plus CB-4 and CB-11–CB-18/CB-20 with `task` still sequential.
8. **task-08-docs-examples-release-readiness** — Update README/living docs/source comments/examples, add root `typecheck:examples`, set `0.2.0 — Unreleased` metadata, and run the complete Node 22 release-readiness gate for DR-1–DR-5 without any release side effect.

## Task table, verification, and commit boundaries

| Task | Commit boundary | Expected verification before commit |
|---|---|---|
| 01 | Provider stop types, mapper normalization, exports, mapper/provider/type fixtures all land together; no event/terminal public type is changed yet. | `pnpm --filter tiny-agentic test -- src/__tests__/anthropic-mapper.test.ts src/__tests__/openai-mapper.test.ts src/__tests__/anthropic.test.ts src/__tests__/openai.test.ts src/__tests__/types.test.ts`; `pnpm --filter tiny-agentic typecheck`; `pnpm lint`; `pnpm --filter tiny-agentic test`. |
| 02 | Event/terminal required fields, loop capture, Task sanitation, and every affected literal/consumer land atomically. | Targeted loop/task/boundary/collect/type tests; `pnpm --filter tiny-agentic typecheck`; `pnpm lint`; full core test. |
| 03 | Required Platform methods and all 11 implementors land in one commit; Node path/ordering behavior is complete at that boundary. | Targeted `node`/`fs-discovery`/`ls`/`glob`/`grep`; core typecheck; root lint; full core test. |
| 04 | Tool portability migration, deletion of `_paths.ts`, test import migration, lint enforcement, and executable boundary proof land together so stricter lint never sees unfixed tests. | Targeted portability/path tests; `pnpm lint`; core typecheck; `pnpm build`; `node scripts/check-core-boundaries.mjs`; full core test. |
| 05 | The `runTools` yield shape and `loop.ts` consumer change together; contexts/envelopes are isolated but scheduling remains one-at-a-time. | Targeted `runTools`, loop, Task, boundary tests; core typecheck; root lint; full core test. |
| 06 | Scheduler, classifier semantics, barriers, all-settled normalization, and scheduler tests land atomically; Task remains unmarked. | Targeted `runTools`; core typecheck; root lint; full core test. |
| 07 | `read_file` marker, loop ordering, cancellation, attribution integration, and all affected tests land together. | Targeted `runTools`, loop, agent, built-ins, Task/boundary; core typecheck; root lint; build + bundle proof; full core test. |
| 08 | Final docs/examples/comments/version and verification script changes only; runtime behavior is already final. | On **Node 22**: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm typecheck:examples`; automated bundle proof passes after build; review confirms no publish/tag/release action. |

Local development currently reports Node `v20.18.1` against the package's `>=22` engine. Intermediate tasks may collect provisional evidence under Node 20 while recording the warning, but task 08 cannot complete until the full final command set is rerun and green on Node 22.

## Dependency rationale and critical path

- **Vertical slice first.** Because this is hardening an already-working stack (baseline: 403 tests), task 01 is the smallest end-to-end vertical slice: provider-native input becomes a normalized public value, flows through a real provider event, is exported, and is tested. It proves the source-breaking type strategy against both adapters before the loop depends on it.
- **Stop-reason compile break is split safely.** Task 01 changes `ProviderEvent.message_stop` and mapper fixtures but deliberately leaves `AgentEvent`/`Terminal` unchanged; current loop code can consume the object without yet exposing it. Task 02 then changes every loop/terminal/task consumer and literal in one atomic commit. No task leaves required public fields absent from consumers.
- **Foundation before portability consumers.** Task 03 adds both required Platform methods and all 11 implementations in one commit. Task 04 only then rewires tools/tests/lint to the real committed contract.
- **Lint migration is atomic.** Tests are not exempt from the new environment rules. Task 04 first removes `node:path` from `ls.test.ts`, `glob.test.ts`, `grep.test.ts`, `node.test.ts`, and `fs-discovery.test.ts` in the same commit that enables the strict rules; there is no knowingly red lint boundary.
- **Build proof follows portable source wiring.** The bundle scanner is added in task 04 after `_paths.ts` and tool imports are removed. It scans built output, including chunks reachable from `dist/index.js`, rather than relying on source grep or checking only the first file.
- **Attribution before overlap.** Task 05 lands `ToolExecution` envelopes and fresh per-call sinks while calls still execute sequentially. Task 06 may then overlap safe calls without any intermediate state where IDs, child events, or usage share mutable batch storage.
- **Scheduler risk first, integration second.** The lazy barrier algorithm and approval ordering are isolated in task 06 with deferred promises. Task 07 separately integrates built-in markers, loop serialization, child events, usage, and cancellation, keeping both review sessions tractable.
- **Critical path.** Every task is on the critical path: `01 → 02 → 03 → 04 → 05 → 06 → 07 → 08`. A failure in tasks 01, 03, or 06 changes a public contract or central scheduler and must be resolved before proceeding; task 08 is blocked until Node 22 is available.

## Coverage check

Feature scope, standard pipeline. The binding engineering specification is product-and-engineering combined, so the matrix walks every major section, all five User-visible behavior subsections, and every named SR/PT/CB/DR test ID.

### Coverage by engineering-spec section

| Engineering specification section | Task(s) | Coverage |
|---|---|---|
| §1 Goal; §2 Motivation | 01–08 | Whole ordered plan delivers typed outcomes, portable graph, safe overlap, and release readiness. |
| §3.1 Primary flow | 01–02 (reason surfaces), 03–04 (portable tools), 05–07 (ordered batching/attribution), 08 (consumer docs/examples) | End-to-end API flow and model-visible order. |
| §3.2 States matrix — provider empty/in-progress/error/partial/offline | 02 | Empty completed turns, streaming unchanged, missing stop/provider errors, valid partial terminals, network errors remain `agent_error`. |
| §3.2 States matrix — portable discovery | 03–04 | Empty/capped/error shapes unchanged; platform grammar/order is authoritative. |
| §3.2 States matrix — safe batch | 06–07 | Empty input, all-settle before yield, sibling isolation, deterministic cancellation, offline N/A. |
| §3.3 Accessibility | N/A for rendered UI; 01–02, 05–07 cover machine-readable analogue | Closed `StopReason.kind`, discriminated terminals/events, stable IDs, `isError`/`truncated`; no UI/a11y surface. |
| §3.4 Edge-case behaviors | 01–02 (unknown/missing/inconsistent/pause), 03–04 (custom grammar/order), 06–07 (large batch/cancellation/external mutation) | Every bullet has tests or explicit accepted risk. |
| §3.5 Microcopy | 06–07 | Exact classifier and cancellation strings; all existing tool error strings retained in barrier tests. |
| §4 Out of scope | Explicit deferrals below | No prohibited feature is assigned. |
| §5.1 Stop-reason contracts/mappings/loop | 01–02 | Public types/mappers first, loop/task propagation second. |
| §5.2 Platform seam/order/implementors/lint/build/cancellation honesty | 03–04, 07 | Contract + all implementors; tools/lint/bundle; cancellation exactness. |
| §5.3 Internal envelopes, marker, scheduler, rejection/barriers/cancellation/no cap | 05–07 | Envelopes before overlap; scheduler; built-in and loop/cancellation integration. |
| §5.4 Module and file changes | 01–08 | Every listed production/config/doc module is assigned in its brief. |
| §6 Data model changes | 01–03, 05 | Public StopReason, required event/terminal fields, required Platform methods, internal envelopes; no storage migration. |
| §7 Edge cases/test matrix | 01–08 | Full ID matrix below. |
| §8 Risks | 01 (source break/provider evolution), 02 (missing stop), 03–04 (Platform/path/lint), 05–07 (context, large batch, approval, cancellation, attribution), 08 (release wording) | Risk mitigations are task acceptance criteria. |
| §9 Documentation and release readiness | 08 | README, roadmap, known issues, STATUS capability narrative, changelog, metadata, examples, stale comments, examples script. `core-package-status.md` stays historical. |
| §10 Success criteria | 01–08 | Functional and non-functional checks culminate in Node 22 gate. |
| §11 Open questions | — | Binding spec says none; planning found no blocker requiring user input. |

### User-visible behavior subsection checklist

- **Primary flow (§3.1):** tasks 01–02 expose reasons, 03–04 provide portable discovery, 05–07 provide ordered safe batching, and 08 updates examples.
- **States matrix (§3.2):** provider states map to task 02; discovery states to tasks 03–04; safe-batch states to tasks 06–07. Safe-batch offline is explicitly N/A as specified.
- **Accessibility (§3.3):** rendered accessibility is N/A because core is headless. Its stated machine-readable contract maps to tasks 01–02 and 05–07.
- **Edge-case behaviors (§3.4):** tasks 01–04 and 06–07 cover every listed case; unbounded resource amplification is an accepted documented risk, not omitted behavior.
- **Microcopy (§3.5):** tasks 06–07 assert both new exact strings and preserve all listed existing strings.

### Test-ID coverage matrix

| IDs | Task | Exact scope |
|---|---|---|
| SR-1, SR-2 | 01 | Anthropic documented, unknown, and missing mappings. |
| SR-3, SR-4 | 01 | OpenAI finish/refusal mapping and precedence. |
| SR-5 | 02 | Natural final reason equality across turn, event, and returned terminal. |
| SR-6 | 02 | Token/context/filter/refusal/unknown valid terminals preserve partial state. |
| SR-7 | 02 | Tool-use turn exposes its reason and continues. |
| SR-8 | 02 | Buffered calls override inconsistent reason metadata; tool-free tool-use reason terminates. |
| SR-9 | 02 | `pause_turn` is visible and does not auto-resubmit. |
| SR-10 | 02 | Missing `message_stop` becomes the exact provider-contract `agent_error`. |
| SR-11 | 02 | Task sanitation and boundary shape. |
| SR-12 | 01 (StopReason arms/provider required field), 02 (event/terminal required fields) | Compile-time exhaustiveness and required fields. |
| SR-13 | 01 (provider emitted events), 02 (all downstream fixtures/unknown-refusal integration) | Provider integration reaches structured reason. |
| PT-1, PT-2, PT-4, PT-5 | 04 | Custom non-host grammar, resolution calls, no parsing, Platform order preserved. |
| PT-3, PT-6, PT-7, PT-8 | 03 | Node formatting/root, mtime/tie-break, test ordering, all implementors compile. |
| PT-9, PT-10, PT-11 | 04 | ESLint fixtures/rules, built graph scan, all model-facing tools. |
| PT-12 | 07 | Pre-abort no invocation and active read/list cancellation honesty. |
| CB-1–CB-3 | 06 | Overlap, reverse completion/order, safe→unsafe→safe barriers. |
| CB-4 | 07 | Exact built-in marker set. |
| CB-5 | 06 | Unknown, malformed, and Zod-invalid calls are barriers. |
| CB-6 | 06 | Denial/approval failures are serial barriers. |
| CB-7 | 06 | Unmarked calls execute alone between batches. |
| CB-8 | 06 | Classifier false/throw behavior and exact classifier error. |
| CB-9 | 06 | Safe call throw does not suppress siblings. |
| CB-10 | 06 | Defensive allSettled rejection normalization retains attribution. |
| CB-11 | 07 | Ordered loop serialization and call-local serialization failure. |
| CB-12 | 05 foundation + 07 concurrent proof | Per-call tool ID isolation. |
| CB-13 | 05 foundation + 07 concurrent proof | Per-call child-event isolation and ordering. |
| CB-14 | 05 foundation + 07 concurrent proof | Per-call usage isolation. |
| CB-15 | 05 sequential baseline + 07 final proof | Task stays unmarked and non-overlapping. |
| CB-16 | 07 | Cancellation during active safe batch settles active work and cancels remainder. |
| CB-17 | 07 | Pre-aborted run performs no preparation and pairs every call with cancellation. |
| CB-18 | 07 | Abort during serial approval prevents approved-but-unstarted work. |
| CB-19 | 06 | More than eight safe calls all start; no cap. |
| CB-20 | 05 foundation + 07 final proof | No stale sinks; merged scalar survives shallow clone. |
| DR-1 | 08 | Complete README/API documentation. |
| DR-2 | 08 | Every example exposes stop kind/raw and passes the existing tsconfig gate. |
| DR-3 | 08 | `0.2.0 — Unreleased` changelog/version metadata and migrations. |
| DR-4 | 08 | No publish/tag/GitHub release side effect. |
| DR-5 | 08 | Full Node 22 gate. |

## Explicit deferrals and out of scope

- **Concurrent `task`/sub-agent calls:** remains unmarked and sequential. `docs/project/known-issues.md` is clarified in task 08; no scheduler exception or child queue is added.
- **Real-time child-event forwarding, new child queues, or child usage redesign:** no task; envelopes preserve existing batch-before-result behavior.
- **Automatic `pause_turn` continuation, provider watchdog/retry redesign, `agent_aborted`:** no task; pause is visible terminal metadata and retry comments only are corrected.
- **Per-tool timeout, configurable concurrency limit, or abortable `Platform.readFile`/`listDir`:** no task. The first release has no cap and makes only the exact no-new-work/signal-delivery guarantee.
- **Universal path grammar/polyfill/broad Path service or removal/deprecation of `Platform.stat`:** no task; platform-specific `resolvePath`/`formatPath` is the locked seam and `stat` stays public.
- **Permission policy, compaction, sessions, memory, skills, MCP, sandboxing, UI, new grep features:** unrelated to this scope.
- **Publish, npm release, Git tag, GitHub release, or release-channel changes:** prohibited. Task 08 prepares only `0.2.0 — Unreleased` metadata.
- **Timing thresholds as CI correctness gates:** optional Node 22 smoke/benchmark evidence may be recorded, but deterministic deferred-promise assertions are authoritative.

## Self-review findings and corrections

1. **Uncompilable stop-reason intermediate avoided.** A single task containing every mapper, loop, terminal, Task, test, and example update would be too large. The plan instead uses a compile-safe seam: task 01 changes the already-required provider field from string to object and updates all provider producers/fixtures; the loop currently ignores its value. Task 02 then adds all required downstream event/terminal fields and consumers atomically.
2. **Platform fan-out corrected to the actual 11 implementors.** The inspected tree has `NodePlatform`, nine `MockPlatform` classes, and one object-literal Platform exactly at the spec paths; task 03 lists every file. No shared-mock refactor is introduced.
3. **Lint enablement moved after import replacement.** Existing `node:path` imports are present in exactly `ls.test.ts`, `glob.test.ts`, `grep.test.ts`, `node.test.ts`, and `fs-discovery.test.ts`. Task 04 replaces them in the same commit as the stricter rule, rather than landing a known-red lint commit.
4. **Bundle proof scans the graph, not only `dist/index.js`.** Current tsup emits `dist/index.js` plus shared chunks. The planned script resolves relative static imports recursively and rejects `node:*`/process access anywhere reachable from the main entry while separately confirming `dist/platform/node.js` is allowed to contain Node imports.
5. **Attribution precedes concurrency.** The old loop has shared `childEvents`/`reportedUsage` sinks and mutable `toolCallId`. Task 05 changes both producer and consumer atomically while retaining sequential execution; only task 06 enables overlap.
6. **Cancellation is placed with final loop integration.** The scheduler can batch in task 06 without changing the safe built-in set. Task 07 adds `read_file` and tests pre-start cancellation plus the honest deferred `readFile`/`listDir` behavior; it does not promise syscall interruption.
7. **Package/command names corrected.** The core package is `tiny-agentic`, not `@tiny-agentic/core`. Briefs use `pnpm --filter tiny-agentic ...`; lint is the root-only `pnpm lint` command because the core package has no lint script. Full workspace gates use the existing root commands.
8. **Example typecheck uses existing configuration.** Task 08 adds only root script `"typecheck:examples": "tsc -p examples/tsconfig.json"`; it does not recreate `examples/tsconfig.json`.
9. **Node 22 gate made explicit.** The inspected environment is Node 20.18.1 and emits an engine warning; task 08 requires rerunning all final commands under Node 22 before completion.
10. **Workflow-state ownership preserved.** The plan does not modify the scope JSON or `docs/project/STATUS.md`. Although the engineering spec lists the latter for capability/test-count maintenance, the user's direct instruction and planner contract prohibit this agent from changing it now; task 08 may update only its non-workflow shipped-capability narrative during implementation, leaving phase/scope fields to the orchestrator.
11. **No stale names.** All referenced production/test/example files were inspected. New verification artifacts are limited to `portability.test.ts` and `scripts/check-core-boundaries.mjs`. One executable Node script performs both ESLint fixture checks and recursive built-graph scanning, avoiding the normal Vitest suite's clean-build race.

## Open questions

None. The engineering spec resolves all architecture choices. The only external prerequisite is access to Node 22 for task 08's mandatory final verification; this is an execution environment requirement, not a design blocker.

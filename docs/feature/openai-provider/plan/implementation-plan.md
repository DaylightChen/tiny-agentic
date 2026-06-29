# Implementation Plan — OpenAI Provider (feature/openai-provider)

> Written in the plan phase by the `planner` agent. Lives at `docs/feature/openai-provider/plan/implementation-plan.md`.
> Source design: `docs/feature/openai-provider/engineering/2026-06-29-openai-provider-engineering.md`.
> Locked decisions: `docs/feature/openai-provider/decisions.md` (six decisions).

## Goal

When every task in this plan is committed, the `tiny-agentic` core package exposes a second `Provider` backend, `OpenAIProvider`, behind the existing `Provider` interface. A developer can run the agent loop against OpenAI's Chat Completions API — and any OpenAI-compatible endpoint via `baseURL` — by installing the optional `openai` peer dependency, importing `OpenAIProvider` from the new `tiny-agentic/providers/openai` sub-path, and swapping the provider instance into `new Agent({ provider, ... })`. Nothing else in their code changes: the loop, tools, platform, and event stream are identical to the Anthropic path. The whole feature is additive — no public type changes, no edits to `loop.ts`, `agent.ts`, or `src/index.ts`. The two deliverable modules are `providers/openai-mapper.ts` (the only mapper that does real translation — Anthropic's casts) and `providers/openai.ts` (the provider class), each with a fixture/mock test suite living in `src/__tests__/`. This is the M2 validation that the `Provider` seam holds for a backend whose message/role/streaming shape genuinely differs from Anthropic's.

## Task list

The order is the execution order. Sequential — each task starts from the committed state of the previous one.

1. **task-01-openai-mapper** — Implement `providers/openai-mapper.ts` (the four LOCKED request transforms + tools + `max_completion_tokens`, plus the streaming `ToolCallAccumulator` + `translateChunk` keyed on `tool_calls[].index` with flush-at-stream-end), and its fixture-based test suite `src/__tests__/openai-mapper.test.ts`. No network, no live SDK — pure object fixtures.
2. **task-02-openai-provider-and-packaging** — Implement the `OpenAIProvider` class in `providers/openai.ts` wiring the mapper, the `openai` SDK, retry-via-`maxRetries`, `AbortSignal`, `baseURL`, and the `request_sent` logger hook; add the `openai` optional peer dependency + `./providers/openai` export to `package.json`, the build entry to `tsup.config.ts`; and write the mock-SDK provider test suite `src/__tests__/openai.test.ts`. Verify the UI-free / `index.ts`-clean boundary holds.

## Dependency rationale

- **Vertical slice / risk-first → task-01.** The mapper is the load-bearing, highest-risk module of this feature: it is the *first* real translation the framework has ever done (the Anthropic mapper is a cast — `anthropic-mapper.ts:12-14`), and the two transforms most likely to break (assistant-turn `tool_calls` split with JSON-stringified `arguments`; the single batched `tool_result` user message exploded into N `role:"tool"` messages) produce an opaque OpenAI 400 at runtime rather than a typed error if wrong (spec §Risks). Doing it first, in isolation, against object fixtures with no network, surfaces a translation bug before any wiring exists to obscure it. The flush-at-stream-end accumulator design (no terminal event, synthesize exactly one `message_stop` at iterator end) is also novel relative to the Anthropic per-event path and is exactly the kind of thing that should be proven first.
- **Foundation before features → task-01 before task-02.** `task-02`'s provider imports `mapRequest`, `translateChunk`, and `ToolCallAccumulator` from the task-01 module (mirror of `anthropic.ts:3`). Coding the provider against a real, committed, tested mapper — not against a sketched interface — is the sequential-execution payoff (no interface drift).
- **Packaging rides with the provider (task-02), not task-01.** The `openai` package is added as a `devDependency` so the mock-SDK provider test can `vi.mock("openai", ...)` and the import can resolve. That dependency, the `peerDependencies`/`peerDependenciesMeta.optional` entry, the `./providers/openai` export sub-path, and the `tsup` build entry are all prerequisites of *running and shipping the provider*, so they belong in the same task as the provider. task-01's mapper tests need no SDK install at all (pure fixtures, mirror of `anthropic-mapper.test.ts`), so task-01 stays dependency-free and fast.
- **No scaffolding task needed.** This is a feature on a mature M1 codebase; the stack, toolchain, test runner, and provider seam already exist and are proven. The "vertical slice" role is served by task-01 proving the riskiest new translation, and task-02 proving the end-to-end provider against a mocked SDK.

## Coverage check

### Coverage by engineering-spec section

| Engineering-spec section | Task(s) | Notes |
|---|---|---|
| Goal / Motivation | task-01 + task-02 | Whole feature; validated end-to-end by task-02's mock-SDK equivalence test. |
| User-visible behavior → Primary flow (install peer dep, import sub-path, construct, pass to Agent, identical events) | task-02 | Import sub-path + constructor + packaging in task-02; equivalent-`AgentEvent` mock-SDK test in task-02. |
| User-visible behavior → States matrix: **Empty** (no content turn) | task-01 | Mapper still synthesizes a lone `message_stop` at flush with no tool calls / no text; asserted in task-01. Loop's empty-turn skip (`loop.ts:81`) is existing behavior, not re-implemented. |
| User-visible behavior → States matrix: **Loading** (streaming `text_delta`) | task-01 | `translateChunk` emits `text_delta` per content fragment; asserted in task-01. |
| User-visible behavior → States matrix: **Error** (survives `maxRetries`, thrown → `agent_error`) | task-02 | Provider does no special handling; error propagates from the generator. The loop's `try/catch` (`loop.ts:59-64`) is existing behavior. Covered as a "no swallow" assertion in task-02. |
| User-visible behavior → States matrix: **Partial** (AbortSignal mid-stream) | task-02 | `signal` threaded as 2nd arg to `create`; asserted in task-02 (mirror `anthropic.test.ts:77-90`). |
| User-visible behavior → States matrix: **Offline** (connection failure retried then thrown) | task-02 | Behavior owned by the SDK's `maxRetries=3`; provider correctness is "passes `maxRetries` to `new OpenAI(...)`", asserted in task-02. No bespoke offline handling per spec. |
| User-visible behavior → Accessibility | — | `N/A` per spec (headless library, no UI). API-ergonomic parity (`OpenAIProviderOptions` field-for-field with Anthropic) is asserted in task-02. |
| User-visible behavior → Edge-case behaviors (large arg JSON across chunks; multiple concurrent tool calls; malformed JSON; no `finish_reason`; `n>1`) | task-01 | All five are mapper-level; each is a fixture assertion in task-01. |
| User-visible behavior → Microcopy (constructor guard string; no synthesized `"Error: "`; no new tool-result text) | task-02 (guard) + task-01 (no `"Error: "` on `is_error` drop) | Constructor guard asserted in task-02; `is_error`-drop-without-prefix asserted in task-01. |
| Out of scope (Responses API, Azure, usage tracking, runTools/runner, watchdog, per-retry hook, developer-role, public type changes) | — | Explicitly not built. Enforced negatively: task-02 asserts no `runTools`/runner usage and no `withRetry` import; task-01/02 add no public type. |
| Architectural fit → edit `package.json` (peer dep + sub-path) | task-02 | |
| Architectural fit → edit `tsup.config.ts` (build entry) | task-02 | |
| Architectural fit → `index.ts` **unchanged** | task-02 | Asserted negatively: task-02 verifies `index.ts` does not import `providers/openai` and contains no `openai` import in its graph. |
| New module `providers/openai.ts` (class wiring detail §) | task-02 | |
| New module `providers/openai-mapper.ts` (request + streaming §) | task-01 | |
| New tests `__tests__/openai-mapper.test.ts` | task-01 | |
| New tests `__tests__/openai.test.ts` | task-02 | |
| New interface `OpenAIProviderOptions` (no new `provider.ts` type) | task-02 | |
| Data model changes | — | `N/A` — spec states none (no schema, no migration). |
| Request-side Transform 1 (system prompt → leading `system` message) | task-01 | LOCKED `system` role. |
| Request-side Transform 2 (`tool_use` blocks → `tool_calls` with JSON-string `arguments`; text flatten / `content:null`) | task-01 | Highest-risk transform; string-`arguments` assertion. |
| Request-side Transform 3 (one batched `tool_result` user msg → N `role:"tool"` msgs, order preserved) | task-01 | Highest-risk transform; N-messages + `tool_call_id` order assertion. |
| Request-side Transform 4 (drop `is_error`, no `"Error: "` prefix) | task-01 | LOCKED. |
| Tools mapping (`ToolSchema` → `function` tool; omit empty `tools`) | task-01 | |
| Max tokens (`max_completion_tokens`, not `max_tokens`; default 32000) | task-01 | LOCKED default 32000; assert `max_tokens` absent. |
| Streaming → `text_delta` | task-01 | |
| Streaming → `tool_use` accumulator (keyed on `index`, flush at stream end, empty-buffer→`{}`, `inputParseError`/`{}` contract) | task-01 | |
| Streaming → `message_stop` synthesized once (finish-reason map + default `"end_turn"`) | task-01 | |
| Accumulator API (`applyDelta` / `setFinishReason` / `flush`) | task-01 | |
| `translateChunk` (reads `choices[0]`, type-guard narrowing, ignores `include_usage` final chunk) | task-01 | |
| Edge cases (all bullets) | task-01 (mapper-level) + task-02 (abort) | Each maps to a fixture or mock-SDK assertion. |
| Risks (mitigations as test assertions) | task-01 + task-02 | Each risk's mitigation is pinned as a named assertion in the relevant brief. |
| Success criteria — Functional (8 bullets) | task-01 + task-02 | See per-brief acceptance criteria; each bullet is traced. |
| Success criteria — Non-functional (4 bullets: `index.ts` clean, UI-free boundary, no-network tests, no regression) | task-02 (boundary, no-regression) + task-01 (no-network) | task-02 runs full `vitest run` + `tsc --noEmit` as the no-regression gate. |
| Open questions 1 & 2 (`system` role; 32000 default) | task-01 | Now LOCKED in decisions.md; encoded as assertions. |
| Open question 3 (`openai` peer-dep version range) | task-02 | Residual implement-time pin — called out in task-02's brief (pin against the SDK major available at implement time; currently `openai@6.x`). |

### Explicit deferrals

- **`developer`-role switching for reasoning models** — deferred; `system` for all models is LOCKED (decisions.md). Not a known-issue (it is a deliberate, correct first cut; OpenAI accepts `system` on reasoning models). If a future model rejects `system`, the branch is a localized addition.
- **Usage / cost tracking, stream-idle watchdog, per-retry logging hook** — out of scope per spec (M2+); no `LogEntry` variant added. Same posture as the Anthropic provider; no new known-issue introduced by this feature.

## Open questions

None block execution. One residual implement-time call (not a design decision):

- **`openai` peer-dependency version range.** The spec's §Open-Questions floated `^4.x`, but that range is stale — the current `openai` major is **6.x** (verified via `npm view openai version` at planning time → `6.45.0`). The task-02 implementer should pin the major available at implement time (currently `^6.0.0`) in both `peerDependencies` and `devDependencies`, and confirm `max_completion_tokens`, `tool_calls[].index`, and `chat.completions.create({ stream: true })` chunk shapes match that major before finalizing. Recorded as a flag, not a decision, per spec §Decision-log note.

No cross-feature decisions arose; `docs/project/decisions.md` is untouched.

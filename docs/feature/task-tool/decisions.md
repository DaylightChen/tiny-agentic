# Decision Log

> Record significant decisions with rationale. Each entry should be self-contained — a future reader should understand both what was decided and why without needing additional context.

## Format

```
## YYYY-MM-DD — [Decision title]

**Phase:** [phase name]

**Decision:** [What was decided]

**Rationale:** [Why this option was chosen — what trade-offs were considered, what alternatives were rejected and why]

**Consequences:** [What this enables, constrains, or commits the project to]
```

---

> **Rev 2 (2026-07-01):** the four entries below were revised the same day after an engineering self-review, before any downstream consumption. Corrections applied in place: `resolveChild` is **mandatory** (no core default resolver — a default cannot reach the parent's private provider/tools); the parent/child boundary crosses a **sanitized `SubagentChildEvent`** union (omitting `messages`), not raw `AgentEvent`; the third context seam is **`toolCallId?`** (correlation), not `depth?`; the **numeric depth guard / `maxDepth` is deferred** (structural bound only); child events are **batched before the `tool_result`** (no real-time deltas in v1).
>
> **Rev 3 (2026-07-01):** after user authorization to proceed without further approval prompts, the remaining open confirmations were resolved using the spec recommendations: `createTaskTool` exports from core; structural-only recursion bound is accepted for v1; child events are batched before `tool_result`; child approval handling is host-owned through `resolveChild` with no automatic inheritance.

## 2026-07-01 — `task` tool is core; subagent-type registry is SDK

**Phase:** engineering

**Decision:** The sub-agent spawning primitive — the `task` built-in tool (`createTaskTool`) plus its three enabling `ToolCallContext` seams — lives in the `tiny-agentic` **core** package. The subagent-*type* registry (named profiles loaded from markdown/frontmatter, `subagent_type` resolution) is an **SDK** concern. Core exposes the `subagent_type` string on the tool input and hands it to a host-supplied `resolveChild`; core never loads or parses profiles. `createTaskTool` itself is exported from core; SDK layers may wrap it with profile loading.

**Rationale:** The spawning primitive is pure over `Agent`/`Tool`/`Usage`/`AbortSignal` and is the construct that makes the framework multi-agent — squarely core. Profile loading (markdown, frontmatter) is product/stateful, matching the project-level tool-only-core decision (2026-06-27). Keeping all provider-name and profile knowledge in the host's `resolveChild` lets the factory stay provider-name-free even if it lives in core, so the split is honored without core learning "anthropic"/"openai".

**Consequences:** Core gains one built-in tool module, exports `createTaskTool`, and adds three optional context fields; it does not gain any provider registry or markdown loader. The SDK layers named subagent profiles on top by supplying `resolveChild`. Resolves research open question #7.

---

## 2026-07-01 — Sub-agent enabling seams added to `ToolCallContext` (not new `Tool.call` args)

**Phase:** engineering

**Decision:** Three new **optional, core-populated** fields are added to the `ToolCallContext` interface: `reportUsage?(usage)`, `emitEvent?(event)`, and `toolCallId?`. `agentLoop` populates them; `Tool.call` arity stays at three; `Agent.run`'s signature is unchanged. `reportUsage` lets a tool contribute out-of-band tokens (a child run) to the parent's `cumulativeUsage`; `emitEvent` lets a tool surface **sanitized** child events (`SubagentChildEvent`) on the parent stream; `toolCallId` is the id of the currently-executing tool-use, so a tool can correlate what it emits/logs back to its own call (the `task` tool uses it as `taskId`). (Rev 2: this third seam was `depth?` in the first draft; the numeric depth guard is deferred, so `depth?` is dropped and `toolCallId?` — needed for event correlation — takes its place.)

**Rationale:** `ToolCallContext` is the one sanctioned, interface-merging extension point (decision 2026-06-27), and the project already chose it as the home for the M2 tool-cancellation `signal` (decision 2026-06-27, M2 seams). All-optional preserves back-compat for every existing tool and honors "SDK must not add required fields." The alternatives — a factory closure holding config (drifts from per-run `signal`) or new positional `Tool.call` args (churns every tool signature) — were rejected. Per-tool config (`resolveChild`) rides on the `createTaskTool` factory; per-run operational data (`signal`, `reportUsage`, `emitEvent`, `toolCallId`) rides on `context`. `toolCallId` must be populated **per tool-use** (by `runTools`, from `tu.id`), not once per batch.

**Consequences:** `types/tool.ts`, `loop/loop.ts`, `types/events.ts` change; `runTools.ts` sets `context.toolCallId` per call but keeps its external signature. The loop gains a second usage-accumulation source (tool-reported, folded after each batch) beyond `message_stop` — the load-bearing novel seam, risk-ordered first. A new `subagent_event` arm (wrapping a sanitized `SubagentChildEvent`) is added to `AgentEvent`, and the `SubagentChildEvent` union is defined in `types/events.ts`.

---

## 2026-07-01 — Per-task model/provider via a host `resolveChild` fallback chain

**Phase:** engineering

**Decision:** Per-task model and optional provider overrides are exposed on the `task` tool input (`model?`, `provider?`, `subagent_type?` — all **opaque strings** to core) and resolved by a **mandatory host-supplied `resolveChild(spec) => Agent`** that returns a fully-constructed child `Agent`. The fallback order is **task override → subagent profile default → runner/global default**, applied inside `resolveChild`. Core does not hardcode, enumerate, or validate provider/model names; the resolver returns a built `Agent` (not raw provider/tools), so all provider-name and profile knowledge stays in host code. An unresolvable model/provider makes `resolveChild` **throw before the child runs**; the tool converts the throw to a clean `isError` tool result (`"Sub-agent config error: <detail>"`), spending zero child tokens.

**Rationale:** Directly implements the user's requirement (per-task/subagent `model` + optional `provider`, with that exact fallback order) while respecting provider-agnosticism and the core/SDK split: a `Provider` binds its model at construction and exposes only `stream()`, so "override the model" means "construct/select a different child `Agent`," which is a host decision, not a core one. `resolveChild` is **mandatory** (no core default) because a running `Tool.call` cannot reach the parent's provider or tool set — both are private on `Agent` — so core has no material from which to build a default child; a default resolver was considered and rejected as unimplementable, not merely undesirable. Returning an `Agent` directly (rather than a `ResolvedChild` wrapper or raw config) is the simplest shape that keeps all provider knowledge host-side. Resolving before the child loop makes bad config fail fast and legibly.

**Consequences:** The tool is a `createTaskTool({ resolveChild, name? })` factory (not a bare constant) so it can close over the required `resolveChild`; there is **no `maxDepth`** (numeric depth deferred — see Rev 2 note and the boundary entry below) and **no default resolver** (so the earlier "Q5 default-resolver" question is dissolved). `createTaskTool({})` is a compile error. Child approval-handler inheritance is entirely the host's call, since `resolveChild` returns a fully-built `Agent` — core neither inherits the parent handler nor imposes one.

---

## 2026-07-01 — Normalized parent/child boundary; usage rolls up via `Terminal.usage` only

**Phase:** engineering

**Decision:** Nothing provider-native crosses the parent/child boundary, enforced at the type level. What the parent model receives is a **`string`** (the child's extracted last-assistant text, or a fixed empty-output string); what the parent's event-stream consumer receives is a **sanitized `SubagentChildEvent`** wrapped in a new `subagent_event` `AgentEvent` arm (tagged with a `taskId` from `context.toolCallId`). `SubagentChildEvent` is a closed union — `text_delta`, `tool_use_start`, `tool_result` (metadata only, no `result` payload), and a reduced `terminal` (`{ reason, usage, errorMessage? }`) — that **omits `messages`** and any `ContentBlock`/`ProviderEvent`. This is deliberate: a child's raw `AgentEvent` terminals carry `messages: Message[]` (the full child transcript with provider-shaped blocks), so wrapping the raw event would leak the transcript; a `sanitizeChildEvent` choke point maps raw → sanitized. Child cost rolls up by the tool calling `context.reportUsage(child.Terminal.usage)` **exactly once** — the parent does **not** re-walk the child's per-turn stream (unlike the reference; `tiny-agentic`'s `Terminal.usage` is already the run total). Child events are **batched immediately before that call's `tool_result`** (v1 does not stream real-time child deltas, since `Tool.call` is awaited). Child terminals map to results as: `agent_done`→summary; `max_turns_exceeded`→turn-cap-prefixed partial (`isError:false`); `agent_error`→`"Sub-agent failed: …"` (`isError:true`); usage rolls up in all cases (partial/`EMPTY_USAGE` on error).

**Rationale:** Implements the user's "keep a normalized task result/events boundary; do not leak provider-native message blocks across parent/child runs" as a **compiler-enforced, structural** invariant — not a convention. The first draft wrapped the raw `AgentEvent`, which self-review found leaks the child transcript via the terminal arms' `messages` field; the sanitized union closes that hole by construction (a `Message`-bearing event is not assignable to `SubagentChildEvent`). `Terminal.usage` is the roll-up *source* the `core-run-controls` feature deliberately shipped for exactly this (that spec, §16); the *write-back* into the parent's cumulative total is the new piece this feature adds. Single-path accumulation (report once, accumulate once) avoids the double-count/loss failure modes. Batch-before-`tool_result` is chosen because real-time forwarding would require restructuring `runTools` into a concurrent producer/consumer — deferred as an additive upgrade.

**Consequences:** Recursion is bounded in v1 **structurally only** — `resolveChild` must omit the `task` tool from the child, so a sub-agent cannot spawn one. The numeric depth counter / `maxDepth` is **deferred** (it would need depth to cross the closed `Agent.run` boundary, which v1 avoids); a host wanting guaranteed-bounded *deep* nesting reopens that design later. Parent-abort cascades to children via a linked child signal (`AbortSignal.any([context.signal, childCtrl.signal])`); a child error does not abort the parent. Per-provider usage fidelity is preserved per-child on each sanitized `terminal` event's `usage` even though the rolled-up parent total mixes provider semantics (spec R5). The correlation id (`taskId`) equals the spawning `tool_use` id. Sequential-only for v1 (`runTools` seam preserves future parallelism).

---

## 2026-07-01 — Task decomposition: type surface → loop seam (isolated) → tool → boundary proof → smoke

**Phase:** plan

**Decision:** The feature is broken into **five sequential tasks**: (1) the type-level surface only (`SubagentChildEvent` + `subagent_event` arm + three optional `ToolCallContext` fields) with additive back-compat/type tests; (2) the loop seams (`reportUsage`/`emitEvent`/`toolCallId` wiring, collect-then-flush, usage write-back) tested **in isolation with stub tools and no child `Agent`**; (3) the `createTaskTool` factory + pure helpers, tested with a `MockProvider` child through `resolveChild`; (4) the parent/child boundary leak-proofness as a **dedicated end-to-end test task/file** (`subagent-boundary.test.ts`); (5) a real-provider smoke example + known-issues documentation. Every engineering-spec T-numbered test is assigned to exactly one task (T18-T20→1, T13-T17→2, T1-T9→3, T10-T12→4, smoke→5). The plan is at `docs/feature/task-tool/plan/implementation-plan.md`.

**Rationale:** Follows planning-methodology §2 (vertical-slice/foundation first, risk-ordered). The type surface is the shared foundation `loop.ts` and `task.ts` both import, so it lands first and is proven back-compatible before any behavior exists — the acceptable "does almost nothing functionally" first task. The engineering spec names usage write-back **R1, "the load-bearing novel seam,"** and explicitly directs implementing/testing it *first, in isolation, before any real child run*; task-2 honors that by exercising the seams with five-line stub tools that call the sinks directly, so a loop bug is diagnosed against a stub rather than a full child run. The tool (task-3) then codes against the *committed, tested* loop behavior — the sequential-execution payoff (no interface drift). The boundary guarantee (E7) is the user's hard requirement and a cross-cutting integration property of tasks 2+3, so it earns its own task and file for a focused review pass rather than being folded into task-3. Smoke goes last because it needs the whole feature and is explicitly non-CI (decision 2026-06-29).

**Consequences:** Task-1 must not touch `index.ts` (public export of `SubagentChildEvent` is deferred to task-3 so all new public surface lands in one edit). Task-2 owns the only mutation of the loop's second usage-accumulation source and the batch-before-`tool_result` ordering; task-3 and task-4 depend on that behavior being stable. Task-4 is expected to require **no production change** (the types already make a leak a compile error); if it surfaces a real leak, the fix lands in `sanitizeChildEvent` (task-3) or the loop flush (task-2). No cross-feature decision is introduced — this decomposition is feature-local and is **not** pushed to `docs/project/decisions.md`.

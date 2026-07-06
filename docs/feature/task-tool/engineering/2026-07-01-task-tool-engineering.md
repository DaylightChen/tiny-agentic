# Feature Engineering Spec — Sub-agent / `Task` tool

> Standard feature pipeline (combined product + engineering). Scope: `feature/task-tool`. Phase: `engineering`. Date: 2026-07-01. Author: `feature-architect`.
> Upstream: research at `docs/feature/task-tool/research/2026-06-30-task-tool-research.md`. Built on the `core-run-controls` seams (`RunOptions.signal`, `Terminal.usage`).
> Primary, binding artifact for this feature. Supersedes the empty template stub at `docs/feature/task-tool/engineering/engineering.md`.
>
> **Rev 2 (2026-07-01, self-review fixes).** Six blocking issues resolved: (1) `resolveChild` is **mandatory** for v1 — no core default resolver (a default cannot reach the parent's private provider/tools); (2) the parent/child boundary is enforced by a **sanitized `SubagentChildEvent` union** that omits `messages`, not the full `AgentEvent` (which carries child transcript on terminals); (3) `taskId` correlation is made concrete via a new `context.toolCallId`; (4) child events are **batched before the `tool_result`** in v1 (no real-time delta promise); (5) the **numeric depth guard is deferred** — v1 relies solely on the structural bound (child tool set excludes `task`), so no `Agent.run` widening and no `maxDepth`/`depth` plumbing; (6) a **Test plan** section maps invariants to tests. Non-blocking: model example corrected, `model`/`provider` clarified as opaque strings, stray `spawn?` removed.
>
> **Rev 4 (2026-07-02, post-review hardening).** After the adversarial review (`../review-2026-07-02-task-tool-review.md`), two items below were **superseded** — see the living record in `../decisions.md` (2026-07-02): (a) the **numeric depth guard is no longer deferred** (Rev 2 item 5 / R2) — a backstop was implemented via an optional `RunOptions.depth` + `context.depth` + `createTaskTool({ maxDepth })` (default 1), so `Agent.run` gains one optional `@internal` field; (b) the required model-facing **`description` input was dropped** (it was a dead "for logging" contract), so the Microcopy section's `description` field no longer applies. The body below is the historical 2026-07-01 snapshot.

## Goal

Add a built-in **`task` tool** to `tiny-agentic` core that lets a running agent spawn a **sub-agent** — a nested `Agent.run()` with its own scoped tool set and turn budget — and receive the child's result back as a single tool result. The audience is framework/SDK consumers building multi-agent workflows (a coordinator that delegates a self-contained sub-task to a focused worker). What changes for the consumer: they can register one extra tool that turns a single agent into a delegating one, and — new in this feature — each sub-task can run on a **different model and/or provider** than the parent (a cheap model for triage, a strong model for the hard sub-task), with the child's token usage rolling up into the parent's run total automatically. The parent model sees only the child's final summary string, never the child's tool noise; the parent's event-stream consumer sees a normalized, `taskId`-tagged view of the child's lifecycle — provider-native message blocks never cross the parent/child boundary.

## Motivation

The project roadmap names the sub-agent Task tool as the payoff of the just-shipped `core-run-controls` work: that feature deliberately added `RunOptions.signal` (so a parent can cancel children) and `Terminal.usage` (so a parent can roll up child costs) *specifically* as the prerequisites for this tool (`docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md:16`). The primitive is what "turns a single agent into a framework": without it, an agent is one flat loop; with it, agents compose. The current state has every seam except the tool itself — `Agent` already runs a scoped loop, `Terminal.usage` already carries the child's total, `context.signal` already reaches tool handlers — but nothing wires them together, and the tool handler is under-provisioned to construct a child (§Architectural fit). The specific new capability the user is asking for on top of the base primitive: **per-task model/provider selection**. A coordinator often wants to run cheaply by default but escalate a single hard sub-task to a stronger (or differently-shaped) model; without per-task overrides, every sub-agent is locked to the parent's provider instance, which forecloses the most common real reason to delegate.

## User-visible behavior

> Lightweight sketch, not a full UX spec. "The user" here is of two kinds and both matter: (a) the **model**, which invokes the tool and reads its result; (b) the **consumer**, the code driving `agent.run()` and reading the event stream. This is a headless framework, so "what the user sees" = the tool schema the model sees + the events/return values the consumer sees.

### Primary flow

Two audiences, one flow.

**Consumer (setup):**

1. Consumer builds a **child-agent resolver** and passes it (required) when constructing the parent's `task` tool: `createTaskTool({ resolveChild })`. `resolveChild` is a caller-supplied function that, given a resolved child spec (`{ subagentType?, model?, provider?, prompt, signal }`), returns a **fully-constructed child `Agent`** to run — the host has already baked in its provider instance, tool set, system prompt, `maxTurns`, and (optionally) approval handler, applying the fallback chain (task override → subagent profile default → runner/global default). `resolveChild` is **mandatory**: core cannot build a child itself because a running `Tool.call` has no access to the parent's provider or tool set (both are private on `Agent`), so there is no core default resolver. This is also where subagent *profiles* live (an SDK concern) and where `model`/`provider` — opaque strings to core — are interpreted and validated.
2. Consumer registers the returned `Tool` in the parent `Agent`'s `tools` array alongside the others.
3. Consumer runs the parent normally: `for await (const ev of agent.run(prompt, { signal }))`.

**Model (invocation):** The model sees a tool named `task` with input `{ description: string, prompt: string, subagent_type?: string, model?: string, provider?: string }`. It calls it to hand a self-contained sub-task to a fresh agent (e.g. `task({ description: "audit deps", prompt: "List outdated dependencies in package.json and their latest versions.", model: "claude-haiku-4-5" })`). `model`/`provider` are opaque hint strings — core does not interpret them; the host's `resolveChild` decides what they mean (and rejects ones it can't honor). It gets back one tool result: the child's final assistant text (a summary), or an error string if the child failed.

**Consumer (observation):** On the parent's event stream, the consumer receives — immediately **before** the parent's `tool_result` for a `task` call — a batch of **sanitized, correlated child events** (`subagent_event` wrapping a `SubagentChildEvent`, each tagged with the spawning call's `taskId`). Each wraps a *sanitized* view of a child lifecycle event (`text_delta`, `tool_use_start`, `tool_result`, or a terminal reduced to `{ reason, usage }` — **never** the child's `messages`). The child's usage is folded into the parent's `cumulativeUsage`, so the parent's terminal `usage` already includes the child's tokens. (v1 batches these before the `tool_result`; it does not promise real-time child deltas interleaved with the parent's own output — see §Risks R3.)

### States matrix

Surfaces: (S1) the model-facing `task` tool result; (S2) the consumer-facing event stream during a child run.

| Surface | Empty | Loading | Error | Partial | Offline |
|---|---|---|---|---|---|
| **S1 — tool result (model-facing)** | Child produced no assistant text → result is the fixed string `"(sub-agent produced no output)"`, `isError:false`. | N/A — a tool result is atomic; the model waits for `runTools` to complete. Liveness is a consumer concern (S2), not the model's. | Child terminal is `agent_error` → result is `"Sub-agent failed: <message>"`, `isError:true`. Unknown `provider`/unresolvable `model` → the tool fails validation-style with `"Sub-agent config error: <detail>"`, `isError:true`, before any child run. | Child hit `max_turns_exceeded` → result is the child's last assistant text (best-effort partial) prefixed with `"[sub-agent stopped at turn cap] "`, `isError:false` (the parent can still use partial work). | Network failures surface *through* the child run as `agent_error` → same as Error row. The `task` tool has no offline mode of its own. |
| **S2 — event stream (consumer-facing)** | Child emits no `text_delta` → consumer still sees the `subagent_event`(terminal, `{reason,usage}`) framing the empty run. | Consumer sees a batch of `subagent_event`s wrapping the child's sanitized `text_delta`/`tool_*` lifecycle, emitted immediately before the parent's `tool_result` for that call (not interleaved with parent output in real time). Correlated by `taskId` so concurrent-in-history or nested runs are distinguishable. | Child error surfaces as a `subagent_event` wrapping the child's terminal `{reason:"agent_error", usage}`, then the parent's `tool_result`(isError). The **parent run continues** — a child failure is a tool error, not a parent error. | Parent aborts mid-child (`signal` fires) → child aborts (cascade); the consumer sees the child's terminal `{reason:"agent_error"}` batch, then the parent's own `agent_error`. | N/A — the stream is in-process; "offline" manifests inside child events as provider errors. |

### Accessibility

N/A — headless framework, no human-facing UI, no keyboard/pointer/color surface. The analogous contract (and the one that matters here) is **stream legibility**: a consumer must be able to distinguish parent output from child output, and one child run from another, without parsing free text. This is met by the `subagent_event` wrapper carrying an explicit `taskId: string` (the spawning `task` call's tool-use id, sourced from the new `context.toolCallId`) rather than relying on interleaved-order or textual markers. (Stated here so the requirement is not lost to the `N/A`.)

### Edge-case behaviors

- **Recursion (model spawns spawner):** the child's tool set **excludes the `task` tool** (structural depth bound), so a sub-agent cannot spawn further sub-agents. `resolveChild` is contractually responsible for this exclusion; it is the *sole* recursion bound in v1 (a numeric depth guard is deferred — §Edge cases E1, §Risks R2).
- **Large child output:** the result string is the child's last assistant text only (not the full transcript), which bounds the size the parent model ingests; a very long single assistant message is still passed through verbatim (not truncated by core — truncation is a consumer/SDK policy).
- **Concurrent sub-agents:** out of scope for this cut — `runTools` is sequential, so two `task` calls in one turn run one after another. The design does not foreclose parallelism (§Out of scope, §Risks R6).
- **Parent cancellation during a child run:** the parent's per-run signal reaches the handler via `context.signal`; the handler runs the child under a **linked child signal** so parent-abort cascades to the child, but a child-internal error does not abort the parent (§Architectural fit).
- **Provider/model override that is invalid:** resolved and validated by `resolveChild` *before* the child loop starts; a bad `provider` id or a model the resolver rejects becomes a clean `isError` tool result, never a thrown exception to the parent consumer.

### Microcopy

Exact strings the model receives (stability matters — the model keys off them):

- Tool `description` (model-facing): `"Delegate a self-contained sub-task to a fresh sub-agent that runs with its own tools and turn budget, and return its final summary. Use for well-scoped work you can describe completely up front. Optionally pick a model or provider for the sub-task. Sub-tasks run one at a time in this version."`
- Empty child output: `"(sub-agent produced no output)"`
- Child error result: `"Sub-agent failed: <error message>"`
- Turn-cap partial result prefix: `"[sub-agent stopped at turn cap] "`
- Config error (bad model/provider): `"Sub-agent config error: <detail>"`
- Field descriptions: `description` → `"3-5 word summary of the sub-task, for logging."`; `prompt` → `"The full task for the sub-agent. Must be self-contained — the sub-agent does not see this conversation."`; `model` → `"Optional model hint for the sub-task. Interpreted by the host; falls back to the sub-agent profile default, then the runner default."`; `provider` → `"Optional provider hint for the sub-task. Interpreted by the host; falls back to the sub-agent profile default, then the runner default."`; `subagent_type` → `"Optional named sub-agent profile to use, if the host registered any."`

(Core treats `model`, `provider`, and `subagent_type` as **opaque strings** — it neither validates nor enumerates them; the host's `resolveChild` gives them meaning. The field descriptions above are the model-facing text; a host that registers named profiles/providers may want to append its concrete allowed values, but core ships the generic wording.)

## Out of scope

- **Subagent *type registry* loaded from markdown/frontmatter** (`SKILL.md`-style agent definitions). Core exposes the `subagent_type` string and hands it to `resolveChild`; loading/parsing named profiles is an SDK concern (decision 2026-06-27, tool-only core).
- **Parallel / background / `run_in_background` sub-agents.** First cut is sequential (matches `runTools`). No worktrees, no remote/detached tasks, no teammate/swarm spawning.
- **Prompt-cache sharing / byte-identical request prefixes** (the reference's `CacheSafeParams`). Anthropic-specific cost optimization, not a correctness requirement, not part of the provider-agnostic surface (research §2.6).
- **Sidechain transcript persistence.** Core is stateless; the child's full `Message[]` is available on its `Terminal` *inside the tool handler* for a host that wants to persist it (via `resolveChild`'s closure or the returned `Agent`), but core never surfaces the child transcript on the parent's event stream or tool result, and never persists it.
- **A numeric depth counter / multi-level deep recursion as a designed feature.** v1 bounds recursion *only* structurally — `resolveChild` excludes the `task` tool from the child, so a sub-agent cannot spawn one. A numeric `depth`/`maxDepth` guard is deferred (it would need depth to cross the `Agent.run` boundary, which v1 does not do — §Risks R2). Nesting beyond depth 1 is neither designed nor guarded-by-counter in v1.
- **A model-selectable list of providers baked into core, and any core default resolver.** Core does not know provider names, does not enumerate them, and ships **no** default `resolveChild` — a default cannot construct a child because the parent's provider and tools are private to `Agent`. `resolveChild` is mandatory; the host owns all provider/model/profile knowledge.

## Architectural fit

The design centers on **three context seams**, ordered by novelty/risk: (1) a **usage write-back** path (`reportUsage`) so a tool can contribute out-of-band tokens (a child run) to the parent's run total; (2) a **child-event sink** (`emitEvent`) so a tool can surface *sanitized* child events on the parent stream; (3) a **tool-call correlation id** (`toolCallId`) so events a tool emits can be tied back to the exact `task` call that produced them. All three are added to the already-sanctioned extension point — `ToolCallContext` (populated by `agentLoop`, decision 2026-06-27) — keeping the `Tool.call` arity at three and honoring the interface-merging convention. Constructing the child itself is **not** a core seam: the `task` tool is a **factory function** (`createTaskTool`) that closes over a caller-supplied `resolveChild`, because a running `Tool.call` cannot reach the parent's provider or tool set (both private on `Agent`) — so the child is built by the host, not by core. Per-run operational data (`signal`, `reportUsage`, `emitEvent`, `toolCallId`) arrives via `context`; per-tool config (`resolveChild`) rides on the factory — the split the research flagged as mandatory (§3.1).

**v1 boundary (self-review outcomes):** `resolveChild` is **mandatory** (no core default resolver). The parent/child boundary is enforced by a **sanitized child-event union** (`SubagentChildEvent`) that omits `messages` — not the raw `AgentEvent`, whose terminal arms carry the child's transcript. Recursion is bounded **structurally only** in v1 (child tool set excludes `task`); the numeric depth guard, `maxDepth`, and any `context.depth` are **deferred** (they would need depth to cross the `Agent.run` boundary — §Risks R2). Child events are **batched immediately before the parent `tool_result`** for that call; real-time interleaving is not promised in v1 (§Risks R3).

**Placement:** the `task` tool is **core** (it is a pure agentic primitive over `Agent`/`Tool`/`Usage`/`AbortSignal`, and it is *the* thing that makes the framework multi-agent). The subagent-*type* registry is SDK. This resolves research open question #7 in favor of "primitive in core, profile registry in SDK," consistent with the tool-only-core decision. `createTaskTool` ships from core; SDK layers can wrap it with profile loading by supplying `resolveChild`.

**Existing modules touched:**

- `packages/core/src/types/tool.ts` — widen the `ToolCallContext` interface with three new **optional, core-populated** fields (`reportUsage?`, `emitEvent?`, `toolCallId?` — signatures below). Optional preserves back-compat for every existing tool and honors the "SDK must not add required fields" rule; these are *core*-populated, so they sit alongside `signal`.
- `packages/core/src/loop/loop.ts` — (a) construct the new context fields before/around each `runTools` batch and thread them, populating `toolCallId` per tool-use from the pending `tool_use.id`; (b) after each batch, fold any tool-reported usage into `cumulativeUsage`; (c) forward any tool-emitted (sanitized) child events onto the parent's yielded stream. This is the load-bearing change — it is the only place `cumulativeUsage` is mutated today (only from `message_stop`, `loop.ts:75`), and the write-back must land here.
- `packages/core/src/loop/runTools.ts` — **minor change:** it must set `context.toolCallId` to the current `tu.id` before each `tool.call` (and clear it after), so the tool knows which call it is. The `reportUsage`/`emitEvent` sinks are set once by the loop and ride along unchanged; no change to `runTools`'s external signature. (Alternative: the loop constructs a fresh per-tool context object; either way the correlation id must be per-tool-use, not per-batch.)
- `packages/core/src/types/events.ts` — add the `subagent_event` variant to `AgentEvent` (wrapping a `taskId` + a **sanitized** `SubagentChildEvent`, defined here), and define the `SubagentChildEvent` union itself. No change to `Terminal`.
- `packages/core/src/index.ts` — export `createTaskTool`, its option/result types, and the new `AgentEvent`/`SubagentChildEvent` types.

**New modules / files introduced:**

- `packages/core/src/tools/builtin/task.ts` — `createTaskTool(options)`; the tool factory, the `resolveChild` call, the child run driver (`for await` over `child.run(prompt, { signal: linkedSignal })`), result extraction, usage roll-up call, and sanitized-event forwarding. The single new production module.
- `packages/core/src/tools/builtin/task.internal.ts` *(optional)* — pure helpers split out for unit testing without a live child run: `extractResultText(messages)` (last-assistant text → string, with the empty-output fallback), `mapChildTerminalToResult(terminal)` (`Terminal` → `{ text, isError }` per the E4 mapping), and `sanitizeChildEvent(event)` (`AgentEvent` → `SubagentChildEvent`, dropping `messages`). May be inlined; the exploration log will note the call. (No `resolveModelProvider` helper — model/provider resolution is entirely the host's `resolveChild`, not core's.)

**New interfaces / contracts:**

```ts
// types/tool.ts — added to the existing ToolCallContext interface (all optional, core-populated)
export interface ToolCallContext {
  signal?: AbortSignal;                       // (existing)
  /** Report token usage consumed by work a tool performed out-of-band (e.g. a
   *  child Agent run). agentLoop folds this into the run's cumulative usage
   *  after the tool batch. Safe to call multiple times; each call accumulates. */
  reportUsage?: (usage: Usage) => void;
  /** Emit a sanitized child event onto the parent's stream from inside a tool.
   *  Used by the task tool to surface the child's lifecycle. In v1 the loop
   *  buffers these and yields them (wrapped as `subagent_event`) immediately
   *  before the tool's `tool_result`. Never carries child `messages`. */
  emitEvent?: (event: SubagentChildEvent) => void;
  /** The tool-use id of the call currently executing. Populated by the loop per
   *  tool-use so a tool can correlate emitted events / logs to its own call
   *  (the task tool uses it as `taskId`). Absent for tools that don't need it. */
  toolCallId?: string;
}

// types/events.ts — sanitized child event union (NO `messages`, NO provider blocks)
export type SubagentChildEvent =
  | { type: "text_delta";      text: string }
  | { type: "tool_use_start";  toolName: string; toolInput: unknown }
  | { type: "tool_result";     toolName: string; toolCallId: string; isError: boolean }  // note: no `result` payload — see below
  | { type: "terminal";        reason: "agent_done" | "max_turns_exceeded" | "agent_error"; usage: Usage; errorMessage?: string };

// types/events.ts — the new AgentEvent arm wraps the sanitized union + correlation id
//   | { type: "subagent_event"; taskId: string; event: SubagentChildEvent }

// tools/builtin/task.ts — the factory's public contract
export type ChildSpec = {
  subagentType?: string;   // model-supplied profile selector — opaque string
  model?: string;          // model-supplied model hint — opaque string
  provider?: string;       // model-supplied provider hint — opaque string
  prompt: string;          // the sub-task
  signal: AbortSignal;     // linked child signal (parent-abort cascades; child error does not touch parent)
};

/** resolveChild returns the fully-constructed child Agent to run. The host bakes
 *  in provider/tools/systemPrompt/maxTurns/approvalHandler and applies the
 *  fallback chain. Returning an Agent (not raw config) keeps ALL provider-name
 *  and profile knowledge in host code. Throw an Error to reject an invalid
 *  model/provider/type; the tool converts the throw to a clean isError result. */
export type CreateTaskToolOptions = {
  resolveChild: (spec: ChildSpec) => Agent | Promise<Agent>;   // MANDATORY — no core default
  /** Optional: override the tool's wire name. Default "task". */
  name?: string;
  // NOTE: no `maxDepth` in v1. Recursion is bounded structurally — resolveChild
  // MUST omit the `task` tool from the child's tool set. See §Risks R2.
};

export function createTaskTool(options: CreateTaskToolOptions): Tool;
```

**On the `tool_result` child event carrying no `result`:** the child's `tool_result.result` is arbitrary tool output that, for a child running provider-shaped tools, can embed provider-native structures. To keep the sanitized union unambiguously provider-agnostic, the forwarded `tool_result` child event carries only `toolName`/`toolCallId`/`isError` (enough for progress display and correlation), **not** the raw result payload. A consumer that needs full child tool outputs reads the child `Terminal` inside its own `resolveChild`-provided `Agent` wiring, not the parent stream. (Optional future extension: a host that wants child tool payloads on the stream can serialize them itself before emitting; core's default sanitized shape omits them.)

**Modified existing interfaces (back-compat plan):**

- `ToolCallContext` — three optional fields added (`reportUsage?`, `emitEvent?`, `toolCallId?`). Existing tools ignore them (they already ignore `context` or read only `signal`). No breakage; `bash.ts` et al. compile and behave identically.
- `AgentEvent` — one new variant `subagent_event` (wrapping `taskId` + a sanitized `SubagentChildEvent`). Additive to a discriminated union. Existing consumers use `switch (event.type)`; a new arm they don't handle falls through their `default`/is ignored — the same forward-compat posture the union already documents (`events.ts:14`, "tertiary events / advanced consumers"). Consumers that exhaustively `switch` without a `default` get a compile nudge to handle it, which is the desired behavior.
- `Agent` / `RunOptions` — **no change.** v1 threads nothing new across the `Agent.run` boundary: the child is a plain `child.run(prompt, { signal: linkedSignal })`. There is no `depth` parameter and no depth seeding (the numeric depth guard is deferred, §Risks R2), so `Agent.run(prompt, { messages?, signal? })` stays exactly as-is. `runTools` sets `context.toolCallId` per tool-use, but that is internal to the loop, not on `Agent`'s public surface.

**Usage/event collection mechanism (the loop-side detail, v1):** the constraint is that `Tool.call` is *awaited* — a tool cannot `yield` onto the parent stream while it runs (research §3.2). So v1 uses a **collect-then-flush** model, no async queue or concurrency:

1. Before each `runTools` batch the loop creates a per-batch `reportedUsage: Usage[]` and wires `context.reportUsage` to push into it.
2. For **each tool-use**, the loop (or `runTools`) sets `context.toolCallId = tu.id` and wires `context.emitEvent` to push into a per-call `childEvents: SubagentChildEvent[]`.
3. When that tool's `call` resolves, the loop yields the buffered `childEvents` as `subagent_event`s (`{ taskId: tu.id, event }`) **immediately before** yielding that tool's `tool_result`. This is the batch-before-`tool_result` ordering contract (§Risks R3): child events always follow the spawning `tool_use_start` and precede its `tool_result`, correlated by `taskId`.
4. After the whole batch, the loop `accumulateUsage`s each entry of `reportedUsage` into `cumulativeUsage`.

This keeps `runTools`'s external signature stable, requires no concurrent draining, and localizes all new loop logic to the tool-execution block (`loop.ts:101-137`). Real-time interleaving (yielding child events *as the child streams*, before `call` resolves) would require restructuring `runTools` into something that can yield mid-`call` — explicitly out of scope for v1 and deferred as an additive future upgrade.

## Data model changes

No schema/storage changes (core is stateless; nothing is persisted). Type-level changes only:

- **`ToolCallContext`** gains `reportUsage?`, `emitEvent?`, `toolCallId?` (above). Optional under `exactOptionalPropertyTypes` — absent, not `undefined`.
- **`SubagentChildEvent`** (new union, `types/events.ts`) — the *sanitized* child-lifecycle union: `text_delta`, `tool_use_start`, `tool_result` (metadata only — no `result` payload), and a reduced `terminal` (`{ reason, usage, errorMessage? }`). **It deliberately omits `messages`** and any provider-native block. This is the crux of the boundary fix: the child's raw `AgentEvent` terminals carry `messages: Message[]` (the full child transcript, containing provider-shaped `tool_use`/`tool_result` blocks), so wrapping the raw `AgentEvent` would leak the transcript onto the parent stream. `sanitizeChildEvent` maps each raw child `AgentEvent` to a `SubagentChildEvent`, dropping `messages` and the raw tool-result payload.
- **`AgentEvent`** gains one arm:
  ```ts
  | { type: "subagent_event"; taskId: string; event: SubagentChildEvent }
  ```
  `taskId` is the spawning `task` call's tool-use id (from `context.toolCallId`), so a consumer correlates a child's events to the exact call. **Not recursive:** the wrapped payload is a `SubagentChildEvent`, which has no `subagent_event` arm — so even if a host misconfigures a child to spawn (against the structural bound), a grandchild's events cannot nest onto the parent stream through this type; they would only appear on the child's own (unforwarded) stream. No change to `Terminal`.
- **`ChildSpec` / `CreateTaskToolOptions`** — new public types from `task.ts` (above). `resolveChild` returns a *constructed `Agent`* directly (not a wrapper, not raw provider/tools), so the fallback logic (task → profile → runner) and all provider-name knowledge live entirely in the host. This is the concrete shape of the user's "fallback order: task override → subagent profile default → runner/global default": the tool passes the opaque `model`/`provider`/`subagentType` hints into `resolveChild`; the resolver decides the winner and returns the built child. No `maxDepth` (deferred), no `ResolvedChild` wrapper (an `Agent` is returned directly).
- **Optional observability metadata (future, not v1 core):** if a host later wants richer per-child stream metadata (e.g. the resolved model/provider name, a child-run start timestamp), the sanitized `terminal` event is the natural carrier and can gain optional fields additively — noted so the union is designed to grow without breaking. v1 ships the minimal shape above.
- **No migration.** Additive optional fields on an interface; new union type; one new `AgentEvent` arm. Existing serialized histories are unaffected (`subagent_event` is a live event, never persisted into `Message[]`). The **normalized-boundary invariant** is now a *type-level* guarantee, not just a convention: what crosses to the parent is (a) a `string` tool result and (b) `subagent_event`-wrapped `SubagentChildEvent`s — a closed, provider-agnostic union with no `Message`, no `ContentBlock`, and no `ProviderEvent` in it.

## Edge cases

Behavioral cases that break naive implementations (pair with the S1/S2 states matrix, which is the user-facing side):

- **E1 — Unbounded recursion.** Naive: give the child the parent's full tool set including `task`; a model recursively spawns until cost/limits blow up. Design (v1): the **sole** bound is structural — `resolveChild` is contractually required to **omit the `task` tool** from the child's tool set, so a sub-agent has no way to spawn one. This works with zero cross-boundary plumbing. (The reference *also* uses a numeric depth counter; ours defers it — E2/R2 — because it would require depth to cross the `Agent.run` boundary. The structural bound alone fully prevents the runaway in v1's depth-1 posture.) A test constructs a `resolveChild` that *wrongly* includes `task` and asserts the documented contract is what prevents recursion (i.e. correct hosts are safe; core does not silently re-add a second guard in v1).
- **E2 — (Deferred) numeric depth propagation.** In a design with a numeric depth guard, the child's loop would need to know its depth, but `Agent.run` is a closed `(prompt, { messages?, signal? })` surface (decision 2026-06-27) with no `depth` param. Rather than widen that surface or thread an ambient depth in v1, **the numeric guard is dropped for v1** and recursion relies on E1's structural bound. Recorded so a later revision that wants deep, guarded nesting knows the deferred design point (candidate: seed `context.depth` inside the loop and have `createTaskTool` read it — but that needs the child loop to receive a starting depth, which is exactly the boundary-crossing v1 avoids). See §Risks R2.
- **E3 — Child aborts vs. parent aborts.** Naive: pass `context.signal` straight to the child; then a *child-internal* timeout that aborts the child also looks like a parent abort, or aborting the child kills the parent. Design: the tool builds a **linked child controller** — `AbortSignal.any([context.signal, childCtrl.signal])` — so parent-abort cascades down, but the child failing/timing out does not touch the parent's signal. Parent continues after a child error (the child error is just a tool result). Mirrors the reference's `createChildAbortController`.
- **E4 — Child ends in `agent_error` / `max_turns_exceeded`.** Naive: throw, killing the parent turn. Design: the tool *never throws for a child terminal*; it maps: `agent_done` → last assistant text (or empty-output string); `max_turns_exceeded` → partial text with the turn-cap prefix, `isError:false`; `agent_error` → `"Sub-agent failed: <message>"`, `isError:true`. In **all** cases the child's `Terminal.usage` (partial on error, `EMPTY_USAGE` if uncaptured) is fed to `context.reportUsage` so cost still rolls up.
- **E5 — Usage double-count or loss.** Naive: both the child's usage *and* a re-walk of child stream events get accumulated → double count; or the tool returns usage in its result value and nothing accumulates it → silent loss. Design: exactly one path — the tool calls `context.reportUsage(child.terminal.usage)` once; the loop accumulates reported usage once, after the batch. The child's per-turn usage is *not* re-derived by the parent (unlike the reference, which must; `tiny-agentic`'s `Terminal.usage` is already the total — research §2.4). Guard test: parent `Terminal.usage` == parent-own tokens + child `Terminal.usage`, exactly.
- **E6 — Unresolvable model/provider.** Naive: construct a provider with a bad id and fail deep in the child's first stream call as an opaque `agent_error`. Design: `resolveChild` validates and **throws before the child runs**; the tool catches the throw and returns `"Sub-agent config error: <detail>"` `isError:true`. Fail fast, fail legibly, zero child tokens spent.
- **E7 — Boundary leak.** Naive: return the child's full `Message[]` as the tool result, or forward the child's raw `AgentEvent`s — whose terminal arms carry `messages: Message[]` (the child transcript, full of provider-shaped `tool_use`/`tool_result` blocks) and whose `tool_result` arm carries an arbitrary `result` payload. Either leaks provider-native structure onto the parent surface. Design: the result is a **`string`** (extracted assistant text); child events crossing to the parent are `SubagentChildEvent`s — a closed union that *by construction* has no `messages`, no `ContentBlock`, and no raw tool-result payload (§Data model). `sanitizeChildEvent` is the single choke point; the parent-facing types make a leak a *type error*, not just a convention. This is the user's "do not leak provider-native message blocks across parent/child runs" made structural and enforced by the compiler.
- **E8 — Empty / whitespace-only child output.** Naive: return `""`, which some providers reject as an empty tool result. Design: substitute the fixed `"(sub-agent produced no output)"` string.
- **E9 — Consumer breaks out mid-child.** If the parent consumer stops iterating during a child run, `context.signal` is aborted (via the `Agent.run` finally, `agent.ts:81`), which cascades to the child's linked signal; the child run unwinds to a terminal, and the buffered `SubagentChildEvent`s (plus the closing `tool_result`) for that call are simply never yielded because the parent generator is being torn down. No throw, no leak, no orphaned child stream.

## Risks

- **R1 — Usage write-back is the load-bearing novel seam.** *Risk:* the loop's accumulation point (`loop.ts:75-77`) only knows about `message_stop`; wiring a *second* accumulation source (tool-reported) risks ordering bugs (accumulate before/after the batch), missed-on-error paths, or double counting (E5). *Impact:* wrong cost attribution — the headline value of the feature. *Mitigation:* implement and test this seam **first**, in isolation, with a `MockProvider` child and a fake reporter, before any real child run. A dedicated loop test asserts parent total == own + reported. Risk-ordered first in the plan.
- **R2 — Numeric depth guard deferred (structural bound only in v1).** *Risk:* the cleanest *numeric* recursion guard needs the child's loop to know its depth, but `Agent.run` is an intentionally closed `(prompt, { messages?, signal? })` surface (decision 2026-06-27) — no `depth` param, and adding one bleeds sub-agent semantics into the base entry point. *Impact if forced:* either the guard silently never trips, or we widen `Agent`'s public API against a recorded decision. *Resolution (v1):* **do not build the numeric guard.** Rely solely on the structural bound — `resolveChild` omits the `task` tool from the child (E1) — which needs zero depth plumbing and fully prevents runaway spawning at the depth-1 posture v1 targets. This removes the risk from v1 entirely (there is no depth to propagate). The trade-off: a host that *deliberately* wants deep, counter-guarded nesting can't get a numeric cap from core yet; that is deferred and, if pursued, must be designed without widening `Agent.run` (candidate in E2). No mid-implement redesign pressure remains here.
- **R3 — Child-event forwarding cannot be real-time in v1.** *Risk:* `Tool.call` is awaited and `runTools` cannot `yield` mid-`call` (research §3.2 — the tool contract returns a value); so a tool genuinely cannot stream events onto the parent stream *while it runs* without restructuring `runTools` into a concurrent producer/consumer (an async queue), which is a real complexity and correctness cost. *Impact:* consumers do not see child `text_delta`s live; they arrive as a batch just before the `tool_result`. *Resolution (v1):* adopt **collect-then-flush** as the design, not a fallback — buffer each call's sanitized events and yield them (as `subagent_event`) immediately before that call's `tool_result`, correlated by `taskId` (§Architectural fit collection mechanism). The ordering contract is stated narrowly and tested: child events for a `task` call appear after its `tool_use_start` and before its `tool_result`; real-time interleaving is explicitly **not** offered in v1. Upgrading to real-time later is additive — it changes *when* events are yielded, not the `SubagentChildEvent` shape — so v1's contract does not foreclose it. This keeps R3 fully out of R1's path.
- **R4 — Core factory placement without provider-registry leakage.** *Risk:* shipping a factory that accepts provider/model *hints* could pull provider-registry concerns toward core, which the tool-only-core decision pushes to SDK. *Impact:* if implemented wrong, core learns provider names (violates the split). *Mitigation:* the seams (`reportUsage`/`emitEvent`/`toolCallId`) are unambiguously core; `resolveChild` keeps *all* provider-name knowledge in host code, so `createTaskTool` lives in core **without** core knowing any provider name. Core exports the factory; SDK layers can wrap it with profile registries.
- **R5 — Per-task provider means the child may differ from the parent in ways usage can't reconcile.** *Risk:* a child on OpenAI has no `cacheWriteTokens`; a parent on Anthropic does. Summing across providers is defined (`accumulateUsage` handles the optional field, decision 2026-06-29 / core-run-controls) but the *aggregate* usage then mixes provider semantics (a cache-read token on Anthropic ≠ one on OpenAI). *Impact:* a consumer reading only the rolled-up total loses per-provider fidelity. *Mitigation:* accept it for the total (documented), and note that per-child fidelity is preserved on each `subagent_event`(terminal)'s `usage` — a consumer that needs per-provider breakdown reads the child terminals, not just the parent total. No code change; a documented limitation.
- **R6 — Sequential-only forecloses the reference's "launch many agents" guidance.** *Risk:* the reference model is prompted to parallelize sub-agents; ours can't (sequential `runTools`). *Impact:* slower multi-delegation; the model may try to batch `task` calls expecting parallelism. *Mitigation:* out of scope by decision; the `isConcurrencySafe` seam (`tool.ts:77`) is the future path and the `task` tool can opt in later (a child run is I/O-bound and independent — a natural concurrency candidate). Note in the tool description that sub-tasks run one at a time so the model doesn't assume otherwise. No redesign risk; the seam already exists.

## Success criteria

**Functional:**

- [ ] A parent agent with a registered `task` tool can spawn a child that runs its own scoped loop and returns a single string result to the parent model.
- [ ] The child's tool set is whatever `resolveChild` returns, and a correct `resolveChild` **omits** the `task` tool (a sub-agent cannot spawn a sub-agent). `resolveChild` is mandatory — `createTaskTool` has no default and there is no path by which core constructs a child on its own.
- [ ] A `task` call with `model`/`provider`/`subagent_type` hints passes those opaque strings to `resolveChild`, which applies the fallback order (task hint → subagent profile default → runner default) and returns the correspondingly-configured child `Agent`; an unhonorable hint makes `resolveChild` throw and yields `"Sub-agent config error: <detail>"` (`isError:true`) with zero child tokens spent.
- [ ] Parent-abort (external `signal` or consumer `break`) cascades to an in-flight child via the linked signal; a child error/timeout does **not** abort the parent — the parent continues and sees an `isError` tool result.
- [ ] Child terminal reasons map correctly: `agent_done`→summary, `max_turns_exceeded`→prefixed partial (`isError:false`), `agent_error`→`"Sub-agent failed: …"` (`isError:true`); empty output→`"(sub-agent produced no output)"`.
- [ ] The child's `Terminal.usage` is folded into the parent's `cumulativeUsage`: the parent's terminal `usage` equals the parent's own tokens plus the child's total, with no double-count and no loss (including on child error).
- [ ] The consumer receives `subagent_event`s wrapping **sanitized** `SubagentChildEvent`s (correlated by `taskId`) for the child's lifecycle, batched immediately before the spawning call's `tool_result`.
- [ ] **No `Message`, `ContentBlock`, or `ProviderEvent` crosses the parent/child boundary** — the tool result is a `string`; forwarded child events are `SubagentChildEvent`s, a closed union with no transcript or raw tool payload. This is enforced by the types (a leak would be a compile error), and asserted by a test that inspects the parent stream and result for any child-transcript shape.
- [ ] Existing tools (`bash`, `read_file`, etc.) and existing `AgentEvent` consumers compile and behave unchanged (additive-only back-compat).

**Non-functional:**

- [ ] The three new `ToolCallContext` fields are optional; a `Tool.call` that ignores them (all existing tools) needs zero changes.
- [ ] The usage write-back adds no measurable per-turn overhead for runs that spawn no sub-agents (the loop's new post-batch step is a no-op when nothing reported).
- [ ] `Agent.run`'s public signature is unchanged (`(prompt, { messages?, signal? })`); no new required parameter anywhere.
- [ ] The tool factory + result-mapping helpers are unit-testable without a live model (via `MockProvider`), and the usage roll-up is testable without a real child (via a fake reporter).

## Test plan

Maps the critical invariants to concrete tests. The existing harness suffices — no live model needed: `MockProvider` replays scripted `ProviderEvent[][]` (one inner array per `stream()` call), `MockPlatform` stubs the platform, `collectEvents`/`collectText` drain a run (see `packages/core/src/__tests__/loop.test.ts`). A **child `Agent` is constructible from a `MockProvider`**, so a `resolveChild` in tests just returns `new Agent({ provider: mockChildProvider, tools, platform })`. New/extended test files:

**`__tests__/task-tool.test.ts`** (new — the tool in isolation, child driven by a `MockProvider`):

| # | Invariant (maps to) | Test |
|---|---|---|
| T1 | Happy path result (SC1) | `resolveChild` returns a child whose `MockProvider` ends `agent_done` with assistant text "OK"; assert the `task` tool result is `"OK"`, `isError:false`. |
| T2 | Empty output (E8, microcopy) | Child ends `agent_done` with no assistant text; assert result === `"(sub-agent produced no output)"`, `isError:false`. |
| T3 | Child error mapping (E4, SC5) | Child provider throws → child `agent_error`; assert result `"Sub-agent failed: <msg>"`, `isError:true`, and parent is unaffected. |
| T4 | Turn-cap partial (E4, SC5) | Child scripted to exceed `maxTurns`; assert result begins `"[sub-agent stopped at turn cap] "` and `isError:false`. |
| T5 | Config error (E6, SC3) | `resolveChild` throws (`new Error("unknown provider 'x'")`); assert result `"Sub-agent config error: unknown provider 'x'"`, `isError:true`, and the child provider's `stream` was **never** called (zero tokens). |
| T6 | Opaque hints passed through (SC3) | `resolveChild` is a spy; call `task({ model:"m", provider:"p", subagent_type:"t", prompt:"…" })`; assert the spy received `{ model:"m", provider:"p", subagentType:"t", prompt:"…" }` and core did not inspect/validate them. |
| T7 | `resolveChild` mandatory | Type-level: `createTaskTool({})` fails to compile (documented in a `// @ts-expect-error` test). Runtime: constructing without `resolveChild` is unrepresentable. |
| T8 | Abort cascade (E3, SC4) | Parent signal aborts while child is mid-stream; assert the child’s run receives an aborted signal (child `stream` sees `signal.aborted`) and the child terminates; the tool returns without throwing. Also assert a child-internal error does **not** abort the parent signal. |
| T9 | Recursion bound (E1, SC2) | `resolveChild` correctly omits `task` → the child’s registry has no `task`; assert a child attempt to call `task` yields the unknown-tool result, not a spawn. |

**`__tests__/subagent-boundary.test.ts`** (new — the leak-proof boundary, the user's hard requirement):

| # | Invariant | Test |
|---|---|---|
| T10 | Sanitized events only (E7, SC8) | Run a parent whose child (via `MockProvider`) emits text + a tool call + a terminal carrying `messages`. Collect the parent stream; for every `subagent_event`, assert `event.event` has no `messages` key, no `content`/`ContentBlock` shape, and `tool_result` child events have no `result` field. |
| T11 | Result is a string (E7) | Assert the parent `tool_result.result` for the `task` call is `typeof === "string"` (never an object/array/Message). |
| T12 | Terminal reduced (data model) | Assert the child terminal surfaces as `{ type:"terminal", reason, usage, errorMessage? }` only. |

**`__tests__/loop.test.ts`** (extend — the load-bearing seams in the loop):

| # | Invariant | Test |
|---|---|---|
| T13 | Usage write-back (R1, SC6) | A stub tool calls `context.reportUsage({inputTokens:5,outputTokens:7,cacheReadTokens:0})`; assert the run's terminal `usage` equals the parent's own message-stop usage **plus** the reported usage, exactly (field-wise). |
| T14 | No double-count / no loss on error (E5, SC6) | Reported usage on a turn where the tool also returns `isError:true`; assert it is still accumulated once and only once. |
| T15 | Event batch ordering (R3, SC7) | A stub tool calls `context.emitEvent(a)` then `emitEvent(b)`; assert the parent stream yields `subagent_event(a)`, `subagent_event(b)`, then the `tool_result` for that call — in that order, and after the call's `tool_use_start`. |
| T16 | `toolCallId` correlation (correlation mechanism) | A stub tool reads `context.toolCallId` and echoes it; assert it equals the `tu.id` of the current call, and the emitted `subagent_event.taskId` matches it. |
| T17 | No-subagent no-op (NF: overhead) | A run with tools but no `reportUsage`/`emitEvent` calls behaves byte-identically to today (regression: existing loop tests still pass unchanged). |

**Back-compat / type tests** (extend `__tests__/types.test.ts` or a new `subagent-types.test.ts`):

| # | Invariant | Test |
|---|---|---|
| T18 | Additive context (NF, SC-backcompat) | An existing tool (e.g. `bashTool`) that ignores the new context fields compiles and runs unchanged. |
| T19 | `AgentEvent` exhaustiveness | A `switch` over `AgentEvent` without a `subagent_event` arm and no `default` produces a compile error (`// @ts-expect-error`), proving the arm is additive-and-visible. |
| T20 | `SubagentChildEvent` closed | Assert (type-level) that `SubagentChildEvent` is not assignable from a `Message`-bearing terminal `AgentEvent` — the sanitized union cannot represent a transcript. |

**Smoke (manual, non-CI):** extend an `examples/*-run.ts` with a `task` call that delegates a trivial sub-task to a second model id, printing `subagent_event`s and the rolled-up `usage`, to catch real-provider surprises the mocks can't (per the project's established "real-API smoke" practice, decision 2026-06-29). Not a phase gate.

## Resolved engineering decisions for planning

The user authorized proceeding without further approval prompts after self-review fixes, so the remaining confirmations are resolved using the spec's recommendations:

- **Factory placement:** `createTaskTool` ships from core and is exported from `packages/core/src/index.ts`. The SDK can layer profile loading on top by supplying `resolveChild`; core remains provider-name-free.
- **Recursion bound:** v1 uses the structural bound only. `resolveChild` must omit `task` from child agents. Numeric `depth`/`maxDepth` is deferred because it would require a new cross-`Agent.run` depth propagation design.
- **Child event timing:** v1 uses batch-before-`tool_result`, not real-time child deltas. The ordering contract is: child events follow the spawning `tool_use_start` and precede its `tool_result`, correlated by `taskId`.
- **Child approval handling:** host-owned through `resolveChild`. Core neither inherits the parent's approval handler nor imposes a default child handler.

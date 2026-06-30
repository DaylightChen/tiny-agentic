# Research — Sub-agent / `Task` tool

> Feature scope: `feature/task-tool`. Phase: research (phase zero). Date: 2026-06-30. Author: researcher agent.
>
> One-line intent: a built-in tool that lets an agent spawn a **sub-agent** — a nested `Agent` run with its own tool set and turn budget — and return the child's result to the parent as a tool result, with the child's token usage rolling up into the parent via the `Terminal.usage` seam shipped in `core-run-controls`.
>
> **No external web research was performed.** This feature sits squarely on ground the project already owns: the Claude Code reference implements exactly this pattern, and the tiny-agentic core API is the only other input that matters. This doc is grounded in (a) a reference deep-dive of the decompiled Claude Code v2.1.88 `AgentTool` subsystem and (b) a feasibility analysis of the current `packages/core` API. Both were required regardless. Surfacing evidence and open questions only — **no engineering decisions** (that is the feature-architect's job next phase).

---

## 1. Research questions

Derived from the feature intent and the architect's grounding notes:

1. **Reference mechanics.** How does Claude Code's `Agent`/`Task` tool construct and drive a nested agent? Specifically: how is the child loop invoked, how is the child's tool set scoped, what is the result shape returned to the parent, how does usage roll up, how is the turn budget set, and how is recursion/depth bounded?
2. **Feasibility in tiny-agentic.** Can a built-in `Tool` construct and drive a nested `Agent` given the *current* core API? What does the tool handler need access to that it does not have today (provider, platform, tool registry, signal, system prompt)?
3. **Event-stream relationship.** How does the child's async-generator event stream relate to the parent's? Does the parent surface child events on its own stream, or only the final result string?
4. **Usage roll-up mechanism.** What exactly does `Terminal.usage` carry, and how would a parent fold a child's usage into its own run total? Does the existing seam suffice, or is a new mechanism needed?
5. **Domain constraints.** How do the UI-free boundary, provider-agnosticism (Anthropic + OpenAI), the stateless-core convention, the core/SDK split, AbortSignal propagation, approval-handler inheritance, and recursion/turn-budget safety bound the design space?
6. **What must be generalized.** Where is the reference Anthropic-API-shaped, and what must be made provider-agnostic for tiny-agentic?

---

## 2. Prior art & existing solutions

The only directly relevant prior art is the **Claude Code reference** (`claude-code-source-code/`, the project's declared learning source). The reference's sub-agent system is mature, in production, and far larger in scope than what tiny-agentic needs. The value of the deep-dive is isolating the *minimal essence* from the production accretions.

### 2.1 Wire name and entry point

- The tool's wire name is **`Agent`** (`tools/AgentTool/constants.ts:1`), with **`Task`** preserved as a legacy alias (`constants.ts:3`) for backward compat (permission rules, hooks, resumed sessions). So "the Task tool" is the same construct.
- Model-facing input schema (`AgentTool.tsx:82`): `{ description: string (3-5 words), prompt: string, subagent_type?: string, model?: enum, run_in_background?: boolean }`, plus multi-agent/isolation extensions gated behind features. **For tiny-agentic, only `description` + `prompt` (+ optionally a subagent-type selector) are essential**; `model`, `run_in_background`, worktree/remote isolation, and teammate/swarm spawning are all production features out of scope.

### 2.2 How the nested agent is constructed and driven

The load-bearing module is `tools/AgentTool/runAgent.ts` — an `async function*` (`runAgent`, line 248) that drives a nested `query()` loop and yields the child's messages. Stripped to essence:

1. Resolve the agent definition and model (`runAgent.ts:340`).
2. Resolve the child's tool set via `resolveAgentTools(...)` (`runAgent.ts:500`) — see §2.3.
3. Build a child system prompt from the agent definition (`getAgentSystemPrompt`, `runAgent.ts:906`).
4. Build a **child `AbortController`** linked to the parent (sync agents share the parent's controller; async agents get a fresh one) (`runAgent.ts:520-528`).
5. Construct an **isolated child context** via `createSubagentContext(...)` (`utils/forkedAgent.ts:345`) — by default *all* mutable state is cloned/isolated to prevent interference with the parent (file-state cache cloned, fresh collections, mutation callbacks no-op'd), and `queryTracking.depth` is **incremented** (`forkedAgent.ts:451-455`).
6. `for await (const message of query({ ...child config }))` — drives the nested loop, yielding the child's messages up (`runAgent.ts:748`).
7. The **result returned to the parent is the child's last assistant message's text content** — `extractTextContent(lastAssistantMessage.message.content, '\n')` (`utils/forkedAgent.ts:241` `extractResultText`; async path `agentToolUtils.ts:605`). Not the full transcript — a single summary string.

The reference's `utils/forkedAgent.ts` `runForkedAgent` (line 489) is a simpler sibling used for *forks* (cache-sharing same-context children) and is where the usage roll-up pattern is clearest (§2.4).

The project's own subsystem map already names the essence (`docs/project/research/01-core-agent-loop.md:62`): *"a sub-agent is just another `query()` with a narrower scoped context."* For tiny-agentic the analog is exact: **a sub-agent is just another `Agent.run()` with a scoped tool set and turn budget.**

### 2.3 Child tool-set scoping

`resolveAgentTools` (`agentToolUtils.ts:122`) + `filterToolsForAgent` (`agentToolUtils.ts:70`) implement scoping:

- An agent definition declares `tools` (allow-list; `undefined` or `['*']` = wildcard = inherit all) and `disallowedTools` (deny-list). The child's pool is the parent's available pool filtered by both.
- **Recursion guard:** `filterToolsForAgent` excludes the `Agent` tool itself from sub-agents (`agentToolUtils.ts:104` references `AGENT_TOOL_NAME`; `ALL_AGENT_DISALLOWED_TOOLS` at line 94 drops it). So by default **a sub-agent cannot spawn further sub-agents** — recursion is bounded structurally by removing the spawning tool from the child, *in addition to* the `queryTracking.depth` counter. (Swarm/teammate features re-allow it under gates, out of scope here.)

This is the cleanest takeaway to borrow: **the simplest depth bound is "don't give the child the Task tool."** A numeric depth counter is a secondary, more flexible guard.

### 2.4 Usage roll-up (the seam THIS feature is built on)

The reference rolls child usage up by summing per-turn usage as the child loop streams:

- `ForkedAgentResult` carries `totalUsage: NonNullableUsage` (`forkedAgent.ts:115-120`).
- Inside the loop, on each `message_delta` stream event it does `turnUsage = updateUsage({...EMPTY_USAGE}, event.usage)` then `totalUsage = accumulateUsage(totalUsage, turnUsage)` (`forkedAgent.ts:557-566`).
- `accumulateUsage` / `updateUsage` / `EMPTY_USAGE` live in `services/api/` — **tiny-agentic's `core-run-controls` feature deliberately ported these exact primitives** as `accumulateUsage`, `mergeUsage`, and `EMPTY_USAGE` in `types/usage.ts`.

The crucial structural difference: in the reference the *parent* manually re-accumulates the child's per-stream-event usage because the child loop doesn't return a tidy total to the model-facing tool. In tiny-agentic, **`Agent.run()` already returns a `Terminal` whose `usage` field is the fully-accumulated run total** (`loop/loop.ts:29,76,143`; `types/events.ts:35`). So the parent does *not* need to re-walk the child's stream — it can read `terminal.usage` directly off the child run and `accumulateUsage` it into its own total. The seam is strictly simpler in tiny-agentic than in the reference.

### 2.5 Turn budgeting

The child gets its own `maxTurns` (`runAgent.ts:756`: `maxTurns ?? agentDefinition.maxTurns`). On hitting the cap, `query()` emits a `max_turns_reached` signal that `runAgent` breaks on (`runAgent.ts:772-787`). tiny-agentic already has the analog: `AgentOptions.maxTurns` (default 25, `agent.ts:38`) and a `max_turns_exceeded` terminal event/`Terminal` (`loop/loop.ts:35-38`).

### 2.6 What is Anthropic-API-shaped and must be generalized

- The reference's usage roll-up reads Anthropic stream events (`message_delta.usage`) directly (`forkedAgent.ts:557-566`). **tiny-agentic already abstracts this away** — both providers normalize to the `Usage` shape and the loop accumulates it provider-agnostically. So this generalization is *already done* by `core-run-controls`; the Task tool just reads `Terminal.usage`.
- The reference's "prompt cache sharing" machinery (`CacheSafeParams`, byte-identical request prefixes) is Anthropic-prompt-cache-specific and **does not need to be ported** — it is a cost optimization, not a correctness requirement, and is not part of the provider-agnostic surface.
- Agent definitions loaded from `SKILL.md`/agent-markdown frontmatter, MCP server wiring, sidechain transcript persistence, worktrees, remote/background tasks, teammates/swarms — all **SDK/product concerns, not core** (consistent with the project's three-package split).

---

## 3. Technical feasibility & candidate approaches in tiny-agentic

**Verdict: feasible with the current core API, but the tool handler is currently under-provisioned with the context it needs.** The gap is small and well-defined.

### 3.1 What a built-in Task tool needs, vs. what `Tool.call` gets today

A `Tool.call(input, platform, context)` receives:
- `input` (validated) — would carry the child `prompt` (+ description, + optional subagent selector).
- `platform: Platform` — **available**, can be passed straight to the child `Agent`.
- `context: ToolCallContext` — currently `{ signal?: AbortSignal }` (`types/tool.ts:16`). The loop populates `signal` (`loop/loop.ts:25`). So the child-cancellation signal **is already reachable** from inside a tool handler.

To construct a child `new Agent({ provider, tools, platform, systemPrompt?, maxTurns?, approvalHandler? })` the handler additionally needs, **none of which are on `ToolCallContext` today**:
- the **`provider`** (held privately on the parent `Agent`, `agent.ts:26`),
- the **tool set** to give the child (the parent holds `tools: Tool[]` privately, `agent.ts:27`),
- optionally the **`approvalHandler`** (private, `agent.ts:31`) and a **system prompt** and **`maxTurns`** for the child.

There are (at least) two credible shapes for closing this gap — **this is the architect's decision, not mine**; I list the trade-offs:

- **Option A — widen the core-populated `ToolCallContext`.** The loop already constructs the context (`loop/loop.ts:25`) and has `provider`/`registry`/`platform`/`approvalHandler`/`systemPrompt` in `LoopParams` (`loop/loop.ts:11-20`). It could populate context with what a Task tool needs (e.g. a `spawn`/agent-factory function, or the raw provider + a tool list). Pro: `ToolCallContext` is *the* designated core extension point and the decision log (2026-06-27, ToolCallContext interface merging) already reserves it for core-populated fields like `signal`. Con: leaks more of the run's internals to every tool; needs care about which tool set the child receives (see §4).
- **Option B — make the Task tool a factory closure.** A `createTaskTool({ provider, tools, platform, ... })` returns a `Tool` whose `call` closes over the config. Pro: keeps `ToolCallContext` minimal; explicit about what the child gets. Con: the closed-over config can drift from the *actual* run config (e.g. a different `signal` per run); the per-run `signal` still has to come from `context`, so it is a hybrid anyway.

Either way, the **per-run `signal` must come from `context`** (it is created fresh per `run()`), while the **provider/tool-set/approval config is per-`Agent`**. Any design must respect that split.

### 3.2 Child event stream vs. parent stream

`Agent.run()` is `AsyncGenerator<AgentEvent, Terminal>`. A Task tool runs *inside* `runTools` (`loop/runTools.ts`), which is itself `async function*`. The handler is a plain `async` method returning `Promise<unknown>` — it cannot itself yield onto the parent stream. So the baseline behavior is:

- The child's events are **consumed internally** by the tool handler (drive `for await (const ev of child.run(prompt, { signal }))` to completion), and **only the final result** (last assistant text, or a structured summary) becomes the `tool_result` the parent loop persists and feeds back to the model. This mirrors the reference exactly (the parent model sees one summary string, not the child's tool noise — `prompt.ts:257`).
- **Open design space (architect):** whether to *also* surface child progress on the parent's event stream (e.g. re-emit child `text_delta`/`tool_result` events, perhaps namespaced/depth-tagged) for observability. This is *not* possible through the current `Tool.call` return-a-value contract; it would need a new seam (e.g. an event-sink callback on `ToolCallContext`, or making the Task tool a special-cased core construct rather than a plain `Tool`). The reference does forward child messages to the parent's *UI metrics* but the *model* only sees the summary. tiny-agentic is headless, so "surface to UI" maps to "surface on the event stream" — a real question with cost/benefit, flagged in §5.

### 3.3 Usage roll-up — the existing seam suffices

`Agent.run()` returns `Terminal` with `usage: Usage` (the run total, `loop/loop.ts:143`). A Task tool handler that drives the child to completion captures that terminal (via the `for await` loop's terminal event, or the generator return), then must surface the child's `usage` so it accumulates into the **parent's** `cumulativeUsage`.

But here is the friction point: **the parent loop accumulates usage only from `message_stop` provider events** (`loop/loop.ts:61-64,75-77`). A tool result does **not** currently contribute to `cumulativeUsage` — the loop has no path for "this tool consumed N tokens." So returning the child's `Terminal.usage` as part of the tool result value is necessary but **not sufficient**: something must add it to the parent's run total. Candidate mechanisms (architect decides):

- A new field on `ToolCallContext` the handler calls to report usage (e.g. `context.reportUsage?.(childTerminal.usage)`), which the loop folds into `cumulativeUsage` after the tool batch.
- The `tool_result` AgentEvent gains an optional `usage?: Usage` that the loop accumulates.
- The loop treats a structured child-usage payload in the returned tool result specially.

Each touches the loop's accumulation logic. The `core-run-controls` spec explicitly named `Terminal.usage` as "the roll-up seam" — confirmed correct as the *source*, but the *sink* (parent accumulation from a tool) is a **new seam this feature must add**. This is the single most load-bearing/novel piece and should be risk-ordered early. **Hard finding to flag, not a hard constraint:** the seam exists on the read side; the write-back side does not yet.

### 3.4 Stateless-core fit

The core is stateless: `run()` threads history via `options.messages` and returns final messages on the terminal. A child `Agent.run(prompt, { messages?, signal })` fits this perfectly — the parent can optionally seed the child with context messages (a "fork"-style child) or start it fresh (the default sub-agent). No persistence, no session state in core — consistent with decisions 2026-06-26 (stateless core) and 2026-06-27 (Skill/Command are SDK-layer).

---

## 4. Domain & landscape constraints

Any credible design must respect these (all sourced from the project's own decisions/specs/code):

- **UI-free / headless (Hard constraint).** The Task tool and any child run import zero UI code; all output flows through the typed event stream or the returned tool-result value (CLAUDE.md hard boundary; decision 2026-06-26). "Show progress to the user" = "put it on the event stream," never render.
- **Provider-agnostic (Hard constraint).** Anthropic + OpenAI behind the `Provider` interface. The child must run under *a* provider; usage normalization is already provider-agnostic via `Usage` (decision 2026-06-26 provider abstraction; `core-run-controls`). The Task tool must not assume Anthropic-shaped usage or cache semantics.
- **Core vs. SDK split.** A *built-in* Task tool that spawns a nested core `Agent` is plausibly **core** (it is a pure agentic primitive, the thing that "turns a single agent into a framework," per the feature intent, and uses only core constructs: `Agent`, `Tool`, `Usage`, `AbortSignal`). Agent *definitions* loaded from markdown frontmatter, subagent "types", MCP wiring, transcript persistence, worktrees, background/remote tasks are **SDK/product** (decision 2026-06-27 tool-only core; three-package architecture). **Open question for the architect:** is the Task tool itself core, or an SDK construct that the SDK injects? Evidence leans core for the *primitive*, SDK for the *type registry* — but this is a genuine fork (§5).
- **AbortSignal propagation.** The parent's per-run composite signal reaches the tool via `context.signal` (`loop/loop.ts:25`, shipped in `core-run-controls`). A child should run under a signal that aborts when the parent aborts. The reference uses a *child* controller linked to the parent (`createChildAbortController`, `utils/abortController.ts:68`) so aborting the child doesn't kill the parent, but parent-abort cascades down. tiny-agentic can pass `context.signal` straight into `child.run(prompt, { signal: context.signal })` for the simplest correct behavior (parent abort → child abort); a child-scoped controller is an enhancement, not a requirement.
- **Approval-handler inheritance.** The parent holds `approvalHandler` privately (`agent.ts:31`); `runTools` receives it (`loop/runTools.ts:19`). Whether the child inherits the same handler, gets a stricter one, or none, is a design choice. The reference *scopes* child permissions (clears parent session allow-rules so parent approvals don't leak, `runAgent.ts:469-479`). Flagged in §5.
- **Recursion / turn-budget safety (Hard constraint on having *a* bound).** Without a depth bound, a model can recursively spawn agents unboundedly (cost + runaway). The reference bounds it two ways: (1) the child doesn't get the spawning tool (`agentToolUtils.ts:94`), (2) a `queryTracking.depth` counter (`forkedAgent.ts:451-455`). At minimum tiny-agentic needs *one* bound. The child also needs its own `maxTurns` (the parent's default 25 applies per-run; a deeply-nested tree multiplies turns).

---

## 5. Key findings & implications

1. **The pattern is well-trodden and the reference maps cleanly.** A sub-agent is "just another `Agent.run()` with a scoped tool set and turn budget." *Implication (engineering):* the architecture risk is low on the loop mechanics; isolate effort on the seams (§3.1, §3.3), not on re-deriving the loop. This is a "standard pattern, confirmed against the reference and the existing `Agent` API" finding.

2. **The usage *read* seam exists; the usage *write-back* seam does not.** `Terminal.usage` gives the child's total directly (simpler than the reference's per-event re-accumulation), but the parent loop only accumulates from `message_stop` — there is no path today for a tool to contribute tokens to the parent's `cumulativeUsage`. *Implication (engineering): this is the single load-bearing, novel piece — add a tool→loop usage write-back seam and risk-order it first.* (Not a hard constraint; a real new mechanism.)

3. **The tool handler is under-provisioned to build a child `Agent`.** It has `platform` and `signal` but not `provider`, the tool set, the approval handler, or a child system prompt/maxTurns. *Implication (engineering): decide how to thread per-`Agent` config (provider/tools/approval) into the handler — widen the core-populated `ToolCallContext` (Option A) or a factory closure (Option B) — while keeping the per-run `signal` sourced from `context`.* (§3.1)

4. **Child events vs. parent stream is a genuine fork.** Baseline: child events are consumed internally and only a summary string returns (matches the reference; cheapest; preserves the headless contract trivially). Surfacing child progress on the parent stream needs a *new* seam (event-sink on context, or special-casing the Task tool out of the plain `Tool.call` contract). *Implication (engineering, weigh): how much observability into nested runs is worth a new seam, given headless consumers can't otherwise see child progress?* (§3.2)

5. **Recursion must be bounded, and "don't give the child the Task tool" is the cheapest bound.** *Implication (engineering, Hard constraint that a bound exists): pick at least one of {exclude Task tool from child set, depth counter}; the reference uses both.* (§2.3, §4)

6. **Is the Task tool core or SDK?** The *spawning primitive* looks core (pure `Agent`+`Tool`+`Usage`); the *subagent-type registry / agent definitions* look SDK (markdown, frontmatter — decision 2026-06-27). *Implication (engineering, weigh): a minimal core Task tool that spawns a child with a caller-provided tool set + prompt, with subagent "types" deferred to the SDK, is consistent with the three-package split — but confirm placement before designing the input schema (`subagent_type` is an SDK-ish concept).* (§4)

7. **Most reference complexity is out of scope.** Cache-sharing (`CacheSafeParams`), worktrees, remote/background tasks, teammates/swarms, sidechain transcripts, MCP wiring, frontmatter hooks — all production accretions or SDK concerns. *Implication: the architect should resist porting them; the minimal essence is a child `Agent.run()` + result extraction + usage roll-up.*

---

## 6. Sources

Primary (the project's own code and the declared learning reference — high trust):

- `packages/core/src/agent.ts` — `Agent` class, `AgentOptions`, `RunOptions` (already has `signal`), private `provider`/`tools`/`platform`/`approvalHandler`. The entry point a child would be constructed from.
- `packages/core/src/loop/loop.ts` — `agentLoop`; shows where `cumulativeUsage` is accumulated (only from `message_stop`), where `ToolCallContext` is built (`{ signal }`), and the terminal `usage` construction. Source of the §3.3 write-back-gap finding.
- `packages/core/src/loop/runTools.ts` — tool-execution path; confirms `Tool.call(input, platform, context)` returns a value (cannot yield onto the parent stream).
- `packages/core/src/types/tool.ts` — `Tool`, `ToolCallContext` (the designated core extension point), `ApprovalHandler`, unused `isConcurrencySafe`.
- `packages/core/src/types/usage.ts` + `types/events.ts` — `Usage`, `EMPTY_USAGE`, `mergeUsage`, `accumulateUsage`; `Terminal.usage` (the read seam) and terminal-event usage fields.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` — explicitly names `Terminal.usage` as the sub-agent roll-up seam and documents the `mergeUsage`/`accumulateUsage` semantics; §2 motivation ties signal + usage to "the upcoming sub-agent Task tool."
- `docs/project/decisions.md` — core/SDK split (2026-06-27 tool-only core), three-package architecture, stateless core, ToolCallContext interface-merging extension, AbortSignal threading, M2 tool-cancellation-via-context seam.
- `claude-code-source-code/src/tools/AgentTool/runAgent.ts` — the nested-agent driver (`runAgent` generator); construction, tool resolution, child abort controller, child `maxTurns`, child `query()` loop.
- `claude-code-source-code/src/utils/forkedAgent.ts` — `runForkedAgent` + `createSubagentContext`; the clearest usage roll-up (`ForkedAgentResult.totalUsage`, `accumulateUsage` on `message_delta`) and the context-isolation/`queryTracking.depth` pattern.
- `claude-code-source-code/src/tools/AgentTool/agentToolUtils.ts` — `resolveAgentTools`/`filterToolsForAgent` (tool scoping; recursion guard excluding the Agent tool); `extractResultText`/`extractPartialResult` (result = last assistant text).
- `claude-code-source-code/src/tools/AgentTool/prompt.ts` — model-facing description; confirms parent sees one summary string, not child tool noise; "launch multiple agents concurrently" guidance.
- `claude-code-source-code/src/tools/AgentTool/constants.ts` — wire name `Agent`, legacy alias `Task`.
- `claude-code-source-code/src/utils/abortController.ts` — `createChildAbortController` (parent→child abort cascade, child-abort doesn't kill parent).
- `docs/project/research/01-core-agent-loop.md` — project subsystem map: "a sub-agent is just another `query()` with a narrower scoped context."

Secondary: none. No web sources were consulted; none were needed.

---

## 7. Open questions & unknowns (for the feature-architect)

Each with the evidence bearing on it. These are decisions for the engineering phase, not for me.

1. **Usage write-back mechanism (highest priority).** How does a child's `Terminal.usage` get added to the parent's `cumulativeUsage`? The loop only accumulates from `message_stop` today (`loop/loop.ts:75-77`). Candidates: a `context.reportUsage(usage)` callback the loop drains after the tool batch; an optional `usage?` on the `tool_result` event; or special-casing. *Needs:* a loop-design decision; possibly a small spike to confirm the accumulation point. This is the novel/load-bearing seam.

2. **Threading per-`Agent` config into the handler.** Widen the core-populated `ToolCallContext` (provider + tool set + approval handler + maybe a child-Agent factory) vs. a factory-closure Task tool. Evidence: `ToolCallContext` is the reserved core extension point (decision 2026-06-27) and already carries `signal`; but the per-run `signal` must stay context-sourced while config is per-`Agent` (§3.1).

3. **Do child events surface on the parent stream?** Baseline = no (consume internally, return summary; matches reference, trivially headless-safe). Surfacing needs a new event-sink seam. Weigh observability vs. a new mechanism + event-namespacing/depth-tagging design (§3.2, §5.4).

4. **Child tool-set scoping.** Does the child inherit the parent's full tool set, a caller-specified subset, or a fixed sub-agent profile? The reference uses allow/deny lists with a wildcard default and **excludes the Task tool from children** (`agentToolUtils.ts:94,104`). At minimum the child set should exclude (or bound) further spawning (§2.3, §4).

5. **Recursion / depth bound.** Which guard(s): exclude Task tool from child set, a numeric depth counter on `ToolCallContext`, or both (the reference does both)? And what default depth/turn budget for children, given turns multiply down a tree (§2.5, §4, §5.5)?

6. **How is the child `Agent` configured?** Same provider as parent (likely, for cost/consistency) or selectable? Default child system prompt vs. caller-provided vs. a subagent-"type" prompt? Note: subagent *types* (named profiles loaded from markdown) look SDK-layer, implying the core Task tool takes an explicit prompt + tool set and the SDK layers types on top — confirm (§4, §5.6).

7. **Is the Task tool core or SDK?** Spawning primitive → core; subagent-type registry → SDK. Genuine fork; affects the input schema (does core's tool expose `subagent_type` at all?) (§4, §5.6).

8. **Approval-handler inheritance.** Child inherits parent's `approvalHandler`, gets a stricter one, or none? The reference scopes child permissions so parent approvals don't leak (`runAgent.ts:469-479`). Evidence available; decision open (§4).

9. **Error / timeout propagation.** If the child run ends in `agent_error` or `max_turns_exceeded`, what does the parent's tool result say? The reference returns a partial result on kill (`extractPartialResult`, `agentToolUtils.ts:488`). Map child terminal reasons → tool-result string/`isError`. The child's `Terminal.usage` (partial on error) should still roll up (§3.3).

10. **Concurrency.** The reference encourages launching multiple agents in parallel (`prompt.ts:248`). tiny-agentic runs tools sequentially today (`runTools`, with an `isConcurrencySafe` hook reserved for M2). Parallel sub-agents are out of scope for a first cut but the architect should note whether the seam forecloses it.

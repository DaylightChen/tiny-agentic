# Known Issues

> Track deferred bugs, workarounds, and architectural debt. Each entry should include a reproduction or symptom, the workaround in place (if any), and the conditions for revisiting.

## Format

```
## [Issue title]

**Discovered:** YYYY-MM-DD ([phase name], Task NN if applicable)
**Status:** open / mitigated / resolved
**Symptom:** [What goes wrong, including reproduction steps]
**Workaround:** [What's in place today, if anything]
**Revisit when:** [Trigger condition for picking this up]
```

---

## edit_file does not enforce read-before-edit (feature/agent-tooling)

**Discovered:** 2026-06-29 (engineering, feature/agent-tooling)
**Status:** open (deferred by design)
**Symptom:** The `edit_file` tool does not verify that the model has previously called `read_file` on the file before editing it. A model that issues an `edit_file` call without first reading the file may attempt to replace a string that was accurate at some earlier point in the conversation but has since been changed on disk (by another tool call, concurrent process, etc.).
**Workaround:** The `edit_file` tool performs an atomic read-find-replace-write at call time, so it always edits the current on-disk content. The uniqueness check (`old_string` must appear exactly once) catches many stale-edit attempts. The risk is low in single-agent, single-file workflows.
**Revisit when:** The Agent SDK layer exists and can widen `ToolCallContext` with `readFileState: Map<string, ReadEntry>`. Enforcement should be added in the SDK layer (which populates the map when `read_file` runs) rather than in the core (which would need to couple the loop to a specific tool's semantics).

---

## write_file range mode with an offset past EOF (M1, minor)

`write_file` with an `offset` beyond the file's last line appends the content at the end (JS `Array.splice` treats a `start` past length as "append"). `deleteCount` is clamped to `>= 0` so nothing is corrupted and `replacedLines` is never negative, but there is no gap-filling with blank lines between the old EOF and the inserted content. This is benign and unlikely in practice; revisit if a real use case needs explicit out-of-range handling.

---

## Sub-agent / `task` tool: cross-provider usage fidelity (feature/task-tool)

**Discovered:** 2026-07-02 (implement, feature/task-tool Task 05)
**Status:** open (accepted limitation, R5)
**Symptom:** When a sub-task runs on a different provider than the parent, the child's `Terminal.usage` is folded into the parent's rolled-up `cumulativeUsage`, but token semantics differ across providers (an Anthropic cache-read token is not equivalent to an OpenAI one; a child on OpenAI has no `cacheWriteTokens`). The **rolled-up parent total therefore mixes provider semantics** and cannot be interpreted as a single provider's token accounting.
**Workaround:** Per-child fidelity is preserved on each `subagent_event`(terminal)'s `usage` — a consumer that needs a per-provider breakdown reads the child terminals rather than only the parent total. No code change planned.
**Revisit when:** A consumer needs a provider-attributed cost breakdown from the aggregate; that would require a usage shape tagged by provider, a cross-cutting change to `Usage`.

---

## Sub-agent / `task` tool: sequential-only sub-agents (feature/task-tool)

**Discovered:** 2026-07-02 (implement, feature/task-tool Task 05)
**Status:** open (deferred by design, R6)
**Symptom:** v1 runs `task` calls one at a time — `runTools` executes tool calls sequentially, so two `task` calls in one turn run one after another, not concurrently. A model prompted to parallelize sub-agents cannot in v1. The tool description states "Sub-tasks run one at a time in this version." so the model does not assume otherwise.
**Workaround:** None needed for correctness; delegation still works, just serially.
**Revisit when:** Parallel sub-agents are wanted. The future path is the `isConcurrencySafe` seam on `Tool` (`packages/core/src/types/tool.ts`) — a child run is I/O-bound and independent, a natural concurrency candidate.

---

## Sub-agent / `task` tool: numeric depth guard — RESOLVED (feature/task-tool)

**Discovered:** 2026-07-02 (implement, feature/task-tool Task 05)
**Resolved:** 2026-07-02 (post-review hardening, review item D1)
**Status:** resolved
**Symptom (original):** v1 bounded recursion **structurally only** — `resolveChild` must omit the `task` tool from the children it builds — with no numeric backstop. A host that *deliberately* (or accidentally, by reusing the parent's tool array) re-included the `task` tool was caught by no second guard and could recurse until `maxTurns`, multiplicatively across depth.
**Resolution:** A numeric backstop was added. `agentLoop` seeds `context.depth` (0 at the top level) from a new optional `RunOptions.depth`; the `task` tool drives each child at `depth + 1` and refuses to spawn when `context.depth >= maxDepth` (new `createTaskTool({ maxDepth })` option, **default 1**), returning `"Sub-agent depth limit reached (maxDepth=N); refusing to spawn a nested sub-agent."` with zero child tokens spent. This crosses the previously-closed `Agent.run` boundary via a single optional, `@internal`-documented field (decision 2026-07-02). The structural bound (omit `task`) remains the primary protection; the counter is a safety net. Covered by tests T-cov-2a/b/c in `task-tool.test.ts`.
**Revisit when:** N/A (resolved). If deep guarded nesting is wanted, raise `maxDepth` per `task` tool.

---

## Sub-agent / `task` tool: child events are not real-time (feature/task-tool)

**Discovered:** 2026-07-02 (post-review hardening, review item D2 / spec R3)
**Status:** open (accepted limitation, v1)
**Symptom:** A consumer sees NONE of a child's `text_delta`/tool events while the child runs; they arrive as a batch of `subagent_event`s immediately BEFORE the spawning call's `tool_result`. In-flight nested runs are opaque on the parent stream. This is inherent to v1's collect-then-flush model: `Tool.call` is awaited, so a tool cannot yield onto the parent stream mid-call.
**Workaround:** For coarse progress, read the batched `subagent_event`s (correctly ordered, `taskId`-correlated). There is no live child-delta stream in v1.
**Revisit when:** Live child observability is needed. The upgrade is additive — it changes WHEN events are yielded, not the `SubagentChildEvent` shape: restructure `runTools` into a concurrent producer/consumer (an async queue) so a tool can surface events as the child streams. Deferred because that is a real complexity/correctness cost the headline feature does not require.

---

## Sub-agent / `task` tool: `break` does not cancel an in-flight child (feature/task-tool)

**Discovered:** 2026-07-02 (post-review hardening, review item D3)
**Status:** open (documented behavior)
**Symptom:** A consumer that wires a "stop" button to breaking the `for await` loop finds it unresponsive for the entire child run. While a `task` tool's `call` is awaited, the parent generator has no yield point, so the consumer's `.return()` is queued behind the still-pending child `.next()`: the child runs to completion and the run's teardown `abort` fires too late to interrupt it.
**Workaround:** To cancel in-flight sub-agent work promptly, abort the run `signal` you passed to `agent.run(prompt, { signal })`. That cascades into the child at once (confirmed by test T-cov-1). Use the signal, not `break`, for sub-agent cancellation.
**Revisit when:** Prompt cancellation of an awaited tool call is needed — the same structural change as real-time child events above (a yielding/concurrent `runTools`).

---

## Sub-agent / `task` tool: child usage absent from `turn_complete` (feature/task-tool)

**Discovered:** 2026-07-02 (post-review hardening, review item I3)
**Status:** open (accepted observability gap)
**Symptom:** Child token spend surfaces only in the run's cumulative `usage` on the TERMINAL event, and per-child on each `subagent_event`(terminal)'s `usage`. It is NEVER included in any `turn_complete.usage`, which carries the parent's own per-turn tokens only. A consumer building a live token meter by summing `turn_complete.usage` deltas under-counts by the entire child spend.
**Workaround:** For live child cost, read each `subagent_event`(terminal)'s `usage`; for the authoritative running total, read the terminal event's cumulative `usage`. Do not reconstruct cost from `turn_complete` alone.
**Revisit when:** A live, child-inclusive per-turn usage signal is wanted; would require attributing folded child usage onto `turn_complete` (a small additive change if a consumer needs it).

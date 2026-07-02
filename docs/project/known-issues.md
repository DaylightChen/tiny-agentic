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

## Sub-agent / `task` tool: numeric depth guard deferred (feature/task-tool)

**Discovered:** 2026-07-02 (implement, feature/task-tool Task 05)
**Status:** open (deferred by design, E2 / R2)
**Symptom:** v1 bounds recursion **structurally only** — `resolveChild` must omit the `task` tool from the children it builds, so a correct host cannot spawn beyond depth 1. There is no numeric `depth`/`maxDepth` counter. A host that *deliberately* wires a child agent with the `task` tool re-included is not caught by a second, counter-based guard in v1.
**Workaround:** Honor the documented contract — do not include the `task` tool in a child's tool set. The example `resolveChild` (in `examples/task-run.ts`) comments this bound.
**Revisit when:** A host needs guaranteed-bounded *deep* nesting (depth > 1) with a numeric cap. Recorded design candidate: seed `context.depth` inside the loop and have `createTaskTool` read it to enforce a cap. This needs the child loop to receive a starting depth, which requires crossing the intentionally-closed `Agent.run(prompt, { messages?, signal? })` boundary that v1 avoids — so it is a deliberate, separate design change, not a quick add.

# Core Package Roadmap — Remaining Scope

> **Status:** living reference. Captures what is still worth building **in `packages/core`** (the UI-free, headless engine), and what deliberately belongs elsewhere (SDK layer / separate packages).
>
> **Date:** 2026-06-29; **last updated 2026-06-30** after the `core-run-controls` feature landed (Tier-1 #2 + #3 done).
>
> This is a roadmap, not a commitment. Each Tier-1/2 item becomes its own `phased-dev` feature scope when picked up. Cross-cutting design decisions already locked live in `docs/project/decisions.md`; defer-to-SDK rationale is there too.

## Current state of `packages/core` (as of 2026-06-30)

The core is a working headless agent:

- **Loop:** stateless `agentLoop` async generator, `maxTurns` guard, abort-on-break, defensive tool-result serialization, per-turn → run-level token-usage accumulation.
- **Providers:** Anthropic + OpenAI behind the `Provider` abstraction, with SDK-delegated retry (`maxRetries`); both capture and normalize token usage.
- **Platform:** `cwd` / `readFile` / `writeFile` / `exec` (Node impl; `exec` supports `shell` + `signal` as of `agent-tooling`).
- **Built-in tools:** `read_file`, `write_file` (with line-range mode), `bash`, `edit_file`.
- **Permission seam:** optional `approvalHandler(toolName, input) → 'allow' | 'deny'` on `AgentOptions`, gated in `runTools` before `tool.call`. Default = blanket allow.
- **Cancellation:** the run's `AbortSignal` threads through `ToolCallContext.signal` into `Platform.exec`; **external `AbortSignal` accepted on `run(prompt, { signal })`** (composed via `AbortSignal.any`, pre-flight guard).
- **Token usage:** normalized `Usage` (`{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens? }`) on the terminal `AgentEvent`s + `Terminal` (cumulative) and on `turn_complete` (per-turn); `mergeUsage`/`accumulateUsage`/`EMPTY_USAGE` helpers exported.

Feature history: M1 core (`docs/project/`), `openai-provider`, `agent-tooling`, `core-run-controls` (`docs/feature/<name>/`).

---

## Tier 1 — real gaps, high leverage, unambiguously core

> **Progress:** #2 (token usage) and #3 (external AbortSignal) shipped in the `core-run-controls` feature (2026-06-30) — see `docs/feature/core-run-controls/`. Remaining Tier-1: #1 (fs-discovery) and #4 (sub-agent Task tool, prioritized).

### 1. Filesystem *discovery* tools (`ls` / `glob` / `grep`)

**The standout gap.** The agent can read/write/edit files whose paths it already knows, but it cannot *find* anything except by shelling out through `bash`. Discovery ("grep for X, glob for Y, read the hits") is most of what makes a coding agent useful.

- Dedicated structured tools are safer than `bash` and — importantly — don't trip the permission gate that consumers will most often use to *block* shell access.
- Requires **new `Platform` methods** (`listDir` / `glob` / `stat`). This is the breaking `Platform` change the M1 decisions log explicitly anticipated for M2 (adding methods forces all `Platform` implementors, incl. `MockPlatform`, to update — acceptable, caught at compile time).
- Recommended as the **next core feature**.

### 2. Token usage in the event stream + `Terminal` — ✅ DONE (core-run-controls, 2026-06-30)

Shipped: normalized `Usage` (`{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens? }`) on the terminal `AgentEvent`s + `Terminal` (cumulative) and on `turn_complete` (per-turn), captured from both providers (Anthropic `message_start`/`message_delta`; OpenAI `include_usage` + `translateChunk`), accumulated in the loop. `mergeUsage`/`accumulateUsage`/`EMPTY_USAGE` exported. **Unblocks** context compaction (SDK) and provides the **Task-tool usage roll-up seam** (`Terminal.usage`).

### 3. External `AbortSignal` on `run()` — ✅ DONE (core-run-controls, 2026-06-30)

Shipped: `RunOptions.signal?` composed with the internal controller via `AbortSignal.any`, with a pre-flight `signal.aborted` guard. Consumers can now cancel from outside (timeout / Ctrl-C / a parent cancelling a child). **Sub-agent enabler** (#4): a parent can cancel a child run.

### 4. Sub-agent / `Task` tool  ⭐ prioritized — NEXT (enablers now in place)

A built-in tool that runs a **nested `Agent`** with its own tool set and turn budget, returning a summarized result to the parent. Promoted from Tier 2 to Tier 1 as the next core feature to pursue — it is the capability that turns "an agent" into "an agent framework."

- The brainstorm flagged sub-agents as core.
- **Both enablers are now shipped (#2 token usage, #3 external AbortSignal)** — this is why `core-run-controls` was sequenced first. The Task tool can roll child usage up via `Terminal.usage` and propagate cancellation to children via the external signal.
- Largest Tier-1 lift. Design points to settle: the `Task` tool wraps a nested `Agent` instance; parent/child isolation (separate history, tool set, `maxTurns`); how child progress surfaces to the parent stream (summarized final result vs. forwarded events); and a **recursion-depth guard** so an agent can't spawn children unboundedly.

---

## Tier 2 — core, medium value

### 5. Concurrent execution of concurrency-safe tools

The `isConcurrencySafe?(input)` hook already exists on the `Tool` interface (`packages/core/src/types/tool.ts`, reserved in M1, currently unused). `runTools` executes tools strictly sequentially.

- Let read-only tools (`read_file`, `grep`, `ls`) in the same turn run in parallel; keep stateful tools (`bash`, `edit_file`, `write_file`) sequential.
- Real latency win; the seam is already present, so this is mostly loop logic + a batching strategy.

---

## Deliberately NOT core (SDK layer / separate packages)

- **Rich permission modes** — `'ask'`, allow-lists, rule patterns (e.g. `Bash(git commit:*)`), permission modes like `acceptEdits`. The current `allow`/`deny` callback is the *seam*; the policy engine is SDK territory (per `docs/project/decisions.md`).
- **Context compaction / auto-summarize** near the context window — a policy, lives in the SDK, but **depends on Tier-1 #2** (token counting must exist in core first).
- **System-prompt assembly, skills, sessions, memory** — assigned to `packages/sdk` by the M1 decisions.
- **MCP / external tool sources** — a separate package layered on top of core.
- **Prompt-cache breakpoint management** — possible core `Provider` concern, lower priority; revisit if cost becomes a driver.

---

## Recommended sequencing

> Reordered 2026-06-30 to prioritize the sub-agent `Task` tool (#4).

1. ~~**External `AbortSignal` on `run()` (#3)** + **token usage in events (#2)**~~ — ✅ **DONE** (`core-run-controls`, 2026-06-30). The enablers the Task tool builds on.
2. **Sub-agent `Task` tool (#4)** ⭐ — **NEXT.** The prioritized core feature; nests an `Agent` behind a tool with parent/child isolation and a recursion-depth guard.
3. **`fs-discovery-tools` (#1)** — high-impact `ls`/`glob`/`grep` + the anticipated `Platform` method additions; gives both the parent and its sub-agents real filesystem reach.
4. **Concurrent tool execution (#5)** — once more read-only tools exist to benefit from it.
5. Then shift to the **SDK layer** (`packages/sdk`): permission policy engine, context compaction (on top of #2), sessions/memory/skills.

## Explicitly deferred (already logged)

See `docs/project/known-issues.md` and `docs/feature/agent-tooling/engineering/2026-06-29-agent-tooling-engineering.md` §13: `edit_file` read-before-edit enforcement, `bash` output truncation, SIGKILL grace period, `bash` background tasks, sandbox integration, `edit_file` quote normalization / stale-read, permission rule patterns.

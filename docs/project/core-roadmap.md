# Core Package Roadmap — Remaining Scope

> **Status:** living reference. Captures what is still worth building **in `packages/core`** (the UI-free, headless engine), and what deliberately belongs elsewhere (SDK layer / separate packages).
>
> **Date:** 2026-06-29. **Author:** orchestrator analysis after the `agent-tooling` feature landed.
>
> This is a roadmap, not a commitment. Each Tier-1/2 item becomes its own `phased-dev` feature scope when picked up. Cross-cutting design decisions already locked live in `docs/project/decisions.md`; defer-to-SDK rationale is there too.

## Current state of `packages/core` (as of 2026-06-29)

The core is a working headless agent:

- **Loop:** stateless `agentLoop` async generator, `maxTurns` guard, abort-on-break, defensive tool-result serialization.
- **Providers:** Anthropic + OpenAI behind the `Provider` abstraction, with SDK-delegated retry (`maxRetries`).
- **Platform:** `cwd` / `readFile` / `writeFile` / `exec` (Node impl; `exec` supports `shell` + `signal` as of `agent-tooling`).
- **Built-in tools:** `read_file`, `write_file` (with line-range mode), `bash`, `edit_file`.
- **Permission seam:** optional `approvalHandler(toolName, input) → 'allow' | 'deny'` on `AgentOptions`, gated in `runTools` before `tool.call`. Default = blanket allow.
- **Cancellation:** the run's `AbortSignal` threads through `ToolCallContext.signal` into `Platform.exec`.

Feature history: M1 core (`docs/project/`), `openai-provider` feature, `agent-tooling` feature (`docs/feature/agent-tooling/`).

---

## Tier 1 — real gaps, high leverage, unambiguously core

### 1. Filesystem *discovery* tools (`ls` / `glob` / `grep`)

**The standout gap.** The agent can read/write/edit files whose paths it already knows, but it cannot *find* anything except by shelling out through `bash`. Discovery ("grep for X, glob for Y, read the hits") is most of what makes a coding agent useful.

- Dedicated structured tools are safer than `bash` and — importantly — don't trip the permission gate that consumers will most often use to *block* shell access.
- Requires **new `Platform` methods** (`listDir` / `glob` / `stat`). This is the breaking `Platform` change the M1 decisions log explicitly anticipated for M2 (adding methods forces all `Platform` implementors, incl. `MockPlatform`, to update — acceptable, caught at compile time).
- Recommended as the **next core feature**.

### 2. Token usage in the event stream + `Terminal`

`AgentEvent` and `Terminal` (`packages/core/src/types/events.ts`) currently carry **no usage data**, though both provider SDKs return it.

- Surface `usage` (input / output / cache-read / cache-write tokens) on a `message_stop`-style event and on the `Terminal` return value.
- Small, pure-core, and **foundational**: unlocks cost tracking, context-budget decisions, and eventually compaction (Tier-3).
- Cheap enough to fold into another feature; do it early.

### 3. External `AbortSignal` on `run()`

`Agent.run()` (`packages/core/src/agent.ts`) creates its `AbortController` internally; today the only way to cancel is to `break` the `for await` loop. A consumer cannot cancel from *outside* — no timeout, no Ctrl-C handler, no cancel button.

- Add `run(prompt, { signal })` (extend `RunOptions`) that links an external signal into the internal controller.
- Small, clean, pure-core; composes directly with the cancellation threading built in `agent-tooling`.

---

## Tier 2 — core, medium value

### 4. Concurrent execution of concurrency-safe tools

The `isConcurrencySafe?(input)` hook already exists on the `Tool` interface (`packages/core/src/types/tool.ts`, reserved in M1, currently unused). `runTools` executes tools strictly sequentially.

- Let read-only tools (`read_file`, `grep`, `ls`) in the same turn run in parallel; keep stateful tools (`bash`, `edit_file`, `write_file`) sequential.
- Real latency win; the seam is already present, so this is mostly loop logic + a batching strategy.

### 5. Sub-agent / `Task` tool

A built-in tool that runs a **nested `Agent`** with its own tool set and turn budget, returning a summarized result to the parent.

- The brainstorm flagged sub-agents as core. This is the largest Tier-2 lift but is the capability that turns "an agent" into "an agent framework."
- Interacts with Tier-1 #2 (usage roll-up) and #3 (signal propagation to children).

---

## Deliberately NOT core (SDK layer / separate packages)

- **Rich permission modes** — `'ask'`, allow-lists, rule patterns (e.g. `Bash(git commit:*)`), permission modes like `acceptEdits`. The current `allow`/`deny` callback is the *seam*; the policy engine is SDK territory (per `docs/project/decisions.md`).
- **Context compaction / auto-summarize** near the context window — a policy, lives in the SDK, but **depends on Tier-1 #2** (token counting must exist in core first).
- **System-prompt assembly, skills, sessions, memory** — assigned to `packages/sdk` by the M1 decisions.
- **MCP / external tool sources** — a separate package layered on top of core.
- **Prompt-cache breakpoint management** — possible core `Provider` concern, lower priority; revisit if cost becomes a driver.

---

## Recommended sequencing

1. **`fs-discovery-tools`** (Tier-1 #1) — the highest-impact core feature; carries the anticipated `Platform` method additions. Fold in **token usage (#2)** and **external signal (#3)** since both are small, pure-core, and unblock later work.
2. **Concurrent tool execution** (#4) — once more read-only tools exist to benefit from it.
3. **Sub-agent `Task` tool** (#5) — when the single-agent core is feature-complete.
4. Then shift to the **SDK layer** (`packages/sdk`): permission policy engine, context compaction (on top of #2), sessions/memory/skills.

## Explicitly deferred (already logged)

See `docs/project/known-issues.md` and `docs/feature/agent-tooling/engineering/2026-06-29-agent-tooling-engineering.md` §13: `edit_file` read-before-edit enforcement, `bash` output truncation, SIGKILL grace period, `bash` background tasks, sandbox integration, `edit_file` quote normalization / stale-read, permission rule patterns.

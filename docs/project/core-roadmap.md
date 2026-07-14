# Core Package Roadmap — Remaining Scope

> **Status:** living reference for `packages/core`, the UI-free headless engine.
>
> **Last updated:** 2026-07-14 after core runtime hardening.
>
> This is a roadmap, not a commitment. Completed feature scopes remain documented under `docs/feature/`; cross-cutting decisions live in `docs/project/decisions.md`.

## Current state of `packages/core`

The core now ships the original agent runtime and every previously identified Tier-1/Tier-2 runtime capability:

- **Loop and outcomes:** stateless `agentLoop` async generator, turn cap, cancellation, defensive serialization, reasoning events, cumulative usage, and required normalized stop reasons on completed turns and successful terminals.
- **Providers:** Anthropic and OpenAI behind one `Provider` abstraction, including SDK-delegated retry, usage normalization, reasoning deltas, and provider-native stop-reason normalization with an `other/raw` fallback.
- **Tools:** `read_file`, `write_file`, `bash`, `edit_file`, `ls`, `glob`, `grep`, and the sub-agent `task` factory.
- **Sub-agents:** host-owned child resolution and tool sets, sanitized child events, child usage roll-up, linked cancellation, and structural plus numeric recursion bounds.
- **Platform:** Node implementation plus a portable main graph. Path resolution/formatting and discovery order belong to the injected Platform; the main model-facing entry has no Node/process edge.
- **Approvals and run controls:** optional allow/deny approval callback, external `AbortSignal`, and explicit cancellation limitations.
- **Safe batching:** approved `read_file`, `ls`, `glob`, and `grep` calls execute in maximal contiguous concurrent batches while results, child attribution, usage, and serialization retain model order. Unsafe calls and failures remain barriers.

Feature history: M1 core, `openai-provider`, `agent-tooling`, `core-run-controls`, `task-tool`, `fs-discovery-tools`, `reasoning-events`, and `core-runtime-hardening` under `docs/feature/`.

## Shipped roadmap items

### Filesystem discovery — shipped

Structured `ls`, `glob`, and `grep` provide shell-independent code navigation with hidden-file and nested-`.gitignore` behavior, bounded output, deterministic test ordering, and a pure-JS Node implementation behind portable Platform methods.

### Token usage and external cancellation — shipped

Normalized `Usage` appears per provider turn and cumulatively on terminals. Child Task usage rolls into the parent total. `Agent.run` accepts an external signal; active calls receive it and no new calls start after abort is observed.

### Sub-agent Task tool — shipped

`createTaskTool` delegates a self-contained prompt to a host-constructed child Agent, surfaces sanitized child lifecycle events, reports child usage, links cancellation, and enforces recursion safeguards.

### Reasoning events — shipped

Provider reasoning deltas surface as observation-only `reasoning_delta` events and are deliberately excluded from threaded assistant history.

### Typed stop reasons — shipped

Every completed provider turn and successful final/child terminal exposes a normalized `StopReason`. Consumers can switch exhaustively on `kind` and retain unknown or missing native detail through `raw`.

### Portable model-facing graph — shipped

Path grammar, formatting, and discovery ordering are Platform contracts. `ls`, `glob`, and `grep` no longer import Node path/process behavior through the main entry, and the built bundle has an automated portability boundary check.

### Concurrent safe filesystem batches — shipped

Contiguous approved calls to `read_file`, `ls`, `glob`, and `grep` may overlap without changing model-visible order. Approvals are serial, barriers prevent look-ahead, all started siblings settle, and no framework concurrency cap is imposed.

## Remaining core work

### Concurrent Task calls — future, separate design

Task deliberately remains unmarked and sequential. Parallel child Agents need explicit decisions for real-time child-event delivery, per-child usage attribution, cancellation while children are active, and resource limits. The filesystem scheduler is not sufficient evidence to mark Task safe.

### Potential additive hardening

- Optional concurrency/backpressure policy if real workloads show resource amplification from very large safe batches.
- Automatic continuation policy for provider pause outcomes, if consumers need it.
- General per-tool timeout controls beyond the existing bash timeout.
- Native discovery acceleration behind `Platform.grep` if pure-JS traversal becomes limiting.

## Deliberately not core

- Rich permission modes, allow-list/rule engines, sandbox policy, and interaction UX.
- Context compaction, system-prompt assembly, skills, sessions, and memory.
- MCP or external tool-source integration.
- CLI, TUI, web, or other rendered interfaces.

These belong in SDK or integration packages layered over the core's typed provider, event, tool, Platform, approval, usage, and cancellation contracts.

## Explicitly deferred

See `docs/project/known-issues.md` for current limitations including Task concurrency/real-time events, cross-provider usage aggregation, pure-JS discovery performance, read-before-edit policy, and deferred grep features.

# Core Package Status

> Snapshot date: 2026-07-11
> Scope: `packages/core`
> Purpose: durable reference for what has shipped, what remains, and why the `core-runtime-hardening` feature is sequenced as proposed.
>
> This is a point-in-time status snapshot, not the workflow state source of truth. Active scope state lives under `docs/.phased-dev/`; the roadmap lives in `docs/project/core-roadmap.md`.

## Summary

All Tier-1 core roadmap capabilities have shipped:

- Anthropic and OpenAI providers behind the shared provider abstraction
- Stateless async-generator agent loop
- Built-in file/edit/bash tools and approval-handler seam
- External cancellation and normalized token usage
- Sub-agent `Task` tool with structural and numeric recursion bounds
- Filesystem discovery (`ls`, `glob`, `grep`) with nested `.gitignore`, context lines, cancellation, and bounded output
- Streaming reasoning events

The only remaining planned core feature is **concurrent execution of concurrency-safe tools**. Two correctness/architecture fixes should land before concurrency: preserving provider stop reasons through terminal events and restoring the strict platform portability boundary.

## Shipped Core Capabilities

### Runtime and event stream

- `Agent.run()` exposes work as a typed async-generator event stream.
- The loop is stateless between runs; callers own conversation history.
- `maxTurns` bounds execution.
- External `AbortSignal` composes with the internal controller.
- Breaking iteration triggers internal abort behavior.
- Terminal and turn events carry normalized token usage.
- Reasoning deltas surface from compatible Anthropic and OpenAI streams.

### Providers

- Anthropic provider with SDK-owned retries.
- OpenAI-compatible provider behind the same `Provider` abstraction.
- Provider mappers normalize messages, tool calls, usage, and stop events.

### Tools and platform

Built-in tools include:

- `read_file`
- `write_file`
- `edit_file`
- `bash`
- `ls`
- `glob`
- `grep`
- host-configured `task` sub-agent tool

The `Platform` abstraction provides filesystem, process, and discovery operations. `NodePlatform` is the Node implementation.

### Filesystem discovery

The discovery feature shipped in PR #6, with review fixes in PR #7:

- Pure-JavaScript shared walk using `ignore` and `picomatch`
- Symmetric hidden-file and `.gitignore` behavior
- Hierarchical nested `.gitignore` composition
- VCS-directory pruning
- Symlink-to-file support without directory traversal
- Glob result limits and deterministic test ordering
- Grep file/content/count modes
- `-A`/`-B`/`-C` context lines with merged windows
- Binary-file skip, per-line caps, total-result guard, and cancellation

Final verification after review fixes: 403 tests, workspace typecheck, and lint passing.

## Remaining Planned Core Feature

### Concurrent execution of concurrency-safe tools — P1

The `Tool.isConcurrencySafe(input)` hook exists, but `runTools` still executes calls sequentially.

Initial concurrency-safe tools:

- `read_file`
- `ls`
- `glob`
- `grep`

Initial sequential barriers:

- `write_file`
- `edit_file`
- `bash`
- `task`
- unmarked tools

Required semantics:

1. Partition calls into maximal contiguous safe batches.
2. Start calls in a safe batch concurrently.
3. Preserve result order according to the model's original call order.
4. Await a safe batch before starting an unsafe barrier.
5. Preserve deterministic validation, approval, cancellation, and per-call error behavior.
6. Prevent cross-call tool ID, event, or usage attribution.

Concurrent `task` calls are deliberately excluded. They require per-call child-event sinks, context isolation, cancellation semantics, and usage attribution, and should be designed as a separate feature.

## Prerequisite Hardening

### Preserve provider stop reasons — P1

Providers normalize stop reasons, but the loop currently consumes usage and can lose the reason a tool-free response stopped. As a result, token exhaustion, filtering, or refusal-like outcomes may look like ordinary successful completion.

Required direction:

- Carry the normalized provider stop reason through turn completion.
- Expose it on `agent_done`, `Terminal`, and applicable turn metadata.
- Preserve partial text, messages, and usage.
- Keep valid provider outcomes distinct from runtime exceptions; do not convert them into `agent_error`.

### Restore strict portability boundary — P2

The architectural promise is that platform implementations own environment-specific behavior, but discovery tool modules currently contain Node path/process dependencies.

Required direction:

- Remove Node built-in imports and process reads from model-facing built-in tools.
- Move path resolution, cwd-relative formatting, and environment-dependent ordering behind a minimal portable `Platform` seam or platform-neutral helpers.
- Keep existing path and ordering behavior stable.
- Enforce the boundary in lint.

## Explicitly Deferred Core Limitations

These are known limitations, not committed roadmap features for the current scope.

### Sub-agent behavior

- Child events are buffered rather than forwarded in real time.
- Breaking parent iteration may not immediately cancel an in-flight child; an external signal does.
- Child usage is rolled into terminal usage but is not represented fully in per-turn usage.
- Multiple `task` calls remain sequential.

### Runtime controls

- No general per-tool timeout.
- No provider stream-idle watchdog.
- Cross-provider aggregate token usage combines provider-specific token semantics.

### Tool limitations

- `write_file` offset beyond EOF appends without gap filling.
- Pure-JavaScript discovery may be slower than ripgrep on very large repositories.
- Grep lacks multiline regex and ripgrep-style type filters.
- Bash output truncation, process-group termination, SIGKILL escalation, background tasks, and sandbox integration remain deferred.

## Deliberately Not Core

The following belong in the SDK layer or separate packages:

- Rich permission modes, allowlists, and rule parsing
- Context compaction and auto-summarization policy
- System-prompt assembly
- Sessions and persistence
- Memory and skills
- MCP and external tool-source integration
- UI, TUI, or web rendering
- Stateful read-before-edit policy

The core remains UI-free and headless.

## Documentation and Release Maintenance

The implementation has moved ahead of some documentation and release metadata.

Remaining maintenance:

1. Refresh `packages/core/README.md` for providers, approvals, cancellation, usage, Task, reasoning, and discovery tools.
2. Refresh `docs/project/core-roadmap.md` to mark Tier-1 complete and concurrency as the remaining planned feature.
3. Refresh `docs/project/STATUS.md` where shipped provider/permission work is still presented as future work.
4. Correct stale source comments that describe shipped usage/OpenAI work as future M2 work.
5. Update `CHANGELOG.md` and package version metadata for the next release.
6. Decide whether the currently unused public `Platform.stat` capability remains intentional; remove it only in a breaking release.
7. Prepare release notes, but do not tag, publish, or create a release without explicit authorization.

## Recommended Sequence

The approved `core-runtime-hardening` scope follows this order:

1. **Stop-reason terminal semantics** — establish correct terminal behavior before modifying loop scheduling.
2. **Strict portability boundary** — settle tool/platform contracts before concurrency relies on them.
3. **Concurrent safe filesystem batches** — parallelize `read_file`, `ls`, `glob`, and `grep`; keep stateful tools and `task` as barriers.
4. **Documentation and release readiness** — align the roadmap, README, status, changelog, comments, and package metadata with the final implementation.
5. **Future separate feature:** concurrent `task` calls, if desired, after per-call child context/event/usage isolation is designed.

## Completion Criteria for Core Runtime Hardening

- Consumers can identify why an agent terminal event stopped.
- Built-in model-facing tools contain no Node-specific imports or process reads.
- Safe filesystem calls overlap in execution while results remain ordered.
- Unsafe calls preserve barriers.
- `task` remains sequential and explicitly documented as future work.
- Full tests, workspace typecheck, lint, and example typecheck pass.
- Core documentation and release metadata accurately describe the shipped surface.

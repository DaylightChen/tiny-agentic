# Core Runtime Hardening — Feature Design

> Approved framing for the `feature/core-runtime-hardening` phased-dev scope.
>
> Date: 2026-07-11
> Pipeline: standard feature (`research → engineering → plan → implement`)
> Upstream status snapshot: `docs/project/core-package-status.md`

## 1. Purpose

Complete the remaining planned `packages/core` runtime work in dependency order, then bring the core documentation and release metadata into alignment with the shipped implementation.

The feature has four ordered stages:

1. Preserve provider stop reasons as typed terminal outcomes.
2. Restore the strict platform portability boundary.
3. Execute concurrency-safe filesystem tools concurrently while preserving observable ordering.
4. Refresh documentation and prepare release metadata.

Concurrent sub-agent `task` calls remain a separate future feature.

## 2. Goals

### 2.1 Stop-reason terminal semantics

Provider stop reasons must survive the agent loop instead of being discarded after usage accounting.

- Normalize and propagate the provider's stop reason for each completed turn.
- Expose the terminal stop reason on `agent_done`, `Terminal`, and applicable turn metadata.
- Preserve partial text, messages, and usage for non-natural stops such as token exhaustion, content filtering, or refusal.
- Do not convert valid provider outcomes into `agent_error`; `agent_error` remains reserved for exceptions and runtime failures.
- Consumers must be able to distinguish natural completion from truncation or refusal without inspecting provider-specific events.

### 2.2 Strict portability boundary

Only platform implementations may depend on Node built-ins or process-global state.

- Built-in model-facing tools must not import Node path/filesystem/process APIs.
- Path resolution, cwd-relative formatting, and environment-dependent discovery ordering move behind portable `Platform` capabilities or platform-neutral code.
- `NodePlatform` provides the Node implementation.
- Custom or browser-oriented platforms can implement the same contract without Node dependencies.
- The lint boundary must enforce the architectural rule rather than merely document it.

The engineering phase decides the smallest coherent contract change. It must avoid introducing a broad platform utility API unrelated to existing tool needs.

### 2.3 Concurrent safe filesystem tools

`runTools` must execute independent read-only filesystem operations concurrently without changing observable semantics.

Initially concurrency-safe:

- `read_file`
- `ls`
- `glob`
- `grep`

Initially sequential barriers:

- `write_file`
- `edit_file`
- `bash`
- `task`
- unknown, invalid, denied, or unmarked tools unless the engineering spec proves a safe treatment

Execution rules:

- Partition calls into contiguous concurrency-safe batches.
- Await each batch before crossing an unsafe-call barrier.
- Preserve `tool_result` order according to the model's original tool-call order, not completion order.
- Preserve deterministic validation, approval, error, and cancellation behavior per call.
- A safe call failure does not prevent sibling results from being collected; each call receives its own error result according to current `runTools` behavior.
- No shared mutable per-call attribution may leak between concurrently executing calls.

### 2.4 Documentation and release readiness

After runtime behavior is final:

- Refresh `docs/project/core-roadmap.md` to mark all Tier-1 work complete and concurrency shipped.
- Refresh `packages/core/README.md` for providers, approvals, usage, cancellation, Task, and discovery tools.
- Refresh `docs/project/STATUS.md` and stale source comments.
- Update `CHANGELOG.md` and package release metadata as appropriate for the next release.
- Record concurrent `task` calls as a separate future feature with its prerequisites.
- Do not tag, publish, or create a release in this scope.

## 3. Explicitly Out of Scope

- Concurrent `task` or sub-agent calls
- Per-call child-event sinks, real-time child-event forwarding, or child usage attribution redesign
- Permission policy modes, allowlist/rule parsing, or SDK policy engines
- Context compaction, sessions, memory, skills, MCP, or UI
- Bash process-group handling, background tasks, sandboxing, or general tool timeouts
- Multiline grep, ripgrep-style type filters, or native-ripgrep optimization
- Publishing, tagging, or creating a GitHub release

## 4. Architecture and Data Flow

### 4.1 Turn completion

The provider emits a normalized stop event. The loop captures both `usage` and `stopReason`, records them on turn completion, and carries the final reason into terminal events. Tool-use turns continue normally; tool-free turns terminate with an explicit reason.

No provider-specific reason string should escape the provider abstraction unless it is part of the existing normalized union. If the current union is insufficient for modern provider outcomes, the engineering spec must define a backward-compatible normalization strategy.

### 4.2 Portable tool/path operations

Tools request path operations through `Platform`. `NodePlatform` performs Node-specific resolution and formatting. Portable tools receive normalized values and remain free of Node imports and process access.

The implementation must maintain the existing public behavior:

- Relative tool paths resolve from `platform.cwd()`.
- Paths under cwd are returned relative to cwd; outside paths remain absolute.
- Discovery ordering remains deterministic under tests and follows the approved production ordering.

### 4.3 Safe batching

`runTools` classifies each parsed call using `tool.isConcurrencySafe?.(input) === true`. It builds maximal contiguous safe batches. Each batch starts all calls before awaiting completion. Results are stored by original index and emitted in original order. Unsafe calls execute one at a time between batches.

Approval and validation occur at the same semantic point as today. The engineering phase must decide whether classification occurs before or after approval/validation, then prove that denials and malformed calls cannot reorder observable results or start disallowed work.

## 5. Error and Cancellation Semantics

- Runtime exceptions remain `agent_error` or per-tool error results according to existing boundaries.
- Abnormal provider stops remain terminal outcomes with explicit `stopReason` and preserved partial output.
- An already-aborted signal prevents new safe batches from starting.
- Aborting a running safe batch signals every active tool through its existing `ToolCallContext.signal`.
- All started calls settle before ordered results are emitted; cancellation must not produce unhandled rejections.
- Unsafe barriers never start until the preceding safe batch settles.

## 6. Testing Contract

### Stop reasons

- Natural end-turn remains distinguishable.
- `max_tokens`/length stop reaches terminal events without becoming success-with-no-reason.
- Filter/refusal-like normalized stops preserve partial text and usage.
- Tool-use continuation does not terminate prematurely.
- Anthropic and OpenAI mappings produce equivalent normalized loop outcomes.

### Portability

- Built-in tool modules compile without Node built-in imports or direct process access.
- A minimal custom `Platform` test double can run the relevant tools without Node-specific helpers.
- Relative resolution, outside-cwd paths, root paths, and deterministic ordering retain existing behavior.
- Lint prevents future Node imports outside approved platform implementation paths.

### Concurrency

- Two safe calls overlap in time.
- Reverse completion order still emits results in request order.
- Safe → unsafe → safe sequences respect barriers.
- Read-only tools are marked safe; stateful and `task` tools remain sequential.
- Mixed unknown tool, invalid input, denial, thrown error, and successful calls remain deterministic.
- Cancellation reaches every call in a running safe batch.
- No cross-call tool ID or event attribution occurs.

### Completion

- Full core tests pass.
- Workspace typecheck passes.
- Root lint passes.
- Examples typecheck.
- Documentation accurately matches the final API.

## 7. Success Criteria

The scope is complete when:

1. Consumers can identify why an agent terminal event stopped.
2. Model-facing built-in tools have no Node-specific imports or process reads.
3. Safe filesystem calls demonstrably overlap while ordered results and unsafe barriers remain stable.
4. `task` remains sequential and is documented as a separate future feature.
5. Core roadmap, README, status, changelog, and release metadata describe the shipped surface.
6. All verification commands are green and every phased-dev task has its execution log and completion marker.

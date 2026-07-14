# Changelog

All notable changes to `tiny-agentic` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — Unreleased

### Added

- Sub-agent delegation through `createTaskTool`, including host-owned child configuration, sanitized child lifecycle events, linked cancellation, recursion safeguards, and child-usage roll-up.
- Structured filesystem discovery tools: `ls`, `glob`, and `grep`, with hidden-file and nested-`.gitignore` controls, bounded output, and Platform-owned ordering.
- Observation-only `reasoning_delta` events for provider reasoning streams.
- Public `StopReasonKind` and `StopReason` types with normalized categories and exact native `raw` fallback data.
- Root `typecheck:examples` verification for all shipped examples.

### Changed

- Approved contiguous calls to `read_file`, `ls`, `glob`, and `grep` execute in maximal concurrency-safe batches with no framework cap. Approvals stay serial; unsafe, invalid, denied, and failed calls are ordering barriers; Task remains sequential.
- Tool execution now isolates per-call context, child events, and reported usage while preserving model-call result and serialization order.
- `Platform` owns model-path resolution, output formatting, and final discovery ordering. The main package graph no longer imports Node built-ins or reads process globals; Node behavior remains in the explicit platform subpath.
- Documentation and examples now cover the complete event, terminal, approval, Platform, usage, cancellation, Task, and safe-batching contracts.

### Fixed

- Provider stop outcomes are no longer discarded. Every completed provider turn, final successful agent event/terminal, and successful sanitized child terminal carries the normalized stop reason.
- Unknown or missing provider-native stop values are preserved as `kind: "other"` with their exact string or `null`, instead of being mislabeled as natural completion.
- Node discovery ordering now has deterministic ascending code-unit tie-breaks for equal modification times, and model-facing tools preserve Platform order.
- Cancellation starts no new tool work after abort is observed, emits ordered results for unstarted calls, and delivers the signal to active calls while allowing signal-free read/list syscalls to finish.

### Breaking changes

- Custom `Provider` implementations must emit `ProviderEvent` `message_stop` with required `stopReason: StopReason`. A stream ending without `message_stop` is now a provider contract error.
- `AgentEvent.turn_complete`, `AgentEvent.agent_done`, the `Terminal` `agent_done` arm, and successful child terminal events now require `stopReason`. Max-turn and error variants intentionally do not expose it.
- Custom `Platform` implementations must add `resolvePath(path)` and `formatPath(path)`, and must return `listDir`, `glob`, and `grep` data in final display order (`grep` matches grouped by file order, then line ascending).

## [0.1.0] — 2026-07-06

Initial public release: a headless, UI-free agentic engine for TypeScript/Node.
It exposes the mechanics of an agent — stream the model, run the tools it calls,
feed results back, loop until it stops — as a typed `AsyncGenerator`, importing
zero UI code.

### Added

- **Agent loop.** Stateless `Agent` that yields a typed `AgentEvent` stream
  (`AsyncGenerator`). Callers own the transcript and drive turns; the engine
  holds no session state.
- **Provider abstraction.** A single provider interface with two
  implementations behind subpath exports:
  - `tiny-agentic/providers/anthropic` — `AnthropicProvider`
  - `tiny-agentic/providers/openai` — `OpenAIProvider`

  Both are normalized to the same event stream, including streaming, tool
  calls, and token-usage reporting.
- **Tools.** `defineTool` for authoring Zod-schema'd tools, a `ToolRegistry`,
  and built-in tools: read file (with offset/limit line ranges), write file,
  `bash`, and `edit_file`.
- **Approval gate.** Optional `approvalHandler` seam so a caller can intercept
  and approve/deny tool calls before they execute.
- **Run controls.** Typed token-usage accumulation across a run and
  `AbortSignal`-based cancellation.
- **Platform injection.** `tiny-agentic/platform/node` (`NodePlatform`) supplies
  filesystem and environment access; the core takes it as a dependency rather
  than importing Node directly.
- **Convenience utilities.** `tiny-agentic/utils` (e.g. `collect`) for draining
  the event stream in simple cases.
- Packaging: ESM-only, `dist`-only tarball, Node `>=22`, MIT-licensed, published
  to npm with build provenance.

### Notes

- `zod` is a **required** peer dependency. `@anthropic-ai/sdk` and `openai` are
  **optional** peer dependencies — install only the SDK(s) for the provider(s)
  you use.
- **Out of scope for this milestone:** sub-agents, skills, slash-commands,
  session persistence, and any UI. The agent loop is sequential (tools run one
  at a time) with a seam left for future concurrency.

[0.1.0]: https://github.com/DaylightChen/tiny-agentic/releases/tag/v0.1.0

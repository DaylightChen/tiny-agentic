# Changelog

All notable changes to `tiny-agentic` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

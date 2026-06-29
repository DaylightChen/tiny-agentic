# tiny-agentic-ui

> Placeholder — not yet implemented.

A future interactive front-end (TUI / CLI REPL / web) built on top of [`tiny-agentic-sdk`](../sdk) and [`tiny-agentic`](../core). Planned for a later milestone.

The UI is a **pure consumer of the typed event stream** — it iterates the `AgentEvent`s produced by the core/SDK and renders them. It is never imported by the layers below it (the one-way dependency rule is `ui → sdk → core`). Keeping the engine headless is a hard architectural boundary: all rendering/terminal concerns live here, never in the core.

It currently contains only a stub. See the root [README](../../README.md) and [`docs/`](../../docs) for the overall architecture.

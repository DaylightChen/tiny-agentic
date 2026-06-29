# tiny-agentic-sdk

> Placeholder — not yet implemented.

A future batteries-included layer built on top of [`tiny-agentic`](../core) (the headless core). Planned for a later milestone; it will add the stateful, product-level concerns the core deliberately omits:

- Customizable built-in tools
- **Skills** (loaded from markdown files with frontmatter) and a skill registry
- **Slash-command** dispatch and a command registry
- Session persistence (local JSONL transcripts) and resume
- Richer system-prompt assembly and memory
- A stateful `Session` wrapper over the core's stateless `Agent.run()`

In the monorepo's one-way dependency rule (`ui → sdk → core`), this package depends on `tiny-agentic` and is consumed by the UI layer. It currently contains only a stub.

See the root [README](../../README.md) and [`docs/`](../../docs) for the overall architecture.

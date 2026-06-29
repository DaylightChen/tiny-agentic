# tiny-agentic

> A UI-free, headless agentic framework for TypeScript/Node — built step by step, learning from the Claude Code reference.

`tiny-agentic` gives you the **agent loop and nothing else**: call a model (streaming), let it use tools, feed results back, loop until done — surfaced as a typed async-generator event stream. No TUI, no CLI, no React/Ink. You bring the UI (or none at all).

```ts
import { Agent, readFileTool } from "tiny-agentic";
import { AnthropicProvider } from "tiny-agentic/providers/anthropic";
import { NodePlatform } from "tiny-agentic/platform/node";

const agent = new Agent({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, model: "claude-opus-4-8" }),
  tools: [readFileTool],
  platform: new NodePlatform(),
});

for await (const event of agent.run("Read ./README.md and summarize it.")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
}
```

The published package lives in [`packages/core`](packages/core) — see its [README](packages/core/README.md) for the full API.

## Repository layout

This is a **pnpm monorepo** with a strict one-way dependency rule (`ui → sdk → core`; lower layers never import higher ones):

| Package | Name | Status |
|---------|------|--------|
| [`packages/core`](packages/core) | `tiny-agentic` | **Milestone 1 — implemented.** The headless engine: agent loop, tool registry, provider abstraction, platform interface, env context, typed event stream. |
| [`packages/sdk`](packages/sdk) | `tiny-agentic-sdk` | Placeholder. A future batteries-included layer (skills, slash-commands, session persistence) on top of core. |
| [`packages/ui`](packages/ui) | `tiny-agentic-ui` | Placeholder. A future interactive front-end (TUI/CLI/web) — a pure consumer of the event stream. |
| [`examples`](examples) | — | Throwaway driver scripts (not published). See [`examples/README.md`](examples/README.md). |

## Requirements

- **Node >= 22** (Node 18 and 20 are EOL as of mid-2026). The supported LTS floor.
- **pnpm** (workspaces). Enable via `corepack enable`.

## Commands

Run from the repo root:

```bash
pnpm install            # install all workspaces
pnpm -r build           # build packages (tsup)
pnpm -r test            # run the test suite (vitest)
pnpm -r typecheck       # tsc --noEmit across all packages
pnpm lint               # eslint --max-warnings 0 (enforces the headless/boundary rules)
ANTHROPIC_API_KEY=… pnpm example   # run the integration example (real API; not CI)
```

## Design principles

- **Headless / UI-free.** The core imports zero UI code and surfaces work as a typed `AsyncGenerator` of events. Any front-end is a separate package on top.
- **Stateless core.** `Agent.run()` holds no memory between calls; multi-turn is achieved by threading the message list. Persistence is an SDK-layer concern.
- **Provider abstraction.** A canonical request/event shape with per-provider adapters (Anthropic in M1; OpenAI planned). The reference is Anthropic-shaped throughout; this framework abstracts it.
- **Platform injection.** All environment access (`fs`, `process`, `child_process`) is behind a `Platform` interface — only `NodePlatform` touches Node globals — so the core is environment-agnostic.

## Documentation

The full design lives under [`docs/`](docs): product design (`brainstorm/`), architecture (`engineering/`), the implementation plan (`plan/`), per-task logs (`tasks/`), and the decision log (`decisions.md`). Project status is mirrored in [`docs/STATUS.md`](docs/STATUS.md).

## License

MIT

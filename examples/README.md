# examples

Throwaway driver scripts that exercise [`tiny-agentic`](../packages/core) end to end. Not published; not run in CI.

## `basic-run.ts`

A real-API integration driver that demonstrates the full M1 surface: simple Q&A, multi-turn history threading, tool use via `read_file`, and the `collectText` convenience — using only the public entry points.

### Run it

Requires a real Anthropic API key (it makes paid network calls) and Node >= 22.

```bash
# from the repo root
pnpm install
pnpm --filter tiny-agentic build      # the example imports the built dist via the exports map
ANTHROPIC_API_KEY=sk-ant-… pnpm example
```

`pnpm example` runs `tsx examples/basic-run.ts`. Without `ANTHROPIC_API_KEY` set, the script prints an error and exits with code 1 (a quick way to confirm the workspace wiring resolves without spending tokens).

### What it shows

- **Turn 1** — simple Q&A, no tools (`text_delta` → `agent_done`).
- **Turn 2** — multi-turn continuation by threading the prior turn's `messages`.
- **Turn 3** — the model calls `read_file` (`tool_use_start` → `tool_result`).
- **collectText** — the non-streaming convenience helper.

This package is a workspace member depending on `tiny-agentic: workspace:*`, so the bare `import { Agent } from "tiny-agentic"` specifiers resolve through the pnpm symlink. The model id is set to `claude-opus-4-8`; swap it for a cheaper valid id (e.g. `claude-haiku-4-5`) if you prefer.

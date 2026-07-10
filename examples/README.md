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

## `openai-run.ts`

The OpenAI counterpart to `basic-run.ts` — the same four scenarios (Q&A, multi-turn, `read_file` tool use, `collectText`), built on `OpenAIProvider` from `tiny-agentic/providers/openai`. It demonstrates that the `Provider` seam holds for a different backend with no other code changes.

### Run it

Requires a real OpenAI API key and Node >= 22.

```bash
# from the repo root
pnpm install
pnpm --filter tiny-agentic build      # the example imports the built ./providers/openai entry
OPENAI_API_KEY=sk-… pnpm tsx examples/openai-run.ts
```

Without `OPENAI_API_KEY` set, the script prints an error and exits 1 (a token-free way to confirm the wiring resolves). The model id is `gpt-4o-mini`; any valid Chat Completions model works, including reasoning models (o-series / GPT-5), since `maxTokens` maps to `max_completion_tokens`.

## `task-run.ts`

A sub-agent (`task` tool) smoke: a parent agent delegates a self-contained sub-task to a **child agent running on a different model id** (`claude-opus-4-8` parent → `claude-haiku-4-5` child), streaming the child's sanitized `subagent_event`s tagged by `taskId` and printing the rolled-up parent `usage` (which includes the child's tokens). The child's tool set omits the `task` tool — the structural recursion bound.

### Run it

Requires a real Anthropic API key and Node >= 22. Optionally exercises a cross-provider (OpenAI) child when `OPENAI_API_KEY` is also set; otherwise a `provider: "openai"` hint demonstrates the clean config-error path.

```bash
# from the repo root
pnpm install
pnpm --filter tiny-agentic build      # the example imports the built package + provider entries
ANTHROPIC_API_KEY=sk-ant-… pnpm tsx examples/task-run.ts
```

Without `ANTHROPIC_API_KEY` set, the script prints an error and exits 1. Not run in CI.

## `fs-discovery-run.ts`

A filesystem-discovery smoke: an `Agent` built with only the three discovery tools (`ls`, `glob`, `grep`) — **no `bashTool`** — and an `approvalHandler` that would deny `bash` outright, performs a discovery loop over `packages/core/src`. It demonstrates the feature headline: structured discovery stays fully usable when the shell is denied.

A direct `grepTool.call` over `packages/core/src` is timed first (`console.time`/`console.timeEnd`) to surface the sub-second target from the engineering spec's §10 — this part needs no API key, so even a keyless run prints the grep timing before hitting the key guard.

### Run it

Requires a real Anthropic API key (the agent loop makes paid network calls) and Node >= 22.

```bash
# from the repo root
pnpm install
pnpm --filter tiny-agentic build      # the example imports the built dist via the exports map
ANTHROPIC_API_KEY=sk-ant-… pnpm example:fs-discovery
```

`pnpm example:fs-discovery` runs `tsx examples/fs-discovery-run.ts`. Without `ANTHROPIC_API_KEY` set, the script still runs the keyless direct-grep timing, then prints an error at the agent-loop guard and exits 1. Not run in CI.

### What it shows

- **Direct grep timing** — a `grepTool.call` over `packages/core/src` completes sub-second (keyless).
- **Discovery loop** — the model uses `ls`/`glob`/`grep` (never `bash`) to locate and group files, with `bash` explicitly denied by the `approvalHandler`.

## `subagent-registry.ts`

A `subagent_type` → tool-set registry. The reference (Claude Code) lets the model pick a **named agent type** but never a tool array — the type's tools are fixed by agent-definition frontmatter (`tools:` / `disallowedTools:`) and resolved by `resolveAgentTools`. This example builds the same shape **imperatively in host code**:

- `AGENT_REGISTRY` maps each label (`researcher`, `editor`, `writer`) to a fixed profile (tool set + system prompt + optional model).
- `formatAgentCatalog()` injects the menu — each type and the tools it has — into the parent's system prompt, mirroring Claude Code's generated "Available agent types and the tools they have access to:" section. Without it the model can't know which types exist, since the `task` schema only offers an opaque `subagent_type` string.
- `resolveChild()` looks up the chosen label and builds the child with that profile's tools; unknown labels throw a clean config-error result.

The run delegates two sub-tasks that resolve to **different profiles** (read `package.json` → `researcher` with `[read_file]`; draft a blurb → `writer` with no tools), so the per-child tool lines in the stream differ — the registry routing, made visible. The takeaway: the LLM passes only a label; the host owns the tools.

### Run it

Requires a real Anthropic API key and Node >= 22.

```bash
# from the repo root
pnpm install
pnpm --filter tiny-agentic build      # the example imports the built dist via the exports map
ANTHROPIC_API_KEY=sk-ant-… pnpm tsx examples/subagent-registry.ts
```

Without `ANTHROPIC_API_KEY` set, the script prints an error and exits 1. Not run in CI.

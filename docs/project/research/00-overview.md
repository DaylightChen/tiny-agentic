# Claude Code Architecture — Subsystem Map

Research notes from the decompiled `claude-code-source-code` submodule (v2.1.88), produced to
inform the design of our own agentic framework (`tiny-agentic`).

Each subsystem has its own detailed file in this folder. This overview is the index plus a
"minimal essence" summary to help scope milestones.

## How the pieces fit together

```
                ┌─────────────────────────────────────────────┐
   user input → │  UI / TUI layer (React Ink)  — file 06        │  ← swappable, headless-able
                └───────────────────────┬─────────────────────┘
                                        │ consumes async-generator events
                ┌───────────────────────▼─────────────────────┐
                │  Core agent loop  (query / QueryEngine)       │  ← the heart — file 01
                │  stream → collect tool_use → run tools → loop │
                └───┬─────────────┬──────────────┬─────────────┘
                    │             │              │
        ┌───────────▼──┐   ┌──────▼───────┐  ┌───▼──────────────┐
        │ LLM provider │   │ Tools +      │  │ Context / memory │
        │ + API  (03)  │   │ permissions  │  │ + skills   (04)  │
        │              │   │ (02)         │  │                  │
        └──────────────┘   └──────────────┘  └──────────────────┘
                    extensibility: commands / hooks / plugins / MCP / config (05)
```

The core loop is a **headless async generator** — it imports zero UI code and yields typed
events. Everything else hangs off it. This is the single most important architectural fact for us:
**build the engine headless, attach a thin I/O layer.**

## Subsystem index

| # | Subsystem | What it is | File |
|---|-----------|------------|------|
| 01 | Core agent loop | Recursive turn controller: stream model → run tools → retry/recover → done | [01-core-agent-loop.md](01-core-agent-loop.md) |
| 02 | Tools & permissions | Tool interface, registry, execution pipeline, approval system | [02-tools-and-permissions.md](02-tools-and-permissions.md) |
| 03 | LLM provider / API | Provider selection, request/response mapping, streaming, retries, cost | [03-llm-provider-api.md](03-llm-provider-api.md) |
| 04 | Context / memory / skills | History, context assembly, memory dir, skills, system prompt | [04-context-memory-skills.md](04-context-memory-skills.md) |
| 05 | Commands / hooks / plugins / config | Slash commands, hooks, plugins, MCP, settings layering | [05-commands-hooks-plugins-config.md](05-commands-hooks-plugins-config.md) |
| 06 | UI / TUI layer | React Ink REPL, live streaming render, input handling | [06-ui-tui-layer.md](06-ui-tui-layer.md) |

## Minimal essence per subsystem (for milestone scoping)

What is the *truly essential* core of each subsystem vs. product polish:

| Subsystem | Essential core (build first) | Product polish (defer) |
|-----------|------------------------------|------------------------|
| **Core loop** | Recursive: stream → collect `tool_use` → execute → feed results back → stop when no tool calls | Reactive compaction, microcompact, max-token escalation, stop-hooks, token/USD budgets, streaming tool exec |
| **Tools** | Tool interface (`name`, `inputSchema`, `description`, `call`); registry; validate→run→format result | MCP, ToolSearch/deferred loading, hooks, ML classifiers, rich diff rendering |
| **Provider** | Provider enum + factory; request mapper; stream-event adapter to a canonical event union | Bedrock/Vertex/Foundry, fallback non-streaming, betas/headers, sticky latches |
| **Context** | Message list across turns; system-prompt builder; static env context (cwd, git, date) | Memory dir + taxonomy, skills, compaction, persisted JSONL history, recall ranking |
| **Extensibility** | (none strictly required) — maybe a tiny command registry | Hooks (28 events), plugins, MCP, settings layering, migrations, keybindings |
| **UI** | `readline` stdin/stdout loop printing streamed text + tool calls | Full Ink TUI, markdown, diffs, spinners, vim, dialogs, approval UI |

## Permission modes (from subsystem 02, useful reference)

`default`, `bypassPermissions`, `dontAsk`, `acceptEdits`, `auto` (classifier), `plan`, `bubble`.

## Built-in tools (from subsystem 02, grouped)

- **File ops**: FileRead, FileWrite, FileEdit, NotebookEdit, Glob, Grep
- **Shell**: Bash, PowerShell
- **Web**: WebFetch, WebSearch, WebBrowser
- **Agents/tasks**: Agent, TaskOutput, Task{Create,Get,Update,List}, Skill, ExitPlanMode
- **Collab**: AskUserQuestion, TodoWrite, SendMessage
- **Infra**: ListMcpResources, ReadMcpResource, ToolSearch, Config, Worktree, Workflow, Cron, Monitor, LSP

## Implication for our first milestone

The natural "smallest complete agent" is **subsystems 01 + 02 + 03 + a sliver of 04 + a sliver of 06**:
a headless recursive loop, a couple of real tools, one provider, a system prompt with env context,
and a plain readline I/O. Everything in the "polish" column is deliberately deferred.

See each file for the detailed control flow and file/line citations into the reference source.

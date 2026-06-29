# 01 — Core Agent Loop

Files: `src/QueryEngine.ts`, `src/query.ts`, `src/query/`, `src/Task.ts`, `src/tasks/`,
`src/assistant/`, `src/coordinator/`, `src/bootstrap/`, `src/entrypoints/`, `src/context.ts`

## The core loop

The agent loop is a **recursive state machine** implemented as an async generator in
`query.ts` (~lines 219–1357), driven by `QueryEngine` (`QueryEngine.ts`).

```
submitMessage(prompt)
  → query({ messages, systemPrompt, tools, ... })          [async generator]
    → callModel(...) with streaming                          (query.ts:659)
      → accumulate assistant content blocks (text, tool_use, thinking)
      → execute tool_use blocks (parallel/serial by concurrency safety)
        → tool may spawn a sub-agent (Agent tool → recursive query())
        → collect tool_result blocks
    → decide continuation:
        ├─ no tool_use            → DONE ("completed")
        ├─ prompt too long        → reactive compact → retry
        ├─ max output tokens      → escalate to 64k → retry (≤3)
        ├─ stop hook blocks       → inject user msg → retry
        └─ turn/budget exhausted  → return early
    → loop if needed
  → yield final result
```

**Key insight:** it is *not* a simple "call API → parse tools → return." It's a stateful
**recovery machine** with several retry paths (compaction, token escalation, stop-hook
blocking) woven into the state transitions. For us, those are all polish — strip them.

## Key modules

| Module | Purpose | Cite |
|--------|---------|------|
| `QueryEngine` | Owns session state, message accumulation, `submitMessage()` surface | QueryEngine.ts:184 |
| `query()` | Recursive turn controller: stream → tools → retry | query.ts:219 |
| `runTools()` | Partitions tool batch by concurrency safety, runs parallel/serial | toolOrchestration.ts:19 |
| `StreamingToolExecutor` | Executes tools *during* streaming (polish) | StreamingToolExecutor.ts:40 |
| `runAgent()` | Spawns sub-agents as background Tasks, wraps `query()` | AgentTool/runAgent.ts |
| `LocalAgentTask` | Background task state machine for a spawned agent | tasks/LocalAgentTask/ |
| `context.ts` | Memoized system/user context (git status, CLAUDE.md, date) | context.ts:116 |

## Streaming, turns, "done"

- Model streams continuously; assistant blocks accumulate into `assistantMessages`.
- **Turn ends (done)** when the last assistant message has **no `tool_use` blocks**.
- Early-return reasons (all polish): `prompt_too_long`, `max_output_tokens_recovery_limit`,
  `max_turns_reached`, `error_max_budget_usd`. (query.ts:1062–1357)
- Stop hooks can *block* completion by injecting a synthetic user message and looping.

## Sub-agents (the Agent tool)

1. Model emits `tool_use` named `Agent`.
2. `runAgent()` resolves the agent definition / `subagent_type` (AgentTool/runAgent.ts).
3. Creates a `LocalAgentTask` and calls `query()` **recursively** with an agent-scoped
   context (`querySource: 'agent:<id>'`, own tools, own MCP, own transcript).
4. Background tasks run concurrently in a task registry; the manager polls for completion.
5. Isolation: distinct `agentId`, separate tool set and MCP servers, own transcript file.

The recursion is the elegant part: a sub-agent is just another `query()` with a narrower
tool/context scope. We can replicate this cheaply once the base loop exists.

## Dependencies

Tools (registry + permission `canUseTool`), Provider/API (`callModel` streaming),
Context (system/user prompt injection), AppState (permissions, modes), Transcript
(persistence/resume), MCP (agent-scoped servers).

## Minimal essence (build first)

1. **Recursive query loop** — stream API → collect `tool_use` → run tools → feed results →
   stop when no tool calls. ~200 lines once stripped of recovery paths.
2. **Tool execution orchestration** — run the tool_use blocks, collect results. ~100 lines.
3. **Message accumulation + system/user context** — build the message list and a system
   prompt with env context. ~100 lines.
4. **(Optional, slightly later) sub-agent fork** — recursive `query()` with a scoped context.

Defer: reactive/micro compaction, context collapse, stop hooks, token/USD budgets,
structured-output retries, streaming-time tool execution.

## Citations

- `QueryEngine.submitMessage()` — QueryEngine.ts:209–1156
- `query()` loop — query.ts:219–1357
- Tool execution — toolOrchestration.ts:19–150; StreamingToolExecutor.ts:40–200
- Sub-agent spawn — AgentTool/runAgent.ts:1–300; tasks/LocalAgentTask/
- Context builders — context.ts:116–189
- Error recovery — query.ts:1062–1183

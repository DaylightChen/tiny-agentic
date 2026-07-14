# Execution Log — feature/core-runtime-hardening — Task 01: Stop-reason provider contract and mappings

## Iteration 1

### Implement
- **Files created:** none.
- **Files modified:** `packages/core/src/types/provider.ts`, `packages/core/src/providers/anthropic-mapper.ts`, `packages/core/src/providers/openai-mapper.ts`, `packages/core/src/index.ts`.
- **Decisions not in plan:** none.
- **Deviations from plan:** none in production scope. `AgentEvent`, `Terminal`, Task sanitation, and loop propagation remain unchanged for task 02.
- **Issues encountered:** none. Production diff formatting passed; no tests were written or run by the implementer.

### Test
- **Tests modified:** `anthropic-mapper.test.ts`, `openai-mapper.test.ts`, `anthropic.test.ts`, `openai.test.ts`, `types.test.ts`.
- **Coverage added:** SR-1–SR-4, provider half of SR-12/SR-13; all nine normalized kinds, unknown/missing raw preservation, OpenAI refusal precedence and empty-fragment negative cases.
- **Runtime failures:** none. Full suite: 24 files, 426 tests passed.
- **Lint:** passed with zero warnings/errors.
- **Typecheck failure:** stale fake Provider fixtures outside the brief's original five tester-owned files still constructed `ProviderEvent.message_stop.stopReason` as strings. Affected: `agent-tooling-integration.test.ts`, `agent.test.ts`, `loop.test.ts`, `subagent-boundary.test.ts`, `task-tool.test.ts`.
- **Root cause:** the plan correctly split provider events from agent terminals, but its task-01 file inventory omitted higher-level fake providers that directly implement the changed provider contract.

### Review
- Not dispatched because typecheck was red.

---

## Iteration 2

### Fix
- **Approved deviation:** expanded task 01 test-fixture ownership to migrate all direct `ProviderEvent.message_stop` producers to structured reasons. No stop-reason fields were added to `AgentEvent`, `Terminal`, Task sanitation, or loop outputs; those remain task 02.
- **Files modified:** `agent-tooling-integration.test.ts`, `agent.test.ts`, `loop.test.ts`, `subagent-boundary.test.ts`, `task-tool.test.ts`.
- **Changes:** 53 `end_turn` and 32 `tool_use` fake-provider input literals migrated; no behavioral terminal assertion changed.

### Test
- **Focused:** 5 files, 122 tests passed.
- **Full suite:** 24 files, 426 tests passed.
- **Typecheck:** passed with zero errors.
- **Lint:** passed with zero warnings/errors.
- **Node:** local Node 20.18.1 emitted the expected package `>=22` engine warning; final Node 22 gate remains task 08.

### Review
- **Verdict:** Approved.
- **Criteria:** exact nine-arm types/export; required structured provider reason; Anthropic known/unknown/missing mapping; OpenAI finish/refusal precedence; no refusal-text leakage; fresh accumulator isolation; all direct ProviderEvent producers migrated; no Task 02 behavior; type assertions valid; no compatibility shim.
- **Code/test quality:** clean and adequate.
- **Regressions/issues:** none.

## Completion
- **Iterations:** 2.
- **Final verification:**
  - focused Task 01 tests: 5 files, 122 tests passed;
  - full core suite: 24 files, 426 tests passed;
  - `pnpm --filter tiny-agentic typecheck`: clean;
  - root `pnpm lint`: clean;
  - `git diff --check`: clean;
  - task-02 production surfaces (`types/events.ts`, `loop/loop.ts`, `tools/builtin/task.ts`) unchanged.
- **Acceptance criteria:** all Task 01 criteria verified. Provider stop reasons are structured at the boundary; downstream terminal propagation remains for Task 02.
- **Regressions:** none.
- **Deviation:** user-approved fake-provider fixture migration required for compile safety.

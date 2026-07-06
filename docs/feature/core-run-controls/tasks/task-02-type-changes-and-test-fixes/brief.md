# Task 02 — type-changes-and-test-fixes

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Update `packages/core/src/types/events.ts` and `packages/core/src/types/provider.ts` with the usage fields required by the feature, and in the same commit fix the 5 typed literal compile errors this change introduces in the test files.

Specifically:
- `types/events.ts`: terminal `AgentEvent` variants (`agent_done`, `max_turns_exceeded`, `agent_error`) gain `usage: Usage` (non-optional); `turn_complete` gains `usage?: Usage`. `Terminal` variants gain `usage: Usage` (non-optional).
- `types/provider.ts`: `message_stop` ProviderEvent variant gains `usage?: Usage`.
- `__tests__/collect.test.ts`: `Terminal` literals at L18, L66, L82 each gain `usage: EMPTY_USAGE`.
- `__tests__/types.test.ts`: `AgentEvent` literal at L65 gains `usage: EMPTY_USAGE`; `Terminal` literal at L77 gains `usage: EMPTY_USAGE`.

These two concerns must be in the same task. Making `usage` non-optional on terminal events is a TS2741 compile error for any typed literal that omits it — vitest will not even parse the test files. The sequential model requires each committed task to produce a green build; splitting the type change from the literal fixes would leave the branch uncompilable.

After this task, the type surface is settled. Tasks 03, 04, 05, 06 all build against these stable types.

## Context files

Read these before starting:

- `packages/core/src/types/usage.ts` — must exist from task-01; this task imports `Usage` and `EMPTY_USAGE` from it.
- `packages/core/src/types/events.ts` — current content; the exact lines to modify.
- `packages/core/src/types/provider.ts` — current content; the `message_stop` variant line to extend.
- `packages/core/src/__tests__/collect.test.ts` — find the three `Terminal` literals at L18, L66, L82 that need `usage: EMPTY_USAGE`.
- `packages/core/src/__tests__/types.test.ts` — find the `AgentEvent` literal at L65 and `Terminal` literal at L77 that need `usage: EMPTY_USAGE`.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §7 "Data model changes" — the before/after type diff. Follow it exactly.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §11 "Risks" first bullet — the compile-breaking literal sites.
- `docs/feature/core-run-controls/decisions.md` §2026-06-30 "Missing usage → EMPTY_USAGE; terminal usage always non-optional" — why non-optional on terminal events.
- `docs/feature/core-run-controls/decisions.md` §2026-06-30 "Per-turn usage on turn_complete (optional field)" — why `turn_complete.usage` is `?`.

## Downstream dependencies

- **Task 03** (`agent.ts`) constructs `{ type: "agent_error", error, messages: [], usage: EMPTY_USAGE }` in the pre-flight guard — requires the updated `AgentEvent` type that accepts `usage`.
- **Task 04** (`loop/loop.ts`) adds `usage: cumulativeUsage` to all three terminal event/return pairs and to `turn_complete` — requires both updated types.
- **Task 05** (`anthropic-mapper.ts`) emits `message_stop` with optional `usage` — requires the updated `ProviderEvent.message_stop` type.
- **Task 06** (`openai-mapper.ts`) emits `message_stop` with optional `usage` — requires the updated `ProviderEvent.message_stop` type.
- **Key invariants downstream tasks depend on:**
  - `usage: Usage` on `agent_done`, `max_turns_exceeded`, `agent_error` AgentEvent variants is NON-OPTIONAL.
  - `usage: Usage` on all three `Terminal` variants is NON-OPTIONAL.
  - `usage?: Usage` on `turn_complete` AgentEvent is OPTIONAL (conditional spread required, never assign `undefined`).
  - `usage?: Usage` on `message_stop` ProviderEvent is OPTIONAL (backward-compatible with mock providers that emit bare `{ type: "message_stop", stopReason }`).

## Steps

1. **Update `packages/core/src/types/events.ts`.**

   a. Add the import at the top of the file (after the existing `Message` import):
   ```typescript
   import type { Usage } from "./usage.js";
   ```

   b. Update the `AgentEvent` union. Change:
   ```typescript
   | { type: "turn_complete";      turnIndex: number }
   // Terminal events ...
   | { type: "agent_done";         messages: Message[] }
   | { type: "max_turns_exceeded"; turnsUsed: number; messages: Message[] }
   | { type: "agent_error";        error: Error; messages: Message[] };
   ```
   To:
   ```typescript
   | { type: "turn_complete";      turnIndex: number; usage?: Usage }
   // Terminal events ...
   | { type: "agent_done";         messages: Message[]; usage: Usage }
   | { type: "max_turns_exceeded"; turnsUsed: number; messages: Message[]; usage: Usage }
   | { type: "agent_error";        error: Error; messages: Message[]; usage: Usage };
   ```

   c. Update the `Terminal` type. Change:
   ```typescript
   export type Terminal =
     | { reason: "agent_done";         messages: Message[] }
     | { reason: "max_turns_exceeded"; messages: Message[]; turnsUsed: number }
     | { reason: "agent_error";        messages: Message[]; error: Error };
   ```
   To:
   ```typescript
   export type Terminal =
     | { reason: "agent_done";         messages: Message[]; usage: Usage }
     | { reason: "max_turns_exceeded"; messages: Message[]; turnsUsed: number; usage: Usage }
     | { reason: "agent_error";        messages: Message[]; error: Error; usage: Usage };
   ```

2. **Update `packages/core/src/types/provider.ts`.**

   a. Add the import at the top (after the existing `Message` import):
   ```typescript
   import type { Usage } from "./usage.js";
   ```

   b. Update `ProviderEvent` — the `message_stop` variant. Change:
   ```typescript
   | { type: "message_stop"; stopReason: "end_turn" | "tool_use" | "max_tokens" | string };
   ```
   To:
   ```typescript
   | { type: "message_stop"; stopReason: "end_turn" | "tool_use" | "max_tokens" | string; usage?: Usage };
   ```

3. **Fix `packages/core/src/__tests__/collect.test.ts`.**

   This file constructs typed `Terminal` literals. Import `EMPTY_USAGE` at the top of the file (add after the existing type imports):
   ```typescript
   import { EMPTY_USAGE } from "../types/usage.js";
   ```

   Then add `usage: EMPTY_USAGE` to each of the three `Terminal` literals:

   - **L18** — `const terminal: Terminal = { reason: "agent_done", messages: [] };`
     → `const terminal: Terminal = { reason: "agent_done", messages: [], usage: EMPTY_USAGE };`

   - **L66** — `const term: Terminal = { reason: "agent_done", messages: [] };`
     → `const term: Terminal = { reason: "agent_done", messages: [], usage: EMPTY_USAGE };`

   - **L82** — `const term: Terminal = { reason: "max_turns_exceeded", messages: [...], turnsUsed: 3 };`
     → add `usage: EMPTY_USAGE` to this literal.

   Note: use the actual current line numbers when you read the file; the numbers here are approximate. Search for the three `Terminal` typed literals (they all follow the pattern `const ...: Terminal = { reason: ...`).

4. **Fix `packages/core/src/__tests__/types.test.ts`.**

   This file constructs a typed `AgentEvent` literal and a typed `Terminal` literal. Import `EMPTY_USAGE` at the top of the file (add after the existing type imports):
   ```typescript
   import { EMPTY_USAGE } from "../types/usage.js";
   ```

   Then:

   - **L65 (approximately)** — `const agentDone: AgentEvent = { type: "agent_done", messages: [message] };`
     → add `usage: EMPTY_USAGE` to this literal.

   - **L77 (approximately)** — `const terminal: Terminal = { reason: "agent_done", messages: [message] };`
     → add `usage: EMPTY_USAGE` to this literal.

   Note: use the actual current line numbers when you read the file. Search for `const agentDone: AgentEvent` and `const terminal: Terminal`.

5. **Run typechecking and tests** to confirm the build is green:
   ```
   pnpm -r typecheck
   pnpm -r test
   ```
   Both must exit 0. The test count will still be approximately 196 (no new tests are added in this task). The key signal is zero TypeScript compile errors.

## Acceptance criteria

- [ ] `pnpm -r typecheck` exits 0 after all four files are modified. Zero TS2741 errors.
- [ ] `pnpm -r test` exits 0. All pre-existing tests continue to pass (no runtime failures from the additional `usage` field on terminal events, since `MockProvider` emits bare `message_stop` without usage and the loop has not been updated yet — tests that assert only on `terminal.reason` or `terminal.messages` are unaffected).
- [ ] `types/events.ts`: `AgentEvent` `agent_done`/`max_turns_exceeded`/`agent_error` variants have `usage: Usage` (non-optional).
- [ ] `types/events.ts`: `AgentEvent` `turn_complete` variant has `usage?: Usage` (optional).
- [ ] `types/events.ts`: all three `Terminal` variants have `usage: Usage` (non-optional).
- [ ] `types/provider.ts`: `message_stop` ProviderEvent has `usage?: Usage` (optional).
- [ ] `__tests__/collect.test.ts` compiles without TS2741 errors (all three `Terminal` literals have `usage`).
- [ ] `__tests__/types.test.ts` compiles without TS2741 errors (both typed literals have `usage`).
- [ ] No other test files were modified (the blast radius is exactly the 5 typed literals identified above).

## Output files

- Modified: `packages/core/src/types/events.ts`
- Modified: `packages/core/src/types/provider.ts`
- Modified: `packages/core/src/__tests__/collect.test.ts`
- Modified: `packages/core/src/__tests__/types.test.ts`

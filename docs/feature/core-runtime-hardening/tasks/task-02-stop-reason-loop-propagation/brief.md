# Task 02 — Stop-reason loop, terminal, and Task propagation

> Written in the plan phase. Immutable during implement-phase execution.

## Goal

Complete the stop-reason source break atomically across the engine. Add required `stopReason` fields to completed turns, successful agent terminals, returned successful `Terminal`, and sanitized child successful terminals; make `agentLoop` capture exactly one valid provider stop per turn; reject a stream that ends without `message_stop`; and preserve all partial text/messages/usage for valid non-natural outcomes.

Every production consumer and every test literal affected by the required fields lands in this same commit. At task completion, a natural or abnormal valid stop is observable and consistent on `turn_complete`, yielded `agent_done`, returned `Terminal`, and Task sanitation; buffered tools remain the continuation authority; `pause_turn` does not auto-resubmit; runtime/provider exceptions still have no invented stop reason.

## Context files

- `docs/feature/core-runtime-hardening/engineering/2026-07-13-core-runtime-hardening-engineering.md` — §§3.1–3.4, 5.1.2, 5.1.4, §6, SR-5–SR-13.
- `docs/feature/core-runtime-hardening/decisions.md` — required propagation and continuation authority.
- `packages/core/src/types/provider.ts` — `StopReason` from task 01.
- `packages/core/src/types/events.ts` — change the exact relevant arms; split child terminal arms rather than putting an optional field on a broad arm.
- `packages/core/src/loop/loop.ts` — per-turn capture, missing-stop error, turn/tool/final behavior.
- `packages/core/src/tools/builtin/task.ts` — `sanitizeChildEvent`; `mapChildTerminalToResult` microcopy must not change.
- `packages/core/src/utils/collect.ts` — inspect for inferred fallout only; no algorithm change expected.
- Tests with terminal/provider scripts: `loop.test.ts`, `task-tool.test.ts`, `subagent-boundary.test.ts`, `collect.test.ts`, `types.test.ts`, `agent.test.ts`, `agent-tooling-integration.test.ts`, plus any task-01 provider integration fixture still constructing downstream events.

## Downstream dependencies

- Tasks 05–07 rely on `turn_complete.stopReason` and final `agent_done.stopReason` surviving scheduler refactors unchanged.
- `SubagentChildEvent` must become three distinct terminal variants: only `reason:"agent_done"` has required `stopReason`; max-turn and error variants do not.
- `agent_error` and `max_turns_exceeded` never gain a reason. Do not synthesize one from partial data.
- The exact missing-stop error is `Provider stream ended without message_stop`.
- Every valid reason kind, including `max_tokens`, `content_filter`, `refusal`, `pause_turn`, context-window, and `other`, is metadata—not an error trigger.

## Steps

Role separation: implementer changes production only; tester owns tests and commands.

1. **Change public event/terminal types atomically** — import `StopReason` into `types/events.ts`; require it on `turn_complete`, yielded `agent_done`, returned `Terminal`'s `agent_done` arm, and sanitized child terminal `agent_done`. Keep other terminal arms reason-free. Preserve optional usage with exact-optional semantics.
2. **Capture one stop per turn** — in `loop.ts`, declare `let turnStopReason: StopReason | undefined` next to `turnUsage`; assign both fields from each `message_stop`. After provider iteration, before accumulating/constructing terminal events, throw `Error("Provider stream ended without message_stop")` when undefined. This throw must be handled by the existing provider-error boundary and become `agent_error` with accumulated prior-turn messages/usage; reorganize the try boundary if necessary so this exact error follows that path.
3. **Propagate after valid stop** — preserve assistant text/tool block accumulation. Increment turn count as today. If buffered tool uses exist, run them regardless of reason kind, yield `turn_complete` with that turn's reason, and continue. If no tools exist, yield `turn_complete`, then `agent_done`, then return `Terminal`, all carrying the same object. A tool-use reason without buffered tools terminates; an end-turn reason with buffered tools executes them and continues.
4. **Preserve empty/partial behavior** — keep skipping invalid empty assistant messages. Valid empty, truncated, filtered, refused, paused, context-window, and unknown completions remain `agent_done`; preserve text events, assistant message when non-empty, usage, and transcript.
5. **Sanitize child success reason** — in `task.ts`, copy `event.stopReason` only for child `agent_done`; keep max-turn/error child shapes and `mapChildTerminalToResult` strings unchanged.
6. **Migrate all direct consumers/literals** — update production type flow and any exhaustive switches necessary to compile. Do not update examples here; task 08 wires user-facing display after the whole API stabilizes.
7. **Tester: add/update tests**:
   - **SR-5:** exact object identity/deep equality across final `turn_complete`, `agent_done`, returned `Terminal`.
   - **SR-6:** table cases for `max_tokens`, `model_context_window_exceeded`, `content_filter`, `refusal`, and `other`, with partial text and usage; no `agent_error`.
   - **SR-7:** two-turn tool script; first completed turn reason is `tool_use`, final terminal reason comes from turn two.
   - **SR-8:** buffered tool + `end_turn` executes; no tool + `tool_use` terminates visibly.
   - **SR-9:** tool-free pause makes exactly one provider request and succeeds with pause reason.
   - **SR-10:** stream ends after partial text without `message_stop`; exact error, prior text event retained, prior completed-turn usage retained, no invented stop.
   - **SR-11:** Task and boundary tests prove only sanitized successful child terminal has structured reason and still no messages/result payload.
   - **SR-12 (terminal half):** compile-required fields on `turn_complete`, `agent_done`, successful `Terminal`, successful child terminal; error/max-turn arms reject extra stop reason if asserted.
   - **SR-13 completion:** provider-shaped scripts flow through loop into structured terminal reason.

## Acceptance criteria

- [ ] Exact event/terminal shapes match engineering §5.1.2; required means required.
- [ ] Every completed provider turn has a reason, including tool-use turns.
- [ ] SR-5–SR-11 and terminal half of SR-12 pass; SR-13 is end-to-end complete.
- [ ] A missing `message_stop` produces `agent_error.error.message === "Provider stream ended without message_stop"` and retains already-yielded partial text/prior usage.
- [ ] No valid stop kind alone becomes `agent_error`; `pause_turn` is not resubmitted.
- [ ] Empty tool-free completion yields no empty assistant message but still emits reason-bearing completion/terminal events.
- [ ] `mapChildTerminalToResult` output strings are unchanged.
- [ ] `pnpm --filter tiny-agentic test -- src/__tests__/loop.test.ts src/__tests__/task-tool.test.ts src/__tests__/subagent-boundary.test.ts src/__tests__/collect.test.ts src/__tests__/types.test.ts src/__tests__/agent.test.ts src/__tests__/agent-tooling-integration.test.ts` passes.
- [ ] `pnpm --filter tiny-agentic typecheck`, root `pnpm lint`, and `pnpm --filter tiny-agentic test` pass.

## Output files

**Implementer-owned production files:**
- Modified: `packages/core/src/types/events.ts`
- Modified: `packages/core/src/loop/loop.ts`
- Modified: `packages/core/src/tools/builtin/task.ts`
- Modified only if inferred types require it: `packages/core/src/utils/collect.ts`

**Tester-owned test files:**
- Modified: `packages/core/src/__tests__/loop.test.ts`
- Modified: `packages/core/src/__tests__/task-tool.test.ts`
- Modified: `packages/core/src/__tests__/subagent-boundary.test.ts`
- Modified: `packages/core/src/__tests__/collect.test.ts`
- Modified: `packages/core/src/__tests__/types.test.ts`
- Modified: `packages/core/src/__tests__/agent.test.ts`
- Modified: `packages/core/src/__tests__/agent-tooling-integration.test.ts`
- Modified as required for downstream integration literals: `packages/core/src/__tests__/anthropic.test.ts`, `openai.test.ts`

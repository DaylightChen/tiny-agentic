# Task 01 — Stop-reason provider contract and mappings

> Written in the plan phase. Immutable during implement-phase execution. A fresh agent can execute this task from this brief and its references.

## Goal

Introduce the normalized stop-reason foundation at the provider boundary without yet changing `AgentEvent` or `Terminal`. Add and export the exact closed `StopReasonKind`/discriminated `StopReason` types; make `ProviderEvent.message_stop.stopReason` a required object; normalize Anthropic and OpenAI native data once in their mapper modules; and migrate all mapper/provider fixtures that construct or assert `message_stop`.

This is a compile-safe first slice of a broad source break: the current loop ignores `message_stop.stopReason`, so provider producers and their direct tests can move to the structured object now while task 02 later changes every loop/terminal consumer atomically. At completion, both adapters preserve exact raw values, missing reasons are `other/null`, OpenAI refusal inference follows the locked precedence, and type tests prove the closed kind surface.

## Context files

- `docs/feature/core-runtime-hardening/engineering/2026-07-13-core-runtime-hardening-engineering.md` — §§5.1.1–5.1.3, §6, test IDs SR-1–SR-4, SR-12, SR-13.
- `docs/feature/core-runtime-hardening/decisions.md` — closed kind/raw decision and exact mapping decision.
- `packages/core/src/types/provider.ts` — add public types and change only the provider event in this task; also fix its stale `jsonSchema7`/usage comments.
- `packages/core/src/providers/anthropic-mapper.ts` — `InputAccumulator` currently defaults missing reasons to `end_turn`; replace with normalize-at-emission behavior.
- `packages/core/src/providers/openai-mapper.ts` — `ToolCallAccumulator` currently defaults missing finishes and does not capture refusal.
- `packages/core/src/index.ts` — export `StopReasonKind` and `StopReason`.
- `packages/core/src/__tests__/anthropic-mapper.test.ts`, `openai-mapper.test.ts`, `anthropic.test.ts`, `openai.test.ts`, `types.test.ts` — direct provider literals/deep-equality/type fixtures that must migrate in this atomic task.
- `packages/core/src/loop/loop.ts` — inspect only to confirm it still compiles while ignoring the now-object reason; do not add terminal propagation yet.

## Downstream dependencies

- Task 02 imports `StopReason` into `types/events.ts` and `loop.ts` and requires all terminal surfaces to carry the exact same object received here.
- Unknown strings must remain `{ kind: "other", raw: exactString }`; absence must remain `{ kind: "other", raw: null }`. Do not invent `end_turn`.
- `raw` is required on every arm. Do not add provider names, optional fields, a legacy parallel string, or an exported open string union.
- OpenAI refusal inference depends on a boolean recording **non-empty** `delta.refusal`; explicit `tool_calls`, `function_call`, `length`, `content_filter`, and unknown future values remain authoritative.

## Steps

Role separation: the **implementer** performs steps 1–5 in production files only and does not write/run tests. The **tester** performs step 6 and all command verification.

1. **Add exact public types** — in `packages/core/src/types/provider.ts`, add `StopReasonKind` and the nine-arm `StopReason` exactly as engineering §5.1.1. Change `ProviderEvent`'s `message_stop` arm to required `stopReason: StopReason`. Correct `ToolSchema`'s comment to `jsonSchema7` and `LogEntry`'s stale “future M2 usage” comment.
2. **Export types** — add `StopReasonKind` and `StopReason` to the provider type export in `packages/core/src/index.ts`.
3. **Normalize Anthropic once** — in `anthropic-mapper.ts`, keep `InputAccumulator.stopReason` as `string | undefined`; make `takeStopReason()` return `StopReason` via a pure module-private normalizer. Map `end_turn`, `tool_use`, `max_tokens`, `stop_sequence`, `pause_turn`, `refusal`, and `model_context_window_exceeded` one-to-one; map other strings to `other/raw`; map absence to `other/null`. `message_stop` always emits this object. Do not reset/default earlier.
4. **Capture OpenAI refusal** — in `ToolCallAccumulator.applyDelta`, record whether any `delta.refusal` string has non-whitespace/non-empty content. Do not emit refusal text as `text_delta` or include it in history.
5. **Normalize OpenAI at flush** — replace `mapFinishReason` with a pure object-returning normalizer. Map `stop→end_turn`, `tool_calls→tool_use`, `length→max_tokens`, `content_filter→content_filter`, `function_call→tool_use`, unknown string→`other/raw`, missing→`other/null`. If refusal was observed, override only `stop` or missing to `refusal` while retaining raw `"stop"` or `null`; never override tool/function/length/filter/unknown.
6. **Tester: migrate and extend tests** — update every provider test literal to include a structured reason and add:
   - **SR-1:** table-driven Anthropic cases for `end_turn`, `tool_use`, `max_tokens`, `stop_sequence`, `pause_turn`, `refusal`, `model_context_window_exceeded`, `future_reason`.
   - **SR-2:** bare Anthropic `message_stop` is exactly `{ kind:"other", raw:null }`.
   - **SR-3:** table-driven OpenAI `stop`, `tool_calls`, `length`, `content_filter`, `function_call`, unknown, missing.
   - **SR-4:** non-empty streamed refusal with stop and missing; explicit length/filter remain authoritative; add at least one empty-refusal-fragment negative case.
   - **SR-12 (provider half):** construct every `StopReason` arm and exhaustively switch on `kind`; prove `ProviderEvent.message_stop` requires a reason and each arm requires `raw` using satisfied `@ts-expect-error` assertions.
   - **SR-13 (provider half):** update `anthropic.test.ts`/`openai.test.ts` integration fixtures/deep equality and assert emitted structured unknown/refusal reasons where the existing provider harness allows.

## Acceptance criteria

- [ ] `StopReasonKind` and `StopReason` exactly match engineering §5.1.1 and are exported from `tiny-agentic`'s main entry.
- [ ] `ProviderEvent.message_stop.stopReason` is required; no mapper emits a string reason.
- [ ] SR-1–SR-4 pass with exact `{ kind, raw }` equality and OpenAI precedence as specified.
- [ ] SR-12's provider/type portion proves all nine kinds, exhaustive narrowing, required provider reason, and required `raw`.
- [ ] Provider integration fixtures for SR-13 emit structured reasons.
- [ ] `AgentEvent`, `Terminal`, `SubagentChildEvent`, `loop.ts`, and `task.ts` do not gain stop-reason fields in this task; that atomic downstream break is task 02.
- [ ] `pnpm --filter tiny-agentic test -- src/__tests__/anthropic-mapper.test.ts src/__tests__/openai-mapper.test.ts src/__tests__/anthropic.test.ts src/__tests__/openai.test.ts src/__tests__/types.test.ts` passes.
- [ ] `pnpm --filter tiny-agentic typecheck` passes with zero errors.
- [ ] Root `pnpm lint` passes with zero warnings/errors.
- [ ] `pnpm --filter tiny-agentic test` passes, with all previous 403 baseline tests plus new cases green.

## Output files

**Implementer-owned production files:**
- Modified: `packages/core/src/types/provider.ts`
- Modified: `packages/core/src/providers/anthropic-mapper.ts`
- Modified: `packages/core/src/providers/openai-mapper.ts`
- Modified: `packages/core/src/index.ts`

**Tester-owned test files:**
- Modified: `packages/core/src/__tests__/anthropic-mapper.test.ts`
- Modified: `packages/core/src/__tests__/openai-mapper.test.ts`
- Modified: `packages/core/src/__tests__/anthropic.test.ts`
- Modified: `packages/core/src/__tests__/openai.test.ts`
- Modified: `packages/core/src/__tests__/types.test.ts`

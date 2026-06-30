# Task 01 — usage-foundation

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Create the `Usage` type, `EMPTY_USAGE` constant, `mergeUsage` helper, and `accumulateUsage` helper in a new file `packages/core/src/types/usage.ts`. Re-export all four from `packages/core/src/index.ts`. Write a self-contained `packages/core/src/__tests__/usage.test.ts` that covers all arithmetic edge cases for both helpers.

This is the pure-foundation task. `types/events.ts`, `types/provider.ts`, `loop/loop.ts`, `anthropic-mapper.ts`, and `openai-mapper.ts` all import from `./usage.js` or `../types/usage.js` — nothing compiles until this file exists. The helpers are verified correct here in isolation; every downstream task inherits that guarantee.

## Context files

- `packages/core/src/types/usage.ts` — does NOT exist yet; create it.
- `packages/core/src/index.ts` — current export surface; add four exports at the bottom.
- `packages/core/src/types/messages.ts` — example of a standalone `types/` module with zero project-internal imports; follow its pattern.
- `packages/core/src/__tests__/collect.test.ts` — example of a vitest test file in the project (import style, describe/it/expect pattern).
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §6 "New modules / files introduced" — the authoritative code sketch for the four exports. Reproduce it faithfully.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §7 "Data model changes" — confirms the `Usage` field names.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §13 "Test strategy notes" → `types/usage.ts` subsection — the required test cases.
- `docs/feature/core-run-controls/decisions.md` §2026-06-30 "Usage helpers live in types/usage.ts" — rationale for zero project-internal imports.
- `docs/feature/core-run-controls/decisions.md` §2026-06-30 "`cacheWriteTokens` optional/absent on OpenAI" — `cacheWriteTokens?: number`; absence is correct, `0` would be wrong.

## Downstream dependencies

- **Task 02** imports `Usage` (type) from `./usage.js` into `types/events.ts` and `types/provider.ts`.
- **Task 03** imports `EMPTY_USAGE` from `./types/usage.js` into `agent.ts`.
- **Task 04** imports `Usage`, `EMPTY_USAGE`, `accumulateUsage` from `../types/usage.js` into `loop/loop.ts`.
- **Task 05** imports `Usage`, `mergeUsage`, `EMPTY_USAGE` from `../types/usage.js` into `anthropic-mapper.ts`.
- **Task 06** imports `Usage` from `../types/usage.js` into `openai-mapper.ts`.
- **All downstream tasks** depend on the exported shapes being stable:
  - `Usage` must have exactly: `inputTokens: number`, `outputTokens: number`, `cacheReadTokens: number`, `cacheWriteTokens?: number`
  - `EMPTY_USAGE` must be `Readonly<Usage>` with `inputTokens: 0, outputTokens: 0, cacheReadTokens: 0` and `cacheWriteTokens` ABSENT (not `undefined`, not `0`)
  - `mergeUsage(a, b)` must be pure and return a new object; `b.field > 0` wins over `a.field`; when `b.field === 0`, `a.field` is preserved
  - `accumulateUsage(total, turn)` must be pure and return a new object; simple field-wise addition with `?? 0` for optional `cacheWriteTokens`

## Steps

1. **Create `packages/core/src/types/usage.ts`.**

   Copy the code sketch from spec §6 verbatim. The exact content:

   ```typescript
   /**
    * Normalized cross-provider token usage for a model call or run.
    * inputTokens, outputTokens, cacheReadTokens are always present.
    * cacheWriteTokens is Anthropic-only; absent for OpenAI and when not applicable.
    */
   export type Usage = {
     inputTokens: number;
     outputTokens: number;
     cacheReadTokens: number;
     cacheWriteTokens?: number;
   };

   /**
    * Zero usage constant. Use as the initial accumulator value.
    * Do NOT mutate. Clone with { ...EMPTY_USAGE } if a mutable copy is needed.
    * cacheWriteTokens is absent (exactOptionalPropertyTypes: absent ≠ undefined).
    */
   export const EMPTY_USAGE: Readonly<Usage> = Object.freeze({
     inputTokens: 0,
     outputTokens: 0,
     cacheReadTokens: 0,
   });

   /**
    * Merge two partial usage values from events within the same model message.
    * Uses a > 0 guard: a later event's zero does not overwrite an earlier non-zero.
    * Pure and immutable — returns a new Usage object.
    *
    * Use case: combining message_start (input tokens) with message_delta (output
    * tokens) from Anthropic's streaming event sequence.
    */
   export function mergeUsage(a: Usage, b: Usage): Usage {
     return {
       inputTokens: b.inputTokens > 0 ? b.inputTokens : a.inputTokens,
       outputTokens: b.outputTokens > 0 ? b.outputTokens : a.outputTokens,
       cacheReadTokens: b.cacheReadTokens > 0 ? b.cacheReadTokens : a.cacheReadTokens,
       ...(((b.cacheWriteTokens ?? 0) > 0)
         ? { cacheWriteTokens: b.cacheWriteTokens }
         : a.cacheWriteTokens !== undefined
           ? { cacheWriteTokens: a.cacheWriteTokens }
           : {}),
     };
   }

   /**
    * Field-wise sum of a completed turn's usage into the run cumulative total.
    * No guards — final values only. Pure and immutable — returns a new Usage object.
    *
    * Use case: summing turn usage into the run-level total after each message_stop.
    */
   export function accumulateUsage(total: Usage, turn: Usage): Usage {
     return {
       inputTokens: total.inputTokens + turn.inputTokens,
       outputTokens: total.outputTokens + turn.outputTokens,
       cacheReadTokens: total.cacheReadTokens + turn.cacheReadTokens,
       ...((total.cacheWriteTokens !== undefined || turn.cacheWriteTokens !== undefined)
         ? { cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (turn.cacheWriteTokens ?? 0) }
         : {}),
     };
   }
   ```

   Zero project-internal imports. No import statement at the top of the file.

2. **Update `packages/core/src/index.ts`.**

   Add two lines at the bottom of the file (after the existing exports):

   ```typescript
   export type { Usage } from "./types/usage.js";
   export { EMPTY_USAGE, mergeUsage, accumulateUsage } from "./types/usage.js";
   ```

   `Usage` is a type export (`export type`). `EMPTY_USAGE`, `mergeUsage`, `accumulateUsage` are value exports.

3. **Create `packages/core/src/__tests__/usage.test.ts`.**

   Cover all cases from spec §13 "types/usage.ts — unit tests":

   - `EMPTY_USAGE` is frozen: `Object.isFrozen(EMPTY_USAGE)` is `true`; mutating it throws in strict mode.
   - `EMPTY_USAGE` has `inputTokens: 0`, `outputTokens: 0`, `cacheReadTokens: 0`, and `cacheWriteTokens` is absent (`'cacheWriteTokens' in EMPTY_USAGE` is `false`).
   - `mergeUsage` zero guard — `b.inputTokens = 0` does not overwrite `a.inputTokens` when `a.inputTokens > 0`.
   - `mergeUsage` non-zero in `b` overwrites `a` — `b.outputTokens = 5` replaces `a.outputTokens = 3`.
   - `mergeUsage` `cacheWriteTokens` cases:
     - `a` has it, `b` does not → result has it (preserved from `a`).
     - `b` has it and `> 0` → result has it (from `b`).
     - `b.cacheWriteTokens = 0` → result uses `a.cacheWriteTokens` if set.
     - Both absent → absent in result.
   - `mergeUsage` returns a new object (referential inequality with both inputs).
   - `accumulateUsage` simple sum: `inputTokens`, `outputTokens`, `cacheReadTokens` added correctly.
   - `accumulateUsage` `cacheWriteTokens` cases:
     - Both present → summed.
     - Present on one, absent on other → sum of that one + 0.
     - Both absent → absent in result.
   - `accumulateUsage` returns a new object (referential inequality with both inputs).

4. **Run the test suite** to confirm all 196 existing tests still pass and the new `usage.test.ts` tests all pass:

   ```
   cd /path/to/repo && pnpm -r test
   ```

   Also run the typecheck:

   ```
   pnpm -r typecheck
   ```

   Both must exit 0.

## Acceptance criteria

- [ ] `packages/core/src/types/usage.ts` exists and exports `Usage`, `EMPTY_USAGE`, `mergeUsage`, `accumulateUsage` with zero project-internal imports.
- [ ] `packages/core/src/index.ts` exports all four from `./types/usage.js` (type export for `Usage`, value exports for the rest).
- [ ] `pnpm -r typecheck` exits 0. No new TS errors introduced.
- [ ] `pnpm -r test` exits 0 with at least 196 + (new usage tests) total passing. All pre-existing 196 tests continue to pass.
- [ ] `EMPTY_USAGE` is frozen: mutating `EMPTY_USAGE.inputTokens = 99` throws in strict mode (vitest runs in strict mode).
- [ ] `EMPTY_USAGE` has no `cacheWriteTokens` key: `'cacheWriteTokens' in EMPTY_USAGE` is `false`.
- [ ] `mergeUsage` is pure: the input objects `a` and `b` are not mutated.
- [ ] `accumulateUsage` is pure: the input objects `total` and `turn` are not mutated.
- [ ] `mergeUsage(a, b)` where `b.inputTokens === 0` preserves `a.inputTokens`.
- [ ] `accumulateUsage` when both `cacheWriteTokens` are absent: result has no `cacheWriteTokens` key.

## Output files

- Created: `packages/core/src/types/usage.ts`
- Created: `packages/core/src/__tests__/usage.test.ts`
- Modified: `packages/core/src/index.ts`

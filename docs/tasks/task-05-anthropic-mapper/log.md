# Execution Log — Task 05: Anthropic Stream Mapper (scope: project) — Opus redo

> Dev-loop execution log for the Opus redo (refined: inputParseError flag + stop_reason caching). Evidence captured inline.

## Iteration 1

### Implement (Opus)
- **Created:** `providers/anthropic-mapper.ts` — exports `mapMessages`, `mapTools`, `mapRequest`, `InputAccumulator`, `translateStreamEvent`.
- **Refined design confirmed:** `finishBlock` returns discriminated `{kind:"ok",id,name,input}` | `{kind:"parse_error",id,name}` | `null` (text/non-tracked; empty buffer→`input:{}`). `translateStreamEvent` on `content_block_stop`: null→`[]`, ok→`tool_use` w/ input, parse_error→`tool_use` w/ `input:{}` + `inputParseError:true`. **No `PARSE_ERROR` symbol.** stop_reason cached via `setStopReason`/`takeStopReason` (`?? "end_turn"`); `message_delta`→set, `message_stop`→emit cached (never hardcoded).
- **Brief-vs-skeleton divergence (FLAGGED for reviewer):** the brief's immutable Downstream-deps contract specifies `translateStreamEvent(event: unknown, acc): ProviderEvent[]` (array, `unknown` param, internal type guards), `finishBlock`→`null` for text blocks, and `appendJson`; the code-arch skeleton used a `function*` generator, `Anthropic.MessageStreamEvent` param, `parse_error{id:""}` for text blocks, and `appendDelta`. Implementer followed the BRIEF (task contract). Behaviorally equivalent for task-06's provider (consumes generically); the brief's `null`-for-text form is cleaner than the skeleton's sentinel. → code-arch skeleton is stale on these 4 surface points; orchestrator to reconcile if reviewer agrees.
- **SDK types (vs `@anthropic-ai/sdk@0.52.0`):** `MessageParam`, `Tool`, `Tool.InputSchema`, `MessageCreateParamsStreaming` resolve; `stop_reason` at `message_delta.delta.stop_reason`. Type-only SDK import; no `PARSE_ERROR` import.
- **Verification (Opus, Node 22):** typecheck→0; lint→0 (build doesn't bundle the mapper until task-06 wires it).

### Test (Opus, Node v22.22.0)
- **New test:** `__tests__/anthropic-mapper.test.ts` (16) — mapRequest (snake_case `input_schema`, max_tokens fallback+override, stream:true); text streaming; single tool use; multi-block accumulation (§10.2); **malformed JSON → `inputParseError:true` + `input` deep-equals `{}` (not null) + `finishBlock`→`{kind:"parse_error"}`**; stop_reason caching (`tool_use` cached; default `end_turn`); empty no-arg tool → `input:{}`; ignored/unknown/non-record → `[]`.
- **Suite:** `Test Files 5 passed (5)`, `Tests 37 passed (37)`. typecheck→0; lint→0.
- **No PARSE_ERROR** in production (only an absence-noting comment in types.test.ts). git status: only expected files; submodule untouched.
- Test-side only: `noUncheckedIndexedAccess` + SDK `ToolUnion` needed an `as` narrowing in the test (no production change).

### Review (Opus)
- **Verdict:** Approved — no blocking issues. High-risk module scrutinized: `inputParseError` flow correct (parse_error → `input:{}` serializable + flag, no symbol, survives history threading); stop_reason caching correct (all 3 states); mapRequest precedence; per-index multi-block accumulation; type-only SDK import.
- **Divergence ruling:** following the brief is correct (immutable task contract). Brief's choices are *better* in two cases: array+`unknown` form decouples the highest-risk module from SDK type churn; `finishBlock`→`null` for text blocks is cleaner/safer than the skeleton's `{id:""}` sentinel (which could misroute a real empty-id tool). Task-06's `for...of` over translateStreamEvent works with the array form unchanged. **Recommendation:** update the code-arch skeleton to match → DONE by orchestrator.
- **Test quality:** thorough — parse-error path asserts `inputParseError:true` + `toEqual({})` (deep) + `not.toBeNull()` + direct `finishBlock` parse_error; multi-block; stop_reason cached/default/none; no-arg empty input (both paths); robustness on null/undefined/42. One optional nice-to-have (mixed text+tool in one turn) — not required.
- **Forward-compat:** task-06 compatible. **Regressions:** none.
- **Orchestrator follow-up:** synced `docs/engineering/2026-06-27-code-architecture.md` mapper skeleton to the brief+impl (array+`unknown` `translateStreamEvent`, `finishBlock`→`FinishResult|null`, `appendDelta`→`appendJson`, null-for-text note).

## Completion
- **Iterations:** 1 (implement → test → review, all green).
- **Verification (orchestrator, Node v22.22.0):** test 37/37; typecheck→0; lint→0.
- **Acceptance criteria:** all met (mapRequest snake_case input_schema + max_tokens; multi-block; malformed JSON → inputParseError+`{}` (no null); stop_reason cached; exports stable; no PARSE_ERROR).
- **Deviations:** followed the brief over a stale skeleton on 4 surface points (reviewer-endorsed; skeleton since synced). **Regressions:** none.
- **Commit:** _(filled after commit lands)_

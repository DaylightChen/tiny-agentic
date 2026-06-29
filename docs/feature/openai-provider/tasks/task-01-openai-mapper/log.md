# Execution Log — feature/openai-provider — Task 01: OpenAI Stream Mapper

> Dev-loop execution log. Structured by iteration (implement → test → review).

## Iteration 1

### Implement
- **Files created:** `packages/core/src/providers/openai-mapper.ts`
- **Files modified:** none
- **Exports (per brief's pinned signatures):** `mapRequest`, `mapTools`, `ToolCallAccumulator` (`applyDelta`/`setFinishReason`/`flush`), `translateChunk`.
- **Decisions not in plan:** Used a locally-defined structural return type (`OpenAIChatCompletionParams`/`OpenAIChatMessage`/etc., exported) instead of `import type OpenAI from "openai"`, because the `openai` SDK is not installed in this workspace yet (task-02 adds the peer/dev dep), so a type-import would not resolve and would fail typecheck. The brief explicitly permits a local structural type; zero type-imports is within the "at most one `import type` line" bound.
- **Deviations from plan:** none (test file intentionally not created — tester's job).
- **Correctness traps handled:** `arguments` = `JSON.stringify(input)` (string); batched `tool_result` → N ordered `role:"tool"` msgs, `is_error` dropped, no `"Error: "` prefix; assistant-only-tool-calls → `content: null`; empty buffer → `{}`, malformed JSON → `{ input: {}, inputParseError: true }`; no `finish_reason` → `stopReason: "end_turn"`; malformed/non-record chunks → `[]` without throwing.
- **Self-check:** `pnpm --filter tiny-agentic typecheck` exits 0 under `exactOptionalPropertyTypes`. (`tool_use`/`message_stop` literals only inside `flush()`; no `from "openai"` runtime import.)

### Test
- **New tests written:** `packages/core/src/__tests__/openai-mapper.test.ts` (33 tests, mirrors `anthropic-mapper.test.ts` with a `run(chunks)` helper). Covers every brief §3 assertion (request transforms 1-4, tools, `max_completion_tokens`/no `max_tokens`, and the full streaming matrix incl. concurrent index order, large arg split, malformed JSON → `inputParseError`, no-finish-reason default, exactly-one `message_stop`, `include_usage` ignored, malformed chunks → `[]`).
- **Failures:** none.
- **Full suite output:**
  ```
  $ pnpm --filter tiny-agentic test
   Test Files  12 passed (12)
        Tests  124 passed (124)
  ```
  (33 new + 91 pre-existing; no regressions. Node-engine warning pre-existing/non-fatal.)
- **Typecheck:**
  ```
  $ pnpm --filter tiny-agentic typecheck   # tsc --noEmit
  EXIT: 0
  ```
- **Note:** tester's first typecheck flagged 13 errors **in the test file only** (`noUncheckedIndexedAccess`); fixed in-test (non-null assertions / optional chaining). No production code touched.

### Review
- **Verdict:** ✅ Approved (no issues to fix).
- **Criteria check:** all pass — exports match §Downstream signatures (`mapRequest` returns body with no `stream` flag; `ToolCallAccumulator` `applyDelta`/`setFinishReason`/`flush`; `translateChunk` text-only); system message first + `max_completion_tokens` present / `max_tokens` absent; `arguments` = `JSON.stringify(input)` string; batched `tool_result` → N ordered `role:"tool"` msgs, `is_error` dropped; empty tools → no `tools` key; accumulator keys on index, flush sorts ascending + exactly one `message_stop`; parse-error → `{ input:{}, inputParseError:true }` (never null); no-finish-reason → `"end_turn"`; `include_usage` → `[]`; no runtime SDK import. Reviewer independently re-ran `tsc --noEmit` (exit 0) + eslint (exit 0) + both grep checks.
- **Code quality findings:** clean — faithfully mirrors `anthropic-mapper.ts` guards + parse-error contract; local structural types justified and sound. No DRY/YAGNI issues.
- **Test quality findings:** adequate/strong — value-level assertions, no tautologies, consume-then-flush helper matches the live provider loop.
- **Regressions:** none.
- **Downstream note (for task-02, non-blocking):** when task-02 spreads `{ ...params, stream: true }` into `chat.completions.create()`, the local `OpenAIChatCompletionParams` is a structural subset of OpenAI 6.x's `ChatCompletionCreateParamsStreaming`; if TS rejects the assignment, task-02 owns adding a cast at the call site (mirrors `anthropic-mapper.ts`). Anticipated by the brief; nothing for task-01 to change.
- **Issues to fix:** none.

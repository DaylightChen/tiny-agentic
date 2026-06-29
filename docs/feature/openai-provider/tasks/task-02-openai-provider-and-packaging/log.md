# Execution Log — feature/openai-provider — Task 02: OpenAIProvider, packaging, and exports

> Dev-loop execution log. Structured by iteration (implement → test → review).

## Iteration 1

### Implement
- **Files created:** `packages/core/src/providers/openai.ts` (`OpenAIProvider`), `examples/openai-run.ts` (OpenAI counterpart to `basic-run.ts`).
- **Files modified:** `packages/core/package.json` (`openai` in peerDeps + `peerDependenciesMeta.openai.optional:true` + devDeps, all `^6.0.0`; `./providers/openai` export), `packages/core/tsup.config.ts` (`providers/openai` entry), `pnpm-lock.yaml`.
- **openai version:** pinned `^6.0.0`; `npm view openai version` → `6.45.0`; installed = 6.45.0. Major 6 confirmed.
- **`await create()`:** matches SDK — streaming overload returns `APIPromise<Stream<ChatCompletionChunk>>`, so awaited before `for await`; `RequestOptions.signal` confirms `{ signal }` as 2nd arg. No deviation.
- **Deviation (pre-authorized):** cast at the `{ ...params, stream: true }` call site to `OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming`, because the mapper's local `OpenAIChatCompletionParams` is a deliberate structural subset (mapper stays SDK-runtime-free). Mirrors `anthropic-mapper.ts:13,21`. Mapper untouched; 2-line comment explains the why.
- **Self-validation:** `typecheck` exit 0 (`exactOptionalPropertyTypes`); `build` success → `dist/providers/openai.js` (6.99 KB) + `.d.ts`. Boundary greps clean: `index.ts` zero `openai` refs; `openai.ts` no `withRetry`/`runTools`/`.stream(` call sites; no UI imports. Test suite not run (tester owns it).

### Test
- **New tests written:** `packages/core/src/__tests__/openai.test.ts` (15 tests, mirrors `anthropic.test.ts`). Hoisted `vi.mock("openai")` with ctor + `create` arg spies; `create` is async (provider awaits it) with per-test swappable async-iterable.
- **Coverage:** logger off→`message_stop`+0 console; logger fires (`request_sent`); AbortSignal as 2nd arg; `maxRetries` default 3 + override via ctorSpy; `baseURL` conditional (`"baseURL" in opts === false` when absent); constructor validation (empty + undefined apiKey); 4 end-to-end equivalence scenarios (text / single tool / 2 concurrent ascending-index / malformed args→`inputParseError`); error propagation (create rejects + iterator throws mid-stream).
- **Failures:** none.
- **Full suite output:**
  ```
  $ pnpm --filter tiny-agentic test
   Test Files  13 passed (13)
        Tests  139 passed (139)
  ```
  (124 baseline + 15 new; no regression in any prior suite.)
- **Typecheck:** `tsc --noEmit` → exit 0.
- **Build:** exit 0 — `dist/providers/openai.js` (6.99 KB) + `dist/providers/openai.d.ts` (713 B) emitted.
- **Boundary greps:** `index.ts` no `openai` refs; `withRetry`/`runTools`/`.stream(` in `openai.ts` are comment-only (no calls).
- **Note:** tester fixed one defect in the **test file only** (an `as const` made `messages` `readonly []`); production `openai.ts` untouched.
- **Coverage gap (by design):** `examples/openai-run.ts` not unit-tested (not run in CI); its import resolution is covered transitively by typecheck.

### Review
- **Verdict:** ✅ Approved (no issues to fix).
- **Criteria check:** all pass — `await create(...)` → `for await { translateChunk }` → trailing `flush()` matches spec; ctor throws exact message; logger off→`message_stop`+0 console / on→`request_sent`; `signal` as 2nd arg; `maxRetries` default 3 → `new OpenAI` + `baseURL` only when present; 4 end-to-end `ProviderEvent` sequences via full `toEqual`; no `withRetry`/`runTools`/`.stream(`; `index.ts` clean; package.json peer+optional+dev (`^6.0.0`) + export; tsup entry; example mirrors `basic-run.ts`, env-read key.
- **Cast at spread site:** sound — type-only; runtime object's every field is a valid Chat Completions streaming field; local type is a genuine structural subset; 5-line comment adequate, cites `anthropic-mapper.ts` precedent; typecheck 0 under `openai@6.45.0`.
- **Security:** no hardcoded key in example (grep for `sk-…` / literal `apiKey:"…"` empty); key from `process.env["OPENAI_API_KEY"]` with guard + exit; logger emits counts only.
- **Code quality:** clean — field-for-field parity with `anthropic.ts`, `exactOptionalPropertyTypes` discipline correct, no dead code.
- **Test quality:** strong — full `toEqual` event sequences, real ctor/arg spies, signal-identity assertion, `"baseURL" in opts` absence check, both error-propagation modes.
- **Regressions:** none. **Issues to fix:** none.
- **Non-blocking note:** no `lint` script in workspace; only static gate is `tsc --noEmit` (reviewer re-ran → 0). `examples/` not in any `tsc` include, so the example isn't typecheck-gated — matches the brief's conditional; acceptable as a faithful copy of the already-typechecked `basic-run.ts`.

### Manual verification — escalation & core fix (post-review)

Running `examples/openai-run.ts` against a live OpenAI-compatible endpoint surfaced a **core (M1) bug**, not a task-02 defect:

- **Symptom:** `400 … invalid 'parameters' schema: True is not of type 'number'` on `read_file`'s `offset.exclusiveMinimum`.
- **Root cause (systematic-debugging, evidence-backed):** `ToolRegistry.toSchemas()` serialized with `zod-to-json-schema` `target: "openApi3"`, which emits Draft-4 **boolean** `exclusiveMinimum: true`. OpenAI's metaschema requires a **number**. Anthropic tolerated the boolean form, so M1 never caught it; mock-SDK tests don't validate against a real metaschema. (Checked all targets: `jsonSchema7` → numeric ✓; `openAi` → still boolean + `anyOf/null` ✗.)
- **Escalated** to the user (cross-boundary: core code + a locked M1 decision + the shared Anthropic path). User approved the **core fix**.
- **Fix:** `registry.ts` → `target: "jsonSchema7"` + strip top-level `$schema`. Numeric `exclusiveMinimum: 0`, accepted by both providers; fixes all tools, not just built-ins. Superseded the 2026-06-27 decision in `docs/project/decisions.md`. Added a regression test in `env-context.test.ts` (failing pre-fix: `expected true to be +0`; passing post-fix).
- **Verification:** full suite **140 passed (140)** (139 + 1 regression), typecheck exit 0. Real-API re-run of both `examples/openai-run.ts` and `examples/basic-run.ts` is the user's confirmation step.

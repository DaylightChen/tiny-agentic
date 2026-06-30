# Engineering Spec — Final Review Addendum

> **STATUS: RESOLVED (2026-06-30).** All four items below have been folded directly into `2026-06-30-core-run-controls-engineering.md` and `decisions.md`. The spec is now the single authoritative source; this addendum is retained as the review record. Summary of what changed in the spec: (1) §11/§12 now list the compile-breaking `collect.test.ts`/`types.test.ts` typed-literal terminals requiring `usage: EMPTY_USAGE`; (2) §6/§9 pin `let turnUsage` to the first statement inside the `while(true)` body; (3) `message_stop` usage is now conditional on BOTH providers (`takeUsage(): Usage | undefined`), with `anthropic-mapper.test.ts` added to the test-impact scan; (4) test dir corrected to `src/__tests__/`, redundant `translateChunk` guards removed.

---


> Final review of `2026-06-30-core-run-controls-engineering.md`, run 2026-06-30 by two independent reviewers (adversarial code-sketch review + codebase blast-radius audit) against the real code, SDK types, and a real `tsc` compile. **Verdict: spec is SOUND — design and code sketches verified correct.** The items below are corrections/constraints the **planner must fold in**; they do not require re-doing the spec.

## Verified correct (no action)
- **`mergeUsage` / `accumulateUsage` / `EMPTY_USAGE` (§6) compile and behave correctly** — proven by writing the sketch into `packages/core/src` and running `npx tsc -p packages/core/tsconfig.json --noEmit` → **exit 0**. Hand-traced `cacheWriteTokens` for all cases incl. the Anthropic `message_start(a=7)→message_delta(b=0)` sequence: the `> 0` guard correctly preserves the real value; **no `cacheWriteTokens: undefined` is ever assigned** (satisfies `exactOptionalPropertyTypes`).
- **`translateChunk` restructure (§9)** correctly captures the final empty-choices usage chunk and does not mis-read `usage: null` on non-final chunks (`isRecord(null) === false`). Honors verification note 7.
- **Per-turn accumulator isolation** confirmed: both `anthropic.ts:48` and `openai.ts:48` construct a fresh accumulator inside each `stream()` call → per-turn usage is naturally isolated.
- **All 9 verification precision notes are honored.** None dropped or contradicted.
- `RunOptions.signal?`, `mapRequest` `stream_options`, and `turn_complete.usage?` break **zero** existing tests. Baseline = **196 tests**.

## MUST FIX — fold into the plan

### 1. [BLOCKING] Spec's test-impact list (§11) omits two **compile-breaking** files
Making `usage` **non-optional** on the terminal `AgentEvent`s and `Terminal` turns every hand-built typed literal into a **TS compile error (TS2741)** — a hard `tsc`/build failure, not a soft `toEqual` mismatch. The spec's §11 names `agent.test.ts` / `loop.test.ts` / `agent-tooling-integration.test.ts` but **omits the only files that actually fail to compile**:
- `packages/core/src/__tests__/collect.test.ts` — `Terminal` literals at **:18**, **:66**, **:82** (e.g. `const terminal: Terminal = { reason: "agent_done", messages: [] }`).
- `packages/core/src/__tests__/types.test.ts` — `AgentEvent` literal at **:65** and `Terminal` literal at **:77**. (This file's test is literally titled "changed required fields break the build" — engineered to fail on exactly this change.)

**Action:** the plan must include adding `usage: EMPTY_USAGE` (or a real value) to these **5 typed literals**. Without it the `implement` phase will not compile. The actual build-break surface in source is confirmed to be **only `loop/loop.ts`** (sites at :32/:34, :62/:64, :129/:131) plus the new pre-flight `agent_error` in `agent.ts` the spec adds — `agent.ts` has no existing terminal construction sites.

### 2. [should-fix] Pin the `turnUsage` declaration site
`turn_complete` is yielded at `loop/loop.ts:123` (tool path) and `:128` (natural completion) — **after** the inner `for await (provider.stream())` loop. The spec's prose is ambiguous (one place implies a `let` inside the `message_stop` branch → out of scope at the yields; another lists it function-level → stale across turns). **Action:** the plan must specify declaring `let turnUsage: Usage | undefined` as the **first statement inside the `while (true)` body** (reset per turn), assigned in the `message_stop` branch, accumulated into `cumulativeUsage` after the for-await, and read at the `turn_complete`/terminal yields.

### 3. [should-fix] Provider asymmetry → extra Anthropic test churn
The spec emits `message_stop.usage` **unconditionally for Anthropic** (`takeUsage()` always returns a `Usage`) but **conditionally for OpenAI** (`flush()` conditional-spread — absent when no usage chunk). The audit sized OpenAI's `message_stop` deep-equality churn (1 guaranteed at `openai-mapper.test.ts:671`; ~10 more only if attachment were unconditional — it isn't, so they stay green). **It did NOT audit `anthropic-mapper.test.ts`** for `message_stop` deep-equality assertions, which **will** break because Anthropic now always attaches `usage`. **Action:** the plan's test-update task must also scan `packages/core/src/__tests__/anthropic-mapper.test.ts` for `toEqual`/`toStrictEqual` on `message_stop` events and add `usage`. Consider (optional) making Anthropic attachment conditional too, for cross-provider symmetry and to minimize churn — on the happy path it always has usage anyway.

### 4. [nit] Test directory + minor cleanups
- Tests live in `packages/core/src/__tests__/` (not co-located with source as several §11/§13 references imply). Line numbers in the spec are correct against that directory.
- `translateChunk` sketch (§9 ~L489) `&& chunk.usage != null` is redundant with `isRecord(...)`; `asNumber(...) ?? 0` (~L495) is dead (`asNumber` never returns null). Harmless.
- §9 Anthropic sketch mutates a literal (`initialUsage.cacheWriteTokens = cw`); prefer conditional-spread to match the file's immutability/`exactOptionalPropertyTypes` conventions.

## Net
No blocking design flaw. The spec is correct to build against. Carry the 4 items above into the plan (item 1 is the only hard build-breaker; items 2–3 prevent a real per-turn bug and a missed test-update). Regression bar: **196 → (196 + new tests)**, with the ~7-floor mechanical `usage` updates concentrated in `collect.test.ts`, `types.test.ts`, `openai-mapper.test.ts:671`, and `anthropic-mapper.test.ts`.

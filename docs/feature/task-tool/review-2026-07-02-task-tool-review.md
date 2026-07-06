# Code Review — Sub-agent / `task` tool feature

> Scope: `feature/task-tool` (research → engineering → plan → tasks 01–05, and the shipped code).
> Date: 2026-07-02. Reviewer: full-feature adversarial review (4 independent lenses — usage accounting, abort/signal lifecycle, boundary/leak, spec-fidelity — plus two throwaway runtime experiments).
> Method: read all design docs + `packages/core` implementation + tests + example; ran `tsc`, `vitest`, `eslint`; ran two throwaway experiments (abort-mid-flight cascade, recursion footgun) and deleted them.

## Bottom line

**The feature is correct, faithful to its spec, and well-tested. No hard bugs found.**

Verification state (committed tree):

- `tsc -p packages/core/tsconfig.json --noEmit` → **0 errors**
- `vitest run` → **314 tests pass** (20 files)
- `eslint packages/*/src --max-warnings 0` → **clean**
- Every spec test T1–T22 exists; all model-facing microcopy is verbatim.
- Empirically confirmed: no usage double-count/loss on any reachable path, no provider-native leak across the boundary, correct multi-call event ordering + `taskId` correlation, working signal-based cancellation, and parent/child isolation.

The items below are what a max-effort pass surfaces regardless: **one sharp design footgun, three latent robustness gaps (no live trigger today), two test-coverage holes, and some doc/cleanliness nits.** None is a release blocker.

Severity legend: **DESIGN** = design limitation/flaw · **LATENT** = correct today, fragile under future change · **COVERAGE** = missing/weak test · **NIT** = cosmetic/doc.

---

## Design flaws / limitations

### D1 — Recursion safety is convention-only, with no backstop *(the big one)*

**Where:** [`task.ts:38-45`](packages/core/src/tools/builtin/task.ts#L38) (the `resolveChild` contract), enforced nowhere in core.

The **sole** thing preventing runaway sub-agent spawning is the host's `resolveChild` remembering to omit the `task` tool from the child's tool set. A naive resolver that reuses the parent's tool array — a very natural thing to write — re-includes `task` and recurses. Core adds no numeric depth guard and does not strip itself from children.

**Demonstrated:** a throwaway where `resolveChild` includes `task` spawned **10 sub-agents and terminated only at the parent's turn cap** (`max_turns_exceeded`). Spawning is multiplicative (turns × depth).

**Status:** documented as a deliberate v1 deferral (spec E2/R2; `docs/project/known-issues.md`). Core genuinely cannot inspect the child's private tool set to enforce this without a new seam, so the deferral is defensible — but the reference implementation uses **both** a structural and a numeric guard precisely because structural-only is fragile. For a framework, "safety by host convention with zero backstop" is the single most consequential limitation.

**Recommendation:** at minimum surface the warning where implementers actually look — the `createTaskTool` / `resolveChild` JSDoc, not only a spec doc. Consider a future opt-in depth seam (e.g. a loop-seeded `context.depth` the tool reads) as the deferred design already sketches.

### D2 — Child observability is entirely non-real-time (collect-then-flush, R3)

**Where:** [`loop.ts:114-135`](packages/core/src/loop/loop.ts#L114).

A consumer sees **none** of a child's `text_delta`/tool events until the child fully completes, then receives them as a burst immediately before the `tool_result`. Accepted for v1 (real-time forwarding would require restructuring `runTools` into a concurrent producer/consumer), but for a headless framework whose value is the event stream, in-flight nested runs are opaque. This is the main *functional* limitation and worth stating loudly to consumers.

### D3 — `break` is not real cancellation for sub-agent work; only the external signal is

**Where:** interaction of [`agent.ts:77-82`](packages/core/src/agent.ts#L77) and [`task.ts:146-156`](packages/core/src/tools/builtin/task.ts#L146).

Because the parent generator has no yield point while the child runs inside `tool.call`, a consumer that wires a "stop" button to breaking the `for await` loop finds it unresponsive for the **entire** child run — the `.return()` is queued behind the still-pending child `.next()`, so the child runs to completion and `abortCtrl.abort()` fires too late to interrupt anything.

**Confirmed empirically:** a consumer that requested `.return()` after 1/5 child chunks still saw all 5 emitted, and `return()` resolved only after the child finished.

The `agent.ts:78-81` comment ("aborting the in-flight provider stream") oversells `break` for this case. E9's literal wording ("unwinds to a terminal, no throw/leak") is technically satisfied (it terminates by *completing*), so this is a risk + misleading comment, not a spec violation. **Correct** cancellation — aborting `options.signal` — cascades promptly and is confirmed working.

**Recommendation:** document that cancellation of in-flight sub-agents must use the run signal, not `break`; soften the `agent.ts` comment.

### D4 — The required `description` input is dead

**Where:** [`task.ts:19`](packages/core/src/tools/builtin/task.ts#L19) (required schema field) vs its (absent) use.

The model is forced to emit a 3–5 word `description` on **every** `task` call, labeled *"for logging"*, but it is never read, never forwarded to `resolveChild` (`ChildSpec` omits it by design), never logged, and never surfaced on any event. The "for logging" promise has no channel by which it could be honored.

**Recommendation:** either surface it (e.g. include on the spawning `subagent_event`, or pass to `resolveChild` for host logging) or drop the requirement / document it explicitly as a model-facing forcing-function only.

---

## Implementation issues (latent — no live trigger today)

### I1 — No `try/finally` around the child-driver loop

**Where:** [`task.ts:146-161`](packages/core/src/tools/builtin/task.ts#L146).

If `iter.next()` rejects or `context.emitEvent` throws mid-drive, `context.reportUsage(terminal.usage)` (line 161) is skipped and the child generator is never `.return()`'d (its teardown `finally` at `agent.ts:81` won't run).

Safe **today** only because two invariants hold: `agentLoop` is total (it converts every internal error to a *terminal event*, never rejects — [`loop.ts:68-73`](packages/core/src/loop/loop.ts#L68)), and `emitEvent` is a non-throwing array push. The one reachable manifestation: if a child's `buildEnvContext`/`platform.cwd()` throws (pre-stream, [`agent.ts:64`](packages/core/src/agent.ts#L64)), `child.run()` **does** reject → the parent tool result is the **raw error string, bypassing the `"Sub-agent failed: "` microcopy** (zero tokens are lost in that specific case since it is pre-stream; usage-loss and dangling-child remain latent-only).

**Fix (cheap):** wrap the drive loop in `try/finally` (or `try/catch`) so usage-report and error→microcopy mapping run even when `child.run()` rejects; `.return()` the iterator on early exit.

### I2 — `context.reportUsage` / `emitEvent` are never cleared after the batch

**Where:** [`loop.ts:110`](packages/core/src/loop/loop.ts#L110) and [`loop.ts:121`](packages/core/src/loop/loop.ts#L121); contrast the correctly-deleted `context.toolCallId` at [`runTools.ts:114-116`](packages/core/src/loop/runTools.ts#L114).

Benign today: both `reportedUsage`/`childEvents` and their closures are recreated fresh each tool batch, and tools only call the sinks synchronously within their awaited `call`. But correctness rests entirely on that invariant. A future fire-and-forget tool that retains `context` and calls `emitEvent`/`reportUsage` **after** its `call` resolves would push into whichever turn's live buffer exists → events misattributed to the wrong `taskId`, or usage double-counted, on a later turn. Related: the flush+reset at `loop.ts:130-133` assumes `runTools` yields **only** `tool_result`.

**Fix (cheap):** `delete context.reportUsage; delete context.emitEvent;` after the batch, mirroring `toolCallId`.

### I3 — Child usage is invisible in the incremental stream, and a loop comment is inaccurate

**Where:** [`loop.ts:173`](packages/core/src/loop/loop.ts#L173) (`turn_complete` carries `turnUsage`, the parent's own per-turn tokens) vs the child fold at [`loop.ts:169-171`](packages/core/src/loop/loop.ts#L169).

Child spend surfaces **only** in the terminal's cumulative `usage`, never in any `turn_complete.usage`. A consumer building a live token meter by summing `turn_complete.usage` deltas under-counts by the entire child spend. The terminal total is correct — this is an observability/reconstruction gap.

The comment at [`loop.ts:165-168`](packages/core/src/loop/loop.ts#L165) ("Fold … before the turn boundary — so a consumer reading `turn_complete` sees a consistent cumulative state") is **misleading**: `turn_complete` exposes per-turn usage, not cumulative, and never includes child tokens. Per-child fidelity *is* available on each `subagent_event(terminal).usage` (documented in R5).

**Fix:** correct the comment; document that live child cost must be read from `subagent_event` terminals, not `turn_complete`.

---

## Test-coverage gaps

### T-cov-1 — T8 is materially weaker than its spec

**Where:** [`task-tool.test.ts:392-421`](packages/core/src/__tests__/task-tool.test.ts#L392) vs spec T8.

The brief's T8 says assert "the child stream sees `signal.aborted` **and the child terminates**." The actual test runs the child **to completion first**, then aborts post-hoc and only checks the linked signal flipped. The `MockProvider` ignores its signal, so mid-flight termination is structurally untested. (A throwaway with a signal-honoring blocking child confirmed the real cascade **does** work — the behavior is right; only the test is thin.)

**Fix:** add a test with a blocking, signal-honoring child provider that aborts the parent signal mid-stream and asserts the child terminates and the tool returns without hanging.

### T-cov-2 — E1's "misconfigured host" case is untested

**Where:** spec E1 narrative vs [`task-tool.test.ts:445-509`](packages/core/src/__tests__/task-tool.test.ts#L445) (T9 only covers the correct-omit case).

The spec's E1 explicitly calls for a test where `resolveChild` *wrongly includes* `task`, pinning core's deliberate "no second guard — a misconfigured host *can* recurse" behavior. Only the correct case is tested. The recursion-footgun demo is exactly this missing test.

**Fix:** add a test asserting that a `resolveChild` including `task` does recurse (bounded only by `maxTurns`), documenting-by-test that core adds no silent guard.

---

## Minor / nits

- **`childCtrl` is vestigial** ([`task.ts:120`](packages/core/src/tools/builtin/task.ts#L120)): `.abort()` is never called, so `AbortSignal.any([context.signal, childCtrl.signal])` is behaviorally identical to using `context.signal` directly — and `Agent.run` re-wraps whatever signal it receives in its own `AbortSignal.any` anyway ([`agent.ts:43-46`](packages/core/src/agent.ts#L43)). Dead scaffolding for an unwired child-only cancel/timeout. Either wire it (e.g. a per-child timeout) or simplify.
- **`toolCallId` JSDoc inaccuracy** ([`tool.ts:31-32`](packages/core/src/types/tool.ts#L31)): says "Absent for tools that don't need it," but `runTools` sets it for **every** call during execution.
- **Loose input validation**: `prompt` and `description` are bare `z.string()` ([`task.ts:19-20`](packages/core/src/tools/builtin/task.ts#L19)) — empty strings pass. Minor input hygiene.
- **`mapChildTerminalToResult` has no explicit exhaustiveness assertion** ([`task.ts:75-84`](packages/core/src/tools/builtin/task.ts#L75)): relies on the declared return type to catch a future 4th `Terminal.reason`. An `assertNever` default would be more robust (as `sanitizeChildEvent` effectively does).
- **Turn-cap partial edge**: a child that trips `max_turns_exceeded` with a tool-use-only last turn yields `"[sub-agent stopped at turn cap] (sub-agent produced no output)"` — awkward but documented and acceptable.

---

## What's done well

- **Compiler-enforced boundary**: the sanitized `SubagentChildEvent` closed union means no `Message`/`ContentBlock`/`ProviderEvent`/raw tool-result payload can cross — a leak is a *type error*. Verified by tests and the boundary review (marker-based, non-vacuous).
- **Single-path usage roll-up**: child usage is reported once and folded once; no double-count and no loss on any reachable path (including child error), confirmed field-wise.
- **Event ordering + correlation**: per-call flush ties each child's events to its own `taskId`, after the spawning `tool_use_start` and before its `tool_result`, even with mixed multi-tool batches.
- **Cancellation & isolation**: the signal-based cascade (parent → child) and child-error isolation (child failure never aborts the parent) are both correct, confirmed empirically.
- **Spec fidelity**: microcopy verbatim, terminal-reason mapping exact, `Agent.run` signature unchanged, all three deferrals (R5 cross-provider fidelity, R6 sequential-only, deferred numeric depth) recorded in `known-issues.md`. The phased docs and per-task execution logs are unusually rigorous and match the code.

---

## Suggested action order

1. **Cheap, safe fixes** (low risk, high clarity): I1 `try/finally`, I2 sink cleanup, I3 comment correction, the two doc nits (`toolCallId` JSDoc, `agent.ts` cancel comment), and the `childCtrl` simplification.
2. **Add the two missing tests** (T-cov-1 abort-mid-flight, T-cov-2 recursion footgun).
3. **Design decisions for you** (larger, not mechanical): D1 recursion backstop, D2 real-time child events, D4 `description` disposition.

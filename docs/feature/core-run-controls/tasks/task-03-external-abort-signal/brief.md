# Task 03 — external-abort-signal

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Extend `RunOptions` with an optional `signal?: AbortSignal` field and wire it into `Agent.run()` in `packages/core/src/agent.ts`. The implementation:

1. Composes the external signal with the internally-created `AbortController.signal` using `AbortSignal.any([options.signal, abortCtrl.signal])`, producing a single composite signal that aborts when either fires.
2. Adds an explicit pre-flight guard: if the composite signal is already aborted when `run()` starts, yield `{ type: "agent_error", ..., usage: EMPTY_USAGE }` and return immediately — before `buildEnvContext` or `agentLoop` run.
3. Passes the composite signal to `agentLoop` (replacing the bare `abortCtrl.signal`).

After this task, consumers can cancel an in-flight `run()` from outside the `for await` loop. The feature is fully additive — `signal` is optional, all existing call sites remain valid.

## Context files

Read these before starting:

- `packages/core/src/agent.ts` — the full current implementation; this is the only file modified.
- `packages/core/src/types/events.ts` — the updated `AgentEvent` and `Terminal` types (from task-02); `agent_error` now requires `usage: Usage`.
- `packages/core/src/types/usage.ts` — `EMPTY_USAGE` is the fallback for the pre-flight guard.
- `packages/core/src/__tests__/agent.test.ts` — existing tests to extend with AbortSignal scenarios.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §3.1 "Primary flow: Cancellation" — the consumer-visible behaviour.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §3.4 "Edge-case behaviors" — pre-aborted signal, env-context build window.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §5 "Open questions resolved" Q1, Q2 — exact code sketches for `AbortSignal.any` and the pre-flight guard.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §9 "Module-by-module change list" → `agent.ts` section — the exact change list with code sketch.
- `docs/feature/core-run-controls/decisions.md` §2026-06-30 "AbortSignal.any — drop-in confirmed" — no fallback, no DOM lib.
- `docs/feature/core-run-controls/decisions.md` §2026-06-30 "Pre-aborted external signal → explicit pre-flight guard" — exact guard implementation.
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` §13 "Test strategy" → `agent.ts — AbortSignal tests` subsection — required test scenarios.

## Downstream dependencies

- **Task 04** (`loop/loop.ts`) does not depend on this task (the loop receives a composite `signal` whether or not it came from `AbortSignal.any` — the type is just `AbortSignal` either way).
- **The `signal` passed to `agentLoop` must remain type `AbortSignal`** (not `AbortSignal | undefined`). The `agentLoop` `LoopParams.signal: AbortSignal` field is non-optional; after the composite-signal computation, the `signal` local variable is always `AbortSignal`.
- **The `RunOptions.signal?: AbortSignal` field must remain optional.** Callers passing `{}` or no second argument to `run()` must continue to compile without change.
- **`exactOptionalPropertyTypes` compliance:** the guard `options.signal !== undefined` (not `options.signal`) is required for correct narrowing. After the guard, `options.signal` narrows to `AbortSignal`.

## Steps

1. **Update `RunOptions` in `packages/core/src/agent.ts`.**

   Change:
   ```typescript
   export type RunOptions = {
     messages?: Message[];
   };
   ```
   To:
   ```typescript
   export type RunOptions = {
     messages?: Message[];
     signal?: AbortSignal;
   };
   ```

2. **Add the `EMPTY_USAGE` import** at the top of `agent.ts`:
   ```typescript
   import { EMPTY_USAGE } from "./types/usage.js";
   ```

3. **Modify `run()` in `agent.ts`.**

   After `const abortCtrl = new AbortController();`, compute the composite signal:
   ```typescript
   const signal = options.signal !== undefined
     ? AbortSignal.any([options.signal, abortCtrl.signal])
     : abortCtrl.signal;
   ```

   Immediately after the composite signal computation, add the pre-flight guard (before any `await`):
   ```typescript
   if (signal.aborted) {
     const error = new Error(
       signal.reason instanceof Error
         ? signal.reason.message
         : "Run aborted before start"
     );
     const event = { type: "agent_error" as const, error, messages: options.messages ?? [], usage: EMPTY_USAGE };
     yield event;
     return { reason: "agent_error", error, messages: options.messages ?? [], usage: EMPTY_USAGE };
   }
   ```

   Then update the `agentLoop` call: replace `signal: abortCtrl.signal` with `signal` (the composite):
   ```typescript
   return yield* agentLoop({
     provider: this.provider,
     registry,
     platform: this.platform,
     messages: workingMessages,
     systemPrompt,
     maxTurns: this.maxTurns,
     signal,   // <-- was: abortCtrl.signal
     ...(this.approvalHandler !== undefined ? { approvalHandler: this.approvalHandler } : {}),
   });
   ```

   The `try/finally` structure, the `buildEnvContext` call, and all other parts of `run()` remain unchanged.

   Important notes:
   - `AbortSignal.any` is available on Node 18.17+ and resolves via `@types/node`. Do NOT add `"DOM"` to `tsconfig.base.json`'s `lib` array.
   - The pre-flight guard runs inside the `try` block, before any `await`. The `finally { abortCtrl.abort() }` still runs on all paths.
   - `signal.reason instanceof Error` handles the case where `AbortController.abort(reason)` was called with an `Error` argument. For all other reasons (string, undefined, etc.) the fallback message is used.

4. **Extend `packages/core/src/__tests__/agent.test.ts`** with three new tests (add as a new `describe` block: `"Agent.run — AbortSignal"`):

   a. **Pre-aborted signal → immediate `agent_error`, no provider stream call:**
   ```
   const ctrl = new AbortController();
   ctrl.abort();
   const agent = new Agent({ provider: new MockProvider([...]), tools: [], platform: new MockPlatform() });
   const { events, terminal } = await collectEvents(agent.run("test", { signal: ctrl.signal }));
   // First (and only) event is agent_error
   expect(events[0]?.type).toBe("agent_error");
   expect(events).toHaveLength(1);
   expect(terminal.reason).toBe("agent_error");
   // Provider received no requests (buildEnvContext not called on dead signal)
   expect(provider.requests).toHaveLength(0);
   ```
   Verify that `events[0].usage` equals `EMPTY_USAGE` (import it in the test file).

   b. **No signal → run completes normally:**
   ```
   // Existing "streams text and completes naturally" test already covers this;
   // add a brief assertion that terminal.reason === "agent_done" when no signal is passed.
   ```
   (This can be a note / sanity assertion appended to an existing test rather than a new one.)

   c. **Mid-run abort → `agent_error` is emitted with partial usage:**
   Use the existing `AbortCapturingProvider` pattern in `agent.test.ts` (which yields one event then blocks until abort). Abort from outside after the first `text_delta` event. Assert that `terminal.reason === "agent_error"`. The usage on the `agent_error` event will be `EMPTY_USAGE` (because `MockProvider` / `AbortCapturingProvider` does not emit usage-bearing `message_stop` — usage wiring comes in task-04). Just assert `terminal.reason === "agent_error"` and that the error is some abort-related error.

   Import `EMPTY_USAGE` in `agent.test.ts` for the pre-aborted test.

5. **Run the full suite:**
   ```
   pnpm -r typecheck
   pnpm -r test
   ```
   Both must exit 0. Existing 196 tests must still pass.

## Acceptance criteria

- [ ] `RunOptions` has `signal?: AbortSignal` (optional field).
- [ ] Calling `agent.run(prompt, { signal: ctrl.signal })` compiles without error.
- [ ] Calling `agent.run(prompt)` with no options, and `agent.run(prompt, {})` with empty options, continue to compile and run correctly.
- [ ] When an already-aborted signal is passed, the first yielded event is `{ type: "agent_error", ..., usage: EMPTY_USAGE }` and the generator terminates — no calls to `buildEnvContext`, no calls to `provider.stream`.
- [ ] When a non-aborted signal is passed and the run completes normally, `agent_done` is yielded.
- [ ] `AbortSignal.any` compiles without error under `pnpm -r typecheck` (no `"DOM"` added to tsconfig).
- [ ] `pnpm -r typecheck` exits 0.
- [ ] `pnpm -r test` exits 0 with all pre-existing 196 tests passing.
- [ ] No changes to `tsconfig.base.json`, `tsconfig.json`, or any other config file.

## Output files

- Modified: `packages/core/src/agent.ts`
- Modified: `packages/core/src/__tests__/agent.test.ts`

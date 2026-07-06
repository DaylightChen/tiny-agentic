# Task 07 — Run-Controls Examples (Anthropic + OpenAI)

> Written in the plan phase (added after tasks 01–06 to demonstrate the feature). Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Demonstrate the two `core-run-controls` capabilities — **external `AbortSignal` cancellation** and **token usage reading** — in a runnable example for **both providers**, by extending the existing per-provider example files:

- `examples/basic-run.ts` (Anthropic provider)
- `examples/openai-run.ts` (OpenAI provider)

Each gains a new **"Turn 5: run controls (token usage + external AbortSignal)"** section that:
1. Reads and prints **cumulative token usage** from the terminal event / `Terminal` return value after a normal run (and per-turn usage from `turn_complete` when present).
2. Demonstrates **external cancellation**: start a run with `run(prompt, { signal })`, abort it mid-stream via an `AbortController` (or a timeout), and show it ends as `agent_error` carrying **partial accumulated usage** (not a crash).

This task is the feature's user-facing proof: after it lands, a developer can copy-paste the pattern to budget tokens and cancel runs. It is the LAST task — it depends on all of tasks 01–06 being implemented (the `usage` field and `RunOptions.signal` must exist).

## Context files

- `examples/basic-run.ts` — current Anthropic example; has Turns 1–4 (the last is the agent-tooling demo). Append Turn 5 before the `collectText` demo, mirroring the existing event-switch style.
- `examples/openai-run.ts` — current OpenAI example; same structure. **SECRET-HANDLING NOTE:** the working-tree copy may contain the user's local hardcoded Azure creds (apiKey / baseURL / model). Edit only the example *body* (imports + the new Turn 5 block). The **committed** version must use the env-var form (`process.env["OPENAI_API_KEY"]` / `process.env["OPENAI_BASE_URL"]` / a public model id like `"gpt-4o-mini"`) — never commit a hardcoded key. The orchestrator handles preserving local creds vs. committing the sanitized version (as was done for the agent-tooling example commit).
- `docs/feature/core-run-controls/engineering/2026-06-30-core-run-controls-engineering.md` — §3.1 (cancellation + usage-reading consumer flows), §3.2 (which events carry `usage`), §7 (the `Usage` type shape: `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens? }`).
- `packages/core/src/index.ts` — confirm the public exports available to the example after task-01/06: `Usage` (type), `EMPTY_USAGE`, `mergeUsage`, `accumulateUsage`, plus the existing `Agent`, tools, `type Message`, etc. The example needs the `Usage` type only if it annotates a variable; otherwise usage is read structurally off events.
- `packages/core/src/types/events.ts` (post-feature) — `agent_done`/`max_turns_exceeded`/`agent_error` carry `usage: Usage`; `turn_complete` carries `usage?: Usage`; `Terminal` variants carry `usage: Usage`.
- `packages/core/src/agent.ts` (post-feature) — `RunOptions` has `signal?: AbortSignal`.

## Downstream dependencies

None — this is the final task. It depends on tasks 01–06 (the `usage` field, `RunOptions.signal`, and both providers' usage capture must all be implemented, or the example will not compile/run).

## Steps

1. **Update imports in both files.** If you annotate a `Usage` variable, add `type Usage` to the `tiny-agentic` import; otherwise read usage structurally and no new import is needed. Keep the existing imports.

2. **Add a small usage-printing helper** (inline, near the top of each file, or duplicated — these are standalone scripts):
   ```ts
   function formatUsage(u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens?: number }): string {
     const cw = u.cacheWriteTokens !== undefined ? `, cacheWrite=${u.cacheWriteTokens}` : "";
     return `in=${u.inputTokens} out=${u.outputTokens} cacheRead=${u.cacheReadTokens}${cw}`;
   }
   ```

3. **Add "Turn 5a: token usage".** Run a simple prompt; in the event loop, print per-turn usage from `turn_complete` (when `event.usage` is present) and the cumulative total from the terminal event:
   ```ts
   console.log("\n=== Turn 5a: token usage ===");
   for await (const event of agent.run("In one sentence, what is an AbortSignal?")) {
     switch (event.type) {
       case "text_delta": process.stdout.write(event.text); break;
       case "turn_complete":
         if (event.usage) console.log(`\n[turn ${event.turnIndex} usage: ${formatUsage(event.usage)}]`);
         break;
       case "agent_done":
         console.log(`\n[done — cumulative usage: ${formatUsage(event.usage)}]`);
         break;
       case "agent_error": console.error("\n[agent error]", event.error.message); break;
       case "max_turns_exceeded": console.error("\n[max turns]"); break;
     }
   }
   ```

4. **Add "Turn 5b: external cancellation".** Use an `AbortController`; abort it mid-stream (e.g. after the first `text_delta`) and show the run ends as `agent_error` with partial usage. Keep it deterministic:
   ```ts
   console.log("\n=== Turn 5b: external AbortSignal (cancel mid-run) ===");
   const controller = new AbortController();
   let aborted = false;
   for await (const event of agent.run(
     "Write a detailed 5-paragraph essay about distributed systems.",
     { signal: controller.signal },
   )) {
     switch (event.type) {
       case "text_delta":
         process.stdout.write(event.text);
         if (!aborted) { aborted = true; controller.abort(); } // cancel as soon as output starts
         break;
       case "agent_error":
         console.log(`\n[run cancelled as expected → agent_error: ${event.error.message}]`);
         console.log(`[partial usage at cancel: ${formatUsage(event.usage)}]`);
         break;
       case "agent_done":
         console.log(`\n[completed before abort took effect — usage: ${formatUsage(event.usage)}]`);
         break;
     }
   }
   ```
   - Also acceptable / encouraged: add a one-liner showing the timeout form in a comment or a short second demo — `agent.run(prompt, { signal: AbortSignal.timeout(2000) })` — to document the timeout use case. (OpenAI note: on an aborted run the final usage chunk may not arrive, so `usage` may be `EMPTY_USAGE` / zeros at cancel — that is expected and the example comment should say so.)

5. **Place both sub-sections after the existing Turn 4 block and before the `collectText` demo** in each file, so the final summary line stays last.

6. **Typecheck both examples** against the built package (examples have no own tsconfig; verify with a standalone `tsc`):
   ```
   # build core first so dist types include the new usage/signal API
   pnpm -r build
   # then typecheck the two example files against the workspace
   ```
   Use the same standalone-`tsc` approach the orchestrator used previously (a temp tsconfig in `examples/` with `module/moduleResolution: nodenext`, `lib: ["ES2022"]`, `types: ["node"]`, `skipLibCheck: true`, `typeRoots` pointing at the core's `node_modules/@types`). Both files must typecheck with zero errors. Remove the temp tsconfig after.

7. **Do NOT require a live API run in CI.** These examples need real API keys; they are run manually. The acceptance bar is: they typecheck against the real exported API and are structurally correct.

## Acceptance criteria

- [ ] `examples/basic-run.ts` (Anthropic) has a "Turn 5" section demonstrating (a) reading cumulative `usage` from the `agent_done` terminal event and per-turn usage from `turn_complete`, and (b) external cancellation via `run(prompt, { signal })` with an `AbortController`, surfacing `agent_error` + partial `usage`.
- [ ] `examples/openai-run.ts` (OpenAI) has the equivalent "Turn 5" section.
- [ ] Both examples reference the real public API: `run(prompt, { signal })`, `event.usage` on `agent_done`/`agent_error`, and `turn_complete.usage`.
- [ ] Both example files typecheck against the built package with zero errors (verified via standalone `tsc`).
- [ ] The committed `examples/openai-run.ts` uses env-var credentials (`process.env[...]`) and a public model id — no hardcoded secret in the committed version.
- [ ] The existing Turns 1–4 in both files are unchanged (only additive).
- [ ] The OpenAI example comments note that `usage` may be zeros/`EMPTY_USAGE` on an aborted run (final usage chunk may not arrive).

## Output files

- Modified: `examples/basic-run.ts`
- Modified: `examples/openai-run.ts`

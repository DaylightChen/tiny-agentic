# Task 05 — Real-provider smoke example + documented limitations

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Close the feature with the two things the mocks cannot provide: a **real-provider smoke run** and the **documented limitations**. First, extend one of the `examples/*-run.ts` files with a `task`-tool delegation that hands a trivial sub-task to a **second model id** (ideally a cheaper one), wiring a real `resolveChild` that constructs a child `Agent` bound to that model, printing the `subagent_event`s as they arrive and the rolled-up `usage` at the end. This is the project's established "real-API smoke" practice (decision 2026-06-29) — it catches provider surprises the `MockProvider` cannot (real usage-field shapes, a live second model, actual sanitization of real transcripts). It is **not a CI gate** (requires an API key), matching how `examples/basic-run.ts` and `examples/openai-run.ts` already work.

Second, record the feature's intentional deferrals/limitations in `docs/project/known-issues.md`: the accepted **R5 cross-provider usage-fidelity** limitation (the rolled-up parent total sums tokens across providers whose semantics differ), the **R6 sequential-only** posture (no parallel sub-agents in v1), and the **deferred numeric depth guard** (E2/R2 — structural bound only) with the recorded design candidate so a later revision has the pointer.

At the end, a human with an API key can run the example and watch a real sub-agent delegation with usage roll-up, and the three deferred design points are logged where the project keeps known issues.

## Context files

- `docs/feature/task-tool/engineering/2026-07-01-task-tool-engineering.md` — binding spec. Focus on: **Test plan → Smoke (manual, non-CI)** (the exact intent: "extend an `examples/*-run.ts` with a `task` call that delegates a trivial sub-task to a second model id, printing `subagent_event`s and the rolled-up `usage`"), **Risks R5 and R6**, and **Edge cases E2 / Risks R2** (deferred depth guard + the candidate design).
- `docs/feature/task-tool/plan/implementation-plan.md` — the "Explicit deferrals" section (the exact set of items to log) and the R5/R6 coverage rows.
- `examples/basic-run.ts` — the Anthropic example; its structure (provider construction, `Agent` setup, the `for await` switch over `AgentEvent`, `formatUsage`). Read it fully — you will mirror its shape for the `task` demo. Note the model-id guidance comment (use a currently-valid id; a cheap id like `claude-haiku-4-5` is fine for a throwaway example).
- `examples/openai-run.ts` — the OpenAI example (currently modified per git status). Either example is a valid host for the smoke; pick the one whose provider you can most reliably construct a **second child model** on. If the parent is Anthropic, the child can be a second Anthropic model id (simplest); a cross-provider child (Anthropic parent, OpenAI child) is a stronger smoke but needs both keys — make it opt-in on env presence.
- `examples/README.md` — how examples are documented/run; add a line for the new smoke if the README enumerates examples.
- `packages/core/src/index.ts` — **as committed after task-03.** Confirm `createTaskTool`, `CreateTaskToolOptions`, `ChildSpec`, and `SubagentChildEvent` are exported from `tiny-agentic` (the example imports them from the package entry, not source paths).
- `packages/core/src/agent.ts` — `Agent`/`AgentOptions` — the child is a `new Agent({...})` bound to the child model's provider, with a tool set that **omits `task`** (the structural recursion bound the host must honor).
- `docs/project/known-issues.md` — the target for the limitation entries. **Read it first** to match its existing entry format (heading style, fields). If the file does not exist, create it with a short header consistent with the project's other `docs/project/*.md` docs and the `CLAUDE.md` convention ("Log known issues in `docs/project/known-issues.md` when deferring bugs or workarounds").

## Downstream dependencies

- None. This is the terminal task. The example is a manual smoke, not imported by anything; the known-issues entries are documentation. Keep the example self-contained and guarded on API-key presence so it never breaks CI or a keyless checkout.

## Steps

1. **Choose the host example and the child model.** Prefer extending `examples/basic-run.ts` (Anthropic) with an added section, or create a small dedicated `examples/task-run.ts` if bolting onto an existing flow would muddy it — a dedicated file is cleaner and keeps the existing examples' assertions intact. **Recommendation:** create `examples/task-run.ts` modeled on `basic-run.ts`, so the smoke is a single focused script. Record the choice in the log. Parent model: a valid Anthropic id (e.g. `claude-opus-4-8` or a cheaper `claude-haiku-4-5`). Child model: a **different** valid id (e.g. parent `claude-opus-4-8`, child `claude-haiku-4-5`) to exercise per-task model selection.

2. **Build a real `resolveChild`.** In the example, write a `resolveChild` that:
   - reads the `spec.model` / `spec.provider` / `spec.subagentType` hints (opaque strings) and applies a simple fallback: `spec.model ?? DEFAULT_CHILD_MODEL`;
   - constructs a child provider bound to the resolved model (`new AnthropicProvider({ apiKey, model: resolvedModel, ... })`), optionally switching provider class if `spec.provider === "openai"` and an `OPENAI_API_KEY` is present (make the cross-provider branch opt-in on env, else throw a clean `Error("unknown provider '<x>'")` to demonstrate the config-error path);
   - returns `new Agent({ provider: childProvider, tools: [/* child tools, NO task tool */], platform: new NodePlatform(), maxTurns: 4, systemPrompt: "You are a focused sub-agent. Do the task and report a short summary." })`;
   - passes `spec.signal` through implicitly (the child `Agent` receives it via `child.run(prompt, { signal })` inside the tool — the host does not re-plumb it; `resolveChild` only builds the `Agent`).

   **Critically, the child's `tools` array must NOT include the `task` tool** — this is the structural recursion bound (E1). Add an inline comment saying so.

3. **Register `createTaskTool` on the parent.** `const taskTool = createTaskTool({ resolveChild });` then include `taskTool` in the parent `Agent`'s `tools`. Give the parent a prompt that induces delegation, e.g. *"Use the task tool to delegate this to a sub-agent: 'List three primary colors, one per line.' Then report what it returned."*

4. **Print `subagent_event`s and rolled-up usage.** In the parent's `for await` switch, add a `case "subagent_event":` arm that logs the child lifecycle legibly, tagged by `taskId`, e.g.:

   ```ts
   case "subagent_event": {
     const c = event.event;
     if (c.type === "text_delta") process.stdout.write(`  [child ${event.taskId}] ${c.text}`);
     else if (c.type === "tool_use_start") console.log(`  [child ${event.taskId}] tool: ${c.toolName}`);
     else if (c.type === "tool_result") console.log(`  [child ${event.taskId}] tool_result (${c.toolName}, isError=${c.isError})`);
     else if (c.type === "terminal") console.log(`  [child ${event.taskId}] terminal: ${c.reason} usage=${formatUsage(c.usage)}`);
     break;
   }
   ```

   Reuse `formatUsage` from `basic-run.ts` (copy it into the new file). After the run terminates, print the parent's terminal `usage` (which now **includes** the child's tokens) so the roll-up is visible: `console.log("rolled-up usage:", formatUsage(terminal.usage))`. Capture the terminal via the `for await` terminal event (`agent_done`) or by reading the generator's return.

5. **Guard on API-key presence.** Mirror `basic-run.ts`: exit early with a clear message if `ANTHROPIC_API_KEY` is unset. If the cross-provider child branch is included, gate it on `OPENAI_API_KEY` and fall back to a same-provider child otherwise (or document that `provider: "openai"` demonstrates the config-error path when the key is absent — either is a valid smoke, just make the behavior explicit in a comment and the console output).

6. **Document the example.** If `examples/README.md` enumerates the examples, add a one-line entry for the task smoke with its run command (`ANTHROPIC_API_KEY=<key> pnpm tsx examples/task-run.ts`). Add a top-of-file doc comment matching `basic-run.ts`'s style (what it exercises, that it is not run in CI, the run command).

7. **Log the limitations in `docs/project/known-issues.md`.** Read the file's existing format first, then add entries (or a single "Sub-agent / `task` tool (v1)" section) covering:
   - **R5 — cross-provider usage fidelity.** The rolled-up parent `Terminal.usage` sums token counts across providers whose semantics differ (an Anthropic cache-read token ≠ an OpenAI one; a child on OpenAI has no `cacheWriteTokens`). The **total** mixes semantics; **per-child fidelity is preserved** on each `subagent_event`(terminal)'s `usage`. Workaround: a consumer needing per-provider breakdown reads the child terminals, not just the parent total. No code change planned.
   - **R6 — sequential-only sub-agents.** v1 runs `task` calls one at a time (matches `runTools`); no parallel/background sub-agents. The tool description tells the model so. Future path: the `isConcurrencySafe` seam (`packages/core/src/types/tool.ts`).
   - **E2 / R2 — numeric depth guard deferred.** v1 bounds recursion **structurally only** (`resolveChild` must omit the `task` tool from children; a correct host cannot spawn beyond depth 1). There is no numeric `depth`/`maxDepth`. A host that *deliberately* wires a child with `task` re-included is not guarded by a second counter in v1. Deferred-design candidate (recorded for a later revision): seed `context.depth` inside the loop and have `createTaskTool` read it to enforce a cap — but that needs the child loop to receive a starting depth, which requires crossing the closed `Agent.run(prompt, { messages?, signal? })` boundary that v1 intentionally avoids.

8. **Typecheck the example.** The example is TypeScript run via `tsx`; ensure it type-checks against the built/exported `tiny-agentic` surface. Run `pnpm -C packages/core typecheck` (unchanged — no core edits here) and, if the repo type-checks examples, the root `pnpm typecheck`. Do **not** run the example in CI. Optionally, if an API key is available in the working environment, do one manual run and paste the observed output into the task log (not required for the gate).

## Acceptance criteria

- [ ] `examples/task-run.ts` (or the extended existing example) exists, imports `createTaskTool` (and `ChildSpec`/`CreateTaskToolOptions` as needed) from `tiny-agentic`, builds a real `resolveChild` that constructs a child `Agent` on a **different model id** than the parent, and whose child tool set **omits** the `task` tool (commented as the recursion bound).
- [ ] The example's parent `for await` handles `case "subagent_event":` and prints child `text_delta`/`tool_use_start`/`tool_result`/`terminal` tagged by `taskId`, and prints the rolled-up parent `usage` at the end.
- [ ] The example guards on `ANTHROPIC_API_KEY` (exits cleanly if unset) and never runs in CI.
- [ ] `docs/project/known-issues.md` contains entries for R5 (cross-provider usage fidelity), R6 (sequential-only), and E2/R2 (deferred numeric depth guard + the recorded candidate), each with a workaround/rationale.
- [ ] `pnpm -C packages/core typecheck` reports zero errors (this task adds no core code; the check confirms the example does not depend on an unexported symbol). If the root config type-checks `examples/`, `pnpm typecheck` also passes.
- [ ] No core `packages/core/src/**` production file is modified by this task (example + docs only). `examples/README.md` may gain a one-line entry.

## Output files

- Created: `examples/task-run.ts` (or Modified: `examples/basic-run.ts` / `examples/openai-run.ts` if extending in place — record the choice)
- Modified or Created: `docs/project/known-issues.md` (R5, R6, E2/R2 entries)
- Modified (optional): `examples/README.md` (one-line entry for the new smoke)

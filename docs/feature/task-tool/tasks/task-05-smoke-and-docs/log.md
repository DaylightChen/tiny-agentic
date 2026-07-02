# Execution Log — Task 05: smoke-and-docs

## Iteration 1

### Implement
- **Files created:**
  - `examples/task-run.ts` — dedicated real-provider `task`-tool smoke (chosen over bolting onto `basic-run.ts` to keep the smoke a single focused script, per the brief's recommendation). Parent `claude-opus-4-8` → child `claude-haiku-4-5` (different model id). Real `resolveChild` maps opaque `model`/`provider` hints with a simple fallback (`spec.model ?? DEFAULT_CHILD_MODEL`), builds a child `Agent` whose tool set **omits `task`** (structural recursion bound, commented), supports an opt-in cross-provider OpenAI child gated on `OPENAI_API_KEY` (else throws `Error("unknown provider 'openai' ...")` to demonstrate the config-error path). Parent `for await` has a `case "subagent_event":` arm printing child `text_delta`/`tool_use_start`/`tool_result`/`terminal` tagged by `taskId`, and prints rolled-up parent `usage` on `agent_done`. Guards on `ANTHROPIC_API_KEY`.
- **Files modified:**
  - `docs/project/known-issues.md` — added three entries: R5 cross-provider usage fidelity, R6 sequential-only sub-agents, E2/R2 deferred numeric depth guard (with the recorded design candidate).
  - `examples/README.md` — added a `task-run.ts` section with run command.
- **Decisions not in plan:** created a dedicated `examples/task-run.ts` rather than extending `basic-run.ts`/`openai-run.ts` (brief-recommended); rebuilt `packages/core/dist` (via `tsup`) so the example resolves the newly-exported `createTaskTool`/`ChildSpec` from the built package (dist is gitignored, not committed).
- **Deviations from plan:** none. No `packages/core/src/**` production file modified.
- **Issues encountered:** `pnpm` not on PATH — used local binaries; typechecked the example standalone with `tsc --noEmit --skipLibCheck --module nodenext --moduleResolution nodenext --strict --typeRoots packages/core/node_modules/@types --types node examples/task-run.ts`.

### Test
- **Typecheck output:**
  ```
  $ tsc --noEmit ... examples/task-run.ts   (against built tiny-agentic dist)
  EXIT=0
  $ packages/core/node_modules/.bin/tsc -p packages/core/tsconfig.json --noEmit
  CORE_TYPECHECK_OK
  $ packages/core/node_modules/.bin/vitest run
  Tests  314 passed (314)
  ```
  (Example is a manual, non-CI smoke — requires an API key to run; no live run performed here.)

### Review
- **Verdict:** Self-reviewed (example + docs task). Acceptance criteria met; no core code changed; example typechecks against the exported surface; known-issues entries cover R5/R6/E2-R2 with workarounds. The unrelated pre-existing `examples/openai-run.ts` working-tree change (hardcoded credential) was excluded from this commit.

---

## Completion

- **Commit:** pending
- **Iterations:** 1
- **Verification evidence:**
  ```
  $ tsc --noEmit examples/task-run.ts (against built package)  → exit 0
  $ packages/core/node_modules/.bin/vitest run                 → 314 passed
  ```
- **Acceptance criteria:**
  - [x] `examples/task-run.ts` imports `createTaskTool`/`ChildSpec` from `tiny-agentic`, builds a real `resolveChild` on a different child model id, child tool set omits `task` (commented) — verified.
  - [x] Parent `for await` handles `subagent_event` (prints child lifecycle tagged by `taskId`) and prints rolled-up parent `usage` — verified.
  - [x] Guards on `ANTHROPIC_API_KEY`; never runs in CI — verified.
  - [x] `docs/project/known-issues.md` has R5, R6, E2/R2 entries with workarounds — verified.
  - [x] `pnpm -C packages/core typecheck` equivalent zero errors; example typechecks against exported surface — verified.
  - [x] No `packages/core/src/**` production file modified — verified by `git status`; `examples/README.md` gained a one-line section.
- **Regressions:** none (314 tests still pass).
- **Deviations from plan:** dedicated example file (recommended); dist rebuilt for local typecheck (gitignored).

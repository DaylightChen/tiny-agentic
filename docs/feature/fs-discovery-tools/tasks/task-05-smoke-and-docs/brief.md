# Task 05 — Smoke run + docs / known-issues

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Prove the whole feature works end-to-end against a real provider and record the accepted limitations. Add an `examples/` script in which an `Agent` configured with **only** `lsTool`/`globTool`/`grepTool` (no `bashTool`) performs a discovery loop over `packages/core/src` — demonstrating the roadmap's headline: structured discovery remains fully usable when the shell is denied. Then update the docs: add known-issues entries for the accepted pure-JS-grep performance trade-off (R3) and the deferred `multiline` grep / ripgrep-style `type` filter (§4). This task touches **no production tool logic**; it is a non-CI smoke check (matches the task-tool scope's task-05 practice).

## Context files

- `docs/feature/fs-discovery-tools/engineering/2026-07-10-fs-discovery-engineering.md` — **§10** (success criteria — the smoke targets the functional "no-`bash` discovery loop" + "sub-second grep" bullets), **§9 R3** (perf trade-off), **§4** (deferred `multiline`/`type`).
- `examples/basic-run.ts` and `examples/task-run.ts` — existing example scripts to mirror (Agent construction, provider/platform wiring, how they run and print).
- `examples/README.md`, `examples/package.json` — how examples are registered/run.
- `docs/project/known-issues.md` — the file to append entries to.
- `packages/core/src/index.ts` — confirm `lsTool`/`globTool`/`grepTool` are exported (from task-03/04).

## Downstream dependencies

- None — this is the closing task.

## Steps

1. **Smoke example** — add `examples/fs-discovery-run.ts` (mirror `basic-run.ts`): construct an `Agent` with `NodePlatform`, a real provider, and `tools: [lsTool, globTool, grepTool]` (**no** `bashTool`). Give it a prompt that forces a discovery loop, e.g. *"Find every file under packages/core/src that defines a Platform method, then list the directory it lives in."* Optionally attach an `approvalHandler` that would `deny` `bash` to make the point explicit (there is no `bash` tool, so it proves discovery works without shell). Print the streamed events / final result. Register it in `examples/README.md` (+ `package.json` script if the others have one).
2. **Timing note** — in the script or its output, surface that a `grep` over `packages/core/src` completes well under the tool timeout (§10 non-functional: sub-second target). A simple `console.time`/`console.timeEnd` around one grep call suffices.
3. **known-issues entries** — append to `docs/project/known-issues.md`:
   - **Pure-JS `grep`/`glob` performance on very large repos (R3):** accepted trade-off vs. ripgrep; mitigated by nested-`.gitignore` pruning + 250 cap + first-match short-circuit; future path is a NodePlatform-internal ripgrep optimization behind the unchanged `Platform.grep` seam.
   - **Deferred grep features:** `multiline` regex and ripgrep-style `type` filter are out of v1 scope; the schema/seam can accommodate them later without a contract break.
4. **Full verification** — run the whole suite once more to confirm nothing regressed across tasks 01-04.

## Acceptance criteria

- [ ] `examples/fs-discovery-run.ts` exists, constructs an `Agent` with only `ls`/`glob`/`grep` (no `bash`), and runs a discovery loop; registered in `examples/README.md`.
- [ ] Running the example against a real provider (manual, non-CI) completes the loop and prints a sensible result; the `grep` over `packages/core/src` prints a sub-second timing.
- [ ] `docs/project/known-issues.md` contains the R3 perf entry and the deferred-`multiline`/`type` entry.
- [ ] `pnpm --filter @tiny-agentic/core test`, `pnpm -r typecheck`, and `pnpm -r lint` all pass (final green across the feature).
- [ ] No production tool/platform file is modified by this task (diff limited to `examples/*` and docs).

## Output files

- Created: `examples/fs-discovery-run.ts`.
- Modified: `examples/README.md` (+ `examples/package.json` if scripts are listed there), `docs/project/known-issues.md`.

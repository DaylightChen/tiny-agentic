# Task 08 — Documentation, examples, metadata, and Node 22 release readiness

> Written in the plan phase. Immutable during implement-phase execution.

## Goal

Align all living documentation, examples, source comments, and package metadata with the runtime that tasks 01–07 actually shipped, then run the complete release-readiness gate on Node 22. Add the missing root `typecheck:examples` script using the existing `examples/tsconfig.json`; make all example terminal handling display `stopReason.kind` and raw fallback for `other`; update the README/export/event/tool/Platform/cancellation/concurrency contracts; mark roadmap/known-issue capability state accurately; add `0.2.0 — Unreleased`; and set the core package version to `0.2.0`.

This task authorizes metadata preparation only. It must not run npm publish, create a Git tag, push a release, invoke `gh release`, or date the unreleased changelog heading. Documentation must report actual final API and observed test results, not the 403-test baseline as a promised frozen count.

## Context files

- Engineering spec §§7.4, 9.1, 9.2; DR-1–DR-5.
- `packages/core/README.md` — stale main documentation inventory.
- `docs/project/core-roadmap.md`, `docs/project/known-issues.md`, `docs/project/STATUS.md`, `docs/project/core-package-status.md` — living vs historical distinction. Do not rewrite `core-package-status.md`. In `STATUS.md`, leave Active Scope/Current Phase/task workflow fields to the orchestrator; only update stale shipped capability/test narrative if needed.
- `CHANGELOG.md`, `packages/core/package.json`, `pnpm-lock.yaml`, root `package.json`.
- Existing `examples/tsconfig.json` — use it; do not recreate/replace it.
- `examples/basic-run.ts`, `openai-run.ts`, `fs-discovery-run.ts`, `task-run.ts`, `subagent-registry.ts`.
- Source comments: `types/provider.ts`, `types/tool.ts`, `loop/runTools.ts`, `loop/loop.ts`, `platform/node.ts`, `platform/fs-discovery.ts`, `providers/retry.ts`; discovery tests with stale cwd comments.
- `.github/workflows/ci.yml` and `.node-version` — Node 22 environment evidence; do not broaden CI scope unless needed to run the new examples gate.
- `scripts/check-core-boundaries.mjs` — post-build gate.

## Downstream dependencies

- None; this is the final task.
- Changelog migration bullets must match actual required contracts: ProviderEvent/AgentEvent/Terminal stop reasons and Platform path methods/ordering.
- Concurrent Task remains explicitly future work; do not imply all tools run concurrently.
- Cancellation wording is exact: no new work after observed abort, active calls receive the signal, read/list syscalls may finish.

## Steps

Role separation: implementer owns docs/examples/config/metadata/comment edits and does not run tests. Tester runs all gates and may add only narrow metadata assertions if the existing suite has a suitable convention.

1. **Add examples gate** — in root `package.json`, add exactly `"typecheck:examples": "tsc -p examples/tsconfig.json"`. Do not edit/recreate `examples/tsconfig.json` unless final API errors reveal a genuine existing-config issue; resolving code errors is preferred.
2. **Update every example** — display final `agent_done.stopReason.kind`; when kind is `other`, include `raw` (`null` or exact string). Display child successful terminal stop reason similarly. Keep switches exhaustive where practical, including `reasoning_delta`/`subagent_event` arms; do not expose stop reason on error/max-turn variants.
3. **Rewrite core README to final surface (DR-1)** — complete main-entry exports and all subpaths; Agent options (`approvalHandler`) and run options (`signal`, internal-only depth wording); all events including reasoning/subagent/usage/stop reasons; non-empty `ToolCallContext`; active purity/throw marker contract; all eight built-ins and Task factory; complete Platform methods/types/path/order contract; approval, usage, cancellation limits, safe maximal batches/barriers, and sequential Task. Remove stale “no approvals/subagents/all sequential” claims.
4. **Update living project docs** — roadmap marks Task, discovery, reasoning, portability hardening, typed stop reasons, and safe filesystem batching shipped; keeps concurrent Task future. Known issues clarifies filesystem-safe calls now batch while Task remains separate due child event/usage/cancellation concerns; retain pure-JS discovery limitation. `docs/project/STATUS.md`: if edited, change only stale capability/test-count narrative and preserve orchestrator-owned scope/phase/task state verbatim. Do not modify historical `core-package-status.md`.
5. **Correct stale source/test comments** — make every comment listed in engineering §9.1 accurate, including both Node platform modules and OpenAI retry already shipped. Comments must not contradict the implementation.
6. **Prepare changelog and version (DR-3)** — add `## [0.2.0] — Unreleased` with `Added`, `Changed`, `Fixed`, `Breaking changes`. Cover accumulated Task/discovery/reasoning since 0.1.0, typed stop reasons, portable main graph, safe batching, docs, and explicit provider/event/terminal/Platform migration bullets. Preserve the historical 0.1.0 entry unchanged. Set `packages/core/package.json` version to `0.2.0`. Do not add dependencies. `pnpm-lock.yaml` changes only if pnpm records version metadata (current workspace lock is expected not to).
7. **No release side effects (DR-4)** — task commands are limited to verification. Do not run publish/tag/push/`gh release`; changelog remains Unreleased with no date/link requiring a release tag.
8. **Tester: provisional local gate** — if still on Node 20, commands may be run to catch code/doc/example errors, but record the engine warning and do not mark task complete.
9. **Tester: mandatory Node 22 final gate (DR-5)** — switch to/use Node 22 and record `node --version`. Run exactly from repository root:
   - `pnpm test`
   - `pnpm typecheck`
   - `pnpm lint`
   - `pnpm build`
   - `pnpm typecheck:examples`
   - after build, `node scripts/check-core-boundaries.mjs`
   Report expanded actual test count; do not require exactly 403.
10. **Optional non-CI smoke only** — deterministic tests are authoritative. If credentials/environment permit, run no-publish examples or scheduler timing smoke and record results; absence is not a phase blocker.

## Acceptance criteria

- [ ] DR-1: README accurately lists complete exports/events/tools/Platform/approvals/cancellation/usage/Task/reasoning/concurrency behavior.
- [ ] DR-2: all five examples typecheck and expose successful stop `kind` plus `other.raw`; root `pnpm typecheck:examples` uses existing `examples/tsconfig.json`.
- [ ] DR-3: package version is `0.2.0`; changelog heading is exactly unreleased and identifies breaking migrations; historical 0.1.0 is unchanged.
- [ ] DR-4: diff/history/log contains no release action and no release date/tag creation.
- [ ] DR-5: on Node 22, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm typecheck:examples`, and post-build portability boundary test all pass.
- [ ] Docs state concurrent Task calls remain out of scope and explain why; no general “all tools sequential” claim remains.
- [ ] Docs accurately state cancellation limitations and no concurrency cap.
- [ ] `docs/project/core-package-status.md` is unchanged.
- [ ] `docs/project/STATUS.md` workflow fields and the feature scope JSON are unchanged by this task.

## Output files

**Implementer-owned docs/config/metadata/examples/comments:**
- Modified: `package.json`
- Modified: `packages/core/package.json`
- Modified if tooling records metadata only: `pnpm-lock.yaml`
- Modified: `CHANGELOG.md`
- Modified: `packages/core/README.md`
- Modified: `docs/project/core-roadmap.md`
- Modified: `docs/project/known-issues.md`
- Modified only for shipped-capability narrative, preserving workflow fields: `docs/project/STATUS.md`
- Modified: `examples/basic-run.ts`
- Modified: `examples/openai-run.ts`
- Modified: `examples/fs-discovery-run.ts`
- Modified: `examples/task-run.ts`
- Modified: `examples/subagent-registry.ts`
- Modified comments only: `packages/core/src/types/provider.ts`, `types/tool.ts`, `loop/runTools.ts`, `loop/loop.ts`, `platform/node.ts`, `platform/fs-discovery.ts`, `providers/retry.ts`, and affected discovery test comments

**Explicitly unchanged:**
- `examples/tsconfig.json`
- `docs/project/core-package-status.md`
- `docs/.phased-dev/scopes/feature/core-runtime-hardening.json`

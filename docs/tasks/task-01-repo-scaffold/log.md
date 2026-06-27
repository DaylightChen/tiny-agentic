# Execution Log — Task 01: Repo Scaffold (scope: project)

> Dev-loop execution log. Structured by iteration. Evidence (real command output) is captured inline.

## Iteration 1

### Implement
- **Files created:** Root config — `pnpm-workspace.yaml`, `.node-version`, `.nvmrc`, `.npmrc`, `package.json`, `tsconfig.base.json`, `eslint.config.js`. `packages/core/` — `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `src/index.ts`, and the three `export {}` entry stubs `src/providers/anthropic.ts`, `src/platform/node.ts`, `src/utils/collect.ts`. `packages/sdk/` & `packages/ui/` — `package.json`, `tsconfig.json`, `src/index.ts` each. `examples/` — `package.json`, `.gitkeep`.
- **Files modified:** none (all new).
- **Decisions not in plan:** Added `"pnpm": { "onlyBuiltDependencies": ["esbuild"] }` to the root `package.json`. pnpm ≥9/10 blocks dependency postinstall scripts by default; without allowlisting esbuild's native-binary installer, tsup cannot run. Minimal, explicit allowlist of only esbuild — a toolchain-compatibility fix the brief's step 1 anticipates.
- **Deviations from plan:** none — all file contents match the brief/code-architecture verbatim.
- **Issues encountered:** esbuild native binary was blocked on first `pnpm install` (pnpm 10 default); resolved via the `onlyBuiltDependencies` allowlist above, after which install + build succeed.
- **Verification command output (implementer):**
  - `pnpm install` → exit 0, 262 packages resolved, esbuild binary installed.
  - `pnpm -r typecheck` → exit 0 (core, sdk, ui all "Done").
  - `pnpm lint` → exit 0 (no violations at stub stage).
  - `pnpm --filter tiny-agentic build` → exit 0; all four entry points emit JS + d.ts:
    ```
    ESM dist/index.js / platform/node.js / providers/anthropic.js / utils/collect.js
    DTS dist/index.d.ts / platform/node.d.ts / providers/anthropic.d.ts / utils/collect.d.ts
    ```

### Test
- **New tests written:** none — task 01 is scaffolding only; first `*.test.ts` arrives in task 03. Verification is by acceptance-criteria commands.
- **Failures:** none. All 13 acceptance criteria PASS.
- **Full suite output (key commands):**
  ```
  $ pnpm install            → exit 0 (5 workspace projects; pnpm v10.30.2)
  $ pnpm -r typecheck       → exit 0 — core, sdk, ui all "Done" (examples has no script, skipped)
  $ pnpm lint               → exit 0 — no warnings (eslint packages/*/src --max-warnings 0)
  $ pnpm --filter tiny-agentic build → exit 0 — 4 entries emit .js + .d.ts (+ .js.map); 12 files in dist/
  ```
  Structural checks: `ls packages/` = `core sdk ui`; package names correct; `workspace:*` deps present in sdk/ui/examples; `.npmrc` has `shamefully-hoist=false`; three core entry stubs exist.
- **Environment notes:** active Node is v20.18.1 (pins say 18.20.8); `engines: >=18` is satisfied, all commands pass — pins are informational for nvm/volta. tsup v8.5.1, vitest v3.2.6.
- **Latent risk (not a task-01 failure):** `pnpm -r test` (and root `pnpm test`) exits 1 with "No test files found" because `vitest run` treats zero tests as a hard error. Not in task-01 acceptance criteria; self-resolves when task 03 adds `collect.test.ts`. **Open question for reviewer:** pre-empt by setting `passWithNoTests: true` in `packages/core/vitest.config.ts` now, or leave it. Submodule/`.gitmodules` untouched; no stray files (`pnpm-lock.yaml`, `node_modules/`, `log.md` expected).

### Review
- **Verdict:** Approved (no blocking issues).
- **Criteria check:** all 13 acceptance criteria pass. All Output-files present.
- **Architecture/boundary:** root `eslint.config.js` matches spec — core block restricts `tiny-agentic-sdk`/`-ui`, `fs`/`node:fs`/`fs/promises`/`child_process`, UI patterns (`react`/`ink`/`chalk`/`ora`), and `process` global; `platform/node.ts` correctly exempted. One-way deps structurally correct (core has no workspace deps; sdk→core; ui→sdk). `node:util`/`node:path` not restricted — acceptable, spec only mandates fs/child_process/UI; not used in planned core modules.
- **Forward-compat:** tasks 02/03/06/09/10 all build cleanly on this scaffold — tsconfig strict flags + 4-entry exports map exact; entry stubs valid; examples workspace+dep wired for task 10.
- **Code/test quality:** clean, minimal, no YAGNI. No tests (correct for a scaffold).
- **Ruling 1 — `onlyBuiltDependencies: ["esbuild"]`:** approved as correct & minimal (pnpm 10 blocks postinstall scripts by default; esbuild needs its native binary for tsup). Necessary deviation; noted in completion.
- **Ruling 2 — `passWithNoTests`:** recommend adding `passWithNoTests: true` to `packages/core/vitest.config.ts` now. Non-blocking for task 01, but prevents `pnpm -r test` exiting 1 across tasks 02–03; idiomatic Vitest for an incrementally-populated suite.
- **Issues to fix:** #1 (non-blocking) add `passWithNoTests: true` before task 02.

### Post-review follow-up (orchestrator-applied)
- Applied reviewer issue #1 directly (one-line, reviewer-dictated config change): added `passWithNoTests: true` to `packages/core/vitest.config.ts`. Re-verified below.

---

## Completion

- **Iterations:** 1 (implement → test → review, all green; one orchestrator-applied follow-up config line).
- **Verification evidence:**
  ```
  $ pnpm -r typecheck     → core / sdk / ui all "Done" (exit 0)
  $ pnpm lint             → exit 0 (eslint packages/*/src --max-warnings 0)
  $ pnpm --filter tiny-agentic build → DTS + ESM build success, 4 entries (exit 0)
  $ pnpm -r test          → "No test files found, exiting with code 0" (exit 0, passWithNoTests)
  ```
- **Acceptance criteria:** all 13 verified by the tester via direct commands (install/typecheck/lint/build exit 0; package names; `workspace:*` deps in sdk/ui/examples; `.npmrc` has `shamefully-hoist=false`; three core entry stubs exist).
- **Regressions:** none (first code in the repo).
- **Deviations from plan:**
  1. Added `"pnpm": { "onlyBuiltDependencies": ["esbuild"] }` to root `package.json` — required so esbuild's native binary installs under pnpm 10's default postinstall-script blocking (reviewer-approved as correct & minimal).
  2. Added `passWithNoTests: true` to `packages/core/vitest.config.ts` — reviewer-endorsed follow-up so `pnpm -r test` is green before the first tests land in task 03.
- **Commit:** `575b2e7` — "Task 01: scaffold pnpm monorepo (core/sdk/ui packages, build/lint/test tooling)"

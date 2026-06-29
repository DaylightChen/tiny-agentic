# Task 09 — Lint and Boundary Verification

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Run the full suite of static analysis checks — ESLint boundary rules, TypeScript strict mode across all packages — and fix any violations. At the end of this task, success criteria 7.10, 7.11, and 7.12 are all machine-verified and the CI commands that enforce them are documented. No new production code is written in this task unless fixing a lint or type violation.

This task exists as a dedicated step because the boundary rules can only be verified meaningfully against the full import graph. Task 01 created the config file; this task runs the checks against the real code that tasks 02–08 produced.

## Context files

- `docs/engineering/2026-06-27-code-architecture.md` — §"ESLint — boundary & purity enforcement" (the exact rules being checked)
- `docs/engineering/2026-06-27-engineering-spec.md` — §1.4 (one-way dependency enforcement), §8.3 (success criteria 7.10–7.12)
- `docs/brainstorm/2026-06-26-tiny-agentic-design.md` — §7, items 11–12 (success criteria)
- `eslint.config.js` (created in task 01) — the rules to enforce
- All `packages/core/src/**/*.ts` files (created in tasks 02–08)

## Downstream dependencies

- Task 10 (integration example) assumes this task passes. The example must not introduce new lint violations.
- Future tasks (any feature task) can add new source files and rely on the lint config being correct.

## Steps

1. **Run `pnpm -r typecheck`** (across all three packages). Expected: exits with code 0. If there are errors:
   - Core package errors: fix in `packages/core/src/`. Common sources: `exactOptionalPropertyTypes` violations, missing `.js` extensions in ESM imports, incorrect generic bounds.
   - SDK/UI placeholders: these have stub `index.ts` files — they should typecheck trivially.

2. **Run `pnpm lint`** (runs `eslint packages/*/src --max-warnings 0`). Expected: exits with code 0. If there are violations:

   - **`no-restricted-imports` — core imports a Node built-in:** a file other than `platform/node.ts` imports `fs`, `node:fs`, `child_process`, etc. Fix by routing the access through the `Platform` interface.
   - **`no-restricted-globals` — `process` referenced in core:** same fix — move to `platform/node.ts` or route through `platform.cwd()`.
   - **`no-restricted-imports` — core imports SDK or UI package:** architectural violation. Fix by removing the import.
   - **`@typescript-eslint/no-empty-object-type` on `ToolCallContext`:** the interface should have the eslint-disable comment from the code-architecture doc.
   - **`@typescript-eslint` recommended rules:** may flag unused variables, `any` types, or explicit `any` returns. Fix each one individually.

3. **Verify success criterion 7.11 (no UI imports):**
   ```bash
   grep -rn "ink\|react\|chalk\|ora" packages/core/src --include="*.ts"
   ```
   Expected: no output (no matches). If matches exist, remove the imports.

4. **Verify success criterion 7.12 (no core fs/process imports outside platform/node):**
   ```bash
   grep -rn "from 'node:fs\|from 'fs\|from 'node:child_process\|from 'child_process\|process\." \
     packages/core/src --include="*.ts" \
     | grep -v "platform/node.ts"
   ```
   Expected: no output. If matches exist, fix them.

5. **Verify success criterion 7.10 (type safety under strict mode):** confirmed by step 1. Additionally, run:
   ```bash
   pnpm --filter tiny-agentic typecheck 2>&1 | grep "error TS"
   ```
   Expected: no output.

6. **Run the full test suite one final time** to confirm nothing broke:
   ```bash
   pnpm --filter tiny-agentic test
   ```
   Expected: all tests pass (collect, env-context, anthropic-mapper, retry, runTools, loop, agent).

7. **Document the CI commands** — add a comment block at the top of the root `package.json` scripts (or in a brief `docs/ci-commands.md` note — NOT a README, just a reference) documenting the four commands that enforce the success criteria:
   - `pnpm -r typecheck` — enforces 7.10
   - `pnpm lint` — enforces 7.11 and 7.12
   - `pnpm -r test` — enforces 7.1–7.9, 7.13, 7.14
   - `pnpm -r build` — confirms the package is distributable

   If `docs/ci-commands.md` would be a new doc just for this, instead add a `# CI Commands` section to the existing `docs/STATUS.md` comment area, or simply note the commands in the task completion doc. Do NOT create a new doc file unless it adds lasting value beyond this task.

## Acceptance criteria

- [ ] `pnpm -r typecheck` exits with code 0 across all three packages.
- [ ] `pnpm lint` exits with code 0 with `--max-warnings 0`.
- [ ] `grep -rn "ink\|react\|chalk\|ora" packages/core/src --include="*.ts"` returns no output.
- [ ] `grep -rn "from 'node:fs\|from 'fs\b" packages/core/src --include="*.ts" | grep -v platform/node` returns no output.
- [ ] `grep -rn "process\." packages/core/src --include="*.ts" | grep -v platform/node` returns no output.
- [ ] `pnpm --filter tiny-agentic test` passes with all tests green.
- [ ] Success criteria 7.10, 7.11, and 7.12 are all green.

## Output files

- Modified: (only if fixes are needed) — specific `packages/core/src/**/*.ts` files that had lint or type violations.
- No new files created in this task unless a fix requires extracting a new module.

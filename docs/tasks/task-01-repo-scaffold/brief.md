# Task 01 — Repo Scaffold

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Create the complete pnpm monorepo skeleton for tiny-agentic. At the end of this task the repository has:

- A working pnpm workspace with three packages: `tiny-agentic` (core, stub), `tiny-agentic-sdk` (empty placeholder), `tiny-agentic-ui` (empty placeholder).
- A root `tsconfig.base.json` that all packages extend.
- A root `eslint.config.js` with the boundary enforcement rules (no-restricted-imports for core, sdk).
- A root `package.json` with workspace-level scripts (`build`, `test`, `lint`, `typecheck`).
- A `.node-version` / `.nvmrc` pinning Node 18 LTS.
- An `.npmrc` with `shamefully-hoist=false`.
- Each package has its own `package.json`, `tsconfig.json`, and a single stub `src/index.ts` (one-line `// TODO` comment).

`pnpm install` runs cleanly. `pnpm -r typecheck` runs cleanly on stubs. `pnpm lint` runs without errors. No production code is written yet.

This task exists to flush out toolchain compatibility problems (pnpm version, Node version, ESLint 9 flat config, tsup/vitest hoisting) before any feature work.

## Context files

- `docs/engineering/2026-06-27-engineering-spec.md` — §1.1–§1.7 (workspace tooling, root layout, package identity, one-way deps, module system, build tool, test runner)
- `docs/engineering/2026-06-27-code-architecture.md` — Root `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `packages/core/package.json` (key fields section), `packages/core/tsup.config.ts`
- `docs/decisions.md` — "Workspace tooling: pnpm workspaces", "Build tool: tsup; test runner: Vitest; module system: ESM", "One-way dependency enforcement"

## Downstream dependencies

- Task 02 extends `../../tsconfig.base.json` from `packages/core/tsconfig.json` — keep `tsconfig.base.json` at repo root with the exact compiler options specified.
- Task 02 uses the `packages/core/package.json` exports map, scripts, and dependencies structure — do not deviate from the spec's `package.json` key fields.
- Task 09 runs `eslint packages/core/src --max-warnings 0` against the root `eslint.config.js` — keep the flat config at repo root, using `typescript-eslint` v8+ flat config API.
- Tasks 02–08 run `pnpm --filter tiny-agentic build`; this only succeeds because the four tsup entry files (`index.ts` + the three stubs created in step 5) all exist from task 01. Do not remove any of the four stub entry files; tasks 03 and 06 replace their contents in place.
- Task 10 writes `examples/basic-run.ts` and relies on `examples` being a workspace member with a `tiny-agentic` workspace dependency (created here) so the public bare-specifier imports resolve.
- All later tasks assume `pnpm install` has been run and `node_modules` is resolved correctly for all packages.

## Steps

1. **Verify Node and pnpm versions.** Confirm Node >=18 is active (`node --version`). Confirm pnpm is available (`pnpm --version`). If pnpm is not installed, install it via `npm install -g pnpm` or `corepack enable && corepack prepare pnpm@latest --activate`.

2. **Create root config files.**
   - `pnpm-workspace.yaml` (includes `examples` so the integration script in task 10 can resolve `tiny-agentic` via a workspace symlink — see Downstream dependencies):
     ```yaml
     packages:
       - "packages/*"
       - "examples"
     ```
   - `.node-version` (and `.nvmrc` symlink or copy): `18.20.8` (latest 18 LTS patch)
   - `.npmrc`:
     ```
     shamefully-hoist=false
     ```
   - Root `package.json`:
     ```json
     {
       "name": "tiny-agentic-repo",
       "private": true,
       "type": "module",
       "scripts": {
         "build":     "pnpm -r build",
         "test":      "pnpm -r test",
         "lint":      "eslint packages/*/src --max-warnings 0",
         "typecheck": "pnpm -r typecheck"
       },
       "devDependencies": {
         "typescript": "^5.7.0",
         "typescript-eslint": "^8.0.0",
         "@typescript-eslint/eslint-plugin": "^8.0.0",
         "@typescript-eslint/parser": "^8.0.0",
         "eslint": "^9.0.0"
       }
     }
     ```

3. **Create `tsconfig.base.json` at repo root.** Use exactly the compiler options from the code-architecture doc:
   ```json
   {
     "compilerOptions": {
       "strict": true,
       "noUncheckedIndexedAccess": true,
       "exactOptionalPropertyTypes": true,
       "target": "ES2022",
       "lib": ["ES2022"],
       "module": "Node16",
       "moduleResolution": "Node16",
       "declaration": true,
       "declarationMap": true,
       "sourceMap": true,
       "esModuleInterop": true,
       "skipLibCheck": false,
       "forceConsistentCasingInFileNames": true
     }
   }
   ```

4. **Create root `eslint.config.js`.** Use the exact flat config from the code-architecture doc (§ "ESLint — boundary & purity enforcement"). This is an ESLint 9 flat config (`export default tseslint.config(...)`). It enforces: no UI imports in core, no Node built-ins in core (except `platform/node.ts`), no SDK/UI imports in core, no `process` reference in core (except `platform/node.ts`), no UI imports in sdk.

5. **Create `packages/core/` package.**
   - `packages/core/package.json` — use the "key fields" from the code-architecture doc exactly. Key points:
     - `"name": "tiny-agentic"`, `"version": "0.1.0"`, `"type": "module"`, `"engines": { "node": ">=18.0.0" }`
     - exports map with 4 entries (`.`, `./providers/anthropic`, `./platform/node`, `./utils`)
     - `dependencies`: `{ "zod-to-json-schema": "^3.23.0" }`
     - `peerDependencies`: `{ "zod": "^3.22.0", "@anthropic-ai/sdk": "^0.52.0" }`
     - `peerDependenciesMeta`: `{ "@anthropic-ai/sdk": { "optional": true } }`
     - `devDependencies`: `{ "@anthropic-ai/sdk": "^0.52.0", "typescript": "^5.7.0", "tsup": "^8.0.0", "vitest": "^3.0.0" }`
     - scripts: `build: "tsup"`, `typecheck: "tsc --noEmit"`, `test: "vitest run"`, `test:watch: "vitest"`
   - `packages/core/tsconfig.json`:
     ```json
     {
       "extends": "../../tsconfig.base.json",
       "compilerOptions": {
         "outDir": "dist",
         "rootDir": "src"
       },
       "include": ["src"]
     }
     ```
   - `packages/core/tsup.config.ts` — exact config from code-architecture doc (4 entry points).
   - `packages/core/vitest.config.ts`:
     ```ts
     import { defineConfig } from "vitest/config";
     export default defineConfig({
       test: {
         globals: false,
         environment: "node",
       },
     });
     ```
   - `packages/core/src/index.ts`:
     ```ts
     // TODO: public surface — implemented in task-08
     ```
   - **Stub the three secondary tsup entry-point files.** `tsup.config.ts` declares four entry points (`index`, `providers/anthropic`, `platform/node`, `utils/collect`). esbuild/tsup **hard-errors on a missing entry**, so all four files must exist from task 01 even though three are filled in later (tasks 03 and 06). Create each as an explicit empty ES module so `pnpm build` succeeds at every task from here on:
     - `packages/core/src/providers/anthropic.ts`:
       ```ts
       // TODO: AnthropicProvider — implemented in task-06
       export {};
       ```
     - `packages/core/src/platform/node.ts`:
       ```ts
       // TODO: NodePlatform — implemented in task-03
       export {};
       ```
     - `packages/core/src/utils/collect.ts`:
       ```ts
       // TODO: collectText / collectEvents — implemented in task-03
       export {};
       ```
     These three stubs exist solely so tsup's four-entry list resolves; their contents are replaced in tasks 03 and 06. The build that proves the entry list resolves is run in step 12 (after `pnpm install`), not here — tsup is not installed until then.

6. **Create `packages/sdk/` placeholder.**
   - `packages/sdk/package.json` (include a `typecheck` script so `pnpm -r typecheck` actually validates this package, not just core):
     ```json
     {
       "name": "tiny-agentic-sdk",
       "version": "0.0.0",
       "private": false,
       "type": "module",
       "scripts": { "typecheck": "tsc --noEmit" },
       "dependencies": { "tiny-agentic": "workspace:*" }
     }
     ```
   - `packages/sdk/tsconfig.json`:
     ```json
     {
       "extends": "../../tsconfig.base.json",
       "compilerOptions": { "outDir": "dist", "rootDir": "src" },
       "include": ["src"]
     }
     ```
   - `packages/sdk/src/index.ts`:
     ```ts
     // TODO: Agent SDK — implemented in a future milestone
     export {};
     ```

7. **Create `packages/ui/` placeholder.**
   - `packages/ui/package.json` (include a `typecheck` script, same reasoning as sdk):
     ```json
     {
       "name": "tiny-agentic-ui",
       "version": "0.0.0",
       "private": false,
       "type": "module",
       "scripts": { "typecheck": "tsc --noEmit" },
       "dependencies": { "tiny-agentic-sdk": "workspace:*" }
     }
     ```
   - `packages/ui/tsconfig.json`:
     ```json
     {
       "extends": "../../tsconfig.base.json",
       "compilerOptions": { "outDir": "dist", "rootDir": "src" },
       "include": ["src"]
     }
     ```
   - `packages/ui/src/index.ts`:
     ```ts
     // TODO: UI package — implemented in a future milestone
     export {};
     ```

8. **Create the `examples/` workspace package.** `examples` is a workspace member (declared in `pnpm-workspace.yaml`, step 2) so that `import { Agent } from "tiny-agentic"` in task 10 resolves through a pnpm workspace symlink — `examples/` is outside `packages/*`, and pnpm does not hoist workspace packages to the repo root, so without this the bare specifier would not resolve. Create:
   - `examples/package.json`:
     ```json
     {
       "name": "tiny-agentic-examples",
       "version": "0.0.0",
       "private": true,
       "type": "module",
       "dependencies": { "tiny-agentic": "workspace:*" }
     }
     ```
   - `examples/.gitkeep` (the actual example script — `basic-run.ts` — is written in task 10; `tsx` and the run script are also added in task 10).

9. **Run `pnpm install`** from the repo root. Resolve any peer dependency warnings (the `@anthropic-ai/sdk` optional peer will warn if not explicitly installed — this is expected and correct).

10. **Run `pnpm -r typecheck`** to confirm all package stubs typecheck cleanly with the shared base config.

11. **Run `pnpm lint`** to confirm the ESLint boundary config is syntactically valid. (No source files to lint yet beyond stubs — the lint may report no files or lint the stubs cleanly.)

12. **Run `pnpm --filter tiny-agentic build`** (now that `pnpm install` has resolved tsup) to confirm all four tsup entry points resolve and emit to `dist/` — `index.ts` plus the three `export {}` stubs. This is the guard against the missing-entry build failure; every later task that asserts `pnpm build` passes depends on it working here.

## Acceptance criteria

- [ ] `pnpm install` exits with code 0 (no fatal errors).
- [ ] `pnpm -r typecheck` exits with code 0. With `typecheck` scripts present in all three packages, the command actually runs in `core`, `sdk`, and `ui` (not just core).
- [ ] `pnpm --filter tiny-agentic build` exits with code 0 — all four tsup entry points resolve (the three stub entries plus `index.ts`) and emit to `dist/`. This guards against the missing-entry build failure.
- [ ] `pnpm lint` exits with code 0 (or exits with "no files matched" warning — not an error).
- [ ] `ls packages/` shows exactly `core/`, `sdk/`, `ui/`.
- [ ] `ls packages/core/src/providers/anthropic.ts packages/core/src/platform/node.ts packages/core/src/utils/collect.ts` all exist (stub entry files).
- [ ] `cat examples/package.json | grep '"tiny-agentic"'` shows `workspace:*` (example resolves the core package via the workspace).
- [ ] `cat packages/core/package.json | grep '"name"'` shows `"tiny-agentic"`.
- [ ] `cat packages/sdk/package.json | grep '"name"'` shows `"tiny-agentic-sdk"`.
- [ ] `cat packages/ui/package.json | grep '"name"'` shows `"tiny-agentic-ui"`.
- [ ] `cat packages/sdk/package.json | grep '"tiny-agentic"'` shows `workspace:*` (dependency declared).
- [ ] `cat packages/ui/package.json | grep '"tiny-agentic-sdk"'` shows `workspace:*` (dependency declared).
- [ ] `cat .npmrc` contains `shamefully-hoist=false`.

## Output files

- Created: `pnpm-workspace.yaml`
- Created: `.node-version`
- Created: `.nvmrc` (or identical content to `.node-version`)
- Created: `.npmrc`
- Created: `package.json` (root)
- Created: `tsconfig.base.json`
- Created: `eslint.config.js`
- Created: `packages/core/package.json`
- Created: `packages/core/tsconfig.json`
- Created: `packages/core/tsup.config.ts`
- Created: `packages/core/vitest.config.ts`
- Created: `packages/core/src/index.ts`
- Created: `packages/core/src/providers/anthropic.ts` (stub — filled in task 06)
- Created: `packages/core/src/platform/node.ts` (stub — filled in task 03)
- Created: `packages/core/src/utils/collect.ts` (stub — filled in task 03)
- Created: `packages/sdk/package.json`
- Created: `packages/sdk/tsconfig.json`
- Created: `packages/sdk/src/index.ts`
- Created: `packages/ui/package.json`
- Created: `packages/ui/tsconfig.json`
- Created: `packages/ui/src/index.ts`
- Created: `examples/package.json`
- Created: `examples/.gitkeep`

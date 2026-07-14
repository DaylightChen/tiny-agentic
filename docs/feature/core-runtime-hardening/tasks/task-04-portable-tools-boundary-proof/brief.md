# Task 04 — Portable model-facing tools, lint enforcement, and bundle proof

> Written in the plan phase. Immutable during implement-phase execution.

## Goal

Restore the promised strict portability boundary end-to-end. Rewire `ls`, `glob`, and `grep` so they delegate all path grammar and display formatting to `Platform`, preserve Platform-provided order, and have no Node/process access; delete `_paths.ts`; add a non-host custom-grammar test; replace every existing forbidden test `node:path` import; restructure ESLint into universal architecture and narrowly allowlisted environment rules; and prove the built `dist/index.js` dependency graph contains no Node/process edge.

All source/test import migrations land in the same commit as stricter lint, preventing an intermediate red tree. A dedicated executable verification script, `scripts/check-core-boundaries.mjs`, runs ESLint fixture checks and then recursively scans `dist/index.js` plus relative chunks reachable from it, while explicitly permitting Node imports in the separate `dist/platform/node.js` entry. Keeping this out of the normal Vitest suite avoids a race where `pnpm test` runs concurrently with a workspace build that cleans `dist`.

## Context files

- Engineering spec §§5.2.1, 5.2.2, 5.2.4, test IDs PT-1, PT-2, PT-4, PT-5, PT-9–PT-11.
- `eslint.config.js` — currently exempts all platform files and enumerates too few Node imports.
- `packages/core/src/tools/builtin/ls.ts`, `glob.ts`, `grep.ts`, `_paths.ts` — exact migration targets.
- `packages/core/src/types/platform.ts` and `platform/node.ts` — committed task-03 capabilities.
- Path-importing tests: `ls.test.ts`, `glob.test.ts`, `grep.test.ts`, `node.test.ts`, `fs-discovery.test.ts`.
- `packages/core/tsup.config.ts` — current build emits `dist/index.js` plus shared chunks and separate `dist/platform/node.js`.
- `package.json`, `packages/core/package.json` — verify commands; no dependency or new root script is required here.

## Downstream dependencies

- Tasks 06–07 classify these discovery tools as safe only after their portability/read-only contract is proven here.
- Keep tool schemas, caps, result shapes, error strings, signal forwarding, and exact safe markers unchanged.
- `read_file`, `write_file`, and `edit_file` retain raw path delegation; do not broaden normalization.
- The bundle proof must remain reusable in tasks 07/08 after `pnpm build`.
- The only environment allowlist is `packages/core/src/platform/node.ts` and `packages/core/src/platform/fs-discovery.ts`; tests are not exempt.

## Steps

1. **Rewire tools** — `ls`: call `platform.resolvePath(input.path)`, then `listDir`; remove Node import, process test helper, and all sorting; cap the returned order only. `glob`: if `path` exists pass `cwd: platform.resolvePath(path)`; map paths with `platform.formatPath`. `grep`: if `path` exists pass `path: platform.resolvePath(path)`; map every returned file/match with `platform.formatPath`. Preserve exact-optional conditional spreads and existing options.
2. **Delete helper** — delete `packages/core/src/tools/builtin/_paths.ts`; no model-facing replacement parses/splits paths.
3. **Add custom portability test** — create `portability.test.ts` with a real in-memory/custom Platform implementation using sentinel non-host grammar (for example `vfs::root`, with explicit resolve/format maps) and no Node imports. Prove PT-1/PT-2/PT-4/PT-5: each tool calls `resolvePath` before list/glob/grep, sentinel paths round-trip without parsing, and deliberately reverse order is preserved.
4. **Replace forbidden path imports before enabling lint** — in all five named tests remove `node:path`. Use `NodePlatform.resolvePath`/`formatPath` where the behavior under test is Node path behavior; use fixture-local POSIX string helpers only for joining known slash-based fixture strings. Do not import a path library. Correct stale comments equating custom `platform.cwd()` with process cwd.
5. **Split ESLint rulesets** — import `builtinModules` from `node:module` in `eslint.config.js`. Universal architecture rules apply to all `packages/core/src/**/*.ts`, including platform modules, and forbid SDK/UI imports/libraries. Environment rules apply to all core TS except exactly the two allowlisted source modules; derive bare builtins from `builtinModules` (normalize any `node:` prefixes), reject those through `no-restricted-imports`, reject `node:*` via a pattern, reject bare `process`, and reject `globalThis.process`/`global.process` through `no-restricted-properties`. Messages name both allowed modules.
6. **Add one executable boundary script (PT-9/PT-11)** — create `scripts/check-core-boundaries.mjs` using Node APIs plus ESLint's programmatic API. Generate virtual fixture source with explicit filenames and assert rejection of `node:path`, bare `path`, bare `process`, `globalThis.process`, and `global.process`; assert a UI/upward import is rejected even under `platform/`; assert the two allowlisted files remain lintable. Also statically scan every `tools/builtin/**/*.ts`, not a hand-maintained subset, for Node/process access. The script exits nonzero with a specific failed contract.
7. **Add built graph proof to the same script (PT-10)** — require an existing `packages/core/dist/index.js` (fail with instruction to run build if absent), recursively follow relative static `import`/`export ... from` specifiers inside `dist`, and reject external `node:*` imports or code access to `process`, `globalThis.process`, or `global.process` in every reachable JS file. Separately assert `dist/platform/node.js` exists and contains an allowed Node import, proving the scanner checks the correct entry boundary. Do not scan source maps or `.d.ts`.
8. **Run build before the script** — tester runs `pnpm build && node scripts/check-core-boundaries.mjs`. Do not register this built-output check in normal Vitest: root `pnpm test` runs workspace package tests concurrently, and a simultaneous build may clean `dist`. The explicit sequential command is the stable phase gate.

## Acceptance criteria

- [ ] PT-1, PT-2, PT-4, PT-5 pass through `portability.test.ts` with zero Node imports.
- [ ] `tools/builtin/**` contains no Node builtin import and no process/global process access; `_paths.ts` is deleted.
- [ ] Discovery tools preserve custom Platform order and grammar; no sorting or path parsing remains in them.
- [ ] PT-9 verifies all requested import/global cases and universal rules inside platform paths.
- [ ] After `pnpm build`, PT-10 recursively proves the main bundle graph portable; `dist/platform/node.js` remains the allowed Node entry.
- [ ] PT-11 covers all model-facing built-in sources, not only discovery files.
- [ ] `pnpm --filter tiny-agentic test -- src/__tests__/portability.test.ts src/__tests__/ls.test.ts src/__tests__/glob.test.ts src/__tests__/grep.test.ts src/__tests__/node.test.ts src/__tests__/fs-discovery.test.ts` passes.
- [ ] Root `pnpm lint` passes under the new rules.
- [ ] `pnpm --filter tiny-agentic typecheck` and full core test pass.
- [ ] `pnpm build && node scripts/check-core-boundaries.mjs` passes.
- [ ] No runtime dependency is added.

## Output files

**Implementer-owned production/config files:**
- Modified: `packages/core/src/tools/builtin/ls.ts`
- Modified: `packages/core/src/tools/builtin/glob.ts`
- Modified: `packages/core/src/tools/builtin/grep.ts`
- Deleted: `packages/core/src/tools/builtin/_paths.ts`
- Modified: `eslint.config.js`

**Tester-owned test files:**
- Created: `packages/core/src/__tests__/portability.test.ts`
- Created: `scripts/check-core-boundaries.mjs`
- Modified: `packages/core/src/__tests__/ls.test.ts`
- Modified: `packages/core/src/__tests__/glob.test.ts`
- Modified: `packages/core/src/__tests__/grep.test.ts`
- Modified: `packages/core/src/__tests__/node.test.ts`
- Modified: `packages/core/src/__tests__/fs-discovery.test.ts`

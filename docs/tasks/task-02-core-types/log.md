# Execution Log — Task 02: Core Types (scope: project)

> Dev-loop execution log. Structured by iteration. Evidence (real command output) is captured inline.

## Iteration 1

### Implement
- **Files created:** `packages/core/src/types/{messages,platform,tool,provider,events}.ts`.
- **Files modified:** `packages/core/src/index.ts` (stub → type re-exports + `defineTool` value, per brief step 7); `packages/core/package.json` (+`@types/node` devDependency — see decision).
- **Decisions not in plan:** Added `@types/node` as a devDependency. `provider.ts` references `AbortSignal` (`Provider.stream(req, signal?)`), but `tsconfig` uses `lib: ["ES2022"]` with no DOM and `skipLibCheck: false`, so `AbortSignal`'s global type isn't resolvable. `@types/node` supplies Node's `AbortSignal` global without pulling browser-only DOM types — the Node-appropriate fix. (Spec gap: it declares `AbortSignal` in the interface but never specifies how it's typed.)
- **Deviations from plan:** Modified `package.json` (the brief said leave config files alone, meaning tsconfig/tsup/vitest). Adding a genuinely-missing `@types/node` dep is the lesser evil vs. adding `"DOM"` lib (which would wrongly import browser globals into a Node library). **Flagged for reviewer.**
- **Issues encountered:** `AbortSignal` not found under `lib: ["ES2022"]` — resolved via `@types/node` (resolved to ^26 in this env; typecheck + build pass with it installed).
- **Verification (implementer):** `pnpm --filter tiny-agentic typecheck` → exit 0; `pnpm --filter tiny-agentic build` → exit 0 (`dist/index.js` + `dist/index.d.ts` present; DTS 7.55 KB).

### Test
- **New tests written:** `packages/core/src/__tests__/types.test.ts` — 23 tests across 6 describe blocks. Includes a compile-time **inference sentinel** for `defineTool` (a `@ts-expect-error` that fails typecheck if generic `S` inference collapses to `any`/`unknown`), `defineTool` passthrough-identity + Zod `safeParse` behavior, and constructible literals for every `messages`/`platform`/`provider`/`events`/`tool` shape (catches renamed exports / changed required fields at typecheck).
- **Failures:** none.
- **Full suite output:**
  ```
  $ pnpm -r test
  ✓ src/__tests__/types.test.ts (23 tests) 4ms
  Test Files  1 passed (1)   Tests  23 passed (23)
  ```
- **Other checks:** `pnpm --filter tiny-agentic typecheck` → exit 0; `build` → exit 0 (`dist/index.js` + `dist/index.d.ts`); `pnpm lint` → exit 0 (the `eslint-disable` on empty `ToolCallContext` works). DAG verified — `types/` imports only `zod` / `./messages.js` / `./platform.js`, nothing from `loop`/`agent`/`tools`/`env`/`providers`/`platform/node`. `@types/node` injects only Node ambient types (no DOM); typecheck stays strict-clean. No regressions; `git status` shows only the expected files.

### Review
- **Verdict:** Issues found (1 blocking) — otherwise exact-match clean.
- **Shape fidelity:** all five type modules + `index.ts` match the code-architecture doc character-for-character (field names, union variants, order, the `defineTool` method-syntax bivariance, empty `ToolCallContext` + eslint-disable). No deviations.
- **DAG/boundary:** confirmed clean — no escaping relative imports; `types/` imports only `zod`/`./messages.js`/`./platform.js`.
- **Ruling 1 — `@types/node` (BLOCKING):** adding `@types/node` is the correct fix for `AbortSignal` (alternatives — DOM lib / local `declare` — are worse). BUT `^26.0.1` types against Node 26 while the project floor is Node 18 (`engines >=18`, `.node-version 18.20.8`); tasks 03+ could call post-18 `node:*` APIs and typecheck cleanly yet break at runtime. **Fix: repin to `^18.0.0`** (still provides `AbortSignal`, present since Node 15).
- **Ruling 2 — `index.ts` export surface:** clean; exports only existing types + `defineTool`, no imports from not-yet-created modules.
- **Forward-compat:** shapes support tasks 03/04/05 without rework (Platform 4 methods; `ToolSchema.inputSchema` index signature allows the zodToJsonSchema cast; `Message` snake_case fields match Anthropic wire format for the cast-without-transform mapper).
- **Issues to fix:** #1 (blocking) repin `@types/node` to `^18.0.0` in `packages/core/package.json`, re-install, re-typecheck.

---

## Iteration 2

### Fix
- Addressed reviewer issue #1 (blocking): repinned `@types/node` `^26.0.1` → `^18.0.0` in `packages/core/package.json` to match the Node 18 runtime floor. One-line, reviewer-dictated change; applied by orchestrator. Re-installed and re-verified — **typecheck now FAILS** (see below). Surfaced a cross-boundary conflict; loop stopped, escalated.

### Test (iteration 2)
- `pnpm install` → exit 0 (`@types/node` resolved to 18.19.130).
- `pnpm --filter tiny-agentic typecheck` → **FAIL (exit 2):**
  ```
  node_modules/.pnpm/vite@7.3.6_@types+node@18.19.130/.../vite/types/customEvent.d.ts(32,14):
    error TS2304: Cannot find name 'WebSocket'.
  ```
- `pnpm -r test` → 23 passed; `build` → exit 0; `pnpm lint` → exit 0. Only typecheck fails.
- **Root cause confirmed:** `tsc --noEmit --skipLibCheck` passes with `@types/node@18`. The error is in **vite's** bundled `.d.ts` (pulled transitively via vitest), which references the `WebSocket` global. `tsconfig.base.json` sets `skipLibCheck: false` (spec-locked), so tsc type-checks third-party `.d.ts`; `@types/node@18` doesn't declare a `WebSocket` global (it's present in `@types/node@22+`, hence iteration 1's `^26` passed). The reviewer's runtime-floor fix conflicts with the spec's `skipLibCheck: false` under the vitest/vite toolchain.

---

## Escalation

- **What broke:** Pinning `@types/node` to the Node-18 floor (reviewer's required fix) breaks `tsc --noEmit` because vite's bundled type declarations reference the `WebSocket` global, which `@types/node@18` does not declare.
- **Why:** `tsconfig.base.json` has `skipLibCheck: false` (set by the engineering spec / code-architecture doc). This makes tsc type-check all third-party `.d.ts`, including vite's, which assume a newer Node/lib with `WebSocket`. So the `@types/node` version is coupled to the toolchain's `.d.ts` assumptions, not just to our own code.
- **Upstream decision affected:** the spec-locked `skipLibCheck: false` in `tsconfig.base.json` (engineering spec §1.6 / code-architecture `tsconfig.base.json`). Resolving this changes a locked engineering decision.
- **Secondary:** Node 18 reached end-of-life (2025-04); the project's `engines: ">=18"` floor pins to an EOL runtime as of 2026-06.
- **Resolution:** blocked pending user decision (options A/B/C presented in chat). Recommended: A — set `skipLibCheck: true` and pin `@types/node` to the runtime floor.

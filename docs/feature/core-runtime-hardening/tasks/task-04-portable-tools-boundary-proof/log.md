# Execution Log — feature/core-runtime-hardening — Task 04: Portable model-facing tools, lint enforcement, and bundle proof

## Iteration 1

### Implement
- Rewired `ls`, `glob`, and `grep` to Platform path resolution/formatting; removed tool sorting and preserved Platform order/options/caps/errors.
- Deleted `_paths.ts`.
- Split ESLint universal architecture rules from environment restrictions with exact Node module allowlist.

### Test
- Added `portability.test.ts` (6 custom-grammar/order tests), removed node:path from five existing tests, and added `scripts/check-core-boundaries.mjs`.
- Focused: 6 files/96 tests; full: 25 files/452 tests; typecheck/lint/build/boundary script passed.

### Review
- Issues: universal lint rules allowed SDK/UI package subpaths and relative upward imports; boundary scanner regex missed compact syntax and produced comment/string/property false positives. Log evidence also pending.

---

## Iteration 2

### Fix
- ESLint now rejects SDK/UI package subpaths and relative imports reaching package sources, including from platform modules.
- Boundary script now uses existing TypeScript ESLint parser AST traversal, supports compact/static/dynamic imports, ignores comments/strings, distinguishes arbitrary `.process` from global process access, and adds focused fixtures. No dependency added.

### Test
- Focused:
  ```text
  $ pnpm --filter tiny-agentic exec vitest run src/__tests__/portability.test.ts src/__tests__/ls.test.ts src/__tests__/glob.test.ts src/__tests__/grep.test.ts src/__tests__/node.test.ts src/__tests__/fs-discovery.test.ts
  Test Files  6 passed (6)
       Tests  96 passed (96)
  ```
- Full:
  ```text
  $ pnpm --filter tiny-agentic test
  Test Files  25 passed (25)
       Tests  452 passed (452)
  ```
- Typecheck/lint:
  ```text
  $ pnpm --filter tiny-agentic typecheck
  $ tsc --noEmit
  $ pnpm lint
  $ eslint packages/*/src --max-warnings 0
  ```
- Build/boundary proof:
  ```text
  $ pnpm build && node scripts/check-core-boundaries.mjs
  PT-9 passed: 11 ESLint boundary fixtures verified.
  Boundary scanner passed: 4 parser fixtures verified.
  PT-11 passed: 8 model-facing built-in source files scanned.
  PT-10 passed: 2 JavaScript files in the dist/index.js graph scanned.
  PT-10 passed: dist/platform/node.js remains a separate allowed Node entry.
  ```
- Node 20.18.1 emitted expected >=22 warning; final Node 22 gate remains Task 08.

### Review
- Iteration 2 found remaining dynamic/package-normalization lint bypasses and scope-incomplete AST scanning; fixed in iteration 3.

---

## Iteration 3

### Fix
- Added repository-aware static/dynamic import restrictions for Node, SDK, and UI boundaries; non-static dynamic imports fail closed.
- Reworked scanner to scope-aware parser analysis, unwrap TS/chain expressions, recognize static template imports, and add exact bypass/false-positive fixtures.

### Test
- Focused/full/typecheck/lint passed, but build-boundary scan crashed on nullable `ExportNamedDeclaration.source`. One normalized SDK fixture path was corrected by tester.

### Review
- Not dispatched because boundary gate was red.

---

## Iteration 4

### Fix
- `unwrap()` now safely handles both null and undefined AST nodes; no detection behavior weakened.

### Test
- Focused: 6 files/96 tests passed.
- Full: 25 files/452 tests passed.
- Typecheck/lint passed.
- Build/boundary:
  ```text
  PT-9 passed: 18 ESLint boundary fixtures verified.
  Boundary scanner passed: 6 parser fixtures verified.
  PT-11 passed: 8 model-facing built-in source files scanned.
  PT-10 passed: 2 JavaScript files in the dist/index.js graph scanned.
  PT-10 passed: dist/platform/node.js remains a separate allowed Node entry.
  ```
- Node 20.18.1 emitted expected >=22 warning; final Node 22 gate remains Task 08.

### Review
_(pending final review)_

## Iteration 5

### Fix
- Unified static/dynamic/TS import-type enforcement for Node, SDK/UI, UI-library, normalized relative, and absolute repository targets.
- Added fail-closed non-static handling, TSImportType scanning, and scope-aware destructured global-process detection with shadowing-safe fixtures.
- User explicitly authorized additional iterations beyond the default cap if verification finds further material issues.

### Test
_(pending)_

### Review
_(pending)_

## Iteration 6

### Fix
- Corrected TSImportType extraction to prefer parser `source`, then safely unwrap literal wrappers.
- Added category-specific ESLint message assertions and independent globalThis/global destructuring + shadowing fixtures.

### Test
- Focused:
  ```text
  $ pnpm --filter tiny-agentic exec vitest run src/__tests__/portability.test.ts src/__tests__/ls.test.ts src/__tests__/glob.test.ts src/__tests__/grep.test.ts src/__tests__/node.test.ts src/__tests__/fs-discovery.test.ts
  Test Files  6 passed (6)
       Tests  96 passed (96)
  ```
- Full workspace:
  ```text
  $ pnpm test
  $ pnpm -r test
  Test Files  25 passed (25)
       Tests  452 passed (452)
  ```
- Typecheck/lint:
  ```text
  $ pnpm --filter tiny-agentic typecheck
  $ tsc --noEmit
  $ pnpm lint
  $ eslint packages/*/src --max-warnings 0
  ```
- Build/boundary:
  ```text
  $ pnpm build && node scripts/check-core-boundaries.mjs
  $ pnpm -r build
  PT-9 passed: 26 ESLint boundary fixtures verified.
  Boundary scanner passed: 11 parser fixtures verified.
  PT-11 passed: 8 model-facing built-in source files scanned.
  PT-10 passed: 2 JavaScript files in the dist/index.js graph scanned.
  PT-10 passed: dist/platform/node.js remains a separate allowed Node entry.
  ```
- No dependency changes; `_paths.ts` deleted. Node 20 warning expected; Node 22 gate remains Task 08.

### Review
- Final functional review approved all code, test, boundary, downstream, and regression criteria.
- One documentation issue remained: actual final commands/output and per-criterion evidence. Addressed below; doc-only re-review pending.

## Completion
- **Iterations:** 6 (iterations beyond five explicitly authorized by user).
- **Acceptance criteria:**
  - [x] PT-1/PT-2/PT-4/PT-5 pass via six custom-grammar/order portability tests.
  - [x] All eight `tools/builtin/**` sources contain no Node/process access; `_paths.ts` is deleted (PT-11 scan).
  - [x] Discovery tools preserve custom Platform grammar/order and do not sort/parse paths (portability tests + diff review).
  - [x] PT-9 covers static/dynamic package roots/subpaths, UI libraries, absolute/normalized relative paths, TS import types, non-static fail-closed, and process-global forms with exact allowlists (26 fixtures).
  - [x] PT-10 recursively proves the main bundle graph portable and the Node entry separate (2 reachable JS files + node-entry assertion).
  - [x] PT-11 scans every model-facing built-in source (8 files), including TSImportType/process AST forms.
  - [x] Focused tests pass: 6 files/96 tests.
  - [x] Root lint, core typecheck, and full workspace/core tests pass: 25 files/452 tests.
  - [x] Build and boundary proof pass with output above.
  - [x] No runtime dependency added (package/lock diff absent).
- **Regressions:** none.

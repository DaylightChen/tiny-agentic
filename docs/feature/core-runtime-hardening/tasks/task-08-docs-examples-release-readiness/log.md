# Execution Log — feature/core-runtime-hardening — Task 08: Documentation, examples, metadata, and Node 22 release readiness

## Iteration 1

### Implement
- Added root `typecheck:examples` using the existing examples tsconfig.
- Updated all five examples to display successful stop kind and `other.raw`, including successful child terminals where applicable.
- Rewrote core README for final exports/events/options/tools/Platform/approval/usage/cancellation/safe batching/barriers/sequential Task behavior.
- Updated living roadmap, known issues, and only the project STATUS capability narrative; preserved workflow fields.
- Corrected listed source/test comments.
- Added `0.2.0 — Unreleased` changelog sections and set core version 0.2.0; historical 0.1.0 and lockfile unchanged.
- No publish/tag/push/GitHub release/date action.

### Test
- **Node:**
  ```text
  $ node --version
  v22.22.0
  ```
- **Tests:**
  ```text
  $ pnpm test
  $ pnpm -r test
  Test Files  25 passed (25)
       Tests  477 passed (477)
  ```
- **Workspace/examples typecheck:**
  ```text
  $ pnpm typecheck
  packages/core typecheck: Done
  packages/sdk typecheck: Done
  packages/ui typecheck: Done
  $ pnpm typecheck:examples
  $ tsc -p examples/tsconfig.json
  ```
- **Lint/build/boundary:**
  ```text
  $ pnpm lint
  $ eslint packages/*/src --max-warnings 0
  $ pnpm build
  packages/core build: Done
  $ node scripts/check-core-boundaries.mjs
  PT-9 passed: 26 ESLint boundary fixtures verified.
  Boundary scanner passed: 11 parser fixtures verified.
  PT-11 passed: 8 model-facing built-in source files scanned.
  PT-10 passed: 2 JavaScript files in the dist/index.js graph scanned.
  PT-10 passed: dist/platform/node.js remains a separate allowed Node entry.
  ```
- Protected files unchanged: `examples/tsconfig.json`, historical `core-package-status.md`, feature scope JSON, `pnpm-lock.yaml`. Changelog 0.1.0 subtree byte-identical (2118 bytes). No release side effect/tag at HEAD.

### Review
- Initial review approved all criteria except one README statement that conflated yielded `tool_result` event behavior with provider-facing serialization failure handling.
- Corrected README: event retains original `isError`; only serialized provider `ToolResultBlock` becomes `is_error:true` with serialization error.
- Final doc-only review pending.

## Completion
- **Iterations:** 1.
- **Acceptance criteria:**
  - [x] DR-1 complete accurate README, including serialization distinction;
  - [x] DR-2 five examples typecheck and expose successful stop kind/other.raw; root script uses unchanged examples tsconfig;
  - [x] DR-3 core version 0.2.0 and exact `## [0.2.0] — Unreleased` with breaking migrations; historical 0.1.0 unchanged;
  - [x] DR-4 no publish/tag/push/release/date side effects;
  - [x] DR-5 all mandatory commands pass on Node v22.22.0;
  - [x] docs keep concurrent Task future with rationale and accurately state cancellation/no cap;
  - [x] protected historical/status/scope fields preserved.
- **Regressions/deviations:** none.

# Execution Log — Task 05: Smoke run + docs

> Dev-loop execution log. Structured by iteration.

## Iteration 1

### Implement
- **Files created:** `examples/fs-discovery-run.ts` — an `Agent` with `NodePlatform`, Anthropic provider, `tools: [lsTool, globTool, grepTool]` (NO `bashTool`), and an `approvalHandler` that denies `bash` explicitly (proving the roadmap headline: structured discovery works with shell denied). Keyless direct `grepTool.call` timing runs first; the full agent discovery loop runs after the `ANTHROPIC_API_KEY` guard.
- **Files modified:** `examples/README.md` (new section, existing style), root `package.json` (`"example:fs-discovery": "tsx examples/fs-discovery-run.ts"`), `docs/project/known-issues.md` (R3 pure-JS perf entry + deferred `multiline`/`type` entry).
- **No `packages/core/src/` files touched** (verified via `git diff --name-only`).
- **Decisions not in plan:** keyless direct-grep timing placed first so even a keyless smoke demonstrates sub-second grep; `approvalHandler` simplified to deny `bash` / allow else (no bash tool registered — the point is explicit shell denial).
- **Deviations:** brief acceptance lists `pnpm -r lint`, but the repo's `lint` script scopes to `packages/*/src` (examples intentionally unlinted) — root `pnpm lint` passes.

### Test / Verify
- This task adds no unit-testable production logic; verification is the manual keyless smoke + full-suite regression check (matches the task-tool scope's task-05 practice).
- **Keyless smoke output:**
  ```
  === Direct grep timing (no API key needed) ===
  grep packages/core/src: 12.617ms
  [grep matched 4 file(s) under packages/core/src]
  Error: ANTHROPIC_API_KEY environment variable is required for the agent loop.
  exit=1
  ```
  → grep over `packages/core/src` in **12.6ms**, well under the §10 sub-second target.
- **Full suite:** `Test Files 24 passed (24)`, `Tests 400 passed (400)`; `pnpm -r typecheck` all Done; root `pnpm lint` clean; `examples` `tsc --noEmit` exit 0.

### Review (orchestrator spot-check)
- Diff scope confirmed: only `examples/*`, root `package.json`, `docs/project/known-issues.md` — no production code.
- No-`bash` construction confirmed (`tools: [lsTool, globTool, grepTool]` + `deny bash` approvalHandler).
- Both known-issues entries present (R3 perf; deferred `multiline`/`type`).

## Completion
- **Iterations:** 1.
- **Verification evidence:** keyless smoke (grep 12.6ms + key-guard exit 1); `pnpm --filter tiny-agentic test` → 400 passed; `pnpm -r typecheck` → all Done; root `pnpm lint` → clean; examples typecheck clean.
- **Acceptance criteria:** all verified (example exists + no-bash + registered; keyless sub-second grep timing; both known-issues entries; suite green; no production file modified).
- **Regressions:** none.
- **Deviations from plan:** `pnpm -r lint` → root `pnpm lint` (examples intentionally unlinted); non-material.

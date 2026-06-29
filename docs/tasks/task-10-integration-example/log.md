# Execution Log — Task 10: Integration Example (scope: project) — Opus redo

> Final task. Developer-run real-API driver (not CI; needs ANTHROPIC_API_KEY). Without a key, verification confirms build/typecheck + that the script resolves and loads (no-key path exits 1 with the required-key message). Evidence inline.

## Iteration 1

### Implement (Opus)
- **Created:** `examples/basic-run.ts` (multi-turn Q&A + continuation + read_file tool use + collectText demo). **Modified:** root `package.json` (+`tsx@^4`, `"example"` script). **Confirmed:** `examples/package.json` already a workspace member (`tiny-agentic: workspace:*`, type module).
- **Confirmed:** public-entry imports only (`tiny-agentic`, `/providers/anthropic`, `/platform/node`, `/utils`); model id `claude-opus-4-8`; no-key path prints required-key error + exit 1; event-field usages verified against `events.ts`/`provider.ts`.
- **Smoke run (no key):** `pnpm tsx examples/basic-run.ts` → `Error: ANTHROPIC_API_KEY environment variable is required.` EXIT 1 — proves bare-specifier resolution + clean load (no network).
- **Verification (Opus, Node 22):** build→0; `pnpm install` (+tsx 4.22.4)→0; `pnpm -r typecheck`→0; `pnpm -r test`→91/91.
- Full end-to-end (real calls, all 18 criteria observable) is developer-run via `ANTHROPIC_API_KEY=… pnpm example` — not CI.

### Test / Verify
- _(verifier report appended here)_

### Review (Opus)
- **Verdict:** Approved — no blocking issues. Public-entry imports all match the exports map; model `claude-opus-4-8` (valid); event-field usages all correct vs `events.ts`/`provider.ts` (logger narrows on `request_sent`); no-key path exits 1 cleanly; workspace symlink resolves; multi-turn threads `agent_done.messages` per the stateless-core contract; Turn 3 fresh tool-use demo intentional.
- **Non-blocking:** brief text said "14 success criteria" vs the refined 18 — orchestrator fixed the brief count to 18.
- Clean, demonstrative throwaway driver; full M1 surface exercised.

## Completion
- **Iterations:** 1 (implement → verify → review, all green).
- **Verification (orchestrator, Node v22.22.0):** build→0; `pnpm -r typecheck`→0; `pnpm -r test`→91/91; no-key smoke `pnpm tsx examples/basic-run.ts` → required-key error + exit 1 (proves resolution; no network).
- **Acceptance criteria:** CI-observable criteria covered by the unit suite (91 tests) + lint + typecheck; runtime criteria (basic / multi-turn / tool-use / collectText) observable via `ANTHROPIC_API_KEY=… pnpm example` (developer-run, not CI).
- **Commit:** _(filled after commit lands)_

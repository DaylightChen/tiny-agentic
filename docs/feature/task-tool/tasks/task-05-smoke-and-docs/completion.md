---
status: complete
commit: 3733cde
completedAt: 2026-07-02T11:33:30+08:00
iterations: 1
---

# Task Completion — Task 05: smoke-and-docs

**Verification:** all acceptance criteria met, core typecheck passed (`tsc -p packages/core/tsconfig.json --noEmit`, exit 0), full core test suite still green (314 tests), and `examples/task-run.ts` typechecks against the built/exported `tiny-agentic` surface (standalone `tsc --noEmit`, exit 0). Added a dedicated real-provider smoke (`examples/task-run.ts`: parent `claude-opus-4-8` delegating to a child `claude-haiku-4-5` via a real `resolveChild`, streaming `subagent_event`s and printing rolled-up usage; child tool set omits `task`), a README section, and three `docs/project/known-issues.md` entries (R5 cross-provider usage fidelity, R6 sequential-only, E2/R2 deferred numeric depth guard). No `packages/core/src/**` production file modified. The unrelated pre-existing `examples/openai-run.ts` credential change was excluded from the commit.

**Final task — feature `task-tool` is fully implemented.**

See `log.md` in the same directory for the full execution log.

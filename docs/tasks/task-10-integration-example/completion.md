---
status: complete
commit: 9f019fb
completedAt: 2026-06-29T09:10:35+08:00
iterations: 1
---

# Task Completion — Task 10: Integration Example (Opus redo)

> Machine-readable record in the frontmatter; required by the implement phase's `outputCheck`.

**Verification:** under Node v22.22.0, `pnpm --filter tiny-agentic build`, `pnpm -r typecheck`, and `pnpm -r test` (91/91) all exit 0; the no-key smoke run `pnpm tsx examples/basic-run.ts` prints the required-key error and exits 1, proving the public bare-specifier imports resolve through the workspace and the script loads end-to-end (no network). Reviewer approved.

`examples/basic-run.ts` is a developer-run real-API driver exercising the full M1 surface: simple Q&A, multi-turn history threading (reading `agent_done.messages` and re-passing `{ messages }`), tool use via `read_file`, and the `collectText` convenience — using only the public entry points (`tiny-agentic`, `/providers/anthropic`, `/platform/node`, `/utils`) and model id `claude-opus-4-8`. Root `package.json` gains a `tsx` devDependency and an `example` script; `examples/` is a workspace member (from task 01).

Full end-to-end observation of the runtime success criteria requires a developer to run `ANTHROPIC_API_KEY=… pnpm example`; it is not part of CI (paid network calls). The CI-observable criteria are covered by the 91-test unit suite, typecheck, and lint.

See `log.md` for the full execution log.

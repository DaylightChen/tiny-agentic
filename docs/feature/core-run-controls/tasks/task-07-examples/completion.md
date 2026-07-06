---
status: complete
commit: 8f9d06b
completedAt: 2026-06-30T16:10:00+08:00
iterations: 1
---

# Task Completion — Task 07: examples

**Verification:** all acceptance criteria met, both examples typecheck against the built package (standalone `tsc --noEmit` → exit 0), reviewer approved on first review. Added a "Turn 5: run controls" section to `examples/basic-run.ts` (Anthropic) and `examples/openai-run.ts` (OpenAI) demonstrating token-usage reading (`turn_complete.usage` + cumulative `agent_done.usage` via `formatUsage`) and external `AbortSignal` cancellation (`run(prompt, { signal })` aborted mid-stream → `agent_error` + partial usage). Doc/demo task — typecheck acceptance, examples run manually. The committed `openai-run.ts` uses env-var credentials; the user's local Azure creds were preserved in the working tree (restored after the sanitized commit). **Final task — feature core-run-controls is fully implemented.**

See `log.md` for the full execution log.

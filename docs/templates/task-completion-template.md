---
status: complete
commit: SHA
completedAt: ISO-8601-timestamp
iterations: N
---

# Task Completion — Task NN: [Name]

> Created by the orchestrator when a task's dev loop finishes and the commit lands. The YAML frontmatter above is the **machine-readable record** — `/phased-dev:phase-status`, `/phased-dev:list-scopes`, and future tooling query it without parsing prose. This file is also required by the implement phase's `outputCheck`; without it, `/phased-dev:advance-phase` cannot verify the implement phase is complete.

**Verification:** all acceptance criteria met, all tests green, reviewer approved.

See `log.md` in the same directory for the full per-iteration execution log.

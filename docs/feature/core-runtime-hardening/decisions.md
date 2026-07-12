# Decision Log

> Significant feature decisions with rationale. Future readers should understand each entry without needing the original conversation.

## 2026-07-11 — One ordered core-runtime-hardening feature

**Phase:** framing

**Decision:** Deliver remaining core runtime work in one standard feature scope ordered as: stop-reason terminal semantics → strict portability boundary → concurrent safe filesystem tool batches → documentation and release readiness.

**Rationale:** These stages touch overlapping loop, tool, event, and Platform contracts. Stop semantics constrain loop behavior; portability settles contracts before concurrency relies on them; documentation should describe the final combined surface. Separate scopes would repeat phase overhead and increase contract churn.

**Consequences:** The feature uses the standard `research → engineering → plan → implement` pipeline. The implementation plan must preserve this dependency order.

---

## 2026-07-11 — Provider stop reasons remain typed terminal outcomes

**Phase:** framing

**Decision:** Expose normalized provider stop reasons on `agent_done`, `Terminal`, and applicable turn metadata. Preserve partial output, messages, and usage. Do not convert valid provider stop outcomes into `agent_error`.

**Rationale:** Token exhaustion, filtering, and refusal are provider outcomes rather than transport/runtime exceptions. Consumers need to distinguish them from natural completion without losing partial output.

**Consequences:** Public event/terminal types gain stop-reason data. Loop and provider tests must verify natural and abnormal terminal behavior across both providers.

---

## 2026-07-11 — Restore the strict Platform portability boundary

**Phase:** framing

**Decision:** Model-facing built-in tools may not import Node built-ins or read process-global state. Path resolution, path formatting, and environment-dependent ordering must move behind minimal portable Platform capabilities or platform-neutral helpers.

**Rationale:** The core promises a provider/platform abstraction and confines environment-specific behavior to platform implementations. Current discovery tools leak Node path/process dependencies beyond that boundary.

**Consequences:** Engineering must define the smallest coherent contract change, keep existing path/ordering behavior stable, and enforce the boundary through lint and tests.

---

## 2026-07-11 — Concurrent filesystem tools only; task remains sequential

**Phase:** framing

**Decision:** Concurrent batching initially covers `read_file`, `ls`, `glob`, and `grep`. `write_file`, `edit_file`, `bash`, `task`, and unmarked tools remain sequential barriers. Concurrent `task` calls are a separate future feature.

**Rationale:** The four filesystem reads are stateless and already fit the concurrency-safe seam. `task` uses shared child-event, tool-call attribution, cancellation, and usage plumbing that requires an independent design.

**Consequences:** `runTools` must execute maximal contiguous safe batches concurrently while preserving original result order and unsafe barriers. No speculative task-context refactor belongs in this feature.

---

## 2026-07-11 — Release readiness without publishing

**Phase:** framing

**Decision:** Refresh the core README, roadmap, project status, changelog, stale source comments, and package release metadata after runtime work is complete. Do not tag, publish, or create a release.

**Rationale:** The implementation has outpaced documentation and version metadata, but publishing is outward-facing and requires separate explicit authorization.

**Consequences:** The final plan includes documentation and release-preparation tasks only; any release action remains user-controlled.

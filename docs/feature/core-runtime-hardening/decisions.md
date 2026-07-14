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

---

## 2026-07-13 — Closed normalized stop-reason kind plus required raw reason

**Phase:** engineering

**Decision:** Replace the effective-string provider stop reason with a required structured `StopReason`: a closed exhaustive `kind` union (`end_turn`, `tool_use`, `max_tokens`, `stop_sequence`, `pause_turn`, `refusal`, `content_filter`, `model_context_window_exceeded`, `other`) plus required `raw: string | null`. Unknown native values map to `other` while preserving the exact string; a stream that exposes no native reason uses `other/null`. `ProviderEvent.message_stop`, `turn_complete`, final `agent_done`, `Terminal.agent_done`, and sanitized child `terminal/agent_done` carry this object as a required field. Engine/runtime terminals do not invent one.

**Rationale:** A closed `kind` supports exhaustive consumer decisions, while `raw` prevents loss when providers add values or compatible endpoints diverge. A known-literals-plus-`string` union is not exhaustive, and an optional raw field would make missing versus omitted ambiguous. Required propagation is a deliberate pre-1.0 source break: optional terminal fields would fail the feature’s guarantee and force consumers to guess.

**Consequences:** Custom providers and typed event/terminal literals must migrate for `0.2.0`. `exactOptionalPropertyTypes` is straightforward because `raw` is required and explicitly nullable. No provider name is embedded in the normalized type.

---

## 2026-07-13 — Explicit Anthropic and OpenAI stop mapping; valid tool-free stops terminate

**Phase:** engineering

**Decision:** Anthropic native values map one-to-one to the corresponding normalized kinds; unknown values map to `other`, and missing maps to `other/null`. OpenAI maps `stop→end_turn`, `tool_calls→tool_use`, `length→max_tokens`, `content_filter→content_filter`, and deprecated `function_call→tool_use`; unknown values map to `other`, preserving the native finish reason in `raw`. A non-empty OpenAI streamed refusal field maps `stop`/missing finish data to `refusal` without overriding explicit tool, length, or filter finishes. Every provider turn carries its reason. Buffered tool calls continue automatically regardless of a mismatched reason; a tool-free turn terminates with its reason. `pause_turn` does not auto-resubmit in this feature. A stream ending without any `message_stop` is a provider contract error and becomes `agent_error` rather than receiving an invented stop.

**Rationale:** The mapping preserves provider distinctions where they exist and avoids inventing a stop-sequence distinction OpenAI does not expose. Buffered protocol data is a more reliable continuation signal than a compatible endpoint’s reason string. Automatic `pause_turn` continuation would be a separate agent-loop behavior expansion. Requiring `message_stop` prevents a disconnected stream from masquerading as natural completion.

**Consequences:** Valid truncation, filter, refusal, pause, context-window, and unknown stops preserve partial text/messages/usage and remain distinct from runtime exceptions. Provider and loop tests become table-driven across all modern and fallback values.

---

## 2026-07-13 — Platform owns path grammar through two high-level capabilities

**Phase:** engineering

**Decision:** Add required `Platform.resolvePath(path): string` and `Platform.formatPath(path): string`. Path grammar is per-platform. Model-facing tools neither import Node path APIs nor parse paths: `ls` resolves input through `resolvePath`; `glob`/`grep` resolve explicit roots and format returned paths through `formatPath`; `_paths.ts` is deleted. `NodePlatform` implements current native behavior: relative inputs resolve from cwd, cwd itself formats as `.`, descendants format relative, and outside-cwd paths remain absolute/canonical. `Platform.stat` is retained without deprecation.

**Rationale:** Two behavior-oriented methods are the smallest coherent seam that preserves current behavior while allowing Windows, browser, URL-like, or virtual platforms to own grammar. A portable POSIX helper would impose one grammar on every platform; a broad Node-like Path service would add speculative surface; changing filesystem result shapes would entangle presentation with primitives. Removing `stat` is unrelated breaking cleanup.

**Consequences:** `NodePlatform` and all ten in-repository test doubles/object literals add two methods, and external implementors receive a documented `0.2.0` source migration. No new path dependency is introduced.

---

## 2026-07-13 — Platform owns discovery ordering with an explicit tie-break

**Phase:** engineering

**Decision:** `listDir`, `glob`, and `grep` return results in final display order; model-facing tools preserve that order. Node production order is mtime descending with name/path ascending as the equal-mtime tie-break. Node test order remains name/path ascending. Grep matches are grouped by file order and then line ascending. Custom platforms choose how to provide their deterministic policy; neutral tools do not read `NODE_ENV`.

**Rationale:** Ordering currently splits between tools and Node helpers, requiring process access in model-facing code and leaving equal mtimes nondeterministic. Platform ownership preserves environment-specific behavior and eliminates process reads outside Node modules without changing signatures.

**Consequences:** `ls` loses its local sort; `NodePlatform.listDir` and `fs-discovery.ts` implement the complete order. Tests prove tools do not re-sort custom-platform output and pin the Node tie-break.

---

## 2026-07-13 — Lint uses universal architecture rules plus an explicit Node-module allowlist

**Phase:** engineering

**Decision:** Apply UI and upward-dependency restrictions to every core source file, including `platform/**`. Separately forbid all Node built-ins, `node:*`, bare `process`, `globalThis.process`, and `global.process` everywhere except exactly `platform/node.ts` and `platform/fs-discovery.ts`. Derive bare builtin names from Node’s `builtinModules` in the ESLint config. Tests are not exempt. Build verification must prove the main `dist/index.js` graph has no Node/process edge while the Node platform subpath may have one.

**Rationale:** Exempting all platform files from the complete core override silently disables unrelated architectural restrictions, while enumerating a few built-ins misses `node:path`, `node:util`, and future imports. Source lint alone does not prove the statically re-exported main bundle is portable.

**Consequences:** Existing Node path imports in discovery tests must be removed or routed through Platform capabilities. The rule messages name the two intended Node platform modules. Platform code remains subject to the headless and one-way dependency boundaries.

---

## 2026-07-13 — Lazy serial preparation and maximal concurrent safe batches

**Phase:** engineering

**Decision:** Prepare tool calls lazily in model order with exact sequencing: lookup → provider parse-error check → Zod validation → synchronous safety classifier → serial approval. Approved safe calls form the maximal contiguous batch and start together. Unknown, parse-invalid, Zod-invalid, classifier-failed, denied, approval-failed, unmarked, and classifier-false calls are barriers. The scheduler never prepares past a known barrier. Unsafe approval and execution occur only after the preceding safe batch settles; following preparation waits until the barrier result settles and is yielded.

**Rationale:** This preserves deterministic approval invocation and temporal barriers while ensuring disallowed work cannot start. Concurrent approvals or look-ahead across barriers would change observable host behavior. Treating immediate errors as non-barriers would also move later approval/execution across an existing call position.

**Consequences:** `read_file` joins the already-marked `ls`/`glob`/`grep` safe set. `write_file`, `edit_file`, `bash`, `task`, and custom unmarked tools remain sequential. `task` continues to state that sub-tasks run one at a time.

---

## 2026-07-13 — Per-call context envelopes and `Promise.allSettled` preserve attribution/order

**Phase:** engineering

**Decision:** Each executable call receives a shallow clone of the declaration-merged base context with its own `toolCallId`, child-event array, and reported-usage array. `runTools` yields an internal attributed envelope containing the `tool_result`, child events, and usage. Safe batches use `Promise.allSettled`; all started calls settle, unexpected helper rejections normalize to that call’s error result, and envelopes are yielded in original input order. `loop.ts` flushes each envelope’s child events, result, serialization, and usage in that order.

**Rationale:** The current shared mutable context is correct only under sequential execution. A shallow clone preserves arbitrary enumerable SDK-merged fields while isolating all core-owned attribution. `allSettled` provides a defensive all-started-settle boundary even if a supposedly total helper unexpectedly rejects. Ordered settlements and loop-side serialization preserve current provider-message ordering.

**Consequences:** Concurrent custom safe tools cannot leak IDs, child events, or usage into siblings. Referenced declaration-merged services are not deep-cloned; a tool may mark itself safe only if concurrent use of those references is safe. Concurrent Task remains out of scope and unmarked.

---

## 2026-07-13 — Cancellation stops new work without promising syscall interruption

**Phase:** engineering

**Decision:** Check the run signal before preparation, after serial approval, and immediately before execution. Once aborted, start no additional calls; each remaining unstarted tool-use receives the ordered exact error `Tool '<name>': call cancelled before start`. Active calls receive the same signal in isolated contexts and all settle before results are emitted. Do not add signals to `Platform.readFile`/`listDir`: `glob`/`grep` remain cooperatively interruptible, while in-flight `read_file`/`ls` operations may finish. If `isConcurrencySafe` throws, skip approval/call, emit `Tool '<name>': concurrency safety check failed — <message>`, and treat it as a barrier.

**Rationale:** One result per provider tool-use preserves protocol pairing and deterministic ordering after cancellation. The existing Platform signatures cannot honestly guarantee interruption of read/list syscalls. A classifier exception is framework/tool-definition failure, not evidence that the call is safe; failing closed avoids accidental execution.

**Consequences:** Cancellation tests distinguish signal delivery/no-new-work from prompt syscall cancellation. The next provider turn observes the aborted run signal and follows existing `agent_error` behavior; no new terminal reason is added.

---

## 2026-07-13 — No concurrency cap in the first safe-batch release

**Phase:** engineering

**Decision:** Start every approved call in a maximal contiguous safe batch; add no cap, default, or Agent option in `0.2.0`.

**Rationale:** Model tool-call lists are normally small, the approved batching contract says the maximal safe group starts together, and there is no workload evidence for a useful universal cap. A cap would introduce policy and configuration before need is demonstrated.

**Consequences:** Large batches can amplify file descriptors, CPU, traversal, and memory. Tests prove batches larger than a common implicit pool size all start. A configurable cap remains an additive future option if production evidence requires it.

---

## 2026-07-13 — Prepare an unreleased `0.2.0` with explicit migrations

**Phase:** engineering

**Decision:** Set the next package-version proposal to `0.2.0` and add an `Unreleased` changelog entry with `Added`, `Changed`, `Fixed`, and `Breaking changes` sections. Include accumulated post-`0.1.0` Task/discovery/reasoning capability plus this feature’s typed stop reasons, portable main graph, safe batching, and migration notes. Do not rewrite the historical `0.1.0` release entry. Do not publish, tag, or create a release.

**Rationale:** The release contains substantial additive capability and deliberate source breaks to provider/event/Platform contracts. Under SemVer major zero, a minor bump communicates this better than a patch, while `1.0.0` would overstate stability. `Unreleased` accurately separates metadata preparation from external release authorization.

**Consequences:** `packages/core/package.json` moves to `0.2.0` during implementation; examples and README document the migrated type surfaces. A separate user-authorized action supplies a release date and performs publication later.

---

## 2026-07-13 — Split the stop-reason source break at the provider boundary

**Phase:** plan

**Decision:** Land structured `ProviderEvent.message_stop.stopReason`, both provider mappers, public exports, and direct provider fixtures in task 01 while leaving `AgentEvent`/`Terminal` unchanged. Then land all required turn/terminal/Task fields, loop propagation, and downstream literals atomically in task 02.

**Rationale:** Putting the complete provider-to-terminal break in one task would exceed a reviewable session, while making required downstream fields optional or leaving consumers broken between commits would violate the binding contract and sequential planning rules. The current loop ignores the provider reason value, so changing the provider field from string to object is a real compile-safe seam.

**Consequences:** Every task boundary compiles. Task 01 proves native normalization independently; task 02 owns the complete required terminal migration and may not weaken any field to optional.

---

## 2026-07-13 — Land attribution envelopes before enabling overlap

**Phase:** plan

**Decision:** Use a dedicated task to replace batch-wide mutable tool attribution with per-call contexts and `ToolExecution` envelopes while tool execution is still sequential. Enable safe batching only in the following task.

**Rationale:** Combining attribution refactoring with the scheduler would make ID/event/usage leakage difficult to isolate and could briefly enable overlap over shared sinks. A sequential envelope commit is independently testable and gives the scheduler a committed, leak-proof foundation.

**Consequences:** The `runTools` yield-shape change and `loop.ts` consumer change land atomically in task 05; task 06 adds overlap without redesigning attribution.

---

## 2026-07-13 — Prove portability against the built main-entry graph

**Phase:** plan

**Decision:** Add an automated post-build test that starts at `packages/core/dist/index.js`, recursively follows relative static imports/exports into emitted chunks, and rejects Node builtin or process access anywhere reachable. The separate `dist/platform/node.js` entry remains allowed to contain Node imports.

**Rationale:** The current tsup build emits shared chunks, so scanning only source or only the text of `dist/index.js` can miss a reachable Node edge. A graph-aware built-output check directly tests the package promise without requiring a new runtime dependency.

**Consequences:** Portability verification runs after `pnpm build` in tasks 04, 07, and the Node 22 final gate. The test must not treat the Node platform subpath as part of the main-entry graph unless it becomes statically reachable, in which case it correctly fails.

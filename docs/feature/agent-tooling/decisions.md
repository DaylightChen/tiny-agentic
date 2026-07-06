# Decision Log — feature/agent-tooling

> Feature-scoped decisions. Each entry is self-contained. Do not add cross-cutting decisions here — those go in `docs/project/decisions.md`.

## Format

```
## YYYY-MM-DD — [Decision title]

**Phase:** [phase name]

**Decision:** [What was decided]

**Rationale:** [Why this option was chosen — what trade-offs were considered, what alternatives were rejected and why]

**Consequences:** [What this enables, constrains, or commits the project to]
```

---

## 2026-06-29 — Shell invocation for `bash` tool: `shell?: boolean` on `ExecOptions`

**Phase:** engineering

**Decision:** Add an optional `shell?: boolean` field to `ExecOptions`. The `bash` built-in tool always passes `{ shell: true }` when calling `platform.exec`. `NodePlatform.exec` forwards `shell: true` to `execFile`, which causes Node to invoke the system shell (`/bin/sh -c` on Unix). When `shell: true`, the full command string is passed as-is; the current `command.split(" ")` split is bypassed.

**Rationale:** Three options were considered: (A) `shell?: boolean` on `ExecOptions` (additive, non-breaking), (B) hard-code `/bin/sh -c` inside the tool (no Platform change, less flexible), (C) new `Platform.execShell()` method (breaking — all existing `Platform` implementors must add the method). Option C is rejected per the project decisions log ("Adding methods in M2 is a breaking change"). Option B works but ties the tool to a Unix-specific invocation path and prevents the mock Platform from cleanly intercepting shell calls. Option A is additive (optional field, existing callers unaffected) and makes the "this is a shell execution" intent explicit at the `Platform` seam, which is the correct abstraction boundary.

**Consequences:** `ExecOptions` gains `shell?: boolean`. `NodePlatform.exec` must branch on `options.shell` to pass the full command string (not split). The `bash` tool always sets `shell: true`. The mock Platform in tests can assert that `shell: true` was passed. No existing code breaks.

---

## 2026-06-29 — `edit_file` read-before-edit enforcement: deferred to SDK layer

**Phase:** engineering

**Decision:** The `edit_file` tool in this feature does NOT enforce that the model has previously read the file before editing it. The tool reads the file atomically at edit time (read → find → replace → write) but does not check whether `read_file` was called earlier in the conversation.

**Rationale:** Enforcing this requires `ToolCallContext` to carry a `readFileState: Map<string, ReadEntry>` populated when `read_file` runs. The SDK (not the core) is the correct layer to populate that map via `ToolCallContext` interface merging, but the SDK does not yet exist. Having the core loop track which `read_file` calls have run would couple the loop to a specific tool's semantics, violating the core's tool-agnostic design. Skipping enforcement is safe to ship initially; the atomic read-find-replace-write in the tool covers the most common stale-write scenario.

**Consequences:** The limitation is logged in `docs/project/known-issues.md`. The `ToolCallContext` interface remains the correct extension point for enforcement once the SDK exists. No core design is foreclosed.

---

## 2026-06-29 — Permission seam: injected async callback on `AgentOptions`

**Phase:** engineering

**Decision:** The permission/approval seam is an optional `approvalHandler?: ApprovalHandler` field on `AgentOptions`, where `ApprovalHandler = (toolName: string, input: unknown) => Promise<'allow' | 'deny'>`. The handler is awaited in `runTools` after Zod validation, before `tool.call`. When omitted, all tool calls are allowed (backward-compatible default). `ApprovalDecision` and `ApprovalHandler` are defined in `types/tool.ts` and exported from `index.ts`.

**Rationale:** Three patterns were evaluated: (A) injected async callback (chosen), (B) `approval_required` `AgentEvent` + generator-resume, (C) out-of-band Promise on `ToolCallContext`. Option B requires the consumer to handle a new event type and resume the generator with `.next(decision)`, changing the consumption protocol — existing `for await` loops would get wrong behavior. The `AsyncGenerator` input type parameter change would also be a breaking interface change. Option C is fragile: a consumer that forgets to resolve the Promise hangs the loop indefinitely. Option A is non-breaking (optional field), follows the existing `logger?: Logger` convention, is async (supports network-based approval services, terminal prompts, etc.), and is the pattern used by most agentic SDKs. It also trivially honors the headless/UI-free boundary: the callback is injected by the consumer, so any UI (terminal prompt, web dialog) lives in the caller, not the core.

**Consequences:** `AgentOptions` and `LoopParams` gain `approvalHandler?: ApprovalHandler`. `runTools` signature gains `approvalHandler?: ApprovalHandler`. The types live in `types/tool.ts`. No `AgentEvent` union change. No generator protocol change. Consumers that want per-run policy construct a new `Agent` per run (the policy is instance-scoped, not call-scoped).

---

## 2026-06-29 — Permission gate location: `runTools` loop, after Zod validation

**Phase:** engineering

**Decision:** The approval gate runs in `runTools`, sequentially between Zod validation success and `tool.call`. It does NOT live inside individual tools, and is NOT injected into `ToolCallContext` for tools to call themselves.

**Rationale:** A loop-level gate is enforced unconditionally for every tool call without requiring each tool to opt in. Injecting into `ToolCallContext` would make the gate optional per-tool, introducing a misuse risk where a new built-in or consumer tool skips the check. The `runTools` loop is the one place every tool call passes through (already responsible for parse-error detection, Zod validation, and try/catch); the approval check belongs in the same sequence.

**Consequences:** Adding a new tool (built-in or user-authored) automatically participates in the approval gate at zero cost. The gate runs even for `read_file` and `write_file` if the consumer's handler returns `'deny'` for them.

---

## 2026-06-29 — `bash` default: blanket allow; `approvalHandler` is opt-in

**Phase:** engineering

**Decision:** `bash` is allowed by default when no `approvalHandler` is provided. The approval gate is a consumer opt-in, not a deny-by-default gate that `bash` must unlock.

**Rationale:** The project decisions log establishes "blanket allow in M1." Changing to deny-by-default for `bash` specifically would be a behavioral breaking change for any consumer that adds `bashTool` to their tool list. Many programmatic uses (CI scripts, automated test agents) want unconditional execution and would find a required callback burdensome. The correct model is: no handler = trust all; handler = consumer controls policy. This matches the pattern of most agentic SDKs and is consistent with the existing `read_file`/`write_file` tools which also pass through unconditionally.

**Consequences:** Consumers adding `bashTool` get full shell access by default. Consumers requiring approval inject `approvalHandler`. Documentation for `bashTool` should prominently note this and recommend an `approvalHandler` for any agent with untrusted inputs.

---

## 2026-06-29 — AbortSignal kill behavior: SIGTERM only, no SIGKILL grace period

**Phase:** engineering

**Decision:** When the agent's `AbortSignal` fires while `bash` is executing, Node sends SIGTERM to the shell process (Node 22 default behavior for `execFile` + `signal`). No explicit SIGKILL grace-period timer is added in this feature.

**Rationale:** SIGTERM is sufficient for the shell commands expected in agentic workflows (git, npm, tsc, lint tools). Adding a SIGKILL grace period requires replacing `execFile` with `spawn` to get the PID, then scheduling `process.kill(-pid, 'SIGKILL')` after a delay — significantly more complex. The `timeout` field on `ExecOptions` provides a secondary hard termination: if a process fails to exit by the timeout, Node forcefully terminates it. The two mechanisms together (signal abort + timeout) cover the practical cases.

**Consequences:** Shell pipelines that create child process groups may leave orphaned processes after SIGTERM if the shell does not forward the signal. This is a known limitation. A future `NodePlatform` enhancement can use `spawn` + process group management.

---

## 2026-06-29 — `ToolCallContext.signal` lifetime: set once at loop construction, reused across turns

**Phase:** engineering

**Decision:** `context.signal = signal` is set when `const context: ToolCallContext = { signal }` is constructed in `agentLoop`, before the `while (true)` loop. The same `context` object is reused for all turns of the run. The signal is not re-set or re-created per turn.

**Rationale:** The `AbortSignal` is created once per `Agent.run()` call and covers the entire run. Re-creating `context` per turn would break any SDK extension that uses `ToolCallContext` to carry stateful data across turns. The single-object-per-run lifetime is the existing design; this decision preserves it while adding the `signal` field.

**Consequences:** `context.signal` always refers to the run-level abort signal. Tools that read `context.signal` get the correct, never-stale signal. Interface merging extensions in the SDK that carry per-run state (not per-turn) continue to work correctly.

---

## 2026-06-29 — `bashTool`/`editFileTool` exported from main `index.ts`; types in `types/tool.ts`

**Phase:** engineering

**Decision:** `bashTool` and `editFileTool` are exported from `packages/core/src/index.ts` as named exports, following the `readFileTool`/`writeFileTool` convention. `ApprovalDecision` and `ApprovalHandler` types are defined in `types/tool.ts` (alongside `ToolCallContext`) and re-exported from `index.ts`. No sub-path exports for these symbols.

**Rationale:** Built-in tools are part of the core's primary public surface — there is no reason to put them behind a sub-path. Placing `ApprovalDecision`/`ApprovalHandler` in `types/tool.ts` avoids an import cycle: `runTools.ts` needs the `ApprovalHandler` type but must not import from `agent.ts` (which imports from `loop/loop.ts` which imports from `loop/runTools.ts`). Defining the types in `types/tool.ts` (which has no circular dependencies) and re-exporting from `agent.ts` breaks the cycle cleanly.

**Consequences:** Consumers import `bashTool`, `editFileTool`, `ApprovalDecision`, `ApprovalHandler` from `"tiny-agentic"`. Model-facing tool names remain `bash` and `edit_file` (snake_case, consistent with the reference and existing built-ins).

---

## 2026-06-29 — Task ordering: permission gate after tools, wiring last

**Phase:** plan

**Decision:** The five tasks are ordered: (1) type + platform foundations, (2) `bash` tool, (3) `edit_file` tool, (4) permission gate, (5) wiring + exports. The gate (task-04) is placed before wiring (task-05) because `ApprovalDecision`/`ApprovalHandler` types must exist in `types/tool.ts` before `agent.ts` and `loop.ts` can reference them. The wiring task is placed last because it depends on all prior outputs: `ToolCallContext.signal?` (task-01), `bashTool`/`editFileTool` (tasks 02-03), and the gate types + `runTools` parameter (task-04). The two tools (tasks 02-03) are ordered bash-before-edit_file: `bash` is the riskier/more novel tool and goes first per the risk-first principle; they are otherwise independent of each other.

**Rationale:** Maximizes early failure detection — the `NodePlatform.exec` refactor (highest regression risk) is task-01, proven against all 140 existing tests before any feature code builds on it. Each task is independently testable by the dev loop with no forward dependencies.

**Consequences:** Each task brief can cite concrete committed state from the previous task. No task requires looking ahead to an as-yet-unwritten interface.

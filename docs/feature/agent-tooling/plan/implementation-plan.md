# Implementation Plan — agent-tooling (feature/agent-tooling)

> Written in the plan phase by the `planner` agent. Lives at `docs/feature/agent-tooling/plan/implementation-plan.md`.
> Source design: `docs/feature/agent-tooling/engineering/2026-06-29-agent-tooling-engineering.md`.
> Locked decisions: `docs/feature/agent-tooling/decisions.md` (8 decisions).

## Goal

When every task in this plan is committed, the `tiny-agentic` core package gains four new capabilities: a `bash` built-in tool that executes shell commands via `/bin/sh`, an `edit_file` built-in tool that performs exact-match string-replacement edits, a permission/approval seam (`approvalHandler`) that lets consumers gate tool calls without importing any UI code, and full cancellation threading so that `ToolCallContext.signal` propagates from `Agent.run()` through `agentLoop` into `NodePlatform.exec` and onward to any in-flight shell process.

The feature is fully additive — no public type is removed or made incompatible, the existing 140 tests continue to pass, and consumers that omit `approvalHandler` get the same blanket-allow behavior they have today. The deliverables are two new built-in tool files (`bash.ts`, `editFile.ts`), additive changes to six existing files (`types/tool.ts`, `types/platform.ts`, `loop/loop.ts`, `loop/runTools.ts`, `platform/node.ts`, `agent.ts`, `index.ts`), and four new test suites (one per tool plus runTools additions and a NodePlatform shell-mode test).

## Task list

The order is the execution order. Sequential — each task starts from the committed state of the previous one.

1. **task-01-type-and-platform-foundations** — Add `signal?`/`shell?` to `ExecOptions`, `signal?` to `ToolCallContext`, and refactor `NodePlatform.exec` to support `shell: true` + `AbortSignal` forwarding.
2. **task-02-bash-tool** — Implement `bashTool` in `tools/builtin/bash.ts` with timeout clamping, shell execution, and abort forwarding; add `bash.test.ts`.
3. **task-03-edit-file-tool** — Implement `editFileTool` in `tools/builtin/editFile.ts` covering all error paths (no match, multiple matches, empty old_string creation, same-string guard); add `editFile.test.ts`.
4. **task-04-permission-gate** — Add `ApprovalDecision`/`ApprovalHandler` types to `types/tool.ts`; thread `approvalHandler` through `AgentOptions` → `LoopParams` → `runTools`; implement the gate in `runTools`; add gate tests to `runTools.test.ts`.
5. **task-05-wiring-and-exports** — Populate `context.signal` in `agentLoop`; thread `approvalHandler` through `agentLoop` to `runTools`; export `bashTool`, `editFileTool`, `ApprovalDecision`, `ApprovalHandler` from `index.ts`; add abort-propagation integration test.

## Dependency rationale

**Foundation before features (task-01 first).** The two type changes — `ExecOptions.shell?`/`ExecOptions.signal?` and `ToolCallContext.signal?` — are consumed by every subsequent task. `bashTool` (task-02) calls `platform.exec({ shell: true, signal: context.signal, ... })`, and these fields must exist in the type before that code compiles. `NodePlatform.exec`'s shell-mode refactor (splitting the full-string vs. program+args code path) is the highest-risk change in the feature (spec §10 risk: existing tests must still pass); placing it in task-01 surfaces any breakage before any feature work sits on top of it. Crucially, task-01 is independently testable via `NodePlatform.exec` unit tests and the full existing test suite — a clean pass at task-01 proves the refactor is safe.

**bash before edit_file (task-02 before task-03).** The two tools are independent of each other, so either order works. `bash` is the riskier and more novel tool (live shell execution, timeout clamping, abort forwarding), and schedules early per the risk-first principle. `edit_file` (task-03) is pure in-memory string manipulation via the existing `platform.readFile`/`platform.writeFile`; it is straightforward once the foundation exists. Doing `bash` first also validates that `context.signal` is reachable from a tool implementation before `editFileTool` needs the same wiring.

**Permission gate after tools, before wiring (task-04).** The gate lives in `runTools` and is independent of both tools' implementations — it intercepts the call regardless of which tool is being called. However, task-04 adds `ApprovalDecision`/`ApprovalHandler` to `types/tool.ts`, which must be defined before `agent.ts` and `loop.ts` can reference them (task-05). Placing the gate before wiring keeps the dependency arrow clean: task-05 imports the types from `types/tool.ts` that task-04 created.

**Wiring and exports last (task-05).** `context.signal` population in `agentLoop` requires `ToolCallContext.signal?` to exist (task-01). Threading `approvalHandler` through `LoopParams` → `runTools` requires the `approvalHandler` parameter to exist on `runTools` (task-04). The `index.ts` exports require `bashTool`, `editFileTool`, and the approval types to exist (tasks 02, 03, 04). Task-05 is therefore the natural integration capstone — it connects all prior pieces and adds the end-to-end abort-propagation integration test that exercises the full signal chain.

**No scaffolding task needed.** This is a feature on a mature M1 codebase. The stack, toolchain, and seams all exist and are proven. The "vertical slice / prove the stack" role is served by task-01's `NodePlatform.exec` refactor running against the existing 140 tests.

## Coverage check

### Coverage by engineering-spec section

| Engineering-spec section | Task(s) | Notes |
|---|---|---|
| §1 Goal: `bash` tool | task-02 | |
| §1 Goal: `edit_file` tool | task-03 | |
| §1 Goal: permission/approval seam | task-04 | |
| §1 Goal: cancellation threading | task-01, task-05 | task-01 adds the types and `NodePlatform` plumbing; task-05 wires `context.signal` in `agentLoop` and adds the integration test |
| §3.1 Primary flow: model issues `bash` call | task-02 | |
| §3.1 Primary flow: model issues `edit_file` call | task-03 | |
| §3.1 Primary flow: abort terminates shell process | task-01 (platform), task-05 (integration test) | |
| §3.1 Consumer `approvalHandler` usage | task-04, task-05 | |
| §3.2 States matrix: `bash` success | task-02 | |
| §3.2 States matrix: `bash` denied | task-04 | |
| §3.2 States matrix: `bash` command failed (non-zero exit) | task-02 | |
| §3.2 States matrix: `edit_file` success | task-03 | |
| §3.2 States matrix: `edit_file` no match | task-03 | |
| §3.2 States matrix: `edit_file` multiple matches | task-03 | |
| §3.2 States matrix: `edit_file` denied | task-04 | |
| §3.2 States matrix: `edit_file` file missing | task-03 | |
| §3.3 Accessibility | N/A — headless library, no UI | Confirmed per spec §3.3 |
| §3.4 Edge cases: `bash` pipes/redirects (`shell: true`) | task-02 | |
| §3.4 Edge cases: `bash` timeout clamping | task-02 | |
| §3.4 Edge cases: `bash` large output (full string, no truncation) | task-02 | Implementation note only; no truncation code added |
| §3.4 Edge cases: `bash` abort mid-run (SIGTERM) | task-01 (NodePlatform), task-05 (integration) | |
| §3.4 Edge cases: `edit_file` empty `old_string` on existing file | task-03 | |
| §3.4 Edge cases: `edit_file` `old_string === new_string` | task-03 | |
| §3.4 Edge cases: `approvalHandler` throws | task-04 | |
| §3.4 Edge cases: `approvalHandler` not provided | task-04 | Existing tests remain unmodified; blanket allow is the default |
| §3.5 Microcopy: denied string | task-04 | Exact string asserted in test |
| §3.5 Microcopy: check failed string | task-04 | Exact string asserted in test |
| §3.5 Microcopy: edit — no match | task-03 | Exact string asserted in test |
| §3.5 Microcopy: edit — multiple matches | task-03 | Exact string asserted in test |
| §3.5 Microcopy: edit — old === new | task-03 | Exact string asserted in test |
| §3.5 Microcopy: edit — file missing | task-03 | Exact string asserted in test |
| §3.5 Microcopy: edit — empty old_string on existing file | task-03 | Exact string asserted in test |
| §6.1 `types/tool.ts`: `signal?` on `ToolCallContext` | task-01 | |
| §6.1 `types/platform.ts`: `shell?`, `signal?` on `ExecOptions` | task-01 | |
| §6.1 `loop/loop.ts`: `context.signal`, `approvalHandler` in `LoopParams` | task-05 (context.signal), task-04 (LoopParams type), task-05 (threading) | |
| §6.1 `loop/runTools.ts`: approval gate | task-04 | |
| §6.1 `platform/node.ts`: forward `shell`, `signal` to `execFileAsync` | task-01 | |
| §6.1 `agent.ts`: `approvalHandler?` on `AgentOptions`, thread to `agentLoop` | task-04 (type), task-05 (threading) | |
| §6.1 `index.ts`: new exports | task-05 | |
| §6.2 New file `tools/builtin/bash.ts` | task-02 | |
| §6.2 New file `tools/builtin/editFile.ts` | task-03 | |
| §6.3 `ApprovalDecision` type | task-04 | Defined in `types/tool.ts` |
| §6.3 `ApprovalHandler` type | task-04 | Defined in `types/tool.ts` |
| §6.3 `AgentOptions.approvalHandler?` | task-04 | |
| §6.3 `LoopParams.approvalHandler?` | task-04 | |
| §6.3 `ToolCallContext.signal?` | task-01 | |
| §6.3 `ExecOptions.shell?`, `ExecOptions.signal?` | task-01 | |
| §8.1 `bash` input schema (command, timeout, description) | task-02 | |
| §8.1 `bash` execution contract (timeout clamping, shell: true, non-zero exit not thrown) | task-02 | |
| §8.2 `edit_file` input schema | task-03 | |
| §8.2 `edit_file` execution contract (all 4 paths: no-op, creation, normal, error) | task-03 | |
| §8.3 Permission gate pseudocode | task-04 | |
| §8.4 Cancellation threading / signal chain | task-01 (NodePlatform), task-05 (agentLoop) | |
| §8.4 `NodePlatform.exec` conditional spread for `shell` and `signal` | task-01 | |
| §9 Edge cases (engineering-facing, all bullets) | task-01, task-02, task-03 | Individually called out in per-task acceptance criteria |
| §11 Success criteria — functional (all 15 bullets) | tasks 01–05 | See per-task acceptance criteria for mapping |
| §11 Success criteria — non-functional: no direct `child_process`/`fs`/`process` outside `node.ts` | task-02 + task-03 | Negative assertion in briefs |
| §11 Success criteria — non-functional: typecheck passes | task-05 | `pnpm typecheck` run in task-05 acceptance criteria; each earlier task also runs it |
| §11 Success criteria — non-functional: lint passes | task-05 | `pnpm lint` run in task-05 acceptance criteria |
| §11 Success criteria — non-functional: 140 existing tests still pass | every task | Each brief's acceptance criteria includes `pnpm test` with 140 tests passing |
| §12 Test strategy: `bash.test.ts` | task-02 | |
| §12 Test strategy: `editFile.test.ts` | task-03 | |
| §12 Test strategy: `runTools.test.ts` additions | task-04 | |
| §12 Test strategy: `node.test.ts` additions (shell mode) | task-01 | `node.test.ts` created/extended in task-01 |
| §12 Test strategy: abort propagation integration test | task-05 | |

### Explicit deferrals

All seven items from spec §13 are confirmed deferred — none appear in any task brief:

- **Read-before-edit enforcement** — deferred to SDK layer; already logged in `docs/project/known-issues.md`.
- **`bash` output truncation** — deferred; full stdout/stderr returned. Future: `outputSizeCap` on `ExecOptions`.
- **SIGKILL grace period** — deferred; SIGTERM only via Node's `execFile` + `AbortSignal`. Future: `spawn`-based `NodePlatform` enhancement.
- **`bash` background task support** — deferred; out of scope.
- **Sandbox integration** — deferred; out of scope.
- **`edit_file` quote normalization and stale-read check** — deferred; out of scope.
- **Allow/deny rule patterns** — deferred to SDK or future `PermissionPolicy` helper; the `approvalHandler` callback is the extension point.

## Open questions

None. All 8 research open questions are resolved in `docs/feature/agent-tooling/decisions.md`. No cross-feature decisions arose; `docs/project/decisions.md` is untouched.

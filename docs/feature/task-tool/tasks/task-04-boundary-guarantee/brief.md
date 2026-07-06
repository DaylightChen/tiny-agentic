# Task 04 — Parent/child boundary guarantee (leak-proof, end-to-end)

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Lock the user's **hard requirement** (engineering-spec E7 / SC "No `Message`, `ContentBlock`, or `ProviderEvent` crosses the parent/child boundary") as an **end-to-end runtime assertion**, complementing the compile-time guarantee the types already give. This task adds one dedicated test file — `packages/core/src/__tests__/subagent-boundary.test.ts` — that runs a **full parent → child → parent** flow (parent `MockProvider` calls the `task` tool; child `MockProvider` emits text + a tool call + a terminal that *carries a full `messages` transcript*) and asserts that **nothing provider-native leaks** onto the parent's surface:

- **T10 — sanitized events only (E7, SC8):** for every `subagent_event` on the parent stream, the wrapped `event` has **no** `messages` key, **no** `content`/`ContentBlock` shape, and `tool_result` child events have **no** `result` field.
- **T11 — result is a string (E7):** the parent's `tool_result.result` for the `task` call is `typeof === "string"` (never an object/array/`Message`).
- **T12 — terminal reduced (data model):** the child terminal surfaces as a `SubagentChildEvent` of shape `{ type: "terminal", reason, usage, errorMessage? }` only — no `messages`, no extra provider fields.

Nothing in production changes here — task-02 (what the loop yields) and task-03 (what the tool emits/returns) already make the boundary hold. This task **proves** the runtime path matches the type-level promise, on a child deliberately constructed to *try* to leak (a terminal with a populated `messages` transcript of provider-shaped `tool_use`/`tool_result` blocks). It is a separate task and a separate file because leak-proofness is the feature's central promise and deserves an isolated review pass; if any assertion fails, the fix lands in `sanitizeChildEvent` (task-03) or the loop flush (task-02), and this test is the regression guard.

## Context files

- `docs/feature/task-tool/engineering/2026-07-01-task-tool-engineering.md` — binding spec. Focus on: **Edge cases E7** (boundary leak), the **"On the `tool_result` child event carrying no `result`"** note, **Data model changes** (the normalized-boundary invariant; `SubagentChildEvent` omits `messages`), and **Test plan → `subagent-boundary.test.ts`** rows T10-T12.
- `docs/feature/task-tool/decisions.md` — "Normalized parent/child boundary; usage rolls up via `Terminal.usage` only" (the type-level, structural framing of the invariant).
- `docs/feature/task-tool/plan/implementation-plan.md` — Coverage rows for E7 and "Data model changes".
- `packages/core/src/tools/builtin/task.ts` — **as committed after task-03.** `createTaskTool` and `sanitizeChildEvent` (the single choke point). This test imports `createTaskTool`.
- `packages/core/src/types/events.ts` — `SubagentChildEvent` shape (the four arms; `tool_result` has no `result`, `terminal` has no `messages`) and the `subagent_event` arm on `AgentEvent`.
- `packages/core/src/types/messages.ts` — `Message`/`ContentBlock`/`ToolUseBlock`/`ToolResultBlock` — used to build the child's *leaky* terminal `messages` transcript the test tries to smuggle through.
- `packages/core/src/agent.ts` — the child `Agent`; the child terminal's `messages` field is what carries the transcript that must not cross.
- `packages/core/src/__tests__/loop.test.ts` — the `MockProvider`/`MockPlatform`/`collectEvents` harness to reuse. Model the parent + child scripts on the T1/T15 patterns established in tasks 02-03.
- `packages/core/src/__tests__/task-tool.test.ts` — **as committed after task-03.** Reuse its parent/child scripting scaffolding (or the shared mock helpers) so this file stays consistent with T1-T9.

## Downstream dependencies

- None. This is a leaf test task; no later task imports from it. Its value is as a permanent regression guard on the boundary. Keep the assertions strict (structural, not string-matching) so a future refactor that reintroduces a leak fails here.

## Steps

1. **Create the test file** `packages/core/src/__tests__/subagent-boundary.test.ts`. Import `createTaskTool`, `Agent`, `collectEvents`, and the `MockProvider`/`MockPlatform` helpers (import if exported; otherwise define minimal local versions matching `loop.test.ts`, as task-03 did). Import `Message`/`ContentBlock` types for constructing the leaky child transcript.

2. **Script a child that *tries* to leak.** Build a child `MockProvider` whose single turn emits: a `text_delta` ("child says hi"), a `tool_use` (so a `tool_result` child event is produced when the child runs that tool — give the child a trivial tool named `"leaky_child_tool"` that returns a structured object, e.g. `{ nested: { provider: "raw" }, marker: "CHILD_TRANSCRIPT_MARKER" }`, to prove the raw `result` is dropped), and a final `message_stop`. The child's *terminal* — the `agent_done`/`Terminal` returned by `child.run` — will carry `messages: Message[]` containing provider-shaped `tool_use`/`tool_result` blocks (this is automatic: `agentLoop` accumulates the transcript into `messages`). That transcript/raw result is what the boundary must **not** surface. The tool name itself is allowed to appear because `SubagentChildEvent.tool_use_start` and `.tool_result` intentionally retain `toolName`; use `"CHILD_TRANSCRIPT_MARKER"` and the raw nested result payload as the forbidden leak markers, not the tool name.

3. **Script the parent to call `task` once.** Parent `MockProvider`: turn 1 emits a `tool_use` for `task` (input `{ description: "d", prompt: "sub" }`), `message_stop`; turn 2 emits a `text_delta` ("parent done") and `message_stop`. Register the `task` tool via `createTaskTool({ resolveChild: () => new Agent({ provider: childProvider, tools: [leakyChildTool], platform: new MockPlatform() }) })` and any other parent tools as needed. Drive the parent with `collectEvents`.

4. **T10 — assert every `subagent_event` is sanitized.** From the collected parent `events`, filter `subagent_event`s. For each, inspect `ev.event` (the `SubagentChildEvent`):
   - Assert `!("messages" in ev.event)` — no transcript.
   - Assert `!("content" in ev.event)` and the object is not a `Message` (has no `role` key) — no `ContentBlock`/message shape.
   - For `ev.event.type === "tool_result"`: assert `!("result" in ev.event)` — the raw payload (`{ nested: { provider: "raw" } }`) is **not** present; only `toolName`/`toolCallId`/`isError`.
   - Deep-stringify each `ev.event` (`JSON.stringify`) and assert it does **not** contain `"CHILD_TRANSCRIPT_MARKER"` nor the raw child tool-result payload shape (e.g. `"nested":{"provider":"raw"}`). Do **not** forbid `"leaky_child_tool"` itself — the sanitized event intentionally retains `toolName`. The marker/raw-result absence proves no transcript or raw payload crossed. (This is the strong, refactor-proof assertion.)

5. **T11 — assert the tool result is a string.** Find the parent `tool_result` event whose `toolName === "task"`; assert `typeof toolResult.result === "string"`. Additionally assert it is **not** JSON that parses to an object with a `messages`/`role` field (a string is fine; a stringified transcript is not — assert the string does not contain `"CHILD_TRANSCRIPT_MARKER"`).

6. **T12 — assert the terminal child event is reduced.** Among the `subagent_event`s, find the one whose `ev.event.type === "terminal"`. Assert its keys are a subset of `{ type, reason, usage, errorMessage }` (i.e. `Object.keys(ev.event)` contains no `messages` and no key outside that set). Assert `ev.event.reason` is one of `"agent_done" | "max_turns_exceeded" | "agent_error"` and `ev.event.usage` is a `Usage`-shaped object (`inputTokens`/`outputTokens`/`cacheReadTokens` present).

7. **(Optional hardening) assert usage still rolled up.** As a sanity co-assertion (not strictly a boundary test but cheap here): assert the parent `terminal.usage` includes the child's reported usage — this confirms the boundary sanitization did not accidentally break the roll-up path (the two must coexist). Keep it light; the authoritative usage tests are T13-T14 in task-02.

8. **Typecheck and run the full suite.** T10-T12 plus all prior tests green.

## Acceptance criteria

- [ ] `pnpm -C packages/core typecheck` reports **zero errors**.
- [ ] `pnpm -C packages/core test` passes — all prior tests plus T10-T12 in `subagent-boundary.test.ts`.
- [ ] T10: for every `subagent_event` on the parent stream, the wrapped `event` has no `messages`, no top-level `content`/`role` message shape, and `tool_result` child events have no `result`; a `JSON.stringify` of each wrapped event contains **neither** the child-transcript marker string **nor** the raw child tool-result payload. The child tool name may appear as `toolName` and must not be treated as a leak.
- [ ] T11: the `task` call's `tool_result.result` is `typeof === "string"` and does not contain the child-transcript marker.
- [ ] T12: the child `terminal` `subagent_event` has only keys in `{ type, reason, usage, errorMessage }` — no `messages`, no provider-native field.
- [ ] Production files (`task.ts`, `loop.ts`, `runTools.ts`, `events.ts`, `tool.ts`) are **unchanged** by this task — it adds only `subagent-boundary.test.ts`. (If an assertion fails and reveals a real leak, the fix belongs in the relevant prior task's file and must be called out in the log as a scope note, but the expectation is no production change.)

## Output files

- Created: `packages/core/src/__tests__/subagent-boundary.test.ts` (T10-T12)

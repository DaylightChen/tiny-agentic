# Core Runtime Hardening — Product and Engineering Specification

**Date:** 2026-07-13
**Scope:** `feature/core-runtime-hardening`
**Pipeline:** standard feature (`research → engineering → plan → implement`)
**Status:** binding input to planning and implementation
**Upstream:** approved framing at `docs/superpowers/specs/2026-07-11-core-runtime-hardening-design.md`; research at `docs/feature/core-runtime-hardening/research/2026-07-13-core-runtime-hardening-research.md`

The implementation order is locked and must remain:

1. typed stop-reason terminal outcomes;
2. strict portability boundary;
3. concurrent safe filesystem batches;
4. documentation and release readiness.

## 1. Goal

Harden the headless `tiny-agentic` core for framework consumers by preserving why a provider stopped, restoring the promised platform-neutral main module graph, and overlapping independent read-only filesystem calls without changing model-visible result order or safety barriers. Consumers gain typed terminal decisions, custom platforms that do not depend on Node path/process behavior, and lower latency for batches of `read_file`, `ls`, `glob`, and `grep`; the final stage aligns documentation and prepares version `0.2.0` metadata without publishing, tagging, or creating a release.

## 2. Motivation

The shipped core has all Tier-1 capabilities, but three correctness gaps remain. Provider adapters observe stop reasons and the loop discards them, so truncation, filtering, refusal, and future provider outcomes look like natural completion. Discovery tools re-exported by the main entry import `node:path` and read process state, contradicting the injected `Platform` boundary. Finally, the `isConcurrencySafe` seam exists while all tool calls remain sequential, leaving avoidable filesystem latency. Documentation and package metadata still describe older behavior. These concerns share provider, event, loop, tool, and Platform contracts, so resolving them in the locked dependency order avoids repeated public-API churn.

## 3. User-visible behavior

The package is headless. “User-visible” means observable TypeScript API shapes, yielded events, tool results, and exact framework-produced error strings.

### 3.1 Primary flow

1. A consumer runs an `Agent` as today and narrows `AgentEvent` by `type`.
2. Every completed provider turn yields `turn_complete` with a required structured `stopReason`. Tool-use turns expose their reason and continue automatically when buffered tool calls exist. A tool-free turn yields `agent_done` and returns a matching `Terminal`, both carrying the final structured reason.
3. Consumers switch exhaustively on `stopReason.kind` for normalized behavior and inspect `stopReason.raw` when diagnostics or provider-compatible future values matter. Valid stops retain partial text, messages, and usage and do not become `agent_error`.
4. Built-in model-facing tools load through `tiny-agentic` without importing Node built-ins or reading process globals. Relative paths resolve through the injected platform; returned discovery paths use that platform’s grammar and display formatting.
5. When one model turn contains contiguous approved calls marked concurrency-safe, `runTools` starts the safe calls together. Results, sanitized child events, usage attribution, serialization, and the tool-result message remain in original model-call order. Unknown, malformed, invalid, denied, classifier-failed, unmarked, or unsafe calls are barriers.
6. `task` remains unmarked and sequential. Its child events and usage remain attributed to the spawning tool call.

### 3.2 States matrix

| Public surface | Empty | Loading / in progress | Error | Partial | Offline |
|---|---|---|---|---|---|
| Provider/agent completion | A tool-free turn with no text still yields `turn_complete.stopReason`, `agent_done.stopReason`, and `Terminal.stopReason`; no invalid empty assistant message is appended. | Text/reasoning events stream unchanged. Stop reason becomes available only when `message_stop` is observed. | Provider/runtime exceptions remain `agent_error`; no `stopReason` is invented on that variant. | Truncation, filter, refusal, pause, context-window, and unknown valid stops preserve accumulated text/messages/usage and terminate as `agent_done` when no tool calls exist. | Network unavailability remains a provider exception and therefore `agent_error`, not a stop reason. |
| Discovery tools on a portable Platform | Empty `ls`/`glob`/`grep` results retain existing structured empty shapes and `truncated:false`. | Calls are awaited; no new progress event is introduced. Safe siblings may overlap. | Existing per-tool errors remain `tool_result` errors. Classifier failure uses the exact string in §3.5. | Existing caps and `truncated` fields remain unchanged. | There is no core offline mode; a custom local/virtual Platform may continue to work without network or Node. |
| Safe batch | An empty call list yields nothing. | All calls in one maximal contiguous safe batch may be active; no batch result is yielded until every started call settles. | One call failure produces only that call’s error result and does not cancel successful siblings. | On cancellation, already-started calls settle; unstarted calls receive deterministic cancellation results and no new work starts. | N/A; depends on each injected Platform operation. |

### 3.3 Accessibility

N/A — `packages/core` has no rendered UI, focus order, keyboard interaction, color signal, or ARIA surface. The machine-readable equivalent is satisfied by discriminated event/terminal unions, a closed `StopReason.kind`, explicit `isError`/`truncated` fields, and stable tool-call IDs; a keyboard-only human flow belongs to a separate UI package.

### 3.4 Edge-case behaviors

- A future or OpenAI-compatible stop string is represented as `{ kind: "other", raw: <string> }`, not discarded and not widened into an untyped string union.
- A cleanly ended stream with no observed native reason is `{ kind: "other", raw: null }`; it is not falsely labeled natural completion.
- Buffered tool calls control continuation even if a provider reports an inconsistent reason. A `tool_use` reason with no buffered calls terminates and remains visible rather than causing an empty loop.
- Anthropic `pause_turn` is a terminal provider outcome in this feature. Automatic resubmission/continuation for pause turns is not introduced.
- A very large safe batch has no framework concurrency cap in this release; every approved call in the maximal batch starts. Resource amplification is an accepted risk documented in §8.
- Cancellation prevents new execution after the signal is observed and is delivered to every active call through its per-call context. `read_file` and `ls` cannot interrupt an already-running `Platform.readFile`/`Platform.listDir` syscall because those signatures remain signal-free.
- External filesystem mutation can cause concurrently read files to represent slightly different instants. The framework introduces no internal write race because mutating calls are barriers.

### 3.5 Microcopy

No CTA or visual copy is added. Structured stop reasons are data, not synthesized prose. Existing tool error strings remain stable. New exact framework-produced strings are:

- classifier throws: `"Tool '<name>': concurrency safety check failed — <error message>"`
- call not started because cancellation was observed: `"Tool '<name>': call cancelled before start"`

Existing relevant strings remain:

- unknown tool: `"Unknown tool: '<name>'"`
- malformed JSON input: `"Tool '<name>': could not parse tool input as JSON"`
- invalid input: `"Tool '<name>': invalid input — <zod message>"`
- approval failure: `"Tool '<name>': approval check failed — <error message>"`
- denial: `"Tool '<name>': call denied by approvalHandler"`
- serialization failure: `"Tool '<name>': could not serialize result — <error message>"`

## 4. Out of scope

- Concurrent `task`/sub-agent calls.
- Real-time child-event forwarding, new child-event queues, or child usage-attribution redesign.
- Automatic continuation for Anthropic `pause_turn`.
- A provider retry/watchdog redesign or a new `agent_aborted` terminal reason.
- General per-tool timeout or configurable concurrency-limit API.
- Adding abort options to `Platform.readFile` or `Platform.listDir`; in-flight syscall interruption for those methods remains unsupported.
- A universal POSIX path grammar, browser path polyfill dependency, or broad general-purpose Path service.
- Removing or deprecating `Platform.stat`.
- Permission policy modes, context compaction, sessions, memory, skills, MCP, sandboxing, UI, or new grep features.
- Publishing to npm, tagging Git, creating a GitHub release, or changing release channels.

## 5. Architectural fit

### 5.1 Stop-reason contracts

#### 5.1.1 Public normalized representation

Add the following to `packages/core/src/types/provider.ts` and export both types from `packages/core/src/index.ts`:

```typescript
export type StopReasonKind =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "pause_turn"
  | "refusal"
  | "content_filter"
  | "model_context_window_exceeded"
  | "other";

export type StopReason =
  | { kind: "end_turn"; raw: string | null }
  | { kind: "tool_use"; raw: string | null }
  | { kind: "max_tokens"; raw: string | null }
  | { kind: "stop_sequence"; raw: string | null }
  | { kind: "pause_turn"; raw: string | null }
  | { kind: "refusal"; raw: string | null }
  | { kind: "content_filter"; raw: string | null }
  | { kind: "model_context_window_exceeded"; raw: string | null }
  | { kind: "other"; raw: string | null };
```

`kind` is the closed, provider-neutral decision surface. It supports an exhaustive switch and changes only when the framework deliberately adds a new normalized behavior. `raw` is required on every arm and carries the provider’s exact native reason; `null` means the stream ended without exposing one. Unknown future/vendor-compatible strings use `kind:"other"` and preserve the string in `raw`.

A separate `provider` discriminator is not added: the active `Provider` instance is already host configuration, while adding vendor names to this core type would weaken provider neutrality.

#### 5.1.2 Exact event and terminal changes

```typescript
// types/provider.ts
export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown; inputParseError?: boolean }
  | { type: "message_stop"; stopReason: StopReason; usage?: Usage };

// types/events.ts — relevant arms
export type AgentEvent =
  // existing non-terminal arms unchanged
  | { type: "turn_complete"; turnIndex: number; stopReason: StopReason; usage?: Usage }
  | { type: "agent_done"; messages: Message[]; usage: Usage; stopReason: StopReason }
  | { type: "max_turns_exceeded"; turnsUsed: number; messages: Message[]; usage: Usage }
  | { type: "agent_error"; error: Error; messages: Message[]; usage: Usage };

export type Terminal =
  | { reason: "agent_done"; messages: Message[]; usage: Usage; stopReason: StopReason }
  | { reason: "max_turns_exceeded"; messages: Message[]; turnsUsed: number; usage: Usage }
  | { reason: "agent_error"; messages: Message[]; error: Error; usage: Usage };

export type SubagentChildEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_use_start"; toolName: string; toolInput: unknown }
  | { type: "tool_result"; toolName: string; toolCallId: string; isError: boolean }
  | { type: "terminal"; reason: "agent_done"; usage: Usage; stopReason: StopReason }
  | { type: "terminal"; reason: "max_turns_exceeded"; usage: Usage }
  | { type: "terminal"; reason: "agent_error"; usage: Usage; errorMessage?: string };
```

Required/optional decisions:

- `ProviderEvent.message_stop.stopReason`: required. Every provider mapper must normalize once at the boundary.
- `turn_complete.stopReason`: required for every provider turn, including tool-use turns.
- `agent_done.stopReason` and `Terminal`’s `agent_done.stopReason`: required and equal to that final `turn_complete.stopReason`.
- `max_turns_exceeded` and `agent_error`: no stop reason, because they are engine/runtime terminals rather than completed provider outcomes.
- sanitized child `terminal` with `reason:"agent_done"`: required `stopReason`; the other child terminal arms do not have it.
- Existing optional `usage` semantics are unchanged (`message_stop.usage?`, `turn_complete.usage?`); terminal usage stays required.

This is intentionally source-breaking for custom `Provider` implementations and hand-constructed `AgentEvent`/`Terminal` literals. Making fields optional would violate the feature guarantee and force every consumer back to guessing. Under the package’s pre-1.0 policy, the change is proposed for `0.2.0`, documented as breaking, and enforced by compile-time type tests. There is no deprecated parallel string field and no silent legacy adapter.

#### 5.1.3 Provider mappings

Add pure normalizers in the mapper modules (they may remain module-private; tests exercise them through emitted events).

**Anthropic:**

| Native `stop_reason` | `StopReason.kind` | `raw` |
|---|---|---|
| `end_turn` | `end_turn` | `"end_turn"` |
| `tool_use` | `tool_use` | `"tool_use"` |
| `max_tokens` | `max_tokens` | `"max_tokens"` |
| `stop_sequence` | `stop_sequence` | `"stop_sequence"` |
| `pause_turn` | `pause_turn` | `"pause_turn"` |
| `refusal` | `refusal` | `"refusal"` |
| `model_context_window_exceeded` | `model_context_window_exceeded` | exact string |
| any other string | `other` | exact string |
| absent at `message_stop` | `other` | `null` |

`InputAccumulator` stores `string | undefined` and normalizes only when constructing `message_stop`. It no longer defaults an absent reason to `end_turn`.

**OpenAI Chat Completions:**

| Native data | `StopReason.kind` | `raw` |
|---|---|---|
| `finish_reason:"stop"` | `end_turn` | `"stop"` |
| `finish_reason:"tool_calls"` | `tool_use` | `"tool_calls"` |
| `finish_reason:"length"` | `max_tokens` | `"length"` |
| `finish_reason:"content_filter"` | `content_filter` | `"content_filter"` |
| deprecated `finish_reason:"function_call"` | `tool_use` | `"function_call"` |
| non-empty streamed `delta.refusal` plus `finish_reason:"stop"` or no finish reason | `refusal` | `"stop"` or `null`, respectively |
| any other string | `other` | exact string |
| no finish reason and no refusal data | `other` | `null` |

`ToolCallAccumulator.applyDelta` records whether any non-empty `delta.refusal` fragment was observed. Explicit `tool_calls`, `function_call`, `length`, or `content_filter` remains authoritative even if a compatible endpoint also sends a refusal field. Refusal overrides only `stop`/missing, the combinations used by the documented refusal channel; unknown future finish reasons remain `other` rather than being overwritten by inference.

OpenAI cannot distinguish a natural stop from a caller-supplied stop sequence through `finish_reason:"stop"`; it therefore maps to `end_turn` and preserves `raw:"stop"` rather than inventing `stop_sequence`.

#### 5.1.4 Loop behavior

`agentLoop` declares `let turnStopReason: StopReason | undefined` beside per-turn usage and assigns it from each `message_stop`. A provider stream that ends without emitting `message_stop` is a provider contract violation: throw `Error("Provider stream ended without message_stop")`, caught by the existing provider-error boundary and surfaced as `agent_error` with partial messages/usage. This prevents construction of required terminal fields from invented data.

After a valid stop:

- append partial text/tool blocks exactly as today;
- increment the turn count;
- if `pendingToolUses.length > 0`, execute tools regardless of `stopReason.kind`, yield `turn_complete` with the reason, and continue;
- if there are no pending tool calls, yield `turn_complete`, then `agent_done`, then return `Terminal`, all with the same reason;
- do not special-case `max_tokens`, filter, refusal, pause, context-window, or `other` into `agent_error`;
- do not automatically continue `pause_turn`.

This treats buffered protocol data as the continuation authority and the reason as observable metadata, preserving current resilience to inconsistent compatible endpoints.

`sanitizeChildEvent` copies `stopReason` from child `agent_done` into the sanitized child terminal. `mapChildTerminalToResult` behavior and microcopy remain unchanged.

### 5.2 Strict portability boundary

#### 5.2.1 Smallest coherent Platform seam

Choose platform-owned path grammar through two high-level capabilities, not a broad Node-like Path API and not a hard-coded POSIX helper:

```typescript
// types/platform.ts
export interface Platform {
  /** Resolve an absolute or platform-relative model path against this platform's cwd. */
  resolvePath(path: string): string;

  /** Format a resolved path for model output: cwd-relative when inside cwd,
   *  "." when equal to cwd, otherwise unchanged absolute/canonical form. */
  formatPath(path: string): string;

  // existing methods remain, including stat
  cwd(): string;
  readFile(path: string, encoding?: "utf-8"): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  listDir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<DirEntry>;
  glob(pattern: string, options?: GlobOptions): Promise<GlobResult>;
  grep(pattern: string, flags: string, options?: GrepOptions): Promise<GrepPlatformResult>;
}
```

Path grammar is **per-platform**, not globally POSIX. `NodePlatform` uses native `node:path` semantics for the host OS. A browser/VFS platform may use POSIX-like, URL-like, or another internally consistent grammar. Model-facing tools never split, join, resolve, relativize, or test absoluteness themselves.

`NodePlatform.resolvePath(path)` is `node:path.resolve(this.cwd(), path)`. `NodePlatform.formatPath(path)` first resolves/canonicalizes the input, computes `relative(this.cwd(), resolved)`, returns `"."` for the cwd itself, returns the relative value only when it is inside cwd, and otherwise returns the resolved absolute value. Existing root behavior follows native path semantics: cwd `/` formats `/` as `.` and `/a` as `a`; with cwd `/work`, `/` remains `/` because it is outside cwd.

Tool changes:

- `ls.ts`: call `platform.resolvePath(input.path)`, then `platform.listDir`; remove `node:path`, `globalThis.process`, and local sorting.
- `glob.ts`: if `input.path` exists, pass `cwd: platform.resolvePath(input.path)`; map output through `platform.formatPath`.
- `grep.ts`: if `input.path` exists, pass `path: platform.resolvePath(input.path)`; map files/matches through `platform.formatPath`.
- delete `tools/builtin/_paths.ts`.
- `read_file`, `write_file`, and `edit_file` retain their existing raw-path delegation. Their Platform operations already own interpretation, and broadening this feature into mutation-path normalization would change unrelated behavior.

#### 5.2.2 Ordering ownership

Platform owns discovery ordering. The contracts are tightened without changing signatures:

- `listDir` returns entries in display order.
- `glob` returns `paths` in display order.
- `grep` returns `files` in display order and `matches` grouped by that file order, then line ascending.
- Model-facing tools preserve Platform order and only cap/format/project fields; they do not sort.

`NodePlatform` behavior remains:

- production: modification time descending;
- equal modification time: name/path ascending by JavaScript code-unit comparison;
- `NODE_ENV === "test"`: name/path ascending regardless of mtime;
- `grep` lines within a file: line ascending.

The tie-break is new precision, not a user-visible reorder where mtimes differ. `NodePlatform.listDir` performs this sort after metadata collection. `fs-discovery.ts` updates `sortWalked` to use the ascending path tie-break when `b.mtimeMs - a.mtimeMs === 0`.

A custom Platform decides how it detects a deterministic-test mode; the core does not read an environment variable. Its observable obligation is simply to return deterministic order according to its documented policy.

#### 5.2.3 Every implementor update

The two required methods are a source break and must be added to every current implementor/object literal:

1. `packages/core/src/platform/node.ts` — real native implementation.
2. `packages/core/src/__tests__/agent.test.ts` — `MockPlatform`.
3. `packages/core/src/__tests__/agent-tooling-integration.test.ts` — object-literal `Platform`.
4. `packages/core/src/__tests__/bash.test.ts` — `MockPlatform`.
5. `packages/core/src/__tests__/builtin-tools.test.ts` — `MockPlatform`.
6. `packages/core/src/__tests__/editFile.test.ts` — `MockPlatform`.
7. `packages/core/src/__tests__/env-context.test.ts` — `MockPlatform`.
8. `packages/core/src/__tests__/loop.test.ts` — `MockPlatform`.
9. `packages/core/src/__tests__/runTools.test.ts` — `MockPlatform`.
10. `packages/core/src/__tests__/subagent-boundary.test.ts` — `MockPlatform`.
11. `packages/core/src/__tests__/task-tool.test.ts` — `MockPlatform`.

Mocks used only outside discovery may use identity/sentinel implementations. Discovery portability tests must use a real in-memory/custom grammar implementation rather than Node helpers.

`Platform.stat` is retained, not deprecated. It is a coherent fine-grained filesystem capability, has shipped publicly, and its removal is unrelated to the hardening goals. A future breaking cleanup may reconsider it with broader Platform versioning; `0.2.0` does not create warning churn for a usable capability.

#### 5.2.4 ESLint and bundle enforcement

Restructure `eslint.config.js` into two independent core rulesets:

1. **Universal architecture rules** apply to every `packages/core/src/**/*.ts`, including `platform/**`: forbid imports from SDK/UI packages and UI libraries. Platform modules do not receive an upward/UI exemption.
2. **Environment rules** apply to every core source file except the explicit allowlist:
   - `packages/core/src/platform/node.ts`
   - `packages/core/src/platform/fs-discovery.ts`

The environment rules:

- derive the complete bare Node builtin list from `builtinModules` in `node:module` inside the ESLint config and feed it to `no-restricted-imports`;
- reject `node:*` via a restricted-import pattern;
- reject bare `process` with `no-restricted-globals`;
- reject `globalThis.process` and `global.process` with `no-restricted-properties` (including current `globalThis.process` bypass);
- use messages naming the two explicit Node platform modules, not the stale “only platform/node.ts” claim.

Tests under `packages/core/src/__tests__` are not exempt. Existing `node:path` test imports in `ls.test.ts`, `glob.test.ts`, `grep.test.ts`, `node.test.ts`, and `fs-discovery.test.ts` must be replaced with platform capabilities or fixture-local POSIX string helpers. This proves the rule is architectural rather than tailored only to production files.

Build proof is mandatory: after `pnpm build`, the main `dist/index.js` graph must contain no external import matching `node:*` and no `process`/`globalThis.process` access. `dist/platform/node.js` is expected to contain Node imports. Add an automated portability boundary test/script that scans the built main entry or tsup metafile; source grep alone is insufficient because static re-export reachability is the actual promise.

#### 5.2.5 Cancellation honesty

No signal parameter is added to `Platform.readFile` or `Platform.listDir`. Every tool call receives the run signal in its isolated `ToolCallContext`; the scheduler checks it before starting work. `glob`/`grep` continue forwarding it through their existing options and checking cooperatively during traversal. `read_file` and `ls` may observe that the signal has aborted before/after their awaited Platform call, but cannot interrupt an underlying in-flight syscall. Documentation and tests must say “no new work starts; active calls receive the signal,” not “all filesystem work aborts promptly.”

### 5.3 Concurrent safe filesystem batches

#### 5.3.1 Internal result envelope and context factory

`runTools` is internal and may change its yield type. Introduce exact internal contracts in `packages/core/src/loop/runTools.ts`:

```typescript
type ToolUseEntry = {
  id: string;
  name: string;
  input: unknown;
  parseError?: boolean;
};

type ToolResultEvent = Extract<AgentEvent, { type: "tool_result" }>;

type ToolExecution = {
  event: ToolResultEvent;
  childEvents: SubagentChildEvent[];
  reportedUsage: Usage[];
};

type PreparedExecution = {
  toolUse: ToolUseEntry;
  tool: Tool;
  input: unknown;
  concurrencySafe: boolean;
  context: ToolCallContext;
  childEvents: SubagentChildEvent[];
  reportedUsage: Usage[];
};

export async function* runTools(
  toolUses: ToolUseEntry[],
  registry: ToolRegistry,
  platform: Platform,
  baseContext: ToolCallContext,
  approvalHandler?: ApprovalHandler,
): AsyncGenerator<ToolExecution>;
```

For each executable call, create a fresh context and fresh attribution buffers:

```typescript
const childEvents: SubagentChildEvent[] = [];
const reportedUsage: Usage[] = [];
const context: ToolCallContext = {
  ...baseContext,
  toolCallId: toolUse.id,
  reportUsage: (usage) => { reportedUsage.push(usage); },
  emitEvent: (event) => { childEvents.push(event); },
};
```

This shallow-copies all enumerable declaration-merged fields while replacing the three core-owned per-call attribution fields. A tool mutating properties on its own context object cannot affect a sibling’s context. Referenced objects in declaration-merged fields are not deep-cloned; a custom tool may mark itself safe only if concurrent access to those references is safe. Core guarantees that `toolCallId`, child events, and reported usage never share storage across calls.

`loop.ts` no longer installs mutable batch-wide sinks. For each yielded `ToolExecution`, in model order it:

1. yields that envelope’s `childEvents` as `subagent_event` with `taskId = event.toolCallId`;
2. yields the `tool_result` event;
3. serializes and appends the matching result block;
4. folds only that envelope’s `reportedUsage` into cumulative usage.

Result-block serialization remains in `loop.ts` and remains ordered exactly as today. `task` therefore keeps batch-before-result child-event behavior and exact usage attribution while staying sequential.

#### 5.3.2 Safety marker

Add `isConcurrencySafe: () => true` to `readFileTool`. Retain the existing markers on `ls`, `glob`, and `grep`. `write_file`, `edit_file`, `bash`, and every `task` factory output remain unmarked.

Update `Tool.isConcurrencySafe` documentation:

- called synchronously after successful Zod validation and before approval;
- must be pure, deterministic, and side-effect-free;
- `true` certifies that overlapping this call with other safe calls cannot violate the tool/Platform contract;
- absence or `false` means sequential barrier;
- throwing produces the classifier error result and a barrier; the call and approval handler are not invoked.

A custom Platform is contractually expected to implement read methods as reads. The framework cannot detect hidden side effects in a dishonest Platform implementation.

#### 5.3.3 Preparation and scheduling algorithm

Use a lazy, model-order scheduler. Preparation for a call follows this exact order:

1. registry lookup;
2. provider parse-error check;
3. Zod `safeParse` validation;
4. `tool.isConcurrencySafe?.(validatedInput) === true` classification;
5. approval handler with `(tool.name, validatedInput)`.

The abort guard runs before preparation and again immediately before execution; it is operational cancellation, not part of semantic validation.

Algorithm:

1. Set `index = 0` and `safeBatch = []`.
2. Lazily prepare only `toolUses[index]`; never prepare a call after a known barrier.
3. Lookup/parse/validation failure produces the existing error envelope and classifies the call as a barrier. If `safeBatch` is non-empty, execute and yield it first; then yield the barrier result. No approval or `tool.call` occurs for that barrier.
4. If `isConcurrencySafe` throws, produce `"Tool '<name>': concurrency safety check failed — <message>"`, classify as a barrier, do not invoke approval or `tool.call`, flush any preceding safe batch first, then yield the error.
5. If classification is absent/false, flush any preceding safe batch before invoking approval for the unsafe call. Then approve serially and execute it alone, or yield its denial/approval-error result. Do not prepare the following call until this barrier is yielded.
6. If classification is true, invoke approval serially. An approval throw/denial becomes a barrier: flush earlier approved safe calls, then yield the approval error/denial; the denied call never starts. An approved call is appended to `safeBatch` and preparation advances to the next call.
7. At end of input, or when the next barrier is reached, start every prepared call in `safeBatch` in input order without awaiting between starts. This is one maximal contiguous approved safe batch; no call beyond a barrier was inspected.
8. Await `Promise.allSettled` for the batch. Settlement records preserve input order. Convert each record to a total `ToolExecution`, then yield in batch/input order.
9. Clear `safeBatch` and continue after the barrier.

Approval handlers are never concurrent. Their invocation order remains model order. Approval for contiguous safe calls necessarily completes before those calls start so disallowed work cannot race already-approved siblings. Unsafe-call approval remains after the preceding batch settles, preserving the barrier’s temporal boundary.

#### 5.3.4 Execution and rejection normalization

`executePrepared(prepared, platform): Promise<ToolExecution>` catches ordinary `tool.call` throws and returns the same raw error-message result used today. It never intentionally rejects.

`Promise.allSettled` is still required as a defensive boundary. If `executePrepared` unexpectedly rejects, normalize that settlement to:

```typescript
{
  event: {
    type: "tool_result",
    toolName: prepared.tool.name,
    toolCallId: prepared.toolUse.id,
    result: reason instanceof Error ? reason.message : String(reason),
    isError: true,
  },
  childEvents: prepared.childEvents,
  reportedUsage: prepared.reportedUsage,
}
```

All started siblings settle before any result is yielded. There are no unhandled rejections, and a failed safe call does not suppress sibling results.

#### 5.3.5 Barrier semantics

| Call condition | Barrier? | Approval? | `tool.call`? |
|---|---:|---:|---:|
| unknown tool | yes | no | no |
| provider parse error | yes | no | no |
| Zod-invalid input | yes | no | no |
| classifier throws | yes | no | no |
| safe but approval throws/denies | yes | yes, serial | no |
| unmarked / classifier false | yes | yes, after prior batch | yes, alone if allowed |
| marked safe and allowed | no; joins current safe batch | yes, serial | yes, concurrent within batch |
| `task` | yes (unmarked) | yes | yes, alone |

“Barrier” means: all preceding safe work settles and is yielded before the barrier result/execution; no following call is prepared or started until the barrier settles and is yielded.

#### 5.3.6 Cancellation

- Before preparing/starting a call, if `baseContext.signal?.aborted === true`, start no more work.
- Every remaining unstarted tool-use receives an ordered synthetic error envelope with `result: "Tool '<name>': call cancelled before start"`; no lookup, classifier, approval, or tool call runs for those entries. This preserves one tool result per provider tool-use and valid message pairing.
- Recheck after serial approval and immediately before starting a safe batch. If aborted, calls approved but not started receive the same cancellation result.
- All active calls share the same run `AbortSignal` value but have distinct context objects. `glob`/`grep` can reject cooperatively; `read_file`/`ls` may finish their current Platform operation before settling.
- Await every active settlement before yielding ordered results or synthesizing later cancellation results.
- The next provider turn receives the already-aborted signal and follows existing `agent_error` behavior. No new terminal reason is introduced.

#### 5.3.7 Concurrency limit

No concurrency cap or new configuration surface is added. The approved contract says every call in a maximal contiguous safe batch starts together, model tool-call lists are normally small, and a cap would add policy/configuration before evidence establishes a useful default. Large batches can increase descriptors, memory, and traversal load; this is a recorded implementation risk and a future additive option if real workloads require backpressure.

### 5.4 Module and file changes

**Stop reasons:**

- `packages/core/src/types/provider.ts` — new `StopReasonKind`/`StopReason`, structured `message_stop`, correct stale JSON-schema/logger comments.
- `packages/core/src/types/events.ts` — required reason fields and split sanitized terminal arms.
- `packages/core/src/providers/anthropic-mapper.ts` — exact modern mapping and missing/unknown fallback.
- `packages/core/src/providers/openai-mapper.ts` — exact finish mapping and refusal-field capture.
- `packages/core/src/loop/loop.ts` — per-turn capture, propagation, missing-stop contract error.
- `packages/core/src/tools/builtin/task.ts` — copy child final stop reason through sanitation.
- `packages/core/src/index.ts` — export new types.
- `packages/core/src/utils/collect.ts` — no algorithm change; updated type flows through.

**Portability:**

- `packages/core/src/types/platform.ts` — two required path capabilities and ordering documentation.
- `packages/core/src/platform/node.ts` — path capabilities, ordered `listDir`, corrected boundary comments.
- `packages/core/src/platform/fs-discovery.ts` — production mtime tie-break and comment corrections.
- `packages/core/src/tools/builtin/ls.ts`, `glob.ts`, `grep.ts` — consume Platform capabilities and preserve Platform order.
- `packages/core/src/tools/builtin/_paths.ts` — delete.
- `eslint.config.js` — split universal/environment restrictions and explicit allowlist.
- all implementors in §5.2.3 and path-importing tests in §5.2.4.

**Concurrency:**

- `packages/core/src/types/tool.ts` — active hook contract.
- `packages/core/src/loop/runTools.ts` — preparation, barriers, batches, per-call contexts, all-settled aggregation, cancellation.
- `packages/core/src/loop/loop.ts` — consume attributed envelopes in order.
- `packages/core/src/tools/builtin/readFile.ts` — safe marker.
- `ls.ts`, `glob.ts`, `grep.ts` — markers retained.
- `task.ts` — no marker; description continues saying one at a time.

No new runtime dependency is required.

## 6. Data model changes

- New in-memory public types: `StopReasonKind` and `StopReason` (§5.1.1).
- Required `stopReason` fields on `ProviderEvent.message_stop`, `AgentEvent.turn_complete`, `AgentEvent.agent_done`, `Terminal.agent_done`, and sanitized child `terminal/agent_done` (§5.1.2).
- Two required `Platform` methods: `resolvePath` and `formatPath` (§5.2.1).
- Internal `ToolExecution`/`PreparedExecution` envelopes; they are not exported from the package.
- No storage, persistence, serialized-history, database, or wire migration. Stop reasons are live event metadata and are not added to `Message[]`.
- Source migration for consumers: custom providers construct `StopReason` objects; custom platforms implement two path methods and ordered discovery contracts; typed terminal literals add required reasons. These changes are documented under `0.2.0`.
- `exactOptionalPropertyTypes` applies throughout: optional `usage`/`errorMessage` fields use conditional spreads and are omitted rather than assigned `undefined`; `StopReason.raw` is required and explicitly permits `null`.

## 7. Edge cases

The behavioral edge cases are specified in §§3.4, 5.1.4, 5.2.5, and 5.3.3–5.3.6. The following test matrix makes each contract plan-ready.

### 7.1 Stop-reason mapping and propagation

| ID | Contract | Test location / assertion |
|---|---|---|
| SR-1 | Anthropic maps all seven documented values plus context-window and unknown exactly | `anthropic-mapper.test.ts`: table-driven events for `end_turn`, `tool_use`, `max_tokens`, `stop_sequence`, `pause_turn`, `refusal`, `model_context_window_exceeded`, and `future_reason`; assert `{kind,raw}`. |
| SR-2 | Anthropic missing reason is `other/null` | bare `message_stop`; assert no invented natural completion. |
| SR-3 | OpenAI maps `stop`, `tool_calls`, `length`, `content_filter`, deprecated `function_call`, unknown, and missing | `openai-mapper.test.ts`: table-driven flush assertions. |
| SR-4 | OpenAI refusal data maps refusal without losing finish value | stream non-empty `delta.refusal` with `finish_reason:"stop"`; assert `{kind:"refusal",raw:"stop"}`; refusal with no finish gives `raw:null`; explicit length/filter remains authoritative. |
| SR-5 | Natural final reason propagates to all surfaces | `loop.test.ts`: reason equality on `turn_complete`, `agent_done`, and `Terminal`. |
| SR-6 | Token/context/filter/refusal/unknown stops remain valid terminals | loop cases with partial text and usage; assert `agent_done`, preserved assistant text/messages/usage, and no `agent_error`. |
| SR-7 | Tool-use turn carries reason and continues | two-turn script; first `turn_complete.stopReason.kind === "tool_use"`, final terminal uses second reason. |
| SR-8 | Buffered tools win over inconsistent reason | tool call plus `end_turn` still executes and continues; no tools plus `tool_use` terminates visibly. |
| SR-9 | `pause_turn` does not auto-resubmit | tool-free pause emits one provider request and final `agent_done` with pause reason. |
| SR-10 | Missing `message_stop` is provider failure | stream ends after partial text; assert `agent_error`, partial text event retained, prior usage retained, exact error message. |
| SR-11 | Child sanitation preserves final reason only on `agent_done` | `task-tool.test.ts` and `subagent-boundary.test.ts`: sanitized terminal has structured reason and still has no messages/raw result. |
| SR-12 | Public type surface is exhaustive | `types.test.ts`: construct every `StopReason` arm, `assertNever` over `kind`, and compile-required event/terminal fields. |
| SR-13 | Provider integration emits structured reason | `anthropic.test.ts`/`openai.test.ts` update deep-equality fixtures and unknown/refusal integration cases. |

### 7.2 Portability

| ID | Contract | Test location / assertion |
|---|---|---|
| PT-1 | Custom Platform runs `ls`/`glob`/`grep` without Node helpers | new `portability.test.ts`: in-memory platform with a non-host cwd and explicit `resolvePath`/`formatPath`; no Node imports. |
| PT-2 | Relative input resolution is Platform-owned | custom platform records canonical paths received by `listDir`/`glob`/`grep`; assert each tool calls `resolvePath` first. |
| PT-3 | Under-cwd/equal/outside/root formatting | `node.test.ts` and custom tests: under cwd relative, equal `.`, outside absolute, root behavior as §5.2.1. |
| PT-4 | Path grammar is not forced to POSIX | custom grammar sentinel values round-trip through tools without splitting or `node:path` interpretation. |
| PT-5 | Platform ordering is preserved by tools | feed reverse/sentinel order and assert tools do not re-sort. |
| PT-6 | Node production ordering and tie-break | direct `NodePlatform`/helper tests: mtime descending; equal mtime name/path ascending. |
| PT-7 | Node test ordering remains name/path ascending | existing `ls`/`glob`/`grep`/`fs-discovery` assertions remain green. |
| PT-8 | Every Platform implementor compiles | workspace typecheck after all 11 updates. |
| PT-9 | Lint rejects Node imports/process outside allowlist | lint fixtures or config-level verification for `node:path`, bare `path`, `process`, and `globalThis.process`; universal UI/upward rules also tested against a platform-path fixture. |
| PT-10 | Main bundle has no Node dependency edge | build then automated scan/metafile assertion for `dist/index.js`; `dist/platform/node.js` remains the only public Node entry. |
| PT-11 | Model-facing tool source has zero Node/process access | lint plus static dependency scan covering all `tools/builtin/**`, not a hand-maintained subset. |
| PT-12 | Cancellation claim remains exact | pre-aborted calls never invoke custom `readFile`/`listDir`; active deferred calls receive an aborted context signal but may settle only when their deferred Platform promise resolves. |

### 7.3 Safe batching and attribution

Use controllable deferred promises rather than wall-clock sleeps except for an optional benchmark.

| ID | Contract | Test location / assertion |
|---|---|---|
| CB-1 | Safe calls overlap | `runTools.test.ts`: two marked calls both reach “started” before either deferred is resolved. |
| CB-2 | Reverse completion preserves result order | resolve second then first; yielded IDs/results remain first, second. |
| CB-3 | Safe → unsafe → safe barriers | first safe batch settles before unsafe starts; unsafe settles before following safe starts. |
| CB-4 | Initial safe set exact | marker tests for `read_file`, `ls`, `glob`, `grep`; negative marker assertions for write/edit/bash/task. |
| CB-5 | Unknown/parse-invalid/Zod-invalid barriers | preceding safe settles first; error emitted in place; following safe does not start early. |
| CB-6 | Denial/approval failure barriers | approvals invoked serially in model order; denied work never starts; following call waits. |
| CB-7 | Unmarked call barrier | approved unmarked tool executes alone with no overlap on either side. |
| CB-8 | Classifier false and throw | false behaves unmarked; throw yields exact classifier message, skips approval/call, and is a barrier. |
| CB-9 | Safe tool throws | sibling still settles; one error and one success emitted in original order. |
| CB-10 | Unexpected helper rejection | allSettled normalization produces one per-call error, retains that call’s buffered attribution, and creates no unhandled rejection. |
| CB-11 | Serialization order unchanged | `loop.test.ts`: reverse-completed values serialize into one user message in original tool-use order; serialization failure stays call-local. |
| CB-12 | Per-call toolCallId isolation | concurrent tools read different correct IDs; neither sees deletion/mutation from a sibling. |
| CB-13 | Per-call child-event isolation | concurrent custom safe tools emit distinct child events; each flushes before its own ordered result with the right `taskId`. |
| CB-14 | Per-call usage isolation | concurrent custom safe tools report distinct usage; cumulative terminal usage is exact with no cross-call duplication/loss. |
| CB-15 | `task` remains sequential | two task-like unmarked calls never overlap; existing child event/usage/boundary tests remain green. |
| CB-16 | Cancellation during safe batch | active calls see the same signal, every started promise settles, no following barrier starts, remaining calls get exact cancellation results. |
| CB-17 | Pre-aborted runTools | no lookup/classifier/approval/tool call occurs; one ordered cancellation result per tool-use. |
| CB-18 | Abort during serial approval | no approved-but-unstarted call begins after the signal; remaining results are deterministic cancellations. |
| CB-19 | No concurrency cap | a controlled batch of more than eight safe calls observes all calls started before any resolves. |
| CB-20 | Context cleanup across turns | no retained sink can report usage/events into a later call/turn; declaration-merged scalar fields survive the shallow clone. |

### 7.4 Documentation, examples, and verification

| ID | Contract | Verification |
|---|---|---|
| DR-1 | README lists complete exports/events/tools/Platform/approvals/cancellation/usage/Task/reasoning/concurrency | documentation review plus examples typecheck. |
| DR-2 | All example terminal switches expose `stopReason.kind` and unknown raw fallback | `pnpm typecheck:examples`. |
| DR-3 | Changelog/version metadata proposes `0.2.0` and calls out breaking contracts | package/changelog assertions or review. |
| DR-4 | No release side effect | git history/task log contains no tag, npm publish, or `gh release` command. |
| DR-5 | Complete regression | on Node 22: `pnpm test` (baseline 403 plus new tests), `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm typecheck:examples` all pass. |

The existing `examples/tsconfig.json` remains the examples typecheck configuration. The planner must add the missing root `typecheck:examples` script (unless an equivalent command lands first), so examples become a repeatable phase gate rather than an informal check.

## 8. Risks

1. **Required stop fields and object-shaped provider reasons are source-breaking.** Custom providers and typed literals must migrate. Mitigation: one coherent `0.2.0` break, exported types, table-driven mapper tests, changelog migration notes; do not weaken fields to optional.
2. **Provider semantics can evolve.** New strings must remain `other/raw` until deliberately normalized. OpenAI refusal is a separate streamed field and compatible endpoints vary. Mitigation: preserve exact raw data, narrow refusal inference, and test unknown/missing paths.
3. **A custom provider may omit `message_stop`.** Required terminal reasons make silent fallback unsafe. Mitigation: explicit provider-contract error after preserving already-yielded partial output; this can reveal previously hidden provider bugs.
4. **Adding required Platform methods fans out to external implementors.** Mitigation: only two high-level methods, no broad Path service, compile-time failure, `0.2.0` migration examples.
5. **Path behavior on Windows/custom VFS may expose untested assumptions.** Mitigation: per-platform grammar, root/outside tests, a custom non-host grammar test, and no string parsing in tools.
6. **ESLint allowlists can either be porous or block legitimate tests.** Mitigation: derive all builtins, allow exactly two Node modules, keep universal rules separate, and prove both forbidden and allowed cases.
7. **Concurrent custom tools may mutate shared referenced declaration-merged state.** A shallow context copy cannot deep-clone callbacks/services. Mitigation: safety-marker contract explicitly includes referenced state; core-owned attribution storage is always independent.
8. **Large safe batches can amplify file descriptors, CPU, and memory.** No cap is chosen to honor maximal-batch semantics and avoid premature policy. Real workload evidence may force a future configurable cap.
9. **Approval timing for safe groups changes.** Multiple safe approvals complete serially before execution begins. Mitigation: deterministic order, no concurrent approvals, no call starts before its approval, barriers stop look-ahead.
10. **Cancellation cannot interrupt `read_file`/`ls` syscalls.** Mitigation: exact documentation, no-new-work guard, signal delivery, and tests that avoid promising prompt interruption.
11. **Loop/task attribution is load-bearing.** Reusing the old shared sinks would mis-tag concurrent custom safe tools. Mitigation: attributed result envelopes and per-call contexts land before overlap is enabled; task remains a barrier.
12. **Release docs can accidentally imply authorization.** Mitigation: use `0.2.0 — Unreleased`, update metadata only, and prohibit publish/tag/release commands in task acceptance criteria.

## 9. Documentation and release readiness

### 9.1 Exact documentation/comment updates

Update after runtime contracts are final:

- `packages/core/README.md`
  - complete main-entry export table, including all built-ins, `StopReason`, usage, Platform discovery types, Task types;
  - `AgentOptions.approvalHandler`, `RunOptions.signal`, and internal-only depth wording;
  - event table including reasoning, subagent events, usage, and stop reasons;
  - non-empty `ToolCallContext` and active concurrency marker contract;
  - all eight built-ins and Task factory setup;
  - complete Platform method set including path capabilities and discovery;
  - cancellation limitations and safe batch/barrier semantics;
  - replace stale “no approvals/sub-agents/all sequential” claims.
- `docs/project/core-roadmap.md` — mark Task, discovery, reasoning, portability hardening, stop reasons, and safe filesystem batching shipped; keep concurrent Task as separate future work.
- `docs/project/STATUS.md` — refresh shipped capability/test-count narrative as documentation maintenance only; the orchestrator, not the feature architect, handles workflow-state fields.
- `docs/project/known-issues.md` — retain sequential Task limitation; clarify general filesystem-safe calls are now concurrent and Task requires separate event/usage/cancellation design. Retain pure-JS discovery performance limitation.
- `docs/project/core-package-status.md` — do not rewrite the dated 2026-07-11 snapshot; it remains historical evidence. Later living docs link forward instead.
- `CHANGELOG.md` — add `## [0.2.0] — Unreleased` with `Added`, `Changed`, `Fixed`, and `Breaking changes` sections. Include Task/discovery/reasoning work accumulated after `0.1.0`, typed stop reasons, portable main graph, safe batching, docs, and migration bullets for `ProviderEvent`/terminal/Platform changes. Retain the historical `0.1.0` entry unchanged even where its “out of scope” notes became stale later.
- `packages/core/package.json` — set proposed next version to `0.2.0`; do not publish.
- `pnpm-lock.yaml` — no change expected from version metadata alone in this workspace; update only if tooling records it. No dependency addition is planned.
- `examples/basic-run.ts`, `openai-run.ts`, `fs-discovery-run.ts`, `task-run.ts`, `subagent-registry.ts` — display final/child `stopReason.kind`, include `raw` for `other`, and remain exhaustive over event kinds where practical.
- retain `examples/tsconfig.json` and add a root `typecheck:examples` script.

Correct stale source comments:

- `types/provider.ts`: `jsonSchema7` rather than `openApi3`; usage is shipped, not future M2.
- `types/tool.ts`: concurrency hook is active, with purity/throw semantics.
- `loop/runTools.ts`: replace sequential M1/future Promise comments with scheduler/barrier contract.
- `loop/loop.ts`: remove assumptions that all tools are globally sequential.
- `platform/node.ts`: Node imports/process are allowed in the explicit Node platform modules, while `process.cwd()` remains here.
- `platform/fs-discovery.ts`: ordering contract and explicit Node-module status.
- `providers/retry.ts`: OpenAI is shipped and also delegates retry to its SDK.
- discovery test comments: custom `platform.cwd()` is not necessarily process cwd.

### 9.2 Version rationale

Propose `0.2.0`. Under SemVer major zero, the project is still in initial development, but downstream source breaks remain real and must be conspicuous. A minor bump is preferable to `0.1.1` because the release combines new public capability with required event/Platform migrations. `1.0.0` would overstate API stability. The changelog heading remains `Unreleased` until separate user authorization supplies a date and performs publish/tag/release actions.

## 10. Success criteria

### Functional

- Consumers exhaustively distinguish all normalized stop categories and retain unknown/missing native detail through `raw`.
- Both provider mapping tables and refusal behavior match §5.1.3.
- Every completed provider turn carries a reason; final `agent_done`, `Terminal`, and sanitized child completion carry the same final reason.
- Non-natural valid stops preserve partial output/messages/usage and never become `agent_error` solely because of the stop kind.
- Main-entry model-facing tools have no Node imports or process/global reads.
- Relative, cwd-relative return, outside-cwd absolute, root, platform grammar, and ordering behavior match §5.2.
- Two safe calls demonstrably overlap; reverse completion still produces original result/message order.
- Every barrier class, serial approval rule, classifier failure, cancellation rule, and all-settle behavior matches §5.3.
- `read_file`, `ls`, `glob`, and `grep` are the only initially marked safe built-ins.
- `task` remains sequential; child events, IDs, sanitized stop reason, and usage remain correctly attributed.
- Docs/examples/types/version metadata match the final API; no publish/tag/release occurs.

### Non-functional

- On a controlled 50 ms + 50 ms deferred-safe-call smoke, batch wall time is under 90 ms on Node 22 while the equivalent barrier sequence remains at least 100 ms; deterministic overlap assertions, not this timing threshold, are the CI correctness gate.
- A typical grep over `packages/core/src` remains under 1 second on the project’s Node 22 smoke environment.
- Scheduler bookkeeping for 100 immediately resolved safe no-op calls is under 10 ms in a non-CI Node 22 benchmark; this detects gross serialization, not a published SLA.
- The main bundle has no Node dependency/process edge; only the Node platform subpath does.
- No unhandled rejection occurs when any safe sibling, classifier, approval, or defensive helper path fails.
- The full Node 22 verification set in DR-5 passes. The engineering baseline observed 403 tests green, but final acceptance is the expanded count rather than a frozen number.

## 11. Open questions

None. All engineering questions from research are resolved by this specification. No user-confirmation blocker remains, and no existing project-level architecture decision must be superseded.

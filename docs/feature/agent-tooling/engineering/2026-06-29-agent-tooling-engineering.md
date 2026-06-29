# Feature Engineering Spec — agent-tooling

**Date:** 2026-06-29
**Scope:** `feature/agent-tooling`
**Phase:** engineering
**Architect:** feature-architect agent

---

## 1. Goal

Add four capabilities to the core package (`packages/core`): a `bash` built-in tool that exposes shell execution to the model, an `edit_file` built-in tool that performs exact-match string-replacement edits, a permission/approval seam that lets consumers gate tool calls (especially `bash`) without importing any UI code, and full cancellation threading so that `ToolCallContext.signal` is populated from the loop's `AbortSignal` and forwarded into `Platform.exec`. Together these turn the core from a loop that can read and write files into an agent that can run shell commands, make surgical edits, and be safely deployed with policy-controlled approval flows.

---

## 2. Motivation

The M1 core proved the agentic loop, the provider abstraction, and the tool/platform seam. The two built-in tools (`read_file`, `write_file`) cover reading and whole-file replacement, but an agent doing real engineering work needs to:

1. **Run shell commands** — linting, tests, git operations, package installs. Without `bash`, the model cannot take any action that isn't a file read or write.
2. **Make targeted edits** — `write_file` replaces whole files or line ranges, which is expensive and error-prone on large files. A string-replacement `edit_file` (find exact snippet, replace, verify uniqueness) dramatically reduces the risk of overwriting code the model didn't intend to touch.
3. **Gate dangerous operations** — `bash` can do anything the process has permission to do. Consumers (scripts, CI bots, interactive agents) need to be able to inject policy without the core importing any UI.
4. **Cancel in-flight tool calls** — the `AgentSignal` already cancels the provider stream, but shell processes spawned by `bash` survive the abort until they time out or finish naturally. Forwarding the signal into `NodePlatform.exec` closes this gap.

These four pieces are tightly coupled: `bash` is the primary consumer of both the permission seam and cancellation; `edit_file` benefits from the same `ToolCallContext.signal` threading (for future long-running scenarios); and the permission gate sits in `runTools` upstream of every tool, not just `bash`.

---

## 3. User-visible behavior

This is a **headless library feature** — there is no user-facing screen or UI. "User" throughout this section means the consumer of the `tiny-agentic` core package (a developer building an application on top). The model is the end-user of the tools themselves.

### 3.1 Primary flow

**From the model's perspective:**

1. The model issues a `bash` tool call with `{ command: "git status", timeout?: number }`. The framework gates the call through the consumer's `approvalHandler` (if provided). If allowed, the tool runs the command in `/bin/sh -c`, collects stdout/stderr/exitCode, and returns a structured result. The model sees the result as a `tool_result` content block.
2. The model issues an `edit_file` tool call with `{ file_path, old_string, new_string, replace_all? }`. The tool reads the file, finds the exact `old_string` match (enforcing uniqueness unless `replace_all` is true), performs the replacement, and writes the result. The model sees `{ edited: true, path }` on success, or a descriptive error explaining what went wrong (no match, multiple matches, file not found).
3. When the agent run's `AbortController` fires (consumer calls `.return()` on the generator, or a timeout signal fires), any in-flight shell process spawned by `bash` also receives SIGTERM via the forwarded `AbortSignal`.

**From the consumer's perspective:**

```ts
const agent = new Agent({
  provider,
  tools: [bashTool, editFileTool, readFileTool, writeFileTool],
  platform: new NodePlatform(),
  approvalHandler: async (toolName, input) => {
    // Consumer decides. For a CLI app, prompt the user.
    // For a bot, apply allow-list policy.
    if (toolName === "bash") return "allow";
    return "allow";
  },
});

for await (const event of agent.run("Fix the lint errors")) {
  // events unchanged: text_delta, tool_use_start, tool_result, agent_done
}
```

If `approvalHandler` is omitted, all tool calls are allowed (backward-compatible with existing consumers).

### 3.2 States matrix

This feature adds no new UI surface. The model-facing tool result states are:

| Tool | Success | Error: not found | Error: multiple matches | Error: permission denied | Error: command failed |
|------|---------|-----------------|------------------------|--------------------------|----------------------|
| `bash` | `{ stdout, stderr, exitCode }` | N/A | N/A | `"Tool 'bash': call denied by approvalHandler"` | `{ stdout, stderr, exitCode: N }` (non-zero is still a success at the tool level — the model reads the result) |
| `edit_file` | `{ edited: true, path }` | `"String to replace not found in file."` | `"Found N matches of old_string but replace_all is false. Provide more context."` | `"Tool 'edit_file': call denied by approvalHandler"` | File I/O error message |
| `edit_file` (file missing + non-empty old_string) | N/A | `"File does not exist."` | N/A | N/A | N/A |
| `edit_file` (file missing + empty old_string) | `{ edited: true, path }` (creates file) | N/A | N/A | N/A | N/A |

Loading state: the model waits while the command runs. There is no new event for "command started." The existing `tool_use_start` event (already yielded before `runTools` executes) serves as the loading signal.

Offline state: N/A for these tools — they execute locally, not over the network.

### 3.3 Accessibility

N/A — this feature is a headless library with no rendered output. The `approvalHandler` callback is a pure function; any approval UI (terminal prompt, web dialog) is the consumer's responsibility and entirely outside the core.

### 3.4 Edge-case behaviors

- **`bash` with pipes/redirects:** the command is passed verbatim to `/bin/sh -c`. Shell operators (`&&`, `||`, `|`, `;`, redirects) work as expected.
- **`bash` timeout:** if the model provides a `timeout` (ms), it is forwarded to `Platform.exec`. The default is 120,000 ms (2 min). The hard cap is 600,000 ms (10 min) — larger values are clamped, not rejected, with a note in the returned stderr.
- **`bash` large output:** stdout/stderr are not truncated at the tool level in this feature. Each is returned as a full string. Truncation is a future optimization (reference's `EndTruncatingAccumulator`). Consumers that need truncation should apply it in their `approvalHandler` or a tool wrapper. Deferred; see §9 (Out of scope).
- **`bash` abort mid-run:** when the agent's `AbortSignal` fires, Node sends SIGTERM to the shell process. If the process does not exit within the `execFile` timeout, Node forcefully kills it. No explicit SIGKILL grace-period timer is added in this feature — SIGTERM is sufficient for the shells and subprocesses we expect (git, npm, tsc); a grace period can be layered in `NodePlatform` in M2 if needed.
- **`edit_file` empty old_string on existing file:** rejected with `"old_string must not be empty when the file already exists."` This prevents the model from accidentally replacing the entire file content with `new_string` via an ambiguous empty-string match.
- **`edit_file` old_string === new_string:** rejected with `"No changes to make — old_string and new_string are identical."` Mirrors the reference contract.
- **`approvalHandler` throws:** the exception is caught by the gate in `runTools`; the tool call is treated as denied and the model receives `"Tool '<name>': approval check failed — <error message>"` as an error result. The run continues.
- **`approvalHandler` not provided:** all tool calls pass through (blanket allow). This is the default and is backward-compatible — existing consumers that construct `Agent` without `approvalHandler` are unaffected.

### 3.5 Microcopy

These are the exact error strings the tool returns to the model (as `tool_result` with `is_error: true`):

- Denied by handler: `"Tool '<name>': call denied by approvalHandler"`
- Handler threw: `"Tool '<name>': approval check failed — <error message>"`
- Edit — no match: `"String to replace not found in file."`
- Edit — multiple matches (non-replace_all): `"Found <N> matches of old_string but replace_all is false. Provide more context to make the match unique."`
- Edit — old === new: `"No changes to make — old_string and new_string are identical."`
- Edit — file missing, non-empty old_string: `"File does not exist."`
- Edit — empty old_string on existing file: `"old_string must not be empty when the file already exists."`

---

## 4. Out of scope

- **`bash` output truncation** — the reference caps stdout/stderr and writes overflow to a temp file. Not in this feature. Full output is returned. A future enhancement can add `outputSizeCap` to `ExecOptions`.
- **`bash` background task support** — `run_in_background: boolean` (reference schema field). Excluded; the single-shell invocation is blocking.
- **`bash` sandbox / `dangerouslyDisableSandbox`** — the reference integrates with macOS Sandbox profiles and an optional Docker sandbox. This feature has no sandbox; all commands run with the process's privileges.
- **`bash` allow/deny rule patterns** — the reference's `bashToolHasPermission` supports exact, prefix, and wildcard rules (e.g., `Bash(git commit:*)`). The permission seam in this feature exposes only the raw `(toolName, input) => Promise<'allow' | 'deny'>` callback; consumers build rule logic in their handler. Rule management helpers are a future SDK-layer concern.
- **`edit_file` read-before-edit enforcement** — the reference rejects edits to files that have not been read since the last modification. Implementing this requires `ToolCallContext` to carry a `readFileState: Map<string, { mtime, hash }>` populated by `read_file`. Since the SDK (not the core) owns that population, and the SDK does not yet exist, enforcement is deferred. The feature ships without the check. Logged as a known limitation.
- **`edit_file` quote normalization** — the reference applies fuzzy quote matching (straight/curly). Not in this feature.
- **`edit_file` stale-read check** — mtime-based stale detection, same dependency as read-before-edit. Deferred.
- **Concurrent tool execution** — still sequential in M1. The permission gate is designed for sequential calls and does not need per-call signal isolation.
- **SIGKILL grace period** — not added. SIGTERM is sent by Node when the `AbortSignal` fires. If a shell process fails to exit within Node's own timeout, the OS reclaims it eventually. A configurable grace period is a future `NodePlatform` enhancement.
- **`platform/browser.ts` changes** — the browser platform currently has no `exec`. This feature targets Node only. `exec` with `shell: true` is a Node-specific behavior; a browser platform would throw "exec not supported" as it already does (or should).
- **`isConcurrencySafe` on new tools** — `bash` is explicitly not concurrency-safe (stateful shell; sequential in M1). `edit_file` is also not concurrency-safe (read-modify-write race). Neither implements `isConcurrencySafe`.

---

## 5. Open questions resolution

The 8 open questions from research are resolved here with rationale:

### OQ-1 — Shell invocation for `bash`

**Decision: `shell?: boolean` on `ExecOptions`, with the `bash` tool always setting `shell: true`.**

Rationale: Hard-coding `/bin/sh -c` in the tool (Option B) works but couples the tool to a Unix shell path that cannot be overridden without rewriting the tool. It also hides the "this is a shell invocation" intent from `Platform` and makes the tool harder to mock (the mock must know to not split on `/bin/sh`). Adding `shell?: boolean` to `ExecOptions` (Option A) is additive — all existing callers omit the field, existing behavior unchanged. `NodePlatform.exec` passes `{ shell: true }` to `execFile` when set, which makes Node use the system shell (typically `/bin/sh` on Unix, `cmd.exe` on Windows). Option C (new `Platform.execShell()` method) is rejected: it is a breaking Platform change (existing `NodePlatform` and `MockPlatform` must add the method), whereas the ExecOptions field is non-breaking. The `bash` tool always sets `{ shell: true }` in its `platform.exec` call.

### OQ-2 — Read-before-edit enforcement in `edit_file`

**Decision: Skip enforcement in this feature. Deferred to SDK layer.**

Rationale: Enforcement requires `ToolCallContext.readFileState: Map<...>` to be populated by whoever calls `read_file`. In the current design the core's `ToolCallContext` is `{}` at construction (set in `agentLoop`). Populating read state requires either (a) the core tracking which `read_file` calls have run (coupling the loop to a specific tool's semantics) or (b) the SDK layer widening `ToolCallContext` via interface merging and populating the map before tool execution. Option (b) is the correct long-term design but the SDK does not yet exist. Option (a) violates the core's tool-agnostic design. The M1 `edit_file` therefore reads the file immediately before replacing (atomic read-find-replace-write), which protects against most stale-write scenarios, but does not enforce that the model has called `read_file` first. This is a known limitation, logged in `known-issues.md`.

### OQ-3 — Permission seam surface

**Decision: Option A — injected async callback `approvalHandler(toolName, input) => Promise<'allow' | 'deny'>` on `AgentOptions`.**

Rationale (this is the consequential choice; full justification follows):

Option B (yield `approval_required` event + generator-resume) would require the consumer to handle a new event type and resume the generator differently: the `for await` loop would need to `.next(decision)` after receiving an `approval_required` event. This changes the consumption protocol — existing `for await` loops that `break` or `return` on unknown events would silently get the wrong behavior (defaulting to whatever the generator's argument was). The `AsyncGenerator<AgentEvent, Terminal>` type also does not currently parameterize the argument type, and changing `AsyncGenerator<AgentEvent, Terminal, never>` to `AsyncGenerator<AgentEvent, Terminal, ApprovalDecision>` is a breaking interface change. Additionally, a yielded event and generator-resume conflates two responsibilities: signaling (what happened) and policy injection (what to do next). In a headless library consumed programmatically, the "what to do next" policy is best expressed as a constructor-injected callback, not an event-response pair.

Option C (out-of-band Promise on `ToolCallContext`) requires the consumer to reach into the context object and resolve a Promise by reference. This is the most fragile design: if the consumer forgets to resolve the Promise, the loop hangs indefinitely. It also exposes internal loop state to the consumer.

Option A (injected callback on `AgentOptions`) aligns with the project's existing patterns: `logger?: Logger` on `Provider` is an optional injected callback with a well-typed argument. `approvalHandler` follows the same shape. The callback is `async`, so consumers can call out to the terminal, a web service, or any other approval mechanism. The callback is injected at construction, not per-run, which is appropriate — policy is typically stable for the lifetime of an agent instance. The `agentLoop` receives the handler via `LoopParams` and passes it to `runTools`; `runTools` awaits it before each `tool.call`. This respects the headless boundary: no UI in core, the consumer's handler is the UI.

Default when omitted: blanket allow (see OQ-5).

### OQ-4 — Gate location

**Decision: Loop-level gate in `runTools`, before `tool.call`.**

Rationale: The reference inserts the gate between Zod validation and `Tool.call()`. In our codebase `runTools` is the only place that calls `tool.call`, making it the natural and unambiguous insertion point. Adding the gate to `ToolCallContext` (so tools could call it themselves) would mean each tool must opt-in to the gate — a misuse risk where a new tool skips the check. A loop-level gate is enforced unconditionally regardless of which tool is called. The gate runs after Zod validation (the tool input is well-formed before we bother asking for approval) and before `tool.call`.

### OQ-5 — Default behavior for `bash`

**Decision: Blanket allow by default (opt-in gate). `approvalHandler` is optional and defaults to allow.**

Rationale: The M1 permission model was explicitly "blanket allow" (project decisions log: "Permissions default to blanket-allow in M1"). Changing the default to deny-unless-configured for `bash` would be a behavioral breaking change for any existing consumer that passes `bashTool` in their tool list. Additionally, many programmatic uses of `bash` (CI scripts, automated test agents, developer tooling) genuinely want unconditional execution and would find a required callback tedious. The correct model is: no `approvalHandler` = trust everything; consumer provides `approvalHandler` = consumer controls policy. This matches how most agentic SDKs (LangChain, OpenAI Agents) handle permission — opt-in gates, not opt-out deny. Backward compatibility is preserved: existing consumers adding `bashTool` to their tool list get blanket-allow behavior.

### OQ-6 — AbortSignal kill behavior

**Decision: SIGTERM only (Node default). No SIGKILL grace period in this feature.**

Rationale: When `execFile` receives an `AbortSignal` that fires, Node 22 sends SIGTERM to the child process group. For the shell commands expected in an agentic context (git, npm, tsc, lint), SIGTERM is sufficient — these are well-behaved processes that terminate on SIGTERM. The timeout (`options.timeout`) acts as a secondary termination mechanism: if the process has not exited by the timeout, Node sends SIGTERM (and the promise rejects with a timeout error). The two mechanisms — signal abort and timeout — run in parallel and whichever fires first terminates the process. A SIGKILL grace-period timer would require spawning with `child_process.spawn` (to track the PID and send SIGKILL after N ms), replacing the simpler `execFile` approach. This complexity is deferred to a future `NodePlatform` enhancement.

### OQ-7 — `ToolCallContext.signal` population

**Decision: Set `context.signal = signal` once when `context` is constructed in `agentLoop`, before the loop begins. The same `context` object is reused across all turns.**

Rationale: The `AbortSignal` is created once per `Agent.run()` call (by the `AbortController` in `agent.ts`) and covers the entire run. It is not per-turn. Reusing the single `context` object across turns is the existing behavior (`const context: ToolCallContext = {}` is constructed once before the `while (true)` loop). Adding `signal` to that same construction keeps the lifecycle consistent: `context.signal` is always the run-level abort signal, never a stale or outdated signal. Re-creating context per turn (the alternative) would add complexity without benefit and would break any SDK extension that carries stateful data across turns via `ToolCallContext` (e.g., a future session-scoped tool state). The current single-object lifetime is correct.

### OQ-8 — Export naming and surface

**Decision: Export `bashTool` and `editFileTool` from the main `index.ts` entry point. Model-facing tool names remain `bash` and `edit_file` (snake_case).**

Rationale: The existing built-in tools are exported as `readFileTool` / `writeFileTool` — camelCase `<name>Tool`. Following this convention gives `bashTool` and `editFileTool`. The model-facing `name` field is `bash` and `edit_file` respectively (snake_case, consistent with the reference and with the existing `read_file` / `write_file` names). No sub-path exports — both built-ins are part of the core's primary surface. `ApprovalDecision` and `ApprovalHandler` types are also exported from `index.ts` so consumers can type their callbacks without importing from internal paths.

---

## 6. Architectural fit

### 6.1 Existing modules touched

| File | Change |
|------|--------|
| `packages/core/src/types/tool.ts` | Add `signal?: AbortSignal` to `ToolCallContext` interface |
| `packages/core/src/types/platform.ts` | Add `shell?: boolean` and `signal?: AbortSignal` to `ExecOptions` |
| `packages/core/src/types/events.ts` | No change |
| `packages/core/src/types/provider.ts` | No change |
| `packages/core/src/loop/loop.ts` | Populate `context.signal = signal` at context construction; pass `approvalHandler` through `LoopParams` to `runTools` |
| `packages/core/src/loop/runTools.ts` | Add pre-call approval gate (await `approvalHandler?.(name, input)` after Zod validation, before `tool.call`) |
| `packages/core/src/platform/node.ts` | Forward `options.shell` and `options.signal` to `execFileAsync` (conditional spread, `exactOptionalPropertyTypes` constraint) |
| `packages/core/src/agent.ts` | Add optional `approvalHandler?: ApprovalHandler` to `AgentOptions`; thread through `agentLoop` via `LoopParams` |
| `packages/core/src/index.ts` | Export `bashTool`, `editFileTool`, `ApprovalDecision`, `ApprovalHandler` |

### 6.2 New modules / files introduced

| File | Purpose |
|------|---------|
| `packages/core/src/tools/builtin/bash.ts` | `bashTool` implementation |
| `packages/core/src/tools/builtin/editFile.ts` | `editFileTool` implementation |

### 6.3 New interfaces and contracts

**`ApprovalDecision` type (new, exported):**
```ts
export type ApprovalDecision = 'allow' | 'deny';
```

**`ApprovalHandler` type (new, exported):**
```ts
export type ApprovalHandler = (
  toolName: string,
  input: unknown,
) => Promise<ApprovalDecision>;
```

**`AgentOptions` (modified, additive):**
```ts
export type AgentOptions = {
  provider: Provider;
  tools: Tool[];
  platform: Platform;
  systemPrompt?: string;
  maxTurns?: number;
  approvalHandler?: ApprovalHandler;  // NEW — optional, default: allow all
};
```

**`LoopParams` (modified, additive):**
```ts
export type LoopParams = {
  provider: Provider;
  registry: ToolRegistry;
  platform: Platform;
  messages: Message[];
  systemPrompt: string;
  maxTurns: number;
  signal: AbortSignal;
  approvalHandler?: ApprovalHandler;  // NEW
};
```

**`ToolCallContext` (interface, modified, additive):**
```ts
export interface ToolCallContext {
  signal?: AbortSignal;  // NEW — populated by agentLoop; tools forward to Platform.exec
}
```

**`ExecOptions` (type, modified, additive):**
```ts
export type ExecOptions = {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  shell?: boolean;    // NEW — if true, use system shell (/bin/sh on Unix)
  signal?: AbortSignal;  // NEW — forward to execFile for abort support
};
```

### 6.4 Modified existing interfaces (back-compat plan)

All changes are purely additive (new optional fields). No existing field is removed or renamed. No existing type alias is changed to an incompatible shape.

- `ToolCallContext` gains `signal?: AbortSignal`. Existing `Tool.call` implementations that ignore the context object compile unchanged; they never see `signal`. The `exactOptionalPropertyTypes: true` tsconfig constraint means tools accessing `context.signal` must check for `undefined` before use — which is correct.
- `ExecOptions` gains `shell?: boolean` and `signal?: AbortSignal`. All existing `Platform.exec` callers (env-context builder, `read_file`/`write_file`) omit these fields; their behavior is unchanged. Existing `Platform` implementors (`NodePlatform`, any mock) are unaffected — `ExecOptions` is a parameter type, not part of the `Platform` interface signature itself (the signature is `exec(command: string, options?: ExecOptions)`; the options shape is a type alias, not an interface, so adding fields to the type alias does not break existing implementors).
- `AgentOptions` gains `approvalHandler?: ApprovalHandler`. Existing `Agent` constructions that omit it continue to work — the gate in `runTools` checks `approvalHandler !== undefined` before awaiting.
- `LoopParams` gains `approvalHandler?: ApprovalHandler`. Only `agentLoop` constructs `LoopParams`; the one caller (`agent.ts`) gains the field.

---

## 7. Data model changes

No new on-disk schema, database, or storage. All changes are type-level:

- `ToolCallContext` interface: `signal?: AbortSignal` added.
- `ExecOptions` type: `shell?: boolean` and `signal?: AbortSignal` added.
- `AgentOptions` type: `approvalHandler?: ApprovalHandler` added.
- `LoopParams` type: `approvalHandler?: ApprovalHandler` added.

No migration is required — all fields are optional and no persisted data is touched.

The `bash` tool's return value is a new JSON shape (`{ stdout, stderr, exitCode }`) sent to the model as a `tool_result`. This is not a stored schema; it is a transient message block.

The `edit_file` tool's return value is `{ edited: true, path }` on success. Also transient.

---

## 8. Detailed contracts

### 8.1 `bash` tool contract

**Model-facing name:** `bash`

**Input schema:**
```ts
z.object({
  command: z.string().describe("Shell command to execute. Supports pipes, redirects, and shell operators."),
  timeout: z.number().int().positive().optional()
    .describe("Timeout in milliseconds (max 600000). Default: 120000."),
  description: z.string().optional()
    .describe("Human-readable summary of what this command does. Logged but not used in execution."),
})
```

**Execution contract:**
1. `timeout` from model input is clamped to `[1, 600_000]`. If the model passes `timeout > 600_000`, the tool silently clamps and adds a note to `stderr` in the result: `"[timeout clamped to 600000ms]"`.
2. The command is passed to `platform.exec(command, { shell: true, cwd: platform.cwd(), timeout: clampedTimeout, signal: context.signal })`.
3. **Both non-zero exit codes and SIGTERM/timeout are non-throwing.** `Platform.exec` always returns `{ stdout, stderr, exitCode }`. The `bash` tool returns this object directly. A non-zero exit code is information for the model, not a tool error.
4. **Exception (thrown):** if `platform.exec` itself throws (e.g., the shell binary does not exist, or `NodePlatform` throws for some internal reason), the exception propagates and is caught by `runTools`'s try/catch, becoming an `isError: true` `tool_result` with the exception message.
5. **Output not truncated** — full stdout and stderr strings are returned. This is noted as a known limitation.
6. **`cwd`:** always `platform.cwd()`. The model cannot change the working directory per-call (no `cwd` field in the input schema). A future enhancement could add `cwd` to the schema if needed.

**Tool description sent to model:**
```
Execute a shell command using /bin/sh. Supports pipes, redirects, &&, ;, and other shell operators.
Returns stdout, stderr, and exit code. A non-zero exit code means the command failed.
Default timeout: 120 seconds (max: 600 seconds). Prefer dedicated tools (read_file, write_file, edit_file) over shell commands when available.
```

### 8.2 `edit_file` tool contract

**Model-facing name:** `edit_file`

**Input schema:**
```ts
z.object({
  file_path: z.string().describe("Absolute or relative path to the file."),
  old_string: z.string().describe("Exact text to find and replace. Empty string creates the file."),
  new_string: z.string().describe("Text to replace old_string with."),
  replace_all: z.boolean().default(false).optional()
    .describe("If true, replace all occurrences. If false (default), old_string must appear exactly once."),
})
```

**Execution contract (in order):**
1. **No-op guard:** if `old_string === new_string`, return error `"No changes to make — old_string and new_string are identical."` without reading the file.
2. **File creation path:** if `old_string === ""`:
   - If the file does not exist: write `new_string` as the entire file content. Return `{ edited: true, path: file_path }`.
   - If the file exists: return error `"old_string must not be empty when the file already exists."` (prevents accidental full-replace via empty match).
3. **Normal edit path:** (non-empty `old_string`)
   - If the file does not exist: return error `"File does not exist."`.
   - Read the file. Count occurrences of `old_string` in the content (exact substring match, case-sensitive, no regex).
   - If count === 0: return error `"String to replace not found in file."`.
   - If count > 1 and `replace_all` is false: return error `"Found <count> matches of old_string but replace_all is false. Provide more context to make the match unique."`.
   - If count > 1 and `replace_all` is true: replace all occurrences.
   - If count === 1: replace the single occurrence.
   - Write the modified content to disk.
   - Return `{ edited: true, path: file_path }`.
4. All errors are thrown as `Error` instances (caught by `runTools` try/catch, producing `isError: true` tool results).
5. The read and write use `platform.readFile` and `platform.writeFile` — no direct fs access.
6. No `signal` threading needed in the `editFileTool` implementation itself — the read and write are non-blocking async calls, and an abort between read and write (the ms-level window) is acceptable for this feature.

**No quote normalization, no mtime check, no read-before-edit enforcement** (all deferred; see §4 Out of scope).

### 8.3 Permission gate in `runTools`

The gate is inserted after Zod validation and before `tool.call`. In pseudocode:

```
for each toolUse in toolUses:
  1. look up tool → error if not found
  2. check parseError → early error if true
  3. Zod safeParse → validation error if failed
  4. [NEW] if approvalHandler is set:
        try:
          decision = await approvalHandler(tool.name, parseResult.data)
        catch err:
          yield isError tool_result: "Tool '<name>': approval check failed — <msg>"
          continue
        if decision === 'deny':
          yield isError tool_result: "Tool '<name>': call denied by approvalHandler"
          continue
  5. try { result = await tool.call(...) } catch → error result
  6. yield success tool_result
```

The `approvalHandler` is threaded from `AgentOptions` → `Agent` constructor → `agentLoop` (via `LoopParams`) → `runTools` (as a parameter). `runTools`'s signature gains `approvalHandler?: ApprovalHandler` as a last parameter.

`runTools` must not import `ApprovalHandler` from `agent.ts` (circular dependency risk). The type is defined in a separate location — it lives in `types/tool.ts` alongside `ToolCallContext`, or alternatively as a re-export from `agent.ts` where it is already public. The safest choice: define `ApprovalDecision` and `ApprovalHandler` in `types/tool.ts` (tools and approval are the same concern; this avoids any import cycle). `agent.ts` re-exports them from there.

### 8.4 Cancellation threading

**End-to-end signal chain:**

```
Agent.run()
  └─ AbortController created
  └─ signal = abortCtrl.signal
  └─ agentLoop({ ..., signal })
       └─ const context: ToolCallContext = { signal }   ← NEW: signal added here
       └─ provider.stream(request, signal)              ← already wired
       └─ runTools(toolUses, registry, platform, context, approvalHandler)
            └─ tool.call(input, platform, context)
                 └─ bashTool:
                      platform.exec(cmd, { shell: true, signal: context.signal, ... })
                           └─ NodePlatform.exec:
                                execFileAsync(program, args, { signal: options.signal, ... })
```

**`NodePlatform.exec` change (conditional spread, exactOptionalPropertyTypes):**
```ts
const { stdout, stderr } = await execFileAsync(program!, args, {
  ...(options.cwd     !== undefined ? { cwd: options.cwd }         : {}),
  ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
  ...(options.env     !== undefined ? { env: { ...process.env, ...options.env } } : {}),
  ...(options.shell   !== undefined ? { shell: options.shell }     : {}),  // NEW
  ...(options.signal  !== undefined ? { signal: options.signal }   : {}),  // NEW
});
```

Note: when `shell: true`, Node passes the command string directly to `/bin/sh -c`. The `program`/`args` split in the current implementation (`command.split(" ")`) is wrong for shell mode — the shell command must be passed as a single string, not split. When `shell: true`, the implementation passes the full `command` string, not `[program, ...args]`:

```ts
const execArgs: Parameters<typeof execFileAsync> = options.shell
  ? [command, { ...spreadOpts }]          // shell: true → full command string, no args array
  : [program!, args, { ...spreadOpts }];  // default → split into program + args
await execFileAsync(...execArgs);
```

This requires refactoring the current `exec` implementation slightly. The change is fully internal to `NodePlatform.exec`.

---

## 9. Edge cases (engineering-facing)

- **`bash` command is empty string:** passed directly to `/bin/sh -c ""`. The shell exits with code 0, stdout/stderr empty. Not an error at the tool level; the model sees `{ stdout: "", stderr: "", exitCode: 0 }`.
- **`bash` produces no output but exits non-zero:** model receives `{ stdout: "", stderr: "", exitCode: N }`. This is valid — the model can retry or report the failure.
- **`bash` with very long command (> 128 KB):** OS arg limit applies. The `execFile` call will throw `E2BIG`. Caught by `runTools` try/catch → `isError: true` with the system error message. No pre-validation at tool level.
- **`edit_file` with binary file:** `platform.readFile` reads as UTF-8. Binary files will produce garbled strings; string replacement may corrupt the file. Not validated at the tool level — the model is expected not to call `edit_file` on binary files. A future enhancement can add a binary-file guard.
- **`edit_file` old_string contains regex metacharacters:** occurrence counting uses exact substring match (`content.split(old_string).length - 1`), not regex. No escaping needed; works correctly for any substring.
- **`edit_file` on a file that grows while editing:** the tool reads the file, finds the match, writes the new content. If another process modifies the file between the read and write, the write silently overwrites the concurrent modification. This is the same risk as `write_file`; no atomic locking in this feature.
- **`approvalHandler` returns a value other than `'allow'` or `'deny'`:** TypeScript prevents this at compile time (return type is `Promise<ApprovalDecision>`). At runtime, any truthy non-`'allow'` value is treated as deny. The implementation checks `decision !== 'allow'`.
- **Signal already aborted when `bash` starts:** `execFile` with an already-aborted signal throws immediately with an `AbortError`. Caught by `runTools` try/catch → `isError: true` tool result.
- **`context.signal` is undefined (e.g., in a test that constructs `context = {}`):** the `bash` tool checks `context.signal !== undefined` before including it in `ExecOptions` (conditional spread). If absent, execution proceeds without signal support, relying on `timeout` only.

---

## 10. Risks

- **`NodePlatform.exec` split-vs-shell refactor:** the current implementation always splits `command` on spaces. Adding `shell: true` requires a code path that passes the full string. The refactor is small but is a change to an existing, tested function — existing tests that call `exec` with `shell: false` (the default) must still pass. Mitigation: the conditional is gated on `options.shell === true`, which is false by default; existing paths are unaffected. Test coverage on both paths.
- **`execFileAsync` + `AbortSignal` + `shell: true` interaction on Node 22:** when `shell: true` and `signal` fires, Node sends SIGTERM to the shell process, which should cascade to child processes if the shell uses a process group. In practice, some shells (`/bin/sh`) do not forward SIGTERM to subprocess groups for pipelines. This means a command like `sleep 100 | cat` may leave `sleep` running after the shell exits. Mitigation: document the limitation; a future enhancement can use `child_process.spawn` with `detached: false` and `process.kill(-pid, 'SIGTERM')` to kill the group. Not blocking for this feature.
- **`approvalHandler` as a constructor parameter (not per-run):** if a consumer wants per-run approval policy (e.g., different policy for different users in a server context), they would need to construct a new `Agent` per run. This is a deliberate design choice — the approval policy is bound to the agent instance. If per-run policy is needed in the future, `RunOptions` can gain an `approvalHandlerOverride` field without breaking the constructor default.
- **`exact_optional_property_types` and `AbortSignal` spread:** the Node `execFile` type signatures expect `AbortSignal` without `undefined` (the option is either present or absent). The conditional spread approach satisfies this but is verbose. A future refactor can build the options object in a helper. Mitigation: the pattern is already established in the existing `NodePlatform.exec` code; adding two more fields follows the same pattern.
- **`edit_file` + empty `old_string` file-exists check:** reading whether a file exists before writing requires a `try/catch` around `platform.readFile` (catch ENOENT → file does not exist). This is already the implicit behavior of the tool (if `readFile` throws, the tool propagates the error). The explicit check for the creation path requires `readFile` to throw on missing files, which `NodePlatform.readFile` does (Node's `fs.readFile` throws ENOENT). Mitigation: tests must cover both paths.
- **No test for live `approvalHandler` in the existing 140 tests:** the permission gate is new code and needs dedicated tests. Mitigation: test matrix covers: no handler (allow), handler returns `'allow'`, handler returns `'deny'`, handler throws (see §11 test strategy).

---

## 11. Success criteria

**Functional:**

- [ ] `bashTool` is exported from `packages/core/src/index.ts` as `bashTool`.
- [ ] `editFileTool` is exported from `packages/core/src/index.ts` as `editFileTool`.
- [ ] `ApprovalDecision` and `ApprovalHandler` types are exported from `packages/core/src/index.ts`.
- [ ] A model issuing `{ command: "echo hello" }` to `bash` receives `{ stdout: "hello\n", stderr: "", exitCode: 0 }`.
- [ ] A model issuing `{ command: "echo a | cat" }` (pipe) to `bash` receives the expected output (confirms shell semantics).
- [ ] `edit_file` with a unique `old_string` successfully mutates the file and returns `{ edited: true, path }`.
- [ ] `edit_file` with a non-existent `old_string` returns an `isError: true` tool result with `"String to replace not found in file."`.
- [ ] `edit_file` with an `old_string` that appears N > 1 times and `replace_all: false` returns `"Found N matches..."`.
- [ ] `edit_file` with `old_string: ""` and no existing file creates the file.
- [ ] `edit_file` with `old_string: ""` and an existing file returns `"old_string must not be empty when the file already exists."`.
- [ ] An `approvalHandler` returning `'deny'` for `bash` causes the tool to return `isError: true` with `"Tool 'bash': call denied by approvalHandler"`. The run continues; the model can respond.
- [ ] An `approvalHandler` that throws causes the tool to return `isError: true` with `"Tool 'bash': approval check failed — <msg>"`. The run continues.
- [ ] Omitting `approvalHandler` in `AgentOptions` allows all tool calls (backward-compatible).
- [ ] Calling `abortCtrl.abort()` while `bash` is executing terminates the shell process (verified by aborting a `sleep 10` command and observing early return).
- [ ] `context.signal` is set on `ToolCallContext` inside `agentLoop`.
- [ ] All 140 existing tests still pass.

**Non-functional:**

- [ ] `bash` with a trivial command (`echo hello`) completes in under 500 ms on a developer machine.
- [ ] `edit_file` on a 10,000-line file completes in under 100 ms.
- [ ] No new imports of `child_process`, `fs`, or `process` outside `platform/node.ts`.
- [ ] `pnpm -r typecheck` passes with zero errors after the changes.
- [ ] `pnpm -r lint` passes with zero errors after the changes.

---

## 12. Test strategy (notes for the planner)

### Unit tests: `bash` tool (`bash.test.ts`)

- Mock `Platform` with a `exec` spy that returns configurable `{ stdout, stderr, exitCode }`.
- Verify `shell: true` is always forwarded in `ExecOptions`.
- Verify `cwd` defaults to `platform.cwd()`.
- Verify `timeout` clamping: model passes `700_000`, tool passes `600_000`.
- Verify non-zero `exitCode` is returned without throwing.
- Verify `context.signal` is forwarded when present.
- Verify `context.signal` absent → no `signal` field in `ExecOptions` (undefined check).

### Unit tests: `edit_file` tool (`editFile.test.ts`)

- Mock `Platform.readFile` and `Platform.writeFile`.
- Test: unique match → `writeFile` called with replaced content, return `{ edited: true, path }`.
- Test: no match → error thrown with `"String to replace not found in file."`.
- Test: 2 matches, `replace_all: false` → error `"Found 2 matches..."`.
- Test: 2 matches, `replace_all: true` → both replaced, `writeFile` called once.
- Test: `old_string === new_string` → error without reading file (verify `readFile` not called).
- Test: `old_string === ""`, file missing → `readFile` throws ENOENT → `writeFile` called with `new_string`.
- Test: `old_string === ""`, file exists → error without calling `writeFile`.
- Test: file missing, non-empty `old_string` → error `"File does not exist."`.

### Unit tests: `runTools` approval gate (`runTools.test.ts` additions)

- Existing tests must continue to pass with no `approvalHandler` (pass `undefined`).
- Test: handler returns `'allow'` → `tool.call` invoked.
- Test: handler returns `'deny'` → `tool.call` NOT invoked, `isError: true` event with deny message.
- Test: handler throws → `tool.call` NOT invoked, `isError: true` event with `"approval check failed"` message.
- Test: handler is called with `(toolName, validatedInput)` (not raw input — called after Zod, so input is parsed).

### Unit tests: `NodePlatform.exec` shell mode (`node.test.ts` additions)

- Test: `exec("echo hello", { shell: true })` → invokes execFile with `shell: true` and full command string (not split).
- Test: `exec("ls -la", {})` → existing behavior (split into program + args, no shell).
- Test: `exec(..., { signal: alreadyAbortedSignal })` → catches AbortError and returns it as an exec error.

### Integration test: abort propagation

- Construct `Agent` with `bashTool` and a mock platform that wraps a real (or simulated) slow command.
- Start `agent.run("sleep 10")` and call `.return()` on the generator after 100ms.
- Verify the run terminates promptly (not after 10 seconds).

### Regression: no breaking changes

- Run all 140 existing tests without modification: zero failures expected.
- Add a test that constructs `Agent` without `approvalHandler` and runs a `bash` call → completes normally.

---

## 13. Deferred items (explicit)

1. **Read-before-edit enforcement** (OQ-2) — deferred to SDK layer. Will be logged in `docs/project/known-issues.md` as "edit_file does not enforce that the model has previously read the file; stale edits are possible."
2. **`bash` output truncation** — deferred; full stdout/stderr returned. Future: add `outputSizeCap?: number` to `ExecOptions` or handle in a higher-level tool wrapper.
3. **SIGKILL grace period** — deferred; SIGTERM only. Future: `NodePlatform` enhancement using `spawn` + process group management.
4. **`bash` background task support** — deferred; out of scope.
5. **Sandbox integration** — deferred; out of scope.
6. **`edit_file` quote normalization and stale-read check** — deferred; out of scope.
7. **Allow/deny rule patterns (prefix/wildcard matching)** — deferred to SDK or a future `PermissionPolicy` helper. The `approvalHandler` callback is the extension point.

---

## 14. Open questions

None. All 8 research open questions are resolved above (§5). No new ambiguities surfaced during the architectural analysis.

---

_Spec written by feature-architect agent on 2026-06-29._

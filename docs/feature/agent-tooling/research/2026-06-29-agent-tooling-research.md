# agent-tooling Feature Research

**Date:** 2026-06-29
**Scope:** `feature/agent-tooling`
**Phase:** research
**Researcher:** researcher agent

---

## 1. Research Questions

The following questions were derived from the feature brief and used to scope this sweep:

1. **bash tool**: How does Claude Code's Bash tool shape its model-facing schema (timeout, description, cwd, shell vs. execFile), handle output truncation, and gate dangerous commands? What maps onto our `Platform.exec(command, options)` signature and what gaps exist?
2. **edit_file tool**: How does Claude Code's FileEditTool contract work — the `old_string/new_string/replace_all` model, uniqueness enforcement, read-before-edit requirement, and failure modes? How would it sit alongside the existing `write_file` (range-replace) without conflict?
3. **permission seam**: How does Claude Code model its `canUseTool`/permission decision (`allow | deny | ask`) and feed that back into the loop? What are the realistic options for a headless async-generator core to surface an "ask" decision without importing UI?
4. **cancellation wiring**: What is the exact current state — where does `AbortSignal` live today, where does it not reach, and what does wiring `ToolCallContext.signal` concretely look like?
5. **domain constraints**: What hard limits does the UI-free/headless boundary, the Platform M2 seam, sequential execution in M1, and TypeScript interface merging impose on the design space?

---

## 2. Prior Art & Existing Solutions

### 2.1 Claude Code Bash Tool

**Source:** `claude-code-source-code/src/tools/BashTool/BashTool.tsx` and related files.

**Model-facing input schema** (from `BashTool.tsx:227-259`):
```ts
z.strictObject({
  command:                z.string()
  timeout:                z.number().optional()   // max: getMaxTimeoutMs() (default 600_000 ms / 10 min)
  description:            z.string().optional()   // human-readable summary
  run_in_background:      z.boolean().optional()
  dangerouslyDisableSandbox: z.boolean().optional()
  // _simulatedSedEdit omitted from model-facing schema (internal)
})
```

**Timeout constants** (`utils/timeouts.ts:2-3`): default = 120,000 ms (2 min), max = 600,000 ms (10 min). Both overridable via `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` env vars.

**How exec works in the reference**: The reference uses a `runShellCommand` async generator that invokes a persistent shell process (not a one-shot `execFile`). It supports background tasks, streaming progress, and output to a file when output exceeds an in-memory threshold. The `abortController.signal` from `ToolUseContext` is passed directly into `runShellCommand`.

**What maps onto our `Platform.exec`**: Our `Platform.exec` is `execFile`-backed (splits command on spaces, no shell expansion, no pipe support). The reference runs a persistent shell. This is a significant gap: the reference's Bash tool passes the raw `command` string to `/bin/sh -c` (or the user's shell) whereas our `NodePlatform.exec` uses `execFile` which requires a program + args split. The comment in `platform/node.ts` already notes this: "For shell commands with pipes/redirects, use /bin/sh -c."

**Output truncation**: The reference uses an `EndTruncatingAccumulator` that caps stdout. Large output is written to a temp file and a `<persisted-output>` tag is sent to the model (`BashTool.tsx:730-753`). The model-facing tool result contains stdout up to the cap plus a pointer to the full file.

**Dangerous command handling**: The reference has a layered permission system (see §2.3), not command-level blocking inside the tool itself. The tool's `validateInput` only blocks a specific `sleep N` pattern when `MONITOR_TOOL` feature is on. Command safety classification (`bashClassifier.ts`) runs in the permission pipeline, not inside `call`.

**What to borrow**: timeout parameter, description parameter, the principle that stdout/stderr are both returned and exit code matters, the "shell passthrough via /bin/sh -c" approach rather than split-on-space. **What to avoid**: the background task infrastructure, the sandbox adapter, the persistent-shell state management, the analytics/LSP notification side effects.

**Feasibility gap**: Our `Platform.exec` does `execFile` which splits on spaces and does not support shell operators (pipes, redirects, `&&`, `;`). A `bash` built-in tool that passes the command verbatim to the model needs shell semantics. The gap must be addressed either by adding a `shell?: boolean` option to `ExecOptions` (forwarded to `execFile`'s `{ shell: true }` option) or by adding a dedicated `execShell` method. **This is a Platform interface change** — potentially a breaking change if done as a new `exec` option (additive) vs. a new method (definitively breaking).

---

### 2.2 Claude Code FileEditTool

**Source:** `claude-code-source-code/src/tools/FileEditTool/FileEditTool.ts` and `types.ts`.

**Model-facing input schema** (`types.ts:6-18`):
```ts
z.strictObject({
  file_path:   z.string()   // absolute path
  old_string:  z.string()   // exact text to find and replace
  new_string:  z.string()   // replacement text (must differ from old_string)
  replace_all: z.boolean().default(false).optional()
})
```

**Contract rules** (from `validateInput`, `FileEditTool.ts:137-362`):
1. `old_string === new_string` → rejected with "No changes to make."
2. File does not exist + `old_string === ''` → file creation (valid).
3. File does not exist + `old_string !== ''` → rejected with "File does not exist."
4. File exists + `old_string === ''` → rejected unless file is empty.
5. **Read-before-edit enforced**: if `readFileState` has no entry for the file, rejected with "File has not been read yet. Read it first before writing to it." (errorCode 6).
6. **Stale-read check**: if `mtime` since last read was modified (and content differs for full reads), rejected with "File has been modified since read."
7. **Unique match required** (unless `replace_all: true`): if `old_string` appears more than once, rejected with `"Found N matches ... but replace_all is false. Provide more context."` (errorCode 9).
8. **Match not found**: rejected with `"String to replace not found in file."` (errorCode 8).

**Quote normalization**: `findActualString` applies fuzzy quote normalization (straight/curly) to handle model-generated `old_string` that differs in quote style from the file.

**Atomic write**: the reference reads the file synchronously just before writing, rechecks `mtime`, then writes. No other awaits between read and write.

**The `write_file` range-replace conflict**: our existing `write_file` does line-number-based range replacement. `edit_file` would be string-based (exact-match). They are complementary, not conflicting — the model chooses which to use. However, the read-before-edit requirement is a semantic difference: our `write_file` has no such requirement (it just fires), which the reference treats as a bug risk (stale writes).

**What to borrow**: the `old_string/new_string/replace_all` schema, the unique-match contract and error messages, the "match not found" error, the file-not-found branch allowing creation (empty `old_string`). **What to avoid (for now)**: the read-before-edit mtime/content enforcement (requires tracking read state in `ToolCallContext`, which is a design question for engineering), the quote normalization (an optimization, not essential), LSP notification, git diff computation.

**Read-before-edit question**: Whether to enforce "must read before edit" requires either (a) tracking `readFileState` in `ToolCallContext` (the reference approach — context carries a `FileStateCache`), or (b) skipping enforcement (simpler, riskier). This is an architectural question for engineering, not a feasibility blocker for the tool itself.

---

### 2.3 Claude Code Permission System

**Source:** `claude-code-source-code/src/types/permissions.ts`, `src/Tool.ts:123-148`, `src/tools/BashTool/bashPermissions.ts`.

**Decision type** (from `types/permissions.ts:44`):
```ts
type PermissionBehavior = 'allow' | 'deny' | 'ask'
```

**Full `ToolPermissionContext`** (`Tool.ts:123-138`): a deeply-immutable object with:
- `mode`: one of `'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'plan' | 'auto' | 'bubble'`
- `alwaysAllowRules`, `alwaysDenyRules`, `alwaysAskRules`: per-source rule maps
- `shouldAvoidPermissionPrompts`: boolean flag for headless/non-interactive agents

**Decision flow** (`toolExecution.ts:600-750` summary):
```
Zod validation
  → Tool.validateInput()
    → canUseTool() / checkPermissions()   ← returns PermissionResult
      → 'deny'  → error tool result (no call)
      → 'ask'   → surface to UI for human decision
      → 'allow' → proceed to Tool.call()
```

**For Bash specifically** (`bashPermissions.ts`): the full `bashToolHasPermission` function:
1. Checks exact-match allow/deny/ask rules.
2. Checks prefix-match rules (`Bash(git commit:*)` style).
3. Checks path constraints.
4. Checks sed constraints.
5. Checks permission mode (`bypassPermissions`, `dontAsk`, `acceptEdits`).
6. Checks `isReadOnly` (auto-allow safe commands).
7. Falls through to `passthrough` (triggers permission prompt UI).

**The `canUseTool` function** is a React hook (`hooks/useCanUseTool.ts`) passed down the call stack into `Tool.call`. It is UI-specific in the reference.

**What maps onto a headless core**: The reference's permission system is deeply entangled with UI (React hooks, `setToolJSX`, async approval dialogs). The headless equivalent is a pure async callback/hook injected at `Agent` construction time. There are two credible options for surfacing "ask":

- **Option A — injected async callback**: `Agent` accepts an optional `approvalHandler: (toolName: string, input: unknown) => Promise<'allow' | 'deny'>`. When the handler is absent, default is allow. The loop awaits the callback before each tool call. No events emitted; the caller's callback blocks the generator.
- **Option B — yield-and-resume via async generator protocol**: The loop yields an `approval_required` event (new `AgentEvent` variant) and pauses. The consumer handles the event and resumes the generator with `gen.next(decision)`. This is async-generator-native but requires the consumer to drive the loop differently for the approval case, and the generator's input type becomes union-typed.
- **Option C — out-of-band via a Promise stored on the context**: The loop stores a pending Promise in `ToolCallContext` that the consumer resolves; the loop awaits it. Avoids generator protocol complexity but requires careful lifecycle management.

All three options are compatible with the UI-free boundary. Option A is the simplest and matches the `fetch` + callback convention. The choice is for engineering.

---

### 2.4 Cancellation — Current State and Wiring

**Current state, confirmed by code reading:**

1. `Agent.run()` creates an `AbortController` and passes `abortCtrl.signal` to `agentLoop` (`agent.ts:38-56`).
2. `agentLoop` passes `signal` to `provider.stream(request, signal)` (`loop.ts:41-43`). The Anthropic provider forwards it to the SDK's HTTP client, so in-flight model calls abort correctly.
3. `agentLoop` constructs `context: ToolCallContext = {}` (`loop.ts:23`) and passes it to `runTools` (`loop.ts:91`).
4. `runTools` calls `tool.call(parseResult.data, platform, context)` (`runTools.ts:62`). The `context` is `{}` — no signal.
5. `Platform.exec` has no `signal` field in `ExecOptions` (`platform.ts:1-5`). The `NodePlatform.exec` comment (`node.ts:34`) explicitly states: "In M1, exec does not accept an AbortSignal — it relies on `timeout` only."

**What wiring looks like**: The decisions log (`docs/project/decisions.md`, "M2 seams confirmed") already pins the seam: add an **optional `signal?: AbortSignal` field on `ToolCallContext`** (not a fourth positional arg to `Tool.call`). The wiring has two parts:
1. `agentLoop` sets `context.signal = signal` before passing to `runTools`. Since `ToolCallContext` is `{}` in M1 but an interface, this requires adding `signal?: AbortSignal` to the interface definition.
2. `ExecOptions` gets `signal?: AbortSignal`, forwarded to `execFileAsync` via `node:child_process`'s `AbortSignal` support (Node 16+ supports `{ signal }` in `exec`/`execFile`).
3. The `bash` tool's `call` implementation reads `context.signal` and passes it to `platform.exec`.

**Important nuance**: `Platform.exec` adding a `signal` field to `ExecOptions` is additive (optional field), not a breaking change to existing `Platform` implementors. Adding `signal` to `ToolCallContext` is also additive (interface merging, optional). Neither requires a breaking change. This is feasible in this feature.

**Timeout vs. signal**: `Platform.exec` already has `timeout` (passed to `execFile` as `options.timeout`). If both `signal` and `timeout` are set, Node's `execFile` respects whichever fires first (the timeout creates an `AbortSignal` internally). The `bash` tool can forward the agent-level `AbortSignal` via context while also accepting a per-call timeout from the model input — both work in parallel.

---

## 3. Technical Feasibility & Candidate Approaches

### 3.1 bash tool implementation options

**A. `execFile` with shell flag** — Add `shell?: boolean` to `ExecOptions`; `NodePlatform.exec` passes `{ shell: true }` to `execFile` when set. This delegates to the user's shell. The `bash` built-in tool always sets `shell: true`. Change is additive (optional ExecOptions field). Risk: shell injection if `env` is misused. Consistent with `Platform` being the security boundary.

**B. Wrap as `/bin/sh -c`** — No Platform change needed. The `bash` tool explicitly passes `['/bin/sh', '-c', command]` as the command string. Works with existing `execFile` split-on-space (splits to `['/bin/sh', '-c', <full command>]`). Simpler, but requires the tool to hard-code the shell invocation pattern. Slightly less portable (Windows).

**C. New `execShell` method on Platform** — Clean separation but adds a method in M2, which the decisions log flags as "breaking change for existing Platform implementations." This is the most principled long-term approach but heaviest to land in this feature.

Option A or B are the lowest-friction approaches for this feature scope. The tool description would advise the model that shell operators (pipes, `&&`, `;`) work.

### 3.2 edit_file implementation options

**Core logic** is simple — the key question is only the read-before-edit enforcement:

**A. No read-before-edit enforcement** — Simplest. The tool reads the file, finds the exact match, replaces, writes. No state tracking in `ToolCallContext`. Risk: model edits a stale version without knowing it. Appropriate for M1 of this feature; enforcement can be added later.

**B. Read-before-edit via ToolCallContext** — The SDK (not core) would widen `ToolCallContext` with a `readFileState: Map<string, ReadEntry>`. The `edit_file` tool checks this map. This is the correct long-term design but requires the SDK layer to populate context, which is currently out of scope for the core-only feature.

Option A (no enforcement) for the initial implementation is the practical choice. Surface this to engineering.

**Uniqueness check** is straightforward: `content.split(old_string).length - 1 > 1` and `replace_all === false` → error. No architectural complexity.

### 3.3 Permission seam implementation options

The three options described in §2.3 (injected callback, yield-and-resume, out-of-band Promise) are all feasible. Engineering must decide. Key trade-offs:

- Option A (callback) is simplest for consumers, requires no loop changes beyond adding a pre-call gate, and the callback can be async (naturally handles network-based approval services).
- Option B (yield event) is the most idiomatic for the async-generator architecture but requires the consumer to handle a new event type and possibly drive the generator differently. Also requires the event to carry enough information for the consumer to make a decision.
- Option C (out-of-band Promise) is the most fragile (lifecycle bugs if the consumer never resolves the Promise).

For a headless library used primarily programmatically, Option A is likely the best fit.

### 3.4 Cancellation wiring

No architectural alternatives — the seam is already decided (`signal?: AbortSignal` on `ToolCallContext`). The work is purely mechanical:
1. Add `signal?: AbortSignal` to `ToolCallContext` interface.
2. `agentLoop` sets `const context: ToolCallContext = { signal }`.
3. Add `signal?: AbortSignal` to `ExecOptions`.
4. `NodePlatform.exec` forwards to `execFileAsync(..., { signal })`.
5. `bash` tool reads `context.signal` and passes as `options.signal`.

---

## 4. Domain & Landscape Constraints

### 4.1 Hard constraints

**Hard constraint — UI-free/headless boundary** (`docs/project/decisions.md`, "Headless, UI-free framework boundary"): The core engine imports zero UI code. The permission seam must be a pure async callback or event, never a React hook, TTY read, or any UI-coupled mechanism. Any approval dialog is the consumer's responsibility.

**Hard constraint — Platform method additions are breaking changes**: The decisions log ("Platform M1 method set") explicitly states "Adding methods in M2 is a breaking change for existing Platform implementations." Any new `Platform` method (e.g., `execShell`) must be treated as breaking and coordinated with `NodePlatform`, `MockPlatform`, and test stubs. Adding optional fields to `ExecOptions` is NOT breaking (existing callers omit the field).

**Hard constraint — `ToolCallContext` is interface-merging only, all fields optional**: The decisions log ("M2 seams confirmed", "ToolCallContext extension mechanism") mandates that SDK-added fields be optional. Adding `signal?: AbortSignal` to the core interface directly is fine (it is core functionality); SDK fields remain optional via merging.

**Hard constraint — sequential tool execution in M1**: `runTools.ts` is a sequential `for` loop. The permission seam and cancellation wiring must not assume concurrent tool calls. This simplifies the design (no need for per-call signal isolation).

**Hard constraint — no `process`, `fs`, `child_process` outside `platform/node.ts`**: The bash tool's `call` function may not import `child_process` directly. It must call `platform.exec(...)`. This is already the pattern for `readFileTool` and `writeFileTool`.

### 4.2 Soft constraints / conventions

- Tool names use `snake_case` (consistent with existing `read_file`, `write_file`).
- Built-in tools live in `packages/core/src/tools/builtin/`.
- New built-in tools are exported from `packages/core/src/index.ts`.
- Tool schemas use JSON Schema 7 (`zodToJsonSchema` with `target: "jsonSchema7"`) — confirmed by the 2026-06-29 decision log entry.
- The `exactOptionalPropertyTypes: true` TS config is in force; conditional spread is required when forwarding optional fields to third-party APIs.

---

## 5. Key Findings & Implications

**Finding 1 — bash tool needs shell semantics, not execFile semantics.**
`Platform.exec` currently splits on spaces and uses `execFile`, which cannot run shell pipelines or compound commands (`cmd1 && cmd2`). A useful `bash` tool requires a full shell invocation. The cleanest approach is adding `shell?: boolean` to `ExecOptions` (additive, not breaking) and having the `bash` tool always set it. Alternatively, the tool can hard-code `/bin/sh -c` as the program. The architecture must pick one.
*Engineering-facing:* this is a Platform interface design choice — the `shell` option vs. hard-coded `/bin/sh -c` vs. new `execShell` method. The first two are feasible without breaking changes; the third is breaking. Isolate this decision early.

**Finding 2 — FileEditTool's uniqueness-match contract is load-bearing and novel.**
The requirement that `old_string` appear exactly once (or `replace_all: true`) is the contract that makes string-replacement edits safe. The failure message ("Found N matches ... provide more context") teaches the model to add context. This is well-trodden ground in the reference and easy to implement. The read-before-edit enforcement is orthogonal and can be deferred.
*Engineering-facing:* decide whether the initial `edit_file` enforces read-before-edit (requires `ToolCallContext` state injection by the caller, which the SDK — not core — currently handles) or skips it. Skipping is safe to ship first; log as a known limitation.

**Finding 3 — Permission seam design must resolve the "ask" path for headless consumers.**
Claude Code's "ask" path triggers a React UI dialog. In a headless library, "ask" must flow through a consumer-provided async callback or a new AgentEvent. Neither path is obvious from the existing loop — the loop has no pre-tool hook point today. A pre-tool gate must be added to `runTools` (or at the loop level) without breaking the existing sequential flow.
*Engineering-facing:* the hook insertion point (before `tool.call` in `runTools`) and the async callback signature must be designed. Avoid adding `canUseTool` as a positional arg to `Tool.call` itself (that churns every tool's signature); prefer injecting it via `ToolCallContext` or as a loop-level callback.
*Product-facing:* does the feature assume the permission callback is async (can call out to a human, a policy service, etc.) or synchronous (in-process decision only)? This bounds whether it must be `async`.

**Finding 4 — Cancellation wiring is mechanical and non-breaking.**
The seam is already reserved (`signal?: AbortSignal` on `ToolCallContext`, per the decisions log). The wiring is additive: optional fields on both `ToolCallContext` and `ExecOptions`, and a one-liner in `agentLoop` to populate the context. No existing tool or test breaks. The primary risk is that `NodePlatform.exec` must use `execFileAsync`'s `signal` option correctly (abort vs. kill behavior on Node).
*Engineering-facing:* confirm Node 22's behavior when `execFile` receives an AbortSignal that fires mid-execution (it sends SIGTERM by default; verify whether `bash` tool calls need a grace period or can rely on the timeout as the primary mechanism instead).

**Finding 5 — The `ToolCallContext` interface is the correct extension point for all four sub-features.**
All four sub-areas (bash, edit_file, permission seam, cancellation) can be cleanly wired through `ToolCallContext` without adding positional args to `Tool.call`. The signal goes in `context.signal`; a permission callback could go in `context.canUseTool?: (name, input) => Promise<'allow' | 'deny'>` (or equivalent); read-file-state for edit_file enforcement goes in `context.readFileState`. The interface merging pattern supports this without breaking existing tools.
*Engineering-facing:* decide which of these optional fields (if any) belong in the **core** `ToolCallContext` vs. the **SDK** layer's extension. `signal` is core (cross-cutting operational concern); `canUseTool` could be either (an argument for core: the loop is where enforcement runs; an argument for SDK: the callback implementation is always consumer-provided and could stay out-of-band).

**Finding 6 — The bash tool's model-facing description and prompt are important for correct model behavior.**
Claude Code's Bash prompt explicitly tells the model the timeout, warns about avoiding `cat/grep/sed` in favor of dedicated tools, and describes sandboxing constraints. A minimal `bash` tool that just runs commands without a good description will likely be misused. The description string is part of the tool schema sent to the model.
*Engineering-facing:* write a description that (a) states what shell is used, (b) mentions timeout, (c) notes that exit code, stdout, and stderr are all returned. This is not a product decision, just good schema hygiene.

---

## 6. Sources

All sources are primary — either the project's own code or the decompiled reference source.

| Source | Type | What it contributed | Trust |
|--------|------|---------------------|-------|
| `packages/core/src/types/tool.ts` | Primary (project code) | Exact `Tool<TInput>`, `ToolCallContext`, `defineTool` interfaces; confirms `context = {}` in M1 | High |
| `packages/core/src/types/platform.ts` | Primary (project code) | `ExecOptions` (timeout, cwd, env — no signal), `ExecResult`, `Platform` interface | High |
| `packages/core/src/loop/loop.ts` | Primary (project code) | `agentLoop` wiring: `context = {}` at line 23, signal to `provider.stream` at lines 41-43, signal not forwarded to tools | High |
| `packages/core/src/loop/runTools.ts` | Primary (project code) | Tool execution flow: `tool.call(data, platform, context)` at line 62, `context` is always the `{}` object from loop | High |
| `packages/core/src/platform/node.ts` | Primary (project code) | `NodePlatform.exec` uses `execFile` (split on space, no shell), M1 note about AbortSignal at lines 34-39 | High |
| `packages/core/src/tools/builtin/readFile.ts` | Primary (project code) | Built-in tool pattern; `defineTool` usage; range parameters | High |
| `packages/core/src/tools/builtin/writeFile.ts` | Primary (project code) | Range-replace pattern; confirms `write_file` has no read-before-write check | High |
| `packages/core/src/agent.ts` | Primary (project code) | `AbortController` creation, signal threading to `agentLoop`, finally-abort on generator return | High |
| `packages/core/src/index.ts` | Primary (project code) | Current exports; `editFileTool` not yet exported | High |
| `packages/core/src/tools/registry.ts` | Primary (project code) | `ToolRegistry.toSchemas()`, jsonSchema7 target | High |
| `docs/project/decisions.md` | Primary (project docs) | Platform M1 method set (breaking change note); M2 seam for `signal` on `ToolCallContext`; blanket-allow in M1; sequential execution in M1; `isConcurrencySafe` hook; `write_file` known issue | High |
| `docs/project/known-issues.md` | Primary (project docs) | `write_file` offset-past-EOF bug; confirms no other relevant known issues | High |
| `claude-code-source-code/src/tools/BashTool/BashTool.tsx` | Primary (reference source, decompiled) | Input schema, timeout values, output handling, checkPermissions wiring, abortController usage in call | High (but decompiled) |
| `claude-code-source-code/src/tools/BashTool/bashPermissions.ts` | Primary (reference source, decompiled) | Full `bashToolHasPermission` algorithm; exact/prefix/wildcard rule matching; `stripSafeWrappers`; SAFE_ENV_VARS; deny vs. allow stricter env stripping | High (but decompiled) |
| `claude-code-source-code/src/tools/BashTool/prompt.ts` | Primary (reference source, decompiled) | Default timeout 120s, max timeout 600s; description of how the model is instructed to use Bash | High (but decompiled) |
| `claude-code-source-code/src/tools/FileEditTool/FileEditTool.ts` | Primary (reference source, decompiled) | Full `validateInput` contract including uniqueness check, read-before-edit enforcement, stale-read check, errorCodes | High (but decompiled) |
| `claude-code-source-code/src/tools/FileEditTool/types.ts` | Primary (reference source, decompiled) | Exact Zod schema: `file_path`, `old_string`, `new_string`, `replace_all` | High (but decompiled) |
| `claude-code-source-code/src/types/permissions.ts` | Primary (reference source, decompiled) | `PermissionBehavior` union (`allow | deny | ask`); mode names; `PermissionRule` type | High (but decompiled) |
| `claude-code-source-code/src/Tool.ts` (lines 123-148) | Primary (reference source, decompiled) | `ToolPermissionContext` shape; `ToolUseContext.abortController` field | High (but decompiled) |
| `docs/project/research/02-tools-and-permissions.md` | Primary (project docs) | Pre-existing subsystem map; execution pipeline summary; permission modes | High |
| `claude-code-source-code/src/utils/timeouts.ts` | Primary (reference source, decompiled) | DEFAULT_TIMEOUT_MS = 120_000, MAX_TIMEOUT_MS = 600_000; env var overrides | High (but decompiled) |

---

## 7. Open Questions & Unknowns

**OQ-1 — Shell invocation strategy for `bash` tool (Platform design question)**
Should the `bash` tool invoke shell via (a) a new `shell?: boolean` flag on `ExecOptions`, (b) hard-coded `/bin/sh -c` in the tool, or (c) a new `Platform.execShell()` method? Option (c) is a breaking Platform change. Options (a) and (b) are additive. The engineer must decide; this choice shapes `ExecOptions` and `NodePlatform` changes.

**OQ-2 — Read-before-edit enforcement for `edit_file`**
Should the M1 `edit_file` tool enforce "must read before edit" (requires `ToolCallContext` to carry a `readFileState: Map`)? This requires the caller to populate context with state the core does not manage today. Deferring enforcement simplifies M1 but leaves a correctness gap. Should it be enforced in core, deferred to the SDK, or skipped entirely for this feature?

**OQ-3 — Permission seam surface: callback vs. event vs. other**
Which of the three options (injected async callback on `Agent`/`AgentOptions`, new `AgentEvent` variant with generator-resume, or out-of-band Promise on `ToolCallContext`) should the permission seam use? This choice affects `AgentOptions`, the event union, and how existing consumers need to update. Engineering must decide.

**OQ-4 — Where does `canUseTool` live in the call stack?**
Should the permission gate live in `runTools` (before calling `tool.call`), or injected into `ToolCallContext` so tools could theoretically check it themselves (reference style)? The simpler and more correct answer for a headless library is probably the loop-level gate. But this must be resolved before implementing.

**OQ-5 — Default permission behavior for `bash` specifically**
The brief states "dangerous calls (esp. bash) can be gated." Does the feature ship with bash auto-gated (the callback is required to allow bash, defaulting to deny), or blanket-allow-by-default (the existing behavior) with the callback as an opt-in override? This is a product/UX question only the user can decide.

**OQ-6 — AbortSignal kill behavior in `NodePlatform.exec`**
When `execFile` receives an `AbortSignal` that fires, Node sends SIGTERM to the child process by default (Node 16+). Does a shell process spawned for the `bash` tool need SIGKILL after a grace period, or is SIGTERM sufficient? This is a Node-level behavior question that may need a quick spike or doc check.

**OQ-7 — `ToolCallContext.signal` population: loop-level or agent-level?**
Currently `context = {}` is created once in `agentLoop` and reused across all turns. The `AbortSignal` is created at `agent.run()` time. Populating `context.signal = signal` at loop initialization is correct (the signal covers the whole run, not per-turn). But should `context` be re-created per turn (to allow SDK extension per-turn) or kept as one object? Currently it is one object per run; this is a loop design question.

**OQ-8 — Exports and naming**
What are the exported names for the new built-in tools? `bash` vs. `bashTool`; `edit_file` vs. `editFileTool`; export from `packages/core/src/index.ts` directly? The existing pattern is `readFileTool` / `writeFileTool` as named exports. Consistent naming suggests `bashTool` / `editFileTool`. But the model-facing `name` string is `bash` / `edit_file` (snake_case tool names). Confirm conventions with the engineer.

# 02 — Tools & Permissions

Files: `src/Tool.ts`, `src/tools.ts`, `src/tools/`, `src/services/tools/toolExecution.ts`,
`src/types/permissions.ts`, `src/utils/permissions/`

## The Tool interface

Defined at `Tool.ts:362–695`. A tool is roughly:

```ts
Tool<Input, Output> = {
  name: string
  aliases?: string[]

  // execution
  call(args, context, canUseTool, parentMessage, onProgress): Promise<ToolResult<Output>>

  // schema & validation
  inputSchema: ZodType
  inputJSONSchema?: ToolInputJSONSchema     // MCP fallback
  outputSchema?: ZodType
  validateInput?(input, context): Promise<ValidationResult>

  // permissions
  checkPermissions(input, context): Promise<PermissionResult>
  preparePermissionMatcher?(input): (pattern: string) => boolean

  // metadata
  description(input, options): Promise<string>
  isReadOnly(input): boolean
  isConcurrencySafe(input): boolean
  isDestructive?(input): boolean

  // UI rendering (all optional)
  renderToolUseMessage, renderToolResultMessage, userFacingName, getPath, ...
}
```

`buildTool()` (Tool.ts:783) is a factory supplying defaults so tools can omit optional
methods. **For us, the essential fields are `name`, `inputSchema`, `description`, `call`,
and (later) `checkPermissions` + `isReadOnly`/`isConcurrencySafe`.**

## Registration & discovery

- `getAllBaseTools()` (tools.ts:172) — static array of ~60 built-ins + feature-gated ones.
- `getTools(permissionContext)` (tools.ts:271) — filters by deny rules, mode, enablement.
- `assembleToolPool(ctx, mcpTools)` (tools.ts:345) — merges built-in + MCP, dedupes, sorts
  for prompt-cache stability.
- The resulting `Tool[]` is converted to the model's tool-schema array and passed in the
  request; the model replies with `tool_use` blocks referencing tools by name.

## Execution pipeline (end-to-end)

`services/tools/toolExecution.ts:600–750`:

```
Zod input validation                          → InputValidationError back to model on fail
  → Tool.validateInput()                      → custom error back to model on fail
    → canUseTool() → PermissionDecision        (allow | ask | deny)
       → (ask) permission prompt to user
       → (deny) error result back to model
       → (allow) Tool.call(args, ctx, ...)
         → map ToolResult → tool_result block  → back to model
```

Hooks can run pre/post (polish). Validation failures are returned to the model as errors so
it can self-correct — a nice property worth keeping.

## Permission system

Types at `types/permissions.ts`. A decision is one of:

```ts
{ behavior: 'allow', updatedInput?, decisionReason? }
{ behavior: 'ask',   message, suggestions?, pendingClassifierCheck? }
{ behavior: 'deny',  message, decisionReason }
```

**Modes:** `default`, `bypassPermissions`, `dontAsk`, `acceptEdits`, `auto` (ML classifier),
`plan`, `bubble`.

**Rules** live in a `ToolPermissionContext` as `alwaysAllowRules` / `alwaysDenyRules` /
`alwaysAskRules`, keyed by source (userSettings, projectSettings, localSettings, cliArg,
session, policy, …). Pattern matching via `preparePermissionMatcher()`. Bash gets extra
classifier-based scrutiny.

**Decision reasons:** `rule`, `mode`, `classifier`, `hook`, `safetyCheck` (e.g. blocks
writes to `.git/`, `.claude/`).

## Built-in tools (grouped)

- **File**: FileRead, FileWrite, FileEdit, NotebookEdit, Glob, Grep
- **Shell**: Bash, PowerShell
- **Web**: WebFetch, WebSearch, WebBrowser
- **Agents/tasks**: Agent, TaskOutput, Task{Create,Get,Update,List}, Skill, ExitPlanMode
- **Collab**: AskUserQuestion, TodoWrite, SendMessage
- **Infra**: ListMcpResources, ReadMcpResource, ToolSearch (deferred), Config, Worktree,
  Workflow, Cron, Monitor, LSP

## Minimal essence (build first)

1. **Tool interface** — `name`, `inputSchema`, `description`, `call`.
2. **Tool registry** — array + lookup-by-name; serialize schemas for the model.
3. **Execution loop** — validate → (permission) → call → format result back to model.
4. **Permission context** — a mode + allow/deny/ask rules (can start as blanket allow).
5. **Model integration** — `Tool[]` → API schema; map `tool_use` ↔ `tool_result`.

Defer: MCP, ToolSearch/deferred loading, hooks, ML classifiers, rich UI rendering, granular
path permissions.

## Citations

- Tool interface — Tool.ts:362–695; `buildTool()` Tool.ts:783
- Registry — tools.ts:172–389
- Execution — services/tools/toolExecution.ts:600–750
- Permissions — types/permissions.ts; utils/permissions/permissions.ts:122–400

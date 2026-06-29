# Task 02 — Core Types

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Implement all shared type definitions in `packages/core/src/types/` and wire the core package's build tooling. At the end of this task:

- Five type modules exist and typecheck cleanly: `messages.ts`, `platform.ts`, `tool.ts` (with the `defineTool` helper), `provider.ts` (ToolSchema, ProviderRequest, ProviderEvent, Provider, LogEntry, Logger), and `events.ts` (AgentEvent, Terminal).
- The core package's `tsup.config.ts` and `vitest.config.ts` are in place (created in task 01, verified here).
- `pnpm --filter tiny-agentic build` succeeds (compiles stubs).
- `pnpm --filter tiny-agentic typecheck` reports zero errors.

These types are the contracts every other module codes against. Nothing else in the core imports from a provider SDK or a platform; the types express the boundaries.

## Context files

- `docs/engineering/2026-06-27-code-architecture.md` — The exact TypeScript skeletons for all five type files. Implement these verbatim. Do not deviate from the exact shapes.
- `docs/engineering/2026-06-27-engineering-spec.md` — §3.1–§3.11 (public interfaces), §2.1 (module map), §2.3 (module dependency DAG)
- `docs/decisions.md` — "ToolCallContext extension mechanism: TypeScript interface merging", "AbortSignal threading: second argument to Provider.stream()", "Platform M1 method set", "ToolSchema JSON Schema target"
- `packages/core/tsconfig.json` (created in task 01) — compiler options that apply

## Downstream dependencies

- Tasks 03–08 import from one or more of these type files. The exported shapes must not change after this task commits. Specifically:
  - `tool.ts` exports `ToolCallContext` (interface, empty, open for merging), `Tool<TInput>`, `defineTool`. Tasks 04, 07, 08 depend on these.
  - `provider.ts` exports `ToolSchema`, `ProviderRequest`, `ProviderEvent`, `Provider`, `LogEntry`, `Logger`. Tasks 05, 06, 07 depend on these.
  - `events.ts` exports `AgentEvent`, `Terminal`. Tasks 03, 07, 08 depend on these.
  - `platform.ts` exports `Platform`, `ExecOptions`, `ExecResult`. Tasks 03, 04, 06, 07 depend on these.
  - `messages.ts` exports `Message`, `ContentBlock`, `TextBlock`, `ToolUseBlock`, `ToolResultBlock`. Tasks 05, 07, 08 depend on these.
- Task 08 (`index.ts`) re-exports all public types from these modules — the export names must match exactly.

## Steps

1. **Create `packages/core/src/types/messages.ts`** — implement exactly as in the code-architecture doc. Four types: `TextBlock`, `ToolUseBlock`, `ToolResultBlock`, `ContentBlock` (union), `Message` (discriminated union on `role`). No imports from `@anthropic-ai/sdk`. All types exported.

2. **Create `packages/core/src/types/platform.ts`** — implement exactly as in the code-architecture doc. Types: `ExecOptions` (all fields optional), `ExecResult`, `Platform` interface (four methods: `cwd(): string`, `readFile`, `writeFile`, `exec`). All exported.

3. **Create `packages/core/src/types/tool.ts`** — implement exactly as in the code-architecture doc. `ToolCallContext` interface (empty body — include the eslint-disable comment for `no-empty-object-type` as specified). `Tool<TInput extends ZodType>` interface with `name`, `description`, `inputSchema`, `call`, `isConcurrencySafe?`. `defineTool<S extends ZodType>` function. All exported. Import `ZodType` and `z` from `"zod"` (type-only), and `Platform` from `"./platform.js"` (type-only).

4. **Create `packages/core/src/types/provider.ts`** — implement exactly as in the code-architecture doc. Types: `ToolSchema`, `ProviderRequest` (with `Message[]` imported type-only from `"./messages.js"`), `ProviderEvent` (three-variant union: `text_delta` | `tool_use` | `message_stop` — the `tool_use` variant carries the optional `inputParseError?: boolean`, set by a provider mapper when streamed tool input was unparseable JSON; there is **no** `PARSE_ERROR` symbol export), `LogEntry` (three-variant union), `Logger` (function type), `Provider` interface (`stream(request, signal?): AsyncGenerator<ProviderEvent>`). All exported.

5. **Create `packages/core/src/types/events.ts`** — implement exactly as in the code-architecture doc. Types: `AgentEvent` (seven-variant discriminated union), `Terminal` (three-variant discriminated union). Import `Message` type-only from `"./messages.js"`. All exported.

6. **Verify the module dependency DAG is respected.** Check imports in each file:
   - `messages.ts` — no intra-package imports.
   - `platform.ts` — no intra-package imports.
   - `tool.ts` — imports only from `./platform.js` and `zod` (external).
   - `provider.ts` — imports only from `./messages.js`.
   - `events.ts` — imports only from `./messages.js`.
   None of these files may import from `loop/`, `agent.ts`, `tools/`, `env/`, `providers/`, or `platform/`.

7. **Update `packages/core/src/index.ts`** — replace the stub with the full public re-exports as specified in the code-architecture doc's `index.ts` section. At this stage, only the type re-exports are possible (the `Agent`, built-in tools, and utilities don't exist yet). Add commented-out lines for those and export only what exists:
   ```ts
   // Types — fully implemented in task-02
   export type { AgentEvent, Terminal } from "./types/events.js";
   export type { Message, ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock } from "./types/messages.js";
   export type { Tool, ToolCallContext } from "./types/tool.js";
   export { defineTool } from "./types/tool.js";
   export type { Provider, ProviderRequest, ProviderEvent, ToolSchema, Logger, LogEntry } from "./types/provider.js";
   export type { Platform, ExecOptions, ExecResult } from "./types/platform.js";
   // Agent, built-in tools, utilities — added in tasks 03–08
   ```

8. **Run `pnpm --filter tiny-agentic typecheck`** and fix any errors. Common pitfall: `exactOptionalPropertyTypes` requires conditional spread for any optional property forwarding (see engineering spec §1.6 ergonomics note). The types themselves are mostly pure definitions and should not trigger this unless a `defineTool` impl uses optional fields.

9. **Run `pnpm --filter tiny-agentic build`** to confirm tsup produces `dist/` output without errors.

## Acceptance criteria

- [ ] `pnpm --filter tiny-agentic typecheck` exits with code 0 and reports no errors.
- [ ] `pnpm --filter tiny-agentic build` exits with code 0; `dist/index.js` and `dist/index.d.ts` are present.
- [ ] `packages/core/src/types/messages.ts` exists and exports `Message`, `TextBlock`, `ToolUseBlock`, `ToolResultBlock`, `ContentBlock`.
- [ ] `packages/core/src/types/platform.ts` exists and exports `Platform`, `ExecOptions`, `ExecResult`.
- [ ] `packages/core/src/types/tool.ts` exists and exports `ToolCallContext`, `Tool`, `defineTool`. The `ToolCallContext` body is empty (contains only the eslint-disable comment and a descriptive comment).
- [ ] `packages/core/src/types/provider.ts` exists and exports `ToolSchema`, `ProviderRequest`, `ProviderEvent`, `Provider`, `LogEntry`, `Logger`.
- [ ] `packages/core/src/types/events.ts` exists and exports `AgentEvent`, `Terminal`.
- [ ] No type file in `packages/core/src/types/` imports from outside `types/` (except `zod` for `tool.ts`). Verify with a quick `grep -r "from '\.\." packages/core/src/types/` — all results should be `./messages.js` or `./platform.js` or `"zod"`.

## Output files

- Created: `packages/core/src/types/messages.ts`
- Created: `packages/core/src/types/platform.ts`
- Created: `packages/core/src/types/tool.ts`
- Created: `packages/core/src/types/provider.ts`
- Created: `packages/core/src/types/events.ts`
- Modified: `packages/core/src/index.ts` (replaced stub with type re-exports)

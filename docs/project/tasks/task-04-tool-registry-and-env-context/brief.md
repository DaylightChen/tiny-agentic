# Task 04 — ToolRegistry and Env Context

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Implement `packages/core/src/tools/registry.ts` (the `ToolRegistry` class) and `packages/core/src/env/context.ts` (`buildEnvContext`). Write unit tests for `buildEnvContext`. At the end of this task:

- `ToolRegistry` can be constructed from a `Tool[]`, look up tools by name, and serialize them to `ToolSchema[]` via `zod-to-json-schema`.
- `buildEnvContext(platform)` returns a multi-line string containing working directory, ISO date, and git branch/status (or their graceful omissions).
- The `env-context.test.ts` tests pass with a `MockPlatform`.

## Context files

- `docs/engineering/2026-06-27-code-architecture.md` — Exact skeletons for `tools/registry.ts` and `env/context.ts`
- `docs/engineering/2026-06-27-engineering-spec.md` — §3.5 (ToolSchema, zod-to-json-schema options), §2.1 (module map), §2.3 (dependency DAG), §8.3 (7.13 env context test)
- `docs/decisions.md` — "ToolSchema JSON Schema target: openApi3", "Platform gains cwd()"
- `packages/core/src/types/tool.ts` — `Tool<TInput>` interface
- `packages/core/src/types/provider.ts` — `ToolSchema` type
- `packages/core/src/types/platform.ts` — `Platform` interface (cwd, exec needed by buildEnvContext)

## Downstream dependencies

- Task 07 (`loop/loop.ts`) calls `registry.toSchemas()` to build `toolSchemas` passed in every `ProviderRequest`. The returned `ToolSchema[]` must conform to the shape in `types/provider.ts`.
- Task 07 (`loop/loop.ts`) calls `registry.findByName(name)` to look up a tool during execution. Returns `Tool | undefined`.
- Task 08 (`agent.ts`) constructs `new ToolRegistry(this.tools)` at the start of each `run()` call.
- Task 08 (`agent.ts`) calls `buildEnvContext(this.platform)` and prepends the result to the system prompt.
- Task 08 tests use `MockPlatform` with scripted exec responses — keep the `MockPlatform` shape stable (same interface as in the code-architecture doc §8.2).

## Steps

1. **Install `zod-to-json-schema` if not already hoisted.** It is listed in `packages/core/package.json` `dependencies` (added in task 01). Confirm `pnpm install` has resolved it: `ls packages/core/node_modules/zod-to-json-schema` should succeed (or it is hoisted to the root).

2. **Create `packages/core/src/tools/registry.ts`** — implement exactly as in the code-architecture doc:
   ```ts
   import { zodToJsonSchema } from "zod-to-json-schema";
   import type { Tool } from "../types/tool.js";
   import type { ToolSchema } from "../types/provider.js";

   export class ToolRegistry {
     private readonly byName: Map<string, Tool>;

     constructor(tools: Tool[]) {
       this.byName = new Map(tools.map(t => [t.name, t]));
     }

     findByName(name: string): Tool | undefined {
       return this.byName.get(name);
     }

     toSchemas(): ToolSchema[] {
       return Array.from(this.byName.values()).map(tool => ({
         name: tool.name,
         description: tool.description,
         inputSchema: zodToJsonSchema(tool.inputSchema, {
           target: "openApi3",
           $refStrategy: "none",
         }) as ToolSchema["inputSchema"],
       }));
     }
   }
   ```

   Important: `zod-to-json-schema` with `target: "openApi3"` produces a schema object without a `$schema` property. The cast `as ToolSchema["inputSchema"]` is safe because the shape matches (has `type`, `properties`, optionally `required`). Verify the output structure in a test.

3. **Create `packages/core/src/env/context.ts`** — implement exactly as in the code-architecture doc:
   - Lines accumulated: `Working directory: <platform.cwd()>`, `Date: <ISO date, date portion only>`.
   - Try/catch around `platform.exec("git rev-parse --abbrev-ref HEAD")` — on success and exitCode 0, add `Git branch: <trimmed stdout>`.
   - Try/catch around `platform.exec("git status --short")` — on success and exitCode 0, parse lines: if non-empty, add `Git status: N file(s) modified`; if empty, add `Git status: clean`.
   - Any exec failure (throw or non-zero exit) silently omits the git lines — no error propagated.
   - Returns `lines.join("\n")`.

4. **Create `packages/core/src/__tests__/env-context.test.ts`** — write Vitest tests using a `MockPlatform` defined inline in the test file. The mock implements `Platform`:

   ```ts
   class MockPlatform implements Platform {
     private files: Record<string, string>;
     execResponses: ExecResult[];
     private fakeCwd: string;

     constructor(
       files: Record<string, string> = {},
       execResponses: ExecResult[] = [],
       cwd: string = "/mock/cwd",
     ) { ... }

     cwd(): string { return this.fakeCwd; }
     async readFile(path: string): Promise<string> { ... }
     async writeFile(path: string, content: string): Promise<void> { ... }
     async exec(): Promise<ExecResult> {
       return this.execResponses.shift() ?? { stdout: "", stderr: "", exitCode: 0 };
     }
   }
   ```

   Test cases:
   - **Happy path:** mock with cwd `/test/dir`, exec responses: `{ stdout: "main\n", exitCode: 0 }` (branch), `{ stdout: " M foo.ts\n", exitCode: 0 }` (status). Assert the result string contains `Working directory: /test/dir`, contains `Git branch: main`, contains `Git status: 1 file(s) modified`, contains today's date (partial match on year is fine).
   - **No git (exec throws):** mock exec that throws `new Error("not a git repo")`. Assert result contains `Working directory:` and `Date:` but does NOT contain `Git branch:` or `Git status:`.
   - **Git not a repo (non-zero exit):** mock exec returns `{ stdout: "", stderr: "fatal: ...", exitCode: 128 }`. Assert git lines omitted.
   - **Clean repo:** exec responses give `{ stdout: "feature\n", exitCode: 0 }` and `{ stdout: "", exitCode: 0 }`. Assert `Git status: clean`.

   This covers success criterion 7.13 (env context injection) and **7.15 (git-absent degradation)**: the "No git (exec throws)" and "Git not a repo (non-zero exit)" cases above assert the git lines are omitted with no error thrown — so `buildEnvContext` returns normally and a run on a git-less platform proceeds to `agent_done` rather than failing.

5. **Run `pnpm --filter tiny-agentic test`** — all tests (collect + env-context) pass.

6. **Run `pnpm --filter tiny-agentic typecheck`** — no errors.

## Acceptance criteria

- [ ] `pnpm --filter tiny-agentic test` passes, including all tests in `env-context.test.ts`.
- [ ] `pnpm --filter tiny-agentic typecheck` exits with code 0.
- [ ] `packages/core/src/tools/registry.ts` exists and exports `ToolRegistry` with `findByName` and `toSchemas`.
- [ ] `packages/core/src/env/context.ts` exists and exports `buildEnvContext`.
- [ ] Manually verify `toSchemas()` output: construct a `ToolRegistry` with one tool whose `inputSchema` is `z.object({ path: z.string() })`, call `toSchemas()`, assert the result has `inputSchema.type === "object"` and `inputSchema.properties.path`.
- [ ] Success criterion 7.13 is green: the env context output contains cwd, date, git branch when the mock platform returns valid git output.
- [ ] Success criterion 7.15 (git-absent degradation) is green: when the mock platform's `exec` throws or returns a non-zero exit, `buildEnvContext` omits the git lines and returns normally (no throw).

## Output files

- Created: `packages/core/src/tools/registry.ts`
- Created: `packages/core/src/env/context.ts`
- Created: `packages/core/src/__tests__/env-context.test.ts`

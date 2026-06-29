# Task 02 — `bash` Tool

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Implement the `bashTool` built-in in `packages/core/src/tools/builtin/bash.ts` and its unit test suite in `packages/core/src/__tests__/bash.test.ts`.

`bashTool` lets the model execute shell commands. It always passes `{ shell: true }` to `platform.exec`, accepts an optional `timeout` (clamped to 600,000 ms), returns `{ stdout, stderr, exitCode }` as the tool result, treats non-zero exit codes as data (not errors), and forwards `context.signal` when present. The implementation must have no direct imports of `child_process`, `fs`, or `process` — all platform access goes through the injected `Platform`.

At the end of this task, `packages/core/src/tools/builtin/bash.ts` exists, is importable, and all `bash.test.ts` tests pass. The file is not yet exported from `index.ts` (that is task-05).

## Context files

- `packages/core/src/tools/builtin/readFile.ts` — canonical pattern for a built-in tool using `defineTool`
- `packages/core/src/tools/builtin/writeFile.ts` — canonical pattern with more complex logic
- `packages/core/src/types/tool.ts` — current state after task-01: `ToolCallContext` now has `signal?: AbortSignal`
- `packages/core/src/types/platform.ts` — current state after task-01: `ExecOptions` now has `shell?: boolean` and `signal?: AbortSignal`
- `packages/core/src/__tests__/builtin-tools.test.ts` — shows `MockPlatform` and test structure to mirror
- `docs/feature/agent-tooling/engineering/2026-06-29-agent-tooling-engineering.md` — §8.1 (full `bash` input schema and execution contract), §3.2 (states matrix for `bash`), §3.4 (edge-case behaviors), §3.5 (microcopy — though `bash` has no error strings beyond the generic `runTools` catch), §9 (engineering edge cases for `bash`), §12 (test strategy for `bash.test.ts`)

## Downstream dependencies

- **Task-05 (wiring and exports)** imports `bashTool` from `tools/builtin/bash.ts` and re-exports it from `index.ts`. Keep the named export `bashTool` stable.
- **Task-04 (permission gate)** calls `tool.call` for `bash` after the gate; the tool implementation is independent of the gate — no changes needed in `bash.ts` for the gate to function.
- **Task-05 integration test** constructs an `Agent` with `bashTool` and tests abort propagation. The `bashTool` must correctly forward `context.signal` to `platform.exec`.

## Steps

1. **Create `packages/core/src/tools/builtin/bash.ts`**. The tool must:

   - Use `defineTool` from `../../types/tool.js`.
   - Use `z` from `zod` for the input schema.
   - **Input schema** (exact fields per spec §8.1):
     ```ts
     z.object({
       command: z.string().describe("Shell command to execute. Supports pipes, redirects, and shell operators."),
       timeout: z.number().int().positive().optional()
         .describe("Timeout in milliseconds (max 600000). Default: 120000."),
       description: z.string().optional()
         .describe("Human-readable summary of what this command does. Logged but not used in execution."),
     })
     ```
   - **Tool description** (exact per spec §8.1):
     ```
     Execute a shell command using /bin/sh. Supports pipes, redirects, &&, ;, and other shell operators.
     Returns stdout, stderr, and exit code. A non-zero exit code means the command failed.
     Default timeout: 120 seconds (max: 600 seconds). Prefer dedicated tools (read_file, write_file, edit_file) over shell commands when available.
     ```
   - **`call` implementation**:
     1. Clamp timeout: `const rawTimeout = input.timeout ?? 120_000; const clampedTimeout = Math.min(rawTimeout, 600_000);`
     2. Build `ExecOptions`: always include `shell: true`, `cwd: platform.cwd()`, `timeout: clampedTimeout`. Include `signal: context.signal` only when `context.signal !== undefined` (use conditional spread to satisfy `exactOptionalPropertyTypes`).
     3. If `clampedTimeout < rawTimeout` (i.e., the model passed `timeout > 600_000`), the spec says add a note to `stderr` in the returned result: `"[timeout clamped to 600000ms]"`. Do this by appending to the `stderr` string after `platform.exec` returns.
     4. Call `await platform.exec(input.command, execOptions)`.
     5. Return `{ stdout, stderr, exitCode }` directly. Do NOT throw on non-zero exit codes.
     6. If `platform.exec` itself throws (unusual), let it propagate — `runTools` catches it.

2. **Create `packages/core/src/__tests__/bash.test.ts`**. Use the `MockPlatform` pattern from `builtin-tools.test.ts`. The mock's `exec` should be a configurable spy (see `runTools.test.ts` for the override pattern).

   Required test cases (per spec §12 test strategy):
   - `shell: true` is always forwarded in `ExecOptions` — assert the spy receives `{ shell: true, ... }`.
   - `cwd` defaults to `platform.cwd()` — assert `options.cwd` equals `"/work"` (mock's cwd).
   - Timeout clamping: input `timeout: 700_000` → exec called with `timeout: 600_000`, returned `stderr` contains `"[timeout clamped to 600000ms]"`.
   - Default timeout: no input `timeout` → exec called with `timeout: 120_000`.
   - Non-zero `exitCode` is returned without throwing: exec returns `{ exitCode: 2, stdout: "", stderr: "fail" }` → tool returns `{ exitCode: 2, stdout: "", stderr: "fail" }` with no error throw.
   - `context.signal` present → forwarded as `signal` in `ExecOptions`.
   - `context.signal` absent (context is `{}`) → no `signal` key in `ExecOptions` (not just `undefined`, but absent — `exactOptionalPropertyTypes` means checking `"signal" in opts` is false).
   - Successful command: exec returns `{ stdout: "hello\n", stderr: "", exitCode: 0 }` → tool returns same object.

3. **Run `pnpm test`** from `packages/core`. All 140 existing tests plus the new `bash.test.ts` tests must pass.

4. **Run `pnpm typecheck`** from `packages/core`. Zero errors expected.

5. **Verify the boundary**: confirm `bash.ts` does not import `child_process`, `fs`, or `process`:
   ```
   grep -n "child_process\|require('fs')\|from 'fs'\|from \"fs\"\|process\." packages/core/src/tools/builtin/bash.ts
   ```
   Expected: no matches.

## Acceptance criteria

- [ ] `pnpm test` (in `packages/core`) passes: all prior tests still pass, plus `bash.test.ts` tests.
- [ ] `pnpm typecheck` reports zero errors.
- [ ] `bashTool.name` is `"bash"` (verified by import in test).
- [ ] `shell: true` is always in the `ExecOptions` passed to `platform.exec` (asserted in `bash.test.ts`).
- [ ] `context.signal` is forwarded when present; absent from `ExecOptions` when `context.signal` is `undefined` (asserted in `bash.test.ts`).
- [ ] `timeout: 700_000` input is clamped to `600_000` in the `exec` call and the returned `stderr` contains `"[timeout clamped to 600000ms]"` (asserted in `bash.test.ts`).
- [ ] Non-zero exit code is returned as `{ exitCode: N, ... }`, not thrown (asserted in `bash.test.ts`).
- [ ] `bash.ts` has no direct imports of `child_process`, `fs`, or `process` (verified by grep in step 5).

## Output files

- Created: `packages/core/src/tools/builtin/bash.ts`
- Created: `packages/core/src/__tests__/bash.test.ts`

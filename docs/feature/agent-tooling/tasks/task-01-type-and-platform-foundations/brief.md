# Task 01 — Type and Platform Foundations

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Lay the type foundations that all subsequent tasks depend on, and refactor `NodePlatform.exec` to handle shell execution and `AbortSignal` forwarding. Specifically:

1. Add `signal?: AbortSignal` to `ToolCallContext` in `types/tool.ts` — needed by `bashTool` (task-02) to forward the run-level abort signal into `platform.exec`.
2. Add `shell?: boolean` and `signal?: AbortSignal` to `ExecOptions` in `types/platform.ts` — needed by the `bash` tool (task-02) to request shell-mode execution and signal forwarding.
3. Refactor `NodePlatform.exec` in `platform/node.ts` to branch on `options.shell`: when `shell: true`, pass the full command string directly (no split); forward `signal` and `shell` via the existing conditional-spread pattern.
4. Create `src/__tests__/node.test.ts` with unit tests covering: shell mode passes the full string (not split), non-shell mode works as before, `AbortSignal` forwarding works, and an already-aborted signal produces an error result.

This task is the one with the highest regression risk — the `NodePlatform.exec` refactor touches an existing, tested function. A clean pass of all 140 pre-existing tests at the end of this task proves the refactor is safe.

## Context files

- `packages/core/src/types/tool.ts` — current `ToolCallContext` interface; add `signal?: AbortSignal`
- `packages/core/src/types/platform.ts` — current `ExecOptions` type; add `shell?: boolean` and `signal?: AbortSignal`
- `packages/core/src/platform/node.ts` — `NodePlatform.exec` implementation to refactor; currently always splits on spaces
- `packages/core/src/__tests__/builtin-tools.test.ts` — shows the existing `MockPlatform` pattern to mirror in the new `node.test.ts`
- `packages/core/src/__tests__/runTools.test.ts` — shows how `ToolCallContext` is constructed (`const ctx: ToolCallContext = {}`) in tests
- `docs/feature/agent-tooling/engineering/2026-06-29-agent-tooling-engineering.md` — §6.1 (module changes), §6.3 (new interface contracts), §8.4 (NodePlatform conditional-spread code sketch), §10 (risks)

## Downstream dependencies

- **Task-02 (bash tool)** imports `ExecOptions` from `types/platform.ts` and calls `platform.exec({ shell: true, signal: context.signal, ... })`. Both new fields must be present and typed correctly.
- **Task-02** reads `context.signal` from `ToolCallContext`. The `signal?: AbortSignal` field must exist on the interface.
- **Task-03 (edit_file tool)** uses `ToolCallContext` but does not read `signal` — the additive field is harmless.
- **Task-04 (permission gate)** defines `ApprovalDecision`/`ApprovalHandler` in `types/tool.ts` (the same file edited here). The `signal` field added here must be preserved.
- **Task-05 (wiring)** sets `context.signal = signal` in `agentLoop`. It needs `ToolCallContext.signal?` to exist (added here).

## Steps

1. **Edit `packages/core/src/types/tool.ts`** — Add `signal?: AbortSignal` to the `ToolCallContext` interface. Place it before the existing comment so the interface reads:
   ```ts
   export interface ToolCallContext {
     signal?: AbortSignal;  // populated by agentLoop; tools forward to Platform.exec
   }
   ```
   Remove the `// eslint-disable-next-line @typescript-eslint/no-empty-object-type` comment since the interface now has a field.

2. **Edit `packages/core/src/types/platform.ts`** — Add `shell?: boolean` and `signal?: AbortSignal` to `ExecOptions`:
   ```ts
   export type ExecOptions = {
     cwd?: string;
     timeout?: number;
     env?: Record<string, string>;
     shell?: boolean;       // if true, use system shell (/bin/sh on Unix)
     signal?: AbortSignal;  // forward to execFile for abort support
   };
   ```

3. **Refactor `packages/core/src/platform/node.ts`** — Replace the current split-and-exec block inside `exec()` with a branch on `options.shell`. The existing conditional-spread pattern for `cwd`/`timeout`/`env` stays; two more spreads are added for `shell` and `signal`. When `shell: true`, the full `command` string (not split) is passed:
   ```ts
   async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
     const spreadOpts = {
       ...(options.cwd     !== undefined ? { cwd: options.cwd }         : {}),
       ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
       ...(options.env     !== undefined ? { env: { ...process.env, ...options.env } } : {}),
       ...(options.shell   !== undefined ? { shell: options.shell }     : {}),
       ...(options.signal  !== undefined ? { signal: options.signal }   : {}),
     };
     try {
       const execArgs: Parameters<typeof execFileAsync> = options.shell
         ? [command, spreadOpts]               // shell: true — full command, no split
         : [command.split(" ")[0]!, command.split(" ").slice(1), spreadOpts];
       const { stdout, stderr } = await execFileAsync(...execArgs);
       return { stdout, stderr, exitCode: 0 };
     } catch (err: unknown) {
       const execErr = err as { stdout?: string; stderr?: string; code?: number };
       return {
         stdout: execErr.stdout ?? "",
         stderr: execErr.stderr ?? "",
         exitCode: execErr.code ?? 1,
       };
     }
   }
   ```
   Note: `execFileAsync` is typed as `(file: string, args?: readonly string[], options?: ExecFileOptions)`. When shell is true, pass `(command, spreadOpts)` — the two-argument overload. When shell is false, pass `(program, args, spreadOpts)` — the three-argument overload. TypeScript may need a type assertion on `execArgs` due to the union; use `as Parameters<typeof execFileAsync>` if needed.

   Important: the `AbortError` thrown when a signal fires before exec starts must NOT escape as an uncaught exception — it should be caught by the existing `catch` block and returned as `{ stdout: "", stderr: "", exitCode: 1 }` (or the error message in stderr). The existing catch already handles this by converting to `execErr.code`.

4. **Create `packages/core/src/__tests__/node.test.ts`** — Unit tests for `NodePlatform.exec`. Because this test exercises real `child_process.execFile` calls, use real shell commands available on all CI platforms (avoid OS-specific paths). Recommended test structure:
   - `shell: true` path: `exec("echo hello", { shell: true })` → `{ stdout: "hello\n", stderr: "", exitCode: 0 }`. Confirm the command works with shell operators: `exec("echo a | cat", { shell: true })` → `{ stdout: "a\n", ... }`.
   - Default (no shell) path: `exec("node --version", {})` → `exitCode: 0`, `stdout` starts with "v". This validates the split-based path is intact.
   - Non-zero exit: `exec("node -e 'process.exit(2)'", { shell: true })` → `{ exitCode: 2 }`.
   - `AbortSignal` already aborted: create `const ctrl = new AbortController(); ctrl.abort(); exec("echo hi", { signal: ctrl.signal })` → the result is returned (not thrown) with `exitCode !== 0` (the abort causes `execFile` to throw `AbortError`; the catch converts it to an error result).
   - Timeout: `exec("node -e 'setTimeout(()=>{},5000)'", { shell: true, timeout: 100 })` → `exitCode !== 0` (times out; confirmed returned not thrown).

5. **Run the full test suite** to confirm zero regressions:
   ```
   cd packages/core && pnpm test
   ```
   Expected: 140 existing tests pass + new `node.test.ts` tests pass.

6. **Run typecheck** to confirm the additive type changes are clean:
   ```
   cd packages/core && pnpm typecheck
   ```

## Acceptance criteria

- [ ] `pnpm test` (in `packages/core`) passes: the 140 existing tests all pass, plus the new `node.test.ts` tests.
- [ ] `pnpm typecheck` reports zero errors.
- [ ] `NodePlatform.exec("echo hello", { shell: true })` returns `{ stdout: "hello\n", stderr: "", exitCode: 0 }` (asserted in `node.test.ts`).
- [ ] `NodePlatform.exec("echo a | cat", { shell: true })` returns `{ stdout: "a\n", stderr: "", exitCode: 0 }` — confirming pipe operators work in shell mode (asserted in `node.test.ts`).
- [ ] `NodePlatform.exec("node --version", {})` (no shell flag) still works — confirms the existing non-shell path is intact (asserted in `node.test.ts`).
- [ ] An already-aborted signal causes `exec` to return an error result (non-zero `exitCode`) rather than throwing (asserted in `node.test.ts`).
- [ ] `ToolCallContext` has a `signal?: AbortSignal` field (verified by `pnpm typecheck`).
- [ ] `ExecOptions` has `shell?: boolean` and `signal?: AbortSignal` fields (verified by `pnpm typecheck`).
- [ ] No new imports of `child_process`, `fs`, or `process` appear outside `platform/node.ts` (verify by grep: `grep -r "child_process\|require('fs')\|process\.env" packages/core/src --include="*.ts" | grep -v platform/node`).

## Output files

- Modified: `packages/core/src/types/tool.ts`
- Modified: `packages/core/src/types/platform.ts`
- Modified: `packages/core/src/platform/node.ts`
- Created: `packages/core/src/__tests__/node.test.ts`

# Task 03 — NodePlatform, serialize, collect

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Implement three standalone utility modules in `packages/core/src/`: `platform/node.ts` (the Node.js concrete implementation of the `Platform` interface), `utils/serialize.ts` (the `serializeToolResult` function), and `utils/collect.ts` (`collectText` and `collectEvents`). Write unit tests for `serialize.ts` and `collect.ts`. At the end of this task:

- `NodePlatform` is ready for the integration example in task 10 and for use in `env/context.ts` tests.
- `serializeToolResult` is ready for `loop/loop.ts` (task 07), which uses it to serialize tool results before bundling.
- `collectText` and `collectEvents` are ready for use in all test files from task 07 onward.
- All tests in `packages/core/src/__tests__/collect.test.ts` pass.

## Context files

- `docs/engineering/2026-06-27-code-architecture.md` — Exact skeletons for `platform/node.ts`, `utils/serialize.ts`, `utils/collect.ts`. Implement verbatim.
- `docs/engineering/2026-06-27-engineering-spec.md` — §3.2 (Platform interface, ExecOptions/ExecResult), §3.10 (collectText/collectEvents signatures), §8.2 (MockPlatform shape), §10.1 (AbortSignal threading note for exec)
- `packages/core/src/types/platform.ts` (created in task 02) — the interface that `NodePlatform` must implement
- `packages/core/src/types/events.ts` (created in task 02) — `AgentEvent` and `Terminal` types used by collect utilities

## Downstream dependencies

- Task 04 (`env/context.ts` tests) uses `MockPlatform` defined inline in `env-context.test.ts` — the `Platform` interface shape drives what fields the mock needs; `NodePlatform` itself is not used in unit tests but is used in the integration example (task 10).
- Task 07 (`loop/loop.ts`) imports `serializeToolResult` from `"../utils/serialize.js"`. The function signature must be: `serializeToolResult(result: unknown): string` — throws if JSON.stringify fails.
- Task 07 and task 08 tests use `collectEvents` and `collectText` to drive the generator in assertions. These functions must accept `AsyncGenerator<AgentEvent, Terminal>` and work correctly.
- Task 10 (example script) imports `NodePlatform` from `"tiny-agentic/platform/node"`.

## Steps

1. **Replace the task-01 stub at `packages/core/src/platform/node.ts`** (currently `export {};`) with the full implementation from the code-architecture doc:
   - Imports: `readFile`, `writeFile` from `"node:fs/promises"`; `execFile` from `"node:child_process"`; `promisify` from `"node:util"`.
   - `NodePlatform` class implements `Platform`.
   - `cwd()` returns `process.cwd()`.
   - `readFile(path, encoding)` calls `readFile(path, "utf-8")` from `node:fs/promises`.
   - `writeFile(path, content)` calls `writeFile(path, content, "utf-8")`.
   - `exec(command, options)` splits the command on spaces, calls `execFileAsync`, wraps in try/catch. On error, returns `{ stdout: execErr.stdout ?? "", stderr: execErr.stderr ?? "", exitCode: execErr.code ?? 1 }`.
   - **AbortSignal note (engineering spec §10.1):** The `ExecOptions` type has a `timeout` field but no `signal` field. In M1, `exec` does not accept an AbortSignal — it uses `timeout` from `options` only. If the team wants to thread an AbortSignal in M2, `ExecOptions` will need a `signal?: AbortSignal` field. Document this as a comment in `NodePlatform.exec`.
   - **`exactOptionalPropertyTypes` caution:** When passing `options.cwd`, `options.timeout`, `options.env` to `execFileAsync`, use conditional spread: `...(options.cwd !== undefined ? { cwd: options.cwd } : {})` etc. Do not pass `cwd: options.cwd` if `options.cwd` may be undefined — `execFileAsync` treats explicit `undefined` differently than absent key.

2. **Create `packages/core/src/utils/serialize.ts`** — implement as in the code-architecture doc:
   ```ts
   export function serializeToolResult(result: unknown): string {
     if (typeof result === "string") return result;
     return JSON.stringify(result);
   }
   ```
   This function throws if `JSON.stringify` fails (e.g., circular references, BigInt). The loop (`loop.ts`) catches this and converts to a recoverable tool error.

3. **Replace the task-01 stub at `packages/core/src/utils/collect.ts`** (currently `export {};`) with the full implementation from the code-architecture doc. Two exported functions:
   - `collectText(gen)` — iterates with `for await`, accumulates `text_delta` chunks, returns joined string. Discards the `Terminal` return value.
   - `collectEvents(gen)` — drives the generator via `iterator.next()` loop, pushes all yielded events, captures the `Terminal` from `result.value` when `result.done === true`. Returns `{ events: AgentEvent[], terminal: Terminal }`.

4. **Create `packages/core/src/__tests__/collect.test.ts`** — write Vitest tests:

   ```ts
   // Test: collectText returns joined text from text_delta events
   // Test: collectText ignores non-text_delta events
   // Test: collectText returns empty string when no text_delta events
   // Test: collectEvents returns all events in order + Terminal
   // Test: collectEvents works when generator has no events before Terminal
   ```

   Use a small helper to create a mock async generator from an array of events + a terminal:
   ```ts
   async function* mockGen(
     events: AgentEvent[],
     terminal: Terminal,
   ): AsyncGenerator<AgentEvent, Terminal> {
     for (const e of events) yield e;
     return terminal;
   }
   ```

   Cover:
   - `collectText` with a generator yielding `text_delta` events — assert joined string.
   - `collectText` with a generator yielding mixed events (text_delta + tool_use_start) — assert only text_delta text is accumulated.
   - `collectEvents` — assert returned `events` array matches what was yielded, and `terminal` matches what was returned.
   - Edge: generator that immediately returns terminal (zero events) — `collectEvents` returns `{ events: [], terminal }`.

5. **Run `pnpm --filter tiny-agentic test`** — confirm all tests pass.

6. **Run `pnpm --filter tiny-agentic typecheck`** — confirm no type errors. Pay attention to the `exactOptionalPropertyTypes` flag when forwarding options in `NodePlatform.exec`.

## Acceptance criteria

- [ ] `pnpm --filter tiny-agentic test` passes with all tests in `collect.test.ts` green.
- [ ] `pnpm --filter tiny-agentic typecheck` exits with code 0.
- [ ] `packages/core/src/platform/node.ts` exists and exports `NodePlatform`.
- [ ] `packages/core/src/utils/serialize.ts` exists and exports `serializeToolResult`.
- [ ] `packages/core/src/utils/collect.ts` exists and exports `collectText` and `collectEvents`.
- [ ] `grep -r "from 'node:" packages/core/src --include="*.ts" | grep -v "platform/node"` returns no results (node built-ins only used in `platform/node.ts`).
- [ ] `grep "process\." packages/core/src --include="*.ts" -r | grep -v "platform/node"` returns no results.

## Output files

- Modified: `packages/core/src/platform/node.ts` (replaced task-01 stub with full implementation)
- Created: `packages/core/src/utils/serialize.ts`
- Modified: `packages/core/src/utils/collect.ts` (replaced task-01 stub with full implementation)
- Created: `packages/core/src/__tests__/collect.test.ts`

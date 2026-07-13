# Task 03 — Platform path and discovery-ordering contract

> Written in the plan phase. Immutable during implement-phase execution.

## Goal

Land the second source-breaking foundation as one compilable commit: add required `Platform.resolvePath(path)` and `Platform.formatPath(path)`, implement native Node semantics, update every current Platform implementation/object literal, and move final discovery ordering into `NodePlatform`/its Node helper with an explicit code-unit tie-break.

This task changes the contract and all 11 implementors but does not yet rewire model-facing tools or enable stricter lint; task 04 consumes the real committed methods. At completion, Platform owns path grammar and display order, Node behavior is pinned for under/equal/outside/root paths, production ordering is mtime descending with deterministic name/path ties, and test ordering remains ascending.

## Context files

- `docs/feature/core-runtime-hardening/engineering/2026-07-13-core-runtime-hardening-engineering.md` — §§5.2.1–5.2.3, §6, PT-3, PT-6–PT-8.
- `docs/feature/core-runtime-hardening/decisions.md` — path grammar and ordering ownership decisions.
- `packages/core/src/types/platform.ts` — exact required signatures and ordering comments.
- `packages/core/src/platform/node.ts` — native path implementation and `listDir` ordering.
- `packages/core/src/platform/fs-discovery.ts` — `sortWalked` tie-break and ordering comments.
- `packages/core/src/__tests__/node.test.ts`, `fs-discovery.test.ts`, `ls.test.ts`, `glob.test.ts`, `grep.test.ts` — existing Node behavior tests. These may still use `node:path` in this task; task 04 removes those imports before stricter lint.
- All implementors: `agent.test.ts`, `agent-tooling-integration.test.ts`, `bash.test.ts`, `builtin-tools.test.ts`, `editFile.test.ts`, `env-context.test.ts`, `loop.test.ts`, `runTools.test.ts`, `subagent-boundary.test.ts`, `task-tool.test.ts`, plus production `platform/node.ts`.

## Downstream dependencies

- Task 04 rewires `ls`, `glob`, and `grep` exclusively to these methods and deletes `_paths.ts`; keep semantics exact.
- `resolvePath` resolves absolute or platform-relative model paths against platform cwd.
- `formatPath` canonicalizes/resolves input, returns `.` at cwd, cwd-relative for descendants, and unchanged resolved absolute/canonical form outside cwd.
- Ordering comments are public obligations: `listDir`, `glob.paths`, and `grep.files/matches` are already in display order. Tools must not sort in task 04.
- Do not remove/deprecate `Platform.stat` or alter method signatures/result shapes.

## Steps

1. **Add required methods and contracts** — add `resolvePath(path: string): string` and `formatPath(path: string): string` to `Platform` with engineering §5.2.1 comments. Tighten `listDir`/`glob`/`grep` result comments to state final display order and grep grouping/line order.
2. **Implement Node path semantics** — in `NodePlatform`, import the necessary native `relative`/`isAbsolute` operations. `resolvePath(p)` is native `resolve(this.cwd(), p)`. `formatPath(p)` resolves/canonicalizes, computes native relative path from cwd, returns `.` for equality, relative only when inside cwd, otherwise resolved absolute. Handle root exactly as spec.
3. **Move `listDir` sorting into NodePlatform** — after metadata collection, sort production by descending `mtimeMs`, then ascending `name` using explicit JS code-unit comparison; under `NODE_ENV === "test"`, sort ascending `name` regardless of mtime. Keep errors/result shape unchanged.
4. **Add discovery tie-break** — in `fs-discovery.ts`, make production `sortWalked` compare descending mtime and then ascending full path when equal; retain test-mode ascending path. Correct comments to identify this as an explicit Node platform module and describe complete ordering.
5. **Update all ten test implementations atomically** — because the required interface change must compile in the same production commit, the implementer adds both methods to each listed test class/object literal but does not add assertions. Non-discovery mocks may use identity/sentinel behavior (for example, return input); use no new shared mock abstraction. The object literal in `agent-tooling-integration.test.ts` must also compile.
6. **Tester: behavior tests**:
   - **PT-3:** Node under-cwd relative, cwd `.`, outside absolute, cwd `/` formatting `/→.` and `/a→a`; with cwd `/work`, `/` stays `/`. Use a test subclass overriding `cwd()` rather than mutating process cwd where possible.
   - **PT-6:** `NodePlatform.listDir` production mtime descending and equal-mtime name ascending; shared glob/grep walk equal-mtime path ascending. Control mtimes deterministically with existing Platform/exec fixture techniques.
   - **PT-7:** existing test-mode name/path ascending behavior stays green for list/glob/grep/fs-discovery.
   - **PT-8:** core typecheck compiles every implementor.

## Acceptance criteria

- [ ] `Platform` has exactly two new required methods; all 11 implementors compile in one commit.
- [ ] PT-3 and PT-6–PT-8 pass with explicit root/outside/tie cases.
- [ ] `NodePlatform.listDir` returns final display order; tools have not yet been edited and may still re-sort until task 04.
- [ ] `sortWalked` has an explicit equal-mtime path tie-break.
- [ ] No broad Path API, portable POSIX helper, dependency, `stat` removal, or mutation-tool path normalization is introduced.
- [ ] `pnpm --filter tiny-agentic test -- src/__tests__/node.test.ts src/__tests__/fs-discovery.test.ts src/__tests__/ls.test.ts src/__tests__/glob.test.ts src/__tests__/grep.test.ts` passes.
- [ ] `pnpm --filter tiny-agentic typecheck`, root `pnpm lint`, and full `pnpm --filter tiny-agentic test` pass.

## Output files

**Implementer-owned production files:**
- Modified: `packages/core/src/types/platform.ts`
- Modified: `packages/core/src/platform/node.ts`
- Modified: `packages/core/src/platform/fs-discovery.ts`

**Implementer-owned compile migration in existing test doubles; tester-owned assertions in the same files:**
- Modified: `packages/core/src/__tests__/agent.test.ts`
- Modified: `packages/core/src/__tests__/agent-tooling-integration.test.ts`
- Modified: `packages/core/src/__tests__/bash.test.ts`
- Modified: `packages/core/src/__tests__/builtin-tools.test.ts`
- Modified: `packages/core/src/__tests__/editFile.test.ts`
- Modified: `packages/core/src/__tests__/env-context.test.ts`
- Modified: `packages/core/src/__tests__/loop.test.ts`
- Modified: `packages/core/src/__tests__/runTools.test.ts`
- Modified: `packages/core/src/__tests__/subagent-boundary.test.ts`
- Modified: `packages/core/src/__tests__/task-tool.test.ts`
- Modified: `packages/core/src/__tests__/node.test.ts`
- Modified: `packages/core/src/__tests__/fs-discovery.test.ts`
- Modified as needed for order assertions: `ls.test.ts`, `glob.test.ts`, `grep.test.ts`

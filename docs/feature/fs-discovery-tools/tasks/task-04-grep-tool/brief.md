# Task 04 — `grep` tool (three modes + `-A`/`-B`/`-C` context lines)

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Build `packages/core/src/tools/builtin/grep.ts` (`grepTool`) — the most intricate tool surface in the feature. It exposes the three `output_mode`s (`files_with_matches` (default) / `content` / `count`), maps `case_insensitive` → RegExp flags and `context`/`before_context`/`after_context` → `GrepOptions.before`/`after`, **compiles and validates the RegExp in the tool** (throwing the actionable `"grep: invalid regular expression: <engine message>"` before any walk), calls `platform.grep(pattern, flags, options)`, and shapes the discriminated-by-`mode` result with cwd-relative file paths, the 250-default cap, the 500-char per-line cap, and the ~20 000-char total-result guard (truncate at a match boundary → `truncated:true`). `isConcurrencySafe: () => true`; registered/exported from `index.ts`.

## Context files

- `docs/feature/fs-discovery-tools/engineering/2026-07-10-fs-discovery-engineering.md` — **§7** (grep Zod schema — copy verbatim — **and** the context-line semantics + caps table), **§6** (discriminated result shape), **§3.5** (grep description + `grep:` error strings), **§8** (no-match≠error, invalid regex, binary, context BOF/EOF clamp, adjacent-window merge), **§5.3** (`grep(pattern, flags, options?)` — the tool derives `flags`).
- `docs/feature/fs-discovery-tools/decisions.md` — the "grep context lines `-A`/`-B`/`-C`" FINAL decision (merge + cap-interaction rules).
- `packages/core/src/tools/builtin/glob.ts` (from task-03) — the cwd-relative path-formatting helper to reuse; the option-mapping + conditional-spread pattern.
- `packages/core/src/types/platform.ts` — `GrepOptions`/`GrepMatch`/`GrepPlatformResult`.
- `packages/core/src/index.ts` — export block.

## Downstream dependencies

- task-05 smoke drives `grep` in the no-`bash` discovery loop; keep the result JSON-serializable and the description accurate.
- Result must be the discriminated `mode` union in §6 exactly (consumers/tests narrow on `mode`).

## Steps

1. **Schema** per §7 verbatim: `pattern`, `path?`, `glob?`, `output_mode?` (enum), `case_insensitive?`, `respect_gitignore?`, `include_hidden?`, `before_context?`, `after_context?`, `context?`, `limit?` — all `.describe()`d, numeric fields `z.number().int().positive().optional()`.
2. **Regex compile + validate in the tool.** Build `flags` (`"i"` if `case_insensitive`); `try { new RegExp(pattern, flags) } catch (e) { throw new Error("grep: invalid regular expression: " + e.message) }`. Do this **before** calling the Platform so the model gets a fixable message, not a stack trace.
3. **Context resolution.** `context` set → `before = after = context` (a set `context` wins over `before_context`/`after_context`); else `before = before_context ?? 0`, `after = after_context ?? 0`. Only meaningful in `content` mode.
4. **Map to `GrepOptions`** (conditional spreads, exactOptionalPropertyTypes ON): `cwd`/`path`/`glob`/`ignoreCase`/`respectGitignore`/`includeHidden`/`limit` (default 250)/`maxLineLength` (500)/`contentMode` (`output_mode === "content"`)/`before`/`after`/`signal`. Call `platform.grep(pattern, flags, options)` (which throws `"grep: path does not exist: …"` on a missing explicit `path` — let it propagate).
5. **Shape the result by mode:**
   - `files_with_matches` (default): `{ mode: "files_with_matches", files: cwdRel[], truncated }`.
   - `count`: `{ mode: "count", count, files: cwdRel[], truncated }`.
   - `content`: `{ mode: "content", matches: {file, line, text, kind}[], truncated }`, ordered by `(file, line)`, `kind:"match"|"context"`, per-line text 500-char-capped with a `…` marker.
6. **Caps.** `limit` counts **match lines only** in content mode (context lines never consume budget). Apply the ~20 000-char total-result guard: if assembling a match's context would exceed the byte total, truncate **at a match boundary** and set `truncated:true`. Convert `file` paths to cwd-relative-where-under-cwd.
7. **`isConcurrencySafe: () => true`.** Description verbatim from §3.5.
8. **Register/export** `grepTool` from `index.ts`.
9. **Tests** — `src/__tests__/grep.test.ts`, temp-dir fixtures on `NodePlatform`, `NODE_ENV==='test'`.

## Acceptance criteria

- [ ] `pnpm --filter @tiny-agentic/core test` passes including `grep.test.ts`; `pnpm -r typecheck` + `pnpm -r lint` pass.
- [ ] **Three modes:** `files_with_matches` (default) returns matching files; `content` returns `{file,line,text,kind}` with 1-based line numbers; `count` returns `{count, files}`.
- [ ] **No match ≠ error:** every mode returns an empty, `truncated:false` result and never throws.
- [ ] **Invalid regex:** throws `"grep: invalid regular expression: <engine message>"` before walking.
- [ ] **Missing path:** an explicit missing `path` throws `"grep: path does not exist: <path>"`.
- [ ] **Context lines:** `after_context`/`before_context`/`context` (mapping `-A`/`-B`/`-C`) produce `kind:"context"` entries interleaved with `kind:"match"`, ordered by `(file,line)`, correct 1-based numbers, clamped at BOF/EOF (no negative / past-EOF lines). `context` overrides `before_context`/`after_context`.
- [ ] **Window merge:** two matches whose context windows overlap or touch emit each shared line exactly once; a line that is itself a match stays `kind:"match"` even inside another match's window (no duplicate lines).
- [ ] **Cap interaction:** `limit` counts match lines only (a `limit` of N yields up to N matches *with* full context); per-line text > 500 chars is truncated with `…`; the ~20 000-char guard truncates at a match boundary and sets `truncated:true`.
- [ ] **Binary skip:** a fixture file with a NUL byte is excluded (no garbage lines).
- [ ] **Toggles:** `.gitignore`-d/hidden excluded by default, included via `respect_gitignore:false`/`include_hidden:true`; VCS dirs always excluded.
- [ ] `grepTool.isConcurrencySafe()` returns `true`; `index.ts` exports `grepTool`.

## Output files

- Created: `packages/core/src/tools/builtin/grep.ts`, `packages/core/src/__tests__/grep.test.ts`.
- Modified: `packages/core/src/index.ts`.

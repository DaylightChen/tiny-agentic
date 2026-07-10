# Implementation Plan — Filesystem Discovery Tools (`ls` / `glob` / `grep`)

> Plan phase, feature scope `feature/fs-discovery-tools`. Author: `planner`, 2026-07-10.
> Upstream (binding): engineering spec at `docs/feature/fs-discovery-tools/engineering/2026-07-10-fs-discovery-engineering.md`.
> Decisions: `docs/feature/fs-discovery-tools/decisions.md` (feature) + `docs/project/decisions.md` (project conventions).
> Follows `docs/methodology/planning-methodology.md`.

## Goal

When every task here is committed, `packages/core` ships three read-only built-in discovery tools — **`ls`**, **`glob`**, and **`grep`** — that let the model *find* things on the filesystem without shelling out through `bash`. They are backed by four new **`Platform`** primitives (`listDir`, `stat`, `glob`, `grep`) implemented in pure JS in `NodePlatform`, with the highest-logic-density work (a single shared recursive directory walk with hierarchical `.gitignore` composition, hidden-file handling, VCS-dir pruning, symlink-cycle safety, binary-file skipping, mtime/name ordering and result caps) living in a new `packages/core/src/platform/fs-discovery.ts`. One walk implementation feeds both `glob` and `grep`. All three tools return strictly JSON-serializable, `truncated`-flagged, capped results; all three declare `isConcurrencySafe() => true`; each is an independently allow/deny-able tool name that does not route through the shell gate. Two dependencies (`ignore`, `picomatch`) are added; the eslint node-built-in boundary is widened to `platform/**` so `fs-discovery.ts` may import `node:fs/promises`. `pnpm -r typecheck` and lint stay green after every task (no un-compilable intermediate state — the breaking Platform change and all 11 doubles land in one task).

## Task list

Sequential, in execution order. Each task starts from the committed state of the previous one.

1. **task-01-platform-contract** — Add the four `Platform` methods + supporting types to `types/platform.ts`, export them from `index.ts`, add `ignore`/`picomatch` deps, widen the eslint boundary to `platform/**`, implement real `listDir`/`stat` and *throwing* `glob`/`grep` stubs in `NodePlatform`, and update all 11 test doubles so the whole package compiles. No `fs-discovery.ts` yet. (Foundation + the breaking-change ripple, landed atomically.)
2. **task-02-shared-walk** — Build `platform/fs-discovery.ts`: the single shared recursive walk (nested-`.gitignore` matcher stack, VCS pruning, hidden handling, symlink no-descend, permission-skip, caps + mtime-desc/name-asc sort, binary skip), plus the `picomatch` glob wrapper and the regex+context-line collection/merge helper. Wire `NodePlatform.glob`/`grep` to it (replacing the task-01 stubs). Highest-logic-density module + its dedicated tests. (Risk-first.)
3. **task-03-ls-glob-tools** — Build `tools/builtin/ls.ts` (`lsTool`) and `tools/builtin/glob.ts` (`globTool`): Zod schemas, cwd-relative path formatting, cap/`truncated` wrapping over the Platform primitives, `isConcurrencySafe: () => true`, register/export. Their tool tests.
4. **task-04-grep-tool** — Build `tools/builtin/grep.ts` (`grepTool`): Zod schema, the three `output_mode`s (`files_with_matches`/`content`/`count`), `-A`/`-B`/`-C` context mapping, discriminated `mode` result, per-line + 20K byte caps, `isConcurrencySafe: () => true`, register/export. Its tool tests including the nested-gitignore and context-merge criteria.
5. **task-05-smoke-and-docs** — An end-to-end smoke check (a model with only `ls`/`glob`/`grep` and no `bash` performs a discovery loop over `packages/core/src`) via an `examples/*` script, and docs/known-issues updates (pure-JS grep perf trade-off; deferred `multiline`/ripgrep-`type`). Non-CI; touches no production tool logic.

## Dependency rationale

- **Vertical slice + foundation first (task-01).** The four `Platform` methods and their supporting types are the shared contract every later task codes against. The engineering spec calls out that adding them is a **compile-time breaking change touching 11 files** (§5.5); leaving the tree un-compilable between tasks would violate the sequential-execution rule (each task must start from a committed, building state). So task-01 lands the interface, all 11 doubles, the dep additions, the eslint widening, and *throwing* `glob`/`grep` stubs in `NodePlatform` (real `listDir`/`stat`) in one coherent unit. This is the acceptable "does almost nothing functionally" first task — it proves the contract compiles against the whole existing suite before any walk logic is written. `fs-discovery.ts` is deliberately **not** created here (nothing can import `node:fs/promises` outside the boundary until the eslint glob is widened, which *is* done here, but the walk itself is risk-dense and gets its own task).

- **Risk-ordered: the shared walk goes second (task-02).** `fs-discovery.ts` is the single most logic-dense module (spec R6, §5.4): the per-directory `ignore`-matcher stack with `!`-negation and relative-path matching, VCS-dir precedence, symlink no-descend, permission-skip, mtime/name sort, caps, and binary sniffing. It backs **both** `glob` and `grep`, so it must exist and be tested before either tool. Discovering a walk bug here (against a filesystem-fixture test) is far cheaper than discovering it through a tool's result assertion in task-04. Wiring `NodePlatform.glob`/`grep` to it in the same task means the throwing stubs from task-01 are replaced by real behavior with the walk's own tests as the safety net.

- **`ls`+`glob` before `grep` (task-03 before task-04).** `lsTool`/`globTool` are thin cap/format wrappers over `listDir`/`stat`/`glob` — lower-complexity, they validate the Platform seam and the cwd-relative path formatting shared by all three tools. `grepTool` (task-04) is the most intricate tool surface (three modes, context-line window merge, two-layer caps) and benefits from the path-formatting/formatting conventions being settled in task-03.

- **Smoke + docs last (task-05).** Needs the whole feature working; touches no production logic; not a phase gate (matches the task-tool scope's task-05 practice).

## Coverage check

Feature scope, standard pipeline (no UX spec). Coverage walks every section of the engineering spec and, per planning-methodology §5 / feature-scope-standard rules, the five User-visible-behavior subsections. Every row maps to a task or an explicit `N/A`/deferral.

### Coverage by engineering-spec section

| Engineering-spec section | Task(s) | Notes |
|---|---|---|
| **§1 Goal** — `ls`/`glob`/`grep` land in `packages/core`, read-only, via new Platform methods | task-01 → task-05 | Whole plan realizes it. |
| **§2 Motivation** — structured discovery usable when `bash` is denied | task-03/04 (`isConcurrencySafe` + distinct names), task-05 (smoke proves no-`bash` loop) | |
| **§3.1 Primary flow** — grep→grep→glob→ls discovery loop; abs/relative in, cwd-relative out | task-03 (ls/glob), task-04 (grep), task-05 (end-to-end loop) | Path-in resolution + cwd-relative-out in every tool. |
| **§3.2 States matrix — empty** (no results ≠ error) | task-03 (ls/glob empty), task-04 (grep mode-appropriate empty) | `truncated:false`. |
| **§3.2 States matrix — loading / offline** | N/A | Spec marks N/A (single awaited call, local FS). |
| **§3.2 States matrix — error** (missing/not-dir/invalid-glob/invalid-regex throw) | task-01 (listDir/stat reject messages), task-02 (glob base-missing, grep path/regex), task-03 (ls errors), task-04 (grep invalid-regex message) | Exact strings in §3.5. |
| **§3.2 States matrix — partial** (`truncated`, `appliedLimit`, per-line cap) | task-02 (walk caps + `truncated`), task-03 (glob cap), task-04 (grep caps incl. per-line + 20K) | |
| **§3.3 Accessibility** | N/A | Headless; machine-legibility analogue met by JSON-serializable + discriminated `mode` + explicit `truncated` (task-04). |
| **§3.4 Edge — large result sets** | task-02 (caps), task-04 (per-line cap) | |
| **§3.4 Edge — binary files** (NUL sniff, silent skip) | task-02 (walk/read binary skip) + task-04 asserts | |
| **§3.4 Edge — concurrent use** | task-03/04 (`isConcurrencySafe:()=>true`) | Stateless; race is caller's. |
| **§3.4 Edge — symlinks / cycles** (no descend into symlinked dirs) | task-02 | |
| **§3.4 Edge — permission-denied subdir** (skip mid-walk, throw on direct target) | task-02 | |
| **§3.5 Microcopy** — exact tool descriptions + error strings | task-03 (ls/glob desc + `ls:` errors), task-04 (grep desc + `grep:` errors), task-02 (`glob: base directory…` from Platform) | Strings pinned verbatim in tests. |
| **§4 Out of scope** — no ripgrep/subprocess, no `stat` tool, no `fs.glob`, no `multiline`/`type` filter, no writes, not concurrency-exec itself, no mock consolidation | deferrals below + enforced by construction | `stat` stays Platform-only (task-01, not registered). |
| **§5.1 Existing modules touched** — `types/platform.ts`, `platform/node.ts`, `index.ts`, 11 doubles | task-01 (types + index + 11 doubles + node stubs), task-02 (node glob/grep real) | |
| **§5.2 New modules** — `ls.ts`/`glob.ts`/`grep.ts`, `fs-discovery.ts`, test files | task-02 (fs-discovery), task-03 (ls/glob), task-04 (grep) | |
| **§5.3 Platform contract** (`DirEntry`/`GlobOptions`/`GlobResult`/`GrepMatch`/`GrepOptions`/`GrepPlatformResult` + 4 methods) | task-01 | Exact signatures copied. |
| **§5.4 NodePlatform impl** — listDir/stat/shared walk/nested-gitignore/glob/grep + deps | task-01 (listDir/stat + deps), task-02 (walk + glob/grep) | |
| **§5.5 Breaking-change ripple** — 11 doubles enumerated | task-01 | builtin-tools.test.ts gets in-memory backing; rest stub-throw. |
| **§5.6 `.gitignore`/hidden** — symmetric, on-by-default, per-call toggle, VCS always excluded, hierarchical | task-02 (walk), task-03/04 (schema toggles wired) | |
| **§5.7 Permission-gate** — distinct names, no shell-gate coupling, individually gateable | task-03/04 (distinct tools, no `platform.exec`), task-05 (no-`bash` smoke) | Zero `runTools` change. |
| **§5.8 Concurrency-safety** — all three `isConcurrencySafe:()=>true` | task-03/04 | |
| **§6 Data model changes** — new types only; index exports; tool result shapes | task-01 (types + exports), task-03 (ls/glob shapes), task-04 (grep discriminated shape) | No storage/migration. |
| **§7 Zod schemas & caps** — ls/glob/grep schemas; 250/500/20K caps; sort; path form; context-line semantics | task-03 (ls/glob schema + caps), task-04 (grep schema + all caps + context semantics) | |
| **§8 Edge cases** (no-match≠error, invalid regex, binary, huge repo, symlink cycle, unreadable subdir, cancellation, path escaping cwd, nested gitignore, context BOF/EOF clamp, adjacent-window merge, NODE_ENV sort) | task-02 (walk edges + nested gitignore + cancellation + sort), task-04 (no-match, invalid regex, context clamp+merge) | |
| **§9 Risks R1** deps added | task-01 | |
| **§9 Risks R2** no `fs.glob` | task-02 (hand-rolled walk) | |
| **§9 Risks R3** pure-JS grep slower | task-05 (known-issues note) | Accepted; mitigations in task-02 (prune+cap+short-circuit). |
| **§9 Risks R4** lint boundary widened | task-01 (eslint glob → `platform/**`) | |
| **§9 Risks R5** 11-file fan-out | task-01 | Compile-time caught. |
| **§9 Risks R6** nested-gitignore complexity | task-02 (dedicated fixture tests) | |
| **§10 Success criteria (Functional)** — every bullet | task-02 (walk/single-impl/nested-gitignore/no-match), task-03 (ls/glob), task-04 (grep modes/context/merge/cap), task-05 (no-`bash` loop, compile+lint) | Each bullet → a named test in a brief. |
| **§10 Success criteria (Non-functional)** — JSON-serializable+bounded, sub-second grep, cancellation, NODE_ENV determinism | task-02 (bounded+cancel+determinism), task-04 (serializable), task-05 (sub-second smoke) | |
| **§11 Open questions** — all resolved | — | None blocking; see below. |

### User-visible-behavior subsection checklist (feature-scope standard, methodology §5)

- **Primary flow (§3.1)** → task-03 + task-04 (each tool), task-05 (the loop end-to-end). Not N/A.
- **States matrix (§3.2)** → empty/error/partial covered by task-02/03/04; loading & offline honored as spec's explicit N/A.
- **Accessibility (§3.3)** → N/A (headless); machine-legibility analogue (JSON-serializable, discriminated `mode`, explicit `truncated`) covered by task-04. Not silently dropped.
- **Edge-case behaviors (§3.4)** → task-02 (binary, symlink, permission-skip, caps) + task-03/04 (concurrency-safe). All addressed.
- **Microcopy (§3.5)** → task-02/03/04 (exact descriptions + error strings pinned in tests). Not N/A.

### Explicit deferrals

Each is out-of-scope by §4 and/or a Risks resolution; none is a coverage gap. Log the runtime-relevant ones in `docs/project/known-issues.md` during task-05.

- **ripgrep / any subprocess backend** — locked pure-JS (decision 2026-07-10). Future NodePlatform-internal optimization behind the same `Platform.grep` seam; no contract change. No task.
- **Model-facing `stat` tool** — `stat` is a Platform primitive only (§4); consumed internally by `ls`/`glob`, never registered. Enforced in task-01 (added to interface) + task-03 (not exported as a tool).
- **Node `fs.glob`** — rejected (decision 2026-07-10); the hand-rolled walk backs both tools. Enforced by construction in task-02.
- **`multiline` grep + ripgrep-style `type` filter** — deferred from v1 (§4). → known-issues note in task-05.
- **Consolidating the 11 inline `MockPlatform` doubles into a shared util** — out of scope (§4/§5.5); task-01 only makes each compile again. No task.
- **Pure-JS grep perf on very large repos (R3)** — accepted trade-off. → known-issues note in task-05.

## Self-review (planner)

Checked per the methodology's self-review ask:

- **No un-compilable intermediate state.** The breaking Platform change + all 11 doubles + eslint widening land together in task-01; `NodePlatform.glob`/`grep` throw a clear `"not implemented"` there so the interface is satisfied and the package compiles before the walk exists. task-02 replaces those stubs. Every task ends green on `pnpm -r typecheck` + lint.
- **Both override features have dedicated tests.** Nested-`.gitignore` composition (multi-level ignore, deep `!`-negation re-include, VCS-dir precedence) → task-02 acceptance criteria. Context lines (`-A`/`-B`/`-C`, window merge so shared lines appear once, `limit` counts match-lines only, 20K truncate-at-match-boundary, BOF/EOF clamp) → task-04 acceptance criteria. Neither is folded into a generic "tool works" check.
- **Dependency ordering.** Shared walk (task-02) precedes both tools (task-03/04); `ls`/`glob` precede `grep`; types precede everything.
- **Bugs / hazards caught during planning (flagged for implementers):**
  - **B1 — eslint `ignores` shape.** The core-restriction block currently uses `ignores: ["packages/core/src/platform/node.ts"]` (an *ignore*, not a glob-match). Widening means changing that array to `["packages/core/src/platform/**"]` (glob), **not** adding a new `files` block. task-01 step pins this exact edit; verify lint fails first (write `fs-discovery.ts` stub importing `node:fs/promises` won't exist yet, so instead confirm by adding the import in task-02) — task-01 must not leave a dangling unused ignore. Implementer: re-read `eslint.config.js` (ground truth) before editing.
  - **B2 — `exactOptionalPropertyTypes` is ON.** New optional `GlobOptions`/`GrepOptions` fields must be forwarded with conditional spreads (as `node.ts#exec` already does), never passed as explicit `undefined`. Called out in task-02.
  - **B3 — `Platform.grep` signature is `grep(pattern, flags, options?)`** — the *tool* derives the `flags` string (e.g. `"i"` from `case_insensitive`) and compiles/validates the RegExp to produce the actionable error *before* calling the Platform. task-04 owns regex compilation + the `"grep: invalid regular expression: …"` message; the Platform receives a valid source+flags. (Spec §5.3/§8 are consistent on this; pinned so it isn't split ambiguously.)
  - **B4 — `builtin-tools.test.ts` MockPlatform is Map-backed** (no real directories). Its `listDir`/`stat`/`glob`/`grep` either get real-ish Map-over-vfs behavior *or* the tool tests use a temp-dir fixture on `NodePlatform`. task-03/04 briefs default to **temp-dir fixtures on `NodePlatform`** for the walk-dependent tests (the walk needs real dirents/mtimes/nested `.gitignore` files), and reserve the Map mock for pure schema/format assertions. This avoids re-implementing the walk inside a mock.

## Open questions

None. All four engineering-spec open questions were resolved by the user on 2026-07-10 (deps, glob engine, nested `.gitignore`, context lines) and are treated as binding inputs. If an implementer finds the committed code has drifted from a referenced line/shape, the code is ground truth — re-read the file and adapt; the contracts (type signatures, exact strings, caps, ordering) are what must be preserved.

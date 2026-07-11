# Decision Log

> Record significant decisions with rationale. Each entry should be self-contained — a future reader should understand both what was decided and why without needing additional context.

## Format

```
## YYYY-MM-DD — [Decision title]

**Phase:** [phase name]

**Decision:** [What was decided]

**Rationale:** [Why this option was chosen — what trade-offs were considered, what alternatives were rejected and why]

**Consequences:** [What this enables, constrains, or commits the project to]
```

---

## 2026-07-10 — Backing implementation: pure-JS behind the Platform seam (no subprocess)

**Phase:** engineering

**Decision:** All three discovery tools (`ls`/`glob`/`grep`) are backed by **pure JavaScript** behind new `Platform` methods — Node stdlib (`fs.promises.readdir`/`stat`/`readFile` + a recursive walk), a JS glob matcher, a `.gitignore` matcher (`ignore` lib), and JS `RegExp` for content search. **Not** a ripgrep subprocess. The `Platform` contract and the tool logic must never assume a subprocess.

**Rationale:** The reference backs both glob and grep with a ripgrep subprocess, but its cost is almost entirely the binary-distribution + process-robustness tail (per-arch vendored binaries, codesigning, SIGKILL escalation, exit-code semantics). This core has a hard browser-portability goal and forbids Node built-ins outside `platform/node.ts`; a subprocess-backed grep could not run in a browser platform and would force per-platform binary distribution. Pure-JS is dependency-light (only `ignore`, optionally `picomatch`), fully portable, and deterministic. The accepted trade-off is slower search on very large repos, mitigated by `.gitignore` pruning + result caps + first-match short-circuit. ripgrep remains available as a **future NodePlatform-internal optimization** behind the same `Platform.grep` seam — no contract change would be needed.

**Consequences:** Adds `ignore` and `picomatch` as runtime deps of `packages/core` (confirmed — see the dependencies decision below). Any Node-specific FS work lives only in the node-platform module (`platform/node.ts` + `platform/fs-discovery.ts`; lint glob widened to `platform/**`). A browser/mock platform can supply its own pure-JS or vfs-backed implementation of the same methods.

---

## 2026-07-10 — Platform gains listDir, stat, glob, grep (fine-grained primitives)

**Phase:** engineering

**Decision:** The `Platform` interface gains four methods: `listDir(path)`, `stat(path)`, `glob(pattern, options?)`, and `grep(pattern, flags, options?)`, with supporting types (`DirEntry`, `GlobOptions`/`GlobResult`, `GrepOptions`/`GrepMatch`/`GrepPlatformResult`). Fine-grained primitives were chosen over one coarse `search` method. `stat` is a Platform primitive only — **not** a model-facing tool.

**Rationale:** Fine-grained primitives leak the least implementation across the seam and are each straightforwardly browser-implementable; `ls` and `glob` compose over `listDir`/`stat`. `glob` and `grep` are on Platform (not in the tool) because the directory walk + `.gitignore`/hidden handling + binary-skip must be environment-specific and performance-sensitive; the tool supplies portable regex source+flags and glob patterns only. `stat` is used internally (mtime sort, path validation) but the model never needs a bare `stat` tool (matches the reference).

**Consequences:** Breaking change to every `Platform` implementor: `NodePlatform` + 11 test-double files must add the methods (compile-time caught, the M2 breakage the M1 decision log anticipated). New types exported from `index.ts`.

---

## 2026-07-10 — .gitignore honored symmetrically, on by default, per-call toggleable

**Phase:** engineering

**Decision:** All three tools honor `.gitignore` and exclude hidden dotfiles **by default**, **symmetrically** (rejecting the reference's grep-yes/glob-no asymmetry). Each is toggleable per call via `respect_gitignore` (default true) and `include_hidden` (default false) inputs. VCS metadata dirs (`.git`, `.svn`, `.hg`, `.jj`, `.sl`, `.bzr`) are always excluded. No env-var toggles — everything routes through explicit tool inputs.

**Rationale:** For an autonomous agent, symmetric behavior is more predictable than the reference's UI-picker-driven asymmetry; on-by-default keeps output relevant and within context budget (searching `node_modules` is almost never wanted); per-call toggles give an escape hatch to reach gitignored/hidden files. Env-var toggles were rejected because this core threads all configuration through explicit inputs, not process env. **Nested `.gitignore` composition is required in v1** — see the dedicated decision below (this supersedes the initial draft's "root-only" provisional stance).

**Consequences:** Adds `ignore` as a dependency (used via a per-directory matcher stack, below). Each tool schema carries `respect_gitignore`/`include_hidden` booleans.

---

## 2026-07-10 — Output caps, sort order, and result shapes

**Phase:** engineering

**Decision:** Default result limit **250** (overridable via a positive-int `limit`; no `limit: 0` unlimited escape hatch in v1); `grep` content-mode per-line cap **500** chars; ~20_000-char max serialized result guard; sort by **mtime desc** in production and **name-asc under `NODE_ENV==='test'`** for determinism. Paths returned are cwd-relative where under cwd, else absolute. `grep` returns a discriminated result keyed by `mode` (`files_with_matches` | `content` | `count`); `ls` returns `{ entries, truncated }`; `glob` returns `{ files, truncated }`. Every result carries an explicit `truncated` boolean.

**Rationale:** Mirrors the reference's proven caps (250, 500 columns, 20 KB) which exist for context-window economics; unbounded output is a context hazard, so the unlimited escape hatch is dropped in v1. The `NODE_ENV` sort switch is the reference's testability pattern, carried forward so snapshot tests are stable. cwd-relative paths save tokens.

**Consequences:** Results are always JSON-serializable and bounded. Tests must set/assert deterministic ordering under `NODE_ENV==='test'`.

---

## 2026-07-10 — All three tools are concurrency-safe; independently gated; no shell-gate coupling

**Phase:** engineering

**Decision:** `ls`/`glob`/`grep` each declare `isConcurrencySafe: () => true`. They are distinct, independently allow/deny-able tool names in the name-keyed `approvalHandler`, do not route through `bash`/`platform.exec`, and are not force-allowed (a consumer omits or denies them by name to opt out).

**Rationale:** All three are read-only and stateless (statelessness decision 2026-06-26 Q1) — exactly the read-only-safe class Tier-2 #5 (concurrent tool execution) will parallelize; setting the hook now means #5 needs no rework. Because the gate is keyed by tool name and there is no auto-registry, denying `bash` (the common stance) does not touch discovery — satisfying the roadmap's headline rationale that structured discovery must remain usable when shell is blocked. Keeping them individually gateable (not force-allowed) is the least-surprising, zero-`runTools`-change behavior.

**Consequences:** No change to `runTools` or the approval seam. Tier-2 #5 can parallelize these three immediately.

---

## 2026-07-10 — FINAL: dependencies — add both `ignore` and `picomatch`

**Phase:** engineering (open-question resolution)

**Decision:** Add **both** `ignore` and `picomatch` as runtime dependencies of `packages/core`. (Confirms the architect's provisional recommendation.)

**Rationale:** Both are pure-JS, MIT, effectively zero-runtime-transitive-dep, ubiquitous, and browser-portable. `ignore` provides git-accurate `.gitignore` matching (including the per-directory matchers the nested-composition walk relies on); `picomatch` provides globstar glob matching. Together they are the minimum needed for correct nested-`.gitignore` + globbing without a subprocess. The project's "tiny dep surface" principle explicitly permits small universal libraries over binaries — these preserve the browser-portability goal that ruled out ripgrep, so the principle is upheld, not violated.

**Consequences:** `packages/core/package.json` gains `ignore` and `picomatch` as `dependencies`. No binary distribution, no per-platform artifacts. This resolves the initial-draft open Q1.

---

## 2026-07-10 — FINAL: uniform hand-rolled walk + `picomatch`; no `fs.glob`

**Phase:** engineering (open-question resolution)

**Decision:** A **single hand-rolled recursive directory walk** (in `platform/fs-discovery.ts`) backs **both** `glob` and `grep`. Node's `fs.glob` is **not** used. `picomatch` performs glob matching; the two tools differ only in what they do per visited file (pattern-match the path vs. read+regex the contents), sharing identical `.gitignore`, hidden-file, ordering (mtime-desc / name-asc in test), and cap behavior.

**Rationale:** One traversal implementation guarantees `glob` and `grep` behave consistently and removes the Node-22 `fs.glob` stability/version-precision risk (`fs.glob` does not parse `.gitignore` anyway, and `grep` needs its own walk regardless — a second glob engine would be redundant and divergent). Confirms the architect's provisional recommendation.

**Consequences:** No dependence on Node's experimental `fs.glob`. The shared walk is the single most logic-dense module and gets its own tests. Resolves the initial-draft open Q2.

---

## 2026-07-10 — FINAL: nested `.gitignore` composed hierarchically (v1, required) — OVERRIDES root-only

**Phase:** engineering (open-question resolution)

**Decision:** v1 **must** honor nested `.gitignore` files composed hierarchically with git-style precedence — every directory's `.gitignore`, not just the repo root. This **overrides** the architect's provisional "root-only for v1" recommendation.

**Rationale (mechanism):** The shared walk maintains a **stack of `ignore`-library matchers**, one frame per directory level. On entering a directory `D` with a `D/.gitignore`, a new matcher built from that file is pushed; it is popped when the walk leaves `D`. A candidate entry is ignored if **any** matcher on the stack matches the entry's path relative to that matcher's directory (`ignore` matches relative to the `.gitignore`'s location), so deeper rules layer on top of shallower ones and a deeper `!`-negation re-includes exactly as git does. VCS metadata dirs are pruned before the stack is consulted. Stack memory is O(depth). This is closer to true git semantics and avoids surprising the agent with generated files that a subdirectory `.gitignore` intended to hide.

**Consequences:** More intricate walk logic (push/pop stack, relative-path matching, negation) — the `ignore` lib supplies the matching; the walk supplies the stack management. Requires dedicated tests (multi-level ignore, deep negation re-include, VCS-dir precedence). No "nested gitignore deferred" limitation remains. Removes the initial-draft R6 "root-only" note.

---

## 2026-07-10 — FINAL: grep context lines `-A`/`-B`/`-C` in v1 — OVERRIDES out-of-scope

**Phase:** engineering (open-question resolution)

**Decision:** v1 **must** support grep context lines: `after_context` (`-A N`), `before_context` (`-B N`), and `context` (`-C N`, both; overrides the other two if set). This **overrides** the architect's provisional "out of scope for v1" recommendation.

**Rationale / shape:** Context lines make `content`-mode grep genuinely useful (a match without surrounding lines is often unreadable) and match the reference. In `content`-mode output, each entry carries `kind: "match" | "context"`; entries are ordered by `(file, line)` with 1-based line numbers and the 500-char per-line cap. **Overlapping/adjacent context windows merge** so each physical line appears exactly once (a match line inside another match's window stays `kind: "match"`). **Cap interaction:** `limit` counts **match** lines only (context lines never consume the budget); the ~20_000-char total-result guard truncates at a match boundary and sets `truncated: true`. Windows clamp at BOF/EOF.

**Consequences:** `GrepOptions` gains `before`/`after`; `GrepMatch` gains `kind`; the `grep` Zod schema gains `before_context`/`after_context`/`context`. The `Platform.grep` primitive owns window collection and merge (portable across platforms). Requires tests for merge, cap interaction (context not counted), and BOF/EOF clamping. No "context lines deferred" limitation remains.

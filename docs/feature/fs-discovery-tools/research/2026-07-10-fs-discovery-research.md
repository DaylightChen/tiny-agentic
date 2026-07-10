# Research — Filesystem Discovery Tools (`ls` / `glob` / `grep`)

**Scope:** `feature/fs-discovery-tools` (Tier-1 #1 in `docs/project/core-roadmap.md`)
**Phase:** research (phase 0) — evidence only; no product or engineering decisions
**Date:** 2026-07-10
**Researcher agent output.** The next phase (`feature-architect`) owns the design decisions this doc surfaces.

> **Depth note:** `ls`/`glob`/`grep` are well-trodden ground, so the *external* research is deliberately lean — the load-bearing content is (a) the reference's concrete tool shapes as prior art, and (b) the **codebase-fit** and **open-questions** sections, both grounded in the actual files this feature touches. Nothing here is minimal-by-omission; the lean sections are marked as judged.

---

## 1. Research questions

Derived from the feature brief and the roadmap entry:

1. **Prior art** — How do mature coding agents (specifically the Claude Code reference in `claude-code-source-code/`) shape `ls`/`glob`/`grep` tools? What are their inputs, outputs, truncation/result caps, ignore-file handling, and path conventions?
2. **Technical feasibility in Node 22** — For each of directory-listing, glob, and content-search: what does stdlib cover vs. what needs a library or a subprocess (ripgrep)? What are the trade-offs (maturity, dependency weight, `.gitignore` support, performance, portability)?
3. **Codebase fit** — Where exactly does the `Platform` seam grow (`listDir` / `glob` / `stat`)? What belongs on `Platform` vs. inside the tool? How does the breaking `Platform` change ripple to `NodePlatform` and the test-double `MockPlatform`? How do the three tools mirror the existing built-in tool conventions (`defineTool`, Zod, JSON-serializable results, error handling)?
4. **Domain constraints** — How do the headless/UI-free boundary, mandatory Zod validation, the permission-gate interaction (structured discovery should *not* trip the shell gate), and statelessness/determinism bound the design?
5. **Concurrency foreshadowing** — Which of the three tools are read-only and therefore candidates for the `isConcurrencySafe` hook that Tier-2 #5 (concurrent tool execution) will exploit?
6. **Open questions for the architect** — ripgrep-subprocess vs. pure-JS; `.gitignore` honoring; output format & caps; whether `stat` is a standalone tool or only a `Platform` primitive; absolute vs. cwd-relative paths.

---

## 2. Prior art & existing solutions

The strongest, most directly applicable prior art is the **Claude Code reference itself** (`claude-code-source-code/`, decompiled v2.1.88), which is this project's designated learning reference. It ships production `Glob` and `Grep` tools. Findings below are read directly from that source.

### 2.1 Grep tool — `claude-code-source-code/src/tools/GrepTool/GrepTool.ts`

- **Backed by ripgrep as a subprocess**, not a JS regex engine. All search logic is ripgrep argument construction; results come back as `string[]` lines from `utils/ripgrep.ts`.
- **Rich input schema (Zod):** `pattern` (regex, required), optional `path`, `glob` (file filter), `output_mode` (`'content' | 'files_with_matches' | 'count'`, default `files_with_matches`), context flags (`-A`/`-B`/`-C`/`context`), `-n` (line numbers), `-i` (case-insensitive), `type` (rg file type), `head_limit`, `offset`, `multiline`. This is a near-1:1 exposure of ripgrep's surface.
- **Result caps:** `DEFAULT_HEAD_LIMIT = 250` entries when `head_limit` is unspecified; explicit `head_limit=0` = unlimited escape hatch. Separately, `maxResultSizeChars: 20_000` (the 20 KB tool-result persistence threshold). Line length capped with `--max-columns 500` to keep minified/base64 lines from flooding output.
- **Ignore handling:** excludes VCS dirs (`.git`, `.svn`, `.hg`, `.bzr`, `.jj`, `.sl`) via `--glob '!…'`; layers in permission-derived ignore patterns (`getFileReadIgnorePatterns`). ripgrep's own default `.gitignore` respect is in play for grep.
- **Path convention:** accepts absolute or cwd-relative `path`; **converts absolute result paths back to relative** before returning (explicitly "to save tokens").
- **Output shape:** a structured object (`{ mode, numFiles, filenames, content?, numLines?, numMatches?, appliedLimit?, appliedOffset? }`) — JSON-serializable, then separately rendered for the UI. `isConcurrencySafe() => true` and `isReadOnly() => true` are both declared.
- **Validation:** `validateInput` stats the `path` first and returns a helpful "path does not exist / did you mean…" message before running.

### 2.2 Glob — `claude-code-source-code/src/utils/glob.ts`

- **Also implemented via ripgrep** (`rg --files --glob <pattern> --sort=modified`), *not* a JS glob library. Rationale in the source comment: "Use ripgrep for better memory performance" (large monorepos: 200k+ files).
- **Pagination:** takes `{ limit, offset }`, returns `{ files, truncated }`. `truncated` is `paths.length > offset + limit`.
- **Ignore/hidden toggles:** `--no-ignore` default **on** (does NOT respect `.gitignore` by default for glob — opposite of grep) and `--hidden` default **on**, both env-overridable (`CLAUDE_CODE_GLOB_NO_IGNORE`, `CLAUDE_CODE_GLOB_HIDDEN`). Note the deliberate asymmetry: glob ignores `.gitignore` by default, grep respects it.
- **Sorting:** `--sort=modified` (most-recently-modified first is the useful default for "what's relevant now").
- **Absolute-pattern handling:** `extractGlobBaseDirectory` splits a glob into a static base dir + relative pattern because `rg --glob` only accepts relative patterns.

### 2.3 ripgrep integration — `claude-code-source-code/src/utils/ripgrep.ts`

Substantial, load-bearing infrastructure — worth reading before choosing the ripgrep path:

- **Binary resolution is non-trivial:** system `rg` (PATH-hijack-guarded by using the bare name `rg`), a vendored per-arch/per-platform binary (`vendor/ripgrep/<arch>-<platform>/rg`), or an embedded (bundled Bun) binary dispatched via `argv0`. macOS codesigning + quarantine removal for the vendored binary.
- **Robustness the naive `exec` path lacks:** 20 MB stdout buffer cap; SIGTERM→SIGKILL escalation (ripgrep can block in uninterruptible I/O); EAGAIN single-thread retry for resource-constrained CI/Docker; exit-code semantics (`0` = matches, `1` = *no matches, not an error*, `2` = usage error); a dedicated `RipgrepTimeoutError` so "timed out" is distinguishable from "no matches"; partial-result recovery on timeout/buffer-overflow.

**Takeaway (evidence, not prescription):** the reference deliberately chose ripgrep-subprocess for *both* glob and grep, and the *reason it's not trivial* is the binary-distribution + process-robustness tail, not the search itself. That tail is the thing to weigh against a pure-JS approach.

### 2.4 `ls` in the reference

The reference's directory listing (`LS`/file-index) is more UI/suggestion-oriented and less cleanly a standalone tool than Glob/Grep; it did not surface as a single portable primitive worth mirroring 1:1. A minimal `ls` (list a directory's entries with type + maybe size) is standard territory — the interesting design question is entirely "how much does it overlap with `glob`" (see open questions), not prior art.

### 2.5 Adjacent ecosystem (secondary, lower weight)

- **`fast-glob` / `globby`** — the de-facto pure-JS glob libraries. `globby` adds `gitignore: true` and layers on `fast-glob`. MIT-licensed, extremely widely used. Relevant as the pure-JS alternative to ripgrep-`--files`.
- **`ignore`** (kaelzhang) — MIT, the standard pure-JS `.gitignore`-matching library; what you'd reach for to honor `.gitignore` without ripgrep.
- **`@vscode/ripgrep`** — an npm package that vendors ripgrep binaries per-platform, i.e. a ready-made solution to the "distribute the binary" tail the reference hand-rolls. Worth the architect's awareness if the ripgrep path is chosen.

---

## 3. Technical feasibility & candidate approaches (Node 22)

Node floor is **>=22** (decisions log, 2026-06-27, `@types/node@22`). Options per capability, with trade-offs — **not a recommendation**.

### 3.1 Directory listing (`ls` / `listDir`)
- **Stdlib, no contest:** `fs.promises.readdir(path, { withFileTypes: true })` gives entries + type; `fs.promises.stat` gives size/mtime. Zero dependencies, fully deterministic. This is the clear low-risk primitive; there is no real "option B" worth researching for plain listing.

### 3.2 Glob
- **Option A — stdlib `fs.promises.glob` (Node 22+).** Node shipped `fs.glob`/`fsPromises.glob`/`fs.globSync` in v22, initially **experimental**; it stabilized over the 22.x/24.x line. Supports `cwd`, `exclude` (function, and array-of-patterns in later 22.x), and `withFileTypes`. **Does NOT natively parse `.gitignore`.** Zero dependencies. *Trade-off:* exact stability status and `exclude`-array support are **version-precise within the 22.x line** — must be pinned against the actual supported minor (see Open Questions); no `.gitignore` support without doing it yourself (e.g. via `ignore`).
- **Option B — `globby`/`fast-glob`.** Mature, `gitignore: true` built in, rich pattern support, MIT. *Trade-off:* adds a runtime dependency to a package that currently has an intentionally tiny dependency surface (`zod`, `zod-to-json-schema`, vendor SDKs).
- **Option C — ripgrep `rg --files --glob` (the reference's choice).** Best large-repo memory/perf; `.gitignore`/hidden toggles for free. *Trade-off:* pulls in the entire binary-distribution + process-robustness tail from §2.3.

### 3.3 Content search (`grep`)
- **Option A — ripgrep subprocess (reference's choice).** Fast, `.gitignore`-aware, battle-tested regex + context/count/line-number modes essentially for free. *Trade-off:* binary distribution (bundle a per-platform binary, depend on `@vscode/ripgrep`, or require a system `rg` and degrade gracefully if absent) plus the robustness handling in §2.3 (buffer caps, SIGKILL escalation, exit-code semantics, timeout-vs-no-match). This is the load-bearing decision of the whole feature.
- **Option B — pure-JS search.** Read files (via existing `Platform.readFile` + a directory walk) and run JS `RegExp` per line. Zero new binary; fully portable; deterministic; works in a browser platform. *Trade-off:* dramatically slower on large repos, must reimplement `.gitignore`/ignore handling and context/count modes yourself, and needs its own truncation/perf guards.

### 3.4 Cross-cutting feasibility note — the ripgrep/subprocess tension with the Platform abstraction
The reference reaches for `child_process` freely. **This core does not** — only `platform/node.ts` may touch Node built-ins, and the framework aims to be environment-agnostic (a browser platform is a stated goal). A ripgrep-backed grep/glob would therefore have to be expressed *entirely behind the `Platform` seam* (e.g. `Platform.glob`/a search primitive), so a browser/mock platform can supply a pure-JS or no-op backend. This is a genuine architectural fork the architect must resolve — see §5 (Hard constraint) and §7.

---

## 4. Domain & landscape constraints

- **Headless / UI-free (Hard boundary, decisions 2026-06-26).** The core imports zero UI. The reference's Grep/Glob carry `renderToolResultMessage`/`renderToolUseMessage` UI methods — **do not port those**. Tools return JSON-serializable data only; any rendering lives in a consumer package.
- **Environment access only through `Platform` (decisions 2026-06-27).** No module except `platform/node.ts` may reference `fs`, `child_process`, or `process` (lint-enforced). Every new capability (`readdir`, `stat`, `glob`, ripgrep spawn) must enter through a `Platform` method, never directly in the tool.
- **Zod mandatory (decisions 2026-06-26, Q3).** Input schemas are Zod, serialized via `zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "none" })` with `$schema` stripped (decisions 2026-06-29). **Numeric constraints must use the numeric Draft-7 form** — the `openApi3` boolean `exclusiveMinimum` broke OpenAI live. So `head_limit`/`offset`/`limit` should follow the existing pattern (`z.number().int().positive().optional()` as in `read_file`) which already serializes correctly for both providers.
- **Permission-gate interaction.** The single approval seam is `approvalHandler(toolName, input) → 'allow' | 'deny'`, gated in `runTools` before `tool.call` (roadmap; agent-tooling spec). A consumer's most common use is to **deny `bash`** to block shell access. The roadmap's headline rationale for these tools is that **structured discovery must remain usable when `bash` is denied** — i.e. `ls`/`glob`/`grep` are distinct tool names the consumer can allow independently. *Constraint, not decision:* the tools must not internally route through the `bash` tool or otherwise inherit its gate; whether they are auto-allowed or still individually gateable is the architect's call.
- **Statelessness / determinism (decisions 2026-06-26, Q1/A′).** Core is stateless; tools hold no cross-call state. Discovery is naturally stateless. Note the reference sorts by mtime in production but **sorts by filename under `NODE_ENV=test`** for determinism — a testability concern to carry forward.
- **Market expectation.** Any credible coding-agent discovery tool respects `.gitignore` *somewhere* and caps output (context-window economics). The reference's asymmetry (grep respects `.gitignore`, glob does not by default) shows even that is a deliberate, contestable choice — not a fixed standard.

---

## 5. Key findings & implications

1. **The reference proves the whole feature is a solved problem — via ripgrep-subprocess for both glob and grep.** *Engineering-facing:* ripgrep is the highest-leverage but highest-risk option; its cost is almost entirely the **binary-distribution + process-robustness tail** (§2.3), not the search. Isolate that decision first — it cascades into `Platform` shape, dependencies, and browser-portability. Weigh it against pure-JS (`fs.glob` + `readdir` + JS-regex or `globby`/`ignore`), which is slower but dependency-light and environment-agnostic.

2. **This is the anticipated breaking `Platform` change, and it collides with the ripgrep decision.** *Hard constraint:* every environment capability must enter through `Platform` (lint-enforced), and a browser platform is a stated goal. **A grep/glob that shells out to ripgrep cannot live in the tool — it must be a `Platform` method** so non-Node platforms can supply an alternative. The architect must decide the `Platform` method *granularity*: fine-grained primitives (`listDir`, `stat`, and either a `glob` or a raw search primitive) vs. a coarser `search`/`glob` method that encapsulates ripgrep. This choice determines how much of the ripgrep tail leaks across the seam.

3. **The `Platform` addition is a compile-time-caught breaking change with exactly two in-repo implementors to update.** *Engineering-facing (low-risk, scoped):* `NodePlatform` (`packages/core/src/platform/node.ts`) and the test-double `MockPlatform` (defined inline in `packages/core/src/__tests__/builtin-tools.test.ts`, and similar doubles across the other test files — see §6). Adding methods breaks their compile until updated; that's the intended early-warning per the decisions log. No external implementors exist yet, so the blast radius is small and internal.

4. **Result caps and output shape are a first-class design concern, not an afterthought.** *Engineering-facing:* the reference invests heavily here (`head_limit=250` default, `head_limit=0` unlimited escape hatch, `maxResultSizeChars=20_000`, `--max-columns 500`, mtime sort, absolute→relative path rewriting to save tokens). Whatever the tools return must be JSON-serializable and bounded; unbounded `grep`/`glob` output will blow the model's context. This is where most of the tool's real design lives.

5. **All three tools are read-only → prime `isConcurrencySafe` candidates, which the very next feature (Tier-2 #5) exploits.** *Engineering-facing:* `ls`, `glob`, and `grep` have no side effects and are independent — the reference declares `isConcurrencySafe() => true` and `isReadOnly() => true` on Grep. Design them to return `true` from `isConcurrencySafe` (matching the read-only-safe / stateful-sequential split the roadmap draws: read-only safe; `bash`/`edit_file`/`write_file` sequential). This makes them the immediate beneficiaries of concurrent tool execution and should inform the tool signatures now so #5 needs no rework.

6. **`.gitignore` handling is a genuine product/UX fork the reference itself treats as contestable.** *Product/UX-facing question (for the architect, since feature scope collapses product+engineering):* the reference makes **grep respect `.gitignore` but glob ignore it by default** (both env-overridable). Should tiny-agentic honor `.gitignore` at all, and symmetrically? This changes what the agent can "see" and is not a settled standard — surface it rather than pick silently.

---

## 6. Codebase-fit map (concrete, grounded in files)

**The `Platform` seam** — `packages/core/src/types/platform.ts`:
```
export interface Platform {
  cwd(): string;
  readFile(path, encoding?): Promise<string>;
  writeFile(path, content): Promise<void>;
  exec(command, options?): Promise<ExecResult>;
}
```
New methods (names per roadmap; final shape is the architect's) would be added here — e.g. `listDir`, `stat`, and a `glob`/search primitive. Each addition is a breaking change to every implementor.

**Implementors that must update (compile-time caught):**
- `packages/core/src/platform/node.ts` — `NodePlatform`, the only module permitted to import `node:fs`/`node:child_process`. New methods land here (`readdir`/`stat` from `node:fs/promises`; ripgrep spawn if that path is chosen).
- **Test doubles** — `MockPlatform` is defined **inline per test file**, not shared. Confirmed inline definition in `packages/core/src/__tests__/builtin-tools.test.ts` (a class `MockPlatform implements Platform` with `cwd`/`readFile`/`writeFile`/`exec`). Grep found `MockPlatform`/`Platform`-implementing doubles across ~10 test files (`loop.test.ts`, `runTools.test.ts`, `task-tool.test.ts`, `subagent-boundary.test.ts`, `env-context.test.ts`, `editFile.test.ts`, `bash.test.ts`, `agent.test.ts`, `agent-tooling-integration.test.ts`). **Adding a `Platform` method breaks all of these until each mock implements it** — the architect/planner should note the update is spread across many files (a candidate for consolidating the mock into a shared test util as part of this feature).

**Tool conventions to mirror** — `packages/core/src/tools/builtin/` (`readFile.ts`, `writeFile.ts`, `bash.ts`, `editFile.ts`, `task.ts`):
- Author with `defineTool({ name, description, inputSchema, call })` (from `types/tool.ts`) for inferred input typing.
- `inputSchema` is a `z.object({...})` with `.describe()` on every field; numeric fields use `z.number().int().positive().optional()` (matches `read_file`'s `offset`/`limit`, serializes correctly for both providers).
- `call(input, platform, context)` returns a **plain JSON-serializable object** (e.g. `bash` returns `{ stdout, stderr, exitCode }`; `read_file` returns `{ content, offset, lineCount, totalLines, truncated }`). Throw to signal an error (framework feeds the message back to the model).
- Read `cwd` via `platform.cwd()`, thread cancellation via `context.signal` into `platform.exec(...)` (see `bash.ts` — the closest analog for a subprocess-backed tool, incl. its timeout-clamping pattern).
- Add `isConcurrencySafe: () => true` on all three (currently unused hook, but reserved and exploited by Tier-2 #5).

**Registration/export** — `packages/core/src/index.ts` re-exports each built-in tool by name (`export { readFileTool } from "./tools/builtin/readFile.js"`). The three new tools follow the same one-line export pattern. There is **no auto-registry**; consumers pass tools explicitly to `new Agent({ tools })`, so the tools are opt-in by construction (relevant to the permission-gate story — a consumer that wants discovery-without-shell simply includes `ls`/`glob`/`grep` and omits `bash`).

---

## 7. Open questions & unknowns (for the feature-architect)

1. **ripgrep-subprocess vs. pure-JS — the load-bearing fork.** ripgrep = best perf + `.gitignore`/hidden for free, but pulls in binary distribution (bundle per-platform / `@vscode/ripgrep` / rely on system `rg` and degrade) and the robustness tail (§2.3), and *must* sit behind `Platform` to preserve browser-portability. Pure-JS (`fs.glob` + `readdir` + JS-regex, or `globby`+`ignore`) = dependency-light, portable, deterministic, but slower and reimplements ignore/context/count. **Needs a decision; may warrant a small spike** benchmarking pure-JS grep on this repo before committing.
2. **`Platform` method granularity & names.** Fine-grained (`listDir`, `stat`, `glob`) vs. a coarser `search` primitive encapsulating ripgrep. Determines how much implementation leaks across the seam and how a browser platform can conform. (Roadmap suggests `listDir`/`glob`/`stat` as a starting point, not a mandate.)
3. **Is `stat` a standalone tool or only a `Platform` primitive?** The reference uses `stat` internally (mtime sort, path validation) but does not expose a model-facing `stat` tool. Likely a `Platform` primitive consumed by `ls`/`glob`, not its own tool — but the architect should confirm.
4. **`.gitignore` / hidden-file handling.** Honor `.gitignore` at all? Symmetrically across `ls`/`glob`/`grep`, or the reference's asymmetry (grep yes, glob no)? Env-overridable like the reference, or fixed? Product-shaping (§5.6).
5. **Output format & caps.** Default result cap (reference: 250 entries), unlimited escape hatch, max result bytes (reference: 20 KB), line-length cap, sort order (mtime vs. name; note the reference's `NODE_ENV=test` determinism switch). What exact JSON shape does each tool return?
6. **Absolute vs. cwd-relative paths.** Accept both on input (reference does), and return relative paths to save tokens (reference does)? Confirm the convention, since the core threads `cwd` only through `platform.cwd()`.
7. **`ls` vs. `glob` overlap.** Is a dedicated `ls` worth it, or does `glob` (`*` in a dir) + `read_file` subsume it? The reference's `ls` is UI/suggestion-flavored, giving weak guidance here.
8. **Node `fs.glob` version-precision (if the stdlib path is chosen).** Exact stability status and `exclude`-array support vary across the 22.x line; must be verified against the project's actual supported minor before relying on it. *(Unresolved by this research — pin at engineering time.)*
9. **Concurrency-safety confirmation.** All three are read-only; confirming `isConcurrencySafe() => true` and that they hold no shared state is a design check the architect should record for Tier-2 #5.

---

## 8. Sources

**Primary — the project's own reference source (highest trust; this is the designated learning reference, decompiled Claude Code v2.1.88):**
- `claude-code-source-code/src/tools/GrepTool/GrepTool.ts` — the Grep tool's full Zod input schema, output shape, result caps (`head_limit=250`, `maxResultSizeChars=20_000`, `--max-columns 500`), ignore handling, absolute→relative rewriting, `isConcurrencySafe/isReadOnly`. The single most load-bearing prior-art source.
- `claude-code-source-code/src/utils/glob.ts` — glob via `rg --files --glob`, `{limit, offset}`→`{files, truncated}`, `--no-ignore`/`--hidden` defaults and env toggles, `--sort=modified`, absolute-pattern base-dir extraction.
- `claude-code-source-code/src/utils/ripgrep.ts` — the ripgrep-subprocess robustness tail: binary resolution (system/vendored/embedded), 20 MB buffer cap, SIGTERM→SIGKILL, EAGAIN retry, exit-code semantics, `RipgrepTimeoutError`.

**Primary — this project's own code & decisions (highest trust):**
- `packages/core/src/types/platform.ts`, `platform/node.ts`, `types/tool.ts`, `tools/builtin/{readFile,bash}.ts`, `index.ts`, `__tests__/builtin-tools.test.ts` (inline `MockPlatform`) — the exact seams and conventions this feature must fit.
- `docs/project/decisions.md` (Platform M1 method set; `cwd()` addition; Zod/`jsonSchema7`; headless boundary; stateless core) and `docs/project/core-roadmap.md` (Tier-1 #1 framing, breaking-change warning, concurrency foreshadow).

**Secondary — external ecosystem (moderate trust; general orientation, not decisions):**
- Node.js `fs`/`fsPromises.glob` docs — <https://nodejs.org/api/fs.html#fspromisesglobpattern-options>. Confirms `fsPromises.glob` exists in the Promises API with `pattern`+`options`; the fetched page did **not** expand stability/options detail — hence open question #8. *(Trust: authoritative for existence, incomplete for version-precise stability.)*
- General ecosystem knowledge (lower trust, unverified this session): `fs.glob` introduced experimental in Node 22 with `cwd`/`exclude`/`withFileTypes` and no native `.gitignore`; `globby` (`gitignore: true`, MIT) over `fast-glob`; `ignore` (MIT) for `.gitignore` matching; `@vscode/ripgrep` for vendored binaries. Flagged as orientation to be verified at engineering time, not relied upon here.
```

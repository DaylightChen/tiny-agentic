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

## 2026-06-26 — Headless, UI-free framework boundary

**Phase:** brainstorm (pre-spec, established in initial brainstorming)

**Decision:** The framework is UI-free and headless. The core engine surfaces its work as a typed event stream and imports zero UI code. Any TUI/CLI/web interface is a separate package built on top of the framework, never inside it.

**Rationale:** The Claude Code reference's core engine (`query()` in `query.ts:219`) is already fully headless — it imports no React/Ink and yields typed events; the UI is purely a consumer. Keeping that boundary as a hard architectural rule (rather than retrofitting it later) preserves composability and testability, and matches the user's mental model of "framework + separate UI package on top."

**Consequences:** Enables swapping any front-end (TUI, web, logger, test harness) without touching the engine. During development the engine is exercised by a throwaway example/test driver, not a shipped UI. Forbids any rendering/terminal dependency in the framework package.

---

## 2026-06-26 — Language & runtime: TypeScript / Node

**Phase:** brainstorm

**Decision:** Build in TypeScript on Node (>=18).

**Rationale:** Matches the Claude Code reference exactly, giving a near 1:1 concept mapping as the user learns from it (a stated project goal). Lowest translation friction versus Python/Go/Rust.

**Consequences:** Reference code can be read structurally, not just conceptually. Commits the project to the npm/TS toolchain.

---

## 2026-06-26 — Provider abstraction: Anthropic first, OpenAI second

**Phase:** brainstorm

**Decision:** Put a provider abstraction in front of the LLM from day one. Implement Anthropic first (mirrors the reference's tool-use loop), then add OpenAI as the second implementation to validate the abstraction.

**Rationale:** The reference has **no** generic provider interface — it is Anthropic-Messages-API-shaped throughout (provider selection only chooses which Anthropic SDK to instantiate). Since the user wants both Anthropic and OpenAI, we must build the abstraction the reference lacks: a canonical internal request shape + event union, with per-provider adapters. Implementing a second provider (OpenAI) is the real test that the abstraction holds.

**Consequences:** Forces an internal canonical `StreamEvent` union and request mapper early. Anthropic adapter is informed in detail by the reference; the OpenAI adapter is our own design. Bedrock/Vertex/Foundry are explicitly out of scope.

---

## 2026-06-26 — Engine surface: async generator

**Phase:** brainstorm

**Decision:** The core engine is an `async function*` that yields a typed event union; the consumer drives iteration (`for await (const event of agent.run(prompt))`). Rejected: EventEmitter/callbacks (Approach B) and reactive streams/RxJS (Approach C).

**Rationale:** Async generators give natural streaming + backpressure (consumer pulls), are trivially awaitable for completion, are composable (wrap/filter/tee), require zero dependencies, and map 1:1 to the reference's central abstraction — maximizing learning transfer. EventEmitter lacks backpressure and clean completion semantics; RxJS adds a heavy dependency and obscures the mechanics the project exists to learn.

**Verification:** Confirmed against the reference source. Claude Code's core engine is `export async function* query(params): AsyncGenerator<StreamEvent | Message | ..., Terminal>` (`claude-code-source-code/src/query.ts:219`). It yields a discriminated union of typed events, has a typed `Terminal` return value (the "why it stopped" result, distinct from yielded events), and composes nested generators via `yield*` (`queryLoop`, query.ts:241). Our Approach A is a faithful mirror of this.

**Status:** Explicitly confirmed by the user on 2026-06-26 after reviewing the reference source (initial approval had been implicit via a batch sign-off; user asked to verify, source was checked, decision re-affirmed).

**Open refinement for the engineering phase:** Consider adopting the reference's `AsyncGenerator<Events, Terminal>` split — yield events, *return* the terminal reason (`agent_done` / `max_turns_exceeded`) rather than folding completion signals into the yielded event union as the current brainstorm spec does. Not blocking; the architect decides.

**Consequences:** All engine output flows through one typed event stream. Sub-agents become recursive generator calls (`yield*`). UI/consumers are pure iterators over events.

---

## 2026-06-26 — Milestone 1 scope

**Phase:** brainstorm

**Decision:** Milestone 1 = headless core loop (01) + provider layer (03, Anthropic) + tools with execution (02, 2-3 real tools) + a context/system-prompt sliver (04, env context: cwd/git/date). Deferred: permissions/approval flow, sub-agents, extensibility (hooks/plugins/MCP/config), and any UI.

**Rationale:** This is the smallest *complete* agent — it can actually call a model and do things via tools — while excluding everything the research classified as resilience or product polish. Permissions default to blanket-allow in M1; the approval seam comes later. OpenAI is the M2 validation of the provider abstraction.

**Consequences:** Defines the boundary of the first engineering spec and plan. Subsystem research lives in `docs/project/research/` (see `00-overview.md` minimal-essence table) and is the primary input to the brainstorm spec.

---

## 2026-06-26 — Three-package architecture

**Phase:** brainstorm

**Decision:** The system is decomposed into (at least) three packages, layered:

1. **`tiny-agentic` (core)** — the agentic primitives: the headless agent loop, tool registration/execution, the provider abstraction (Anthropic + OpenAI), the event stream, env-context injection. Environment-agnostic (Node or browser) via platform capability injection. **This is the milestone-1 deliverable.**
2. **Agent SDK (on top of core)** — a Claude-Code-like batteries-included layer: customizable tools, skills, session persistence (local JSONL transcripts), richer system-prompt assembly, memory. Consumes the core; adds the stateful/product concerns the core deliberately omits.
3. **UI/TUI package (on top of the SDK / core)** — the interactive front-end (TUI/CLI/web). Pure consumer of the event stream. Never depended on by the layers below it.

Dependency direction is strictly one-way: UI → SDK → core. Lower layers never import higher ones.

**Rationale:** Mirrors how Claude Code is internally layered (headless `query()` core, stateful `QueryEngine` wrapper, Ink UI consumer) but makes the layers explicit package boundaries rather than internal modules. Keeps the core minimal, learnable, and reusable; lets the SDK accrue product features without bloating the core; keeps UI fully swappable. Reinforces the already-locked headless boundary and the stateless-core (A′) decision — persistence and session state live in the SDK layer, not the core.

**Consequences:** M1 scope is now precisely "the core package." Features the brainstorm spec marked forward-looking (OpenAI provider stays in core; permission seam in core; sub-agents in core) vs. SDK-layer (skills, session persistence, memory, custom system-prompt assembly) must be assigned to the right package. The core must expose clean extension seams (Tool interface, Provider interface, platform interface, event union, stateless run with threaded history) that the SDK builds on. Monorepo vs. multi-repo packaging is an engineering-phase decision.

---

## 2026-06-26 — Milestone-1 open questions resolved

**Phase:** brainstorm

**Decision:** The five open questions from the brainstorm spec (§8) are resolved as:

- **Q1 (session model):** A′ — stateless core. `run()` optionally accepts prior messages; its terminal return includes the final in-memory message list. Multi-turn by threading the value. No on-disk persistence in the core (that's an SDK-layer concern). A stateful `Session` wrapper is additive, deferred to the SDK.
- **Q2 (tool concurrency):** Sequential execution in M1; build the `runTools` seam so parallel-where-safe (via `isConcurrencySafe()`) can be added later without reworking the loop.
- **Q3 (tool schema):** Zod, mandatory. `inputSchema` is a Zod schema, serialized via `zod-to-json-schema` and used for runtime validation before `call`. `zod` is a peer dependency.
- **Q4 (built-in tools / environment):** Platform capability injection. The core defines one environment-agnostic tool *definition* (e.g. `read_file`) that calls an injected `platform` interface (`readFile`/`writeFile`/`exec`); a `NodePlatform` or `BrowserPlatform` supplies the concrete backend. The core stays filesystem/shell-free.
- **Q5 (debug/logging):** Optional `logger?: (entry) => void` callback on the provider; off by default.

**Rationale:** Each choice favors the smallest correct M1 core while leaving clean seams for the SDK and UI layers. See the per-question discussion in the session brainstorming; all are consistent with the headless, stateless-core, three-package decisions above.

**Consequences:** These bind the engineering phase's interface design for the core package: a stateless generator `run(prompt, { messages? })`, a `Tool` interface with Zod `inputSchema`, a `Platform` capability interface, sequential `runTools` with a concurrency-safe seam, and a `Provider` interface with an optional logger.

---

## 2026-06-27 — Tool-only core: Skill and Command are SDK-layer constructs

**Phase:** brainstorm

**Decision:** Of the three concepts {Tool, Skill, Command}, only **Tool** lives in the `tiny-agentic` core package. **Skill** and **Command** are SDK-layer constructs. The core has no concept of "skill" or "command" at all — they reduce to the two primitives the core already has: **tools** and **messages**. The core's sole obligation toward them is to expose an **extensible tool-call context** (a context object passed to every `Tool.call`, which the SDK can widen to carry, e.g., a skill/command registry) — mirroring the reference's `ToolUseContext`.

**Rationale:** Established by a dedicated round of reference research (see below). The evidence: the core agent loop never imports skills or commands — it receives them as *data*. (1) `Tool` (`Tool.ts`) has zero filesystem/UI/config coupling — pure primitive. (2) `Command` (`types/command.ts:205`) is a `prompt | local | local-jsx` union, loaded from disk and defined by *user* invocation (`/foo` via the REPL parser); the `local-jsx` variant returns React. (3) A `Skill` is literally a `PromptCommand` (`type:'prompt'`) produced by parsing a `SKILL.md` frontmatter file (`skills/loadSkillsDir.ts`). The two model/user invocation paths decompose cleanly across packages: a model-invoked skill reaches the model through `SkillTool`, which is *just a core Tool* backed by an SDK-loaded registry (core sees only a tool); a user `/command` is expanded by the SDK/UI to a prompt and passed via `core.run(prompt, { messages })` (core sees only a prompt + messages).

**Consequences:** M1 (core) ships none of the skill/command machinery (no markdown loading, no frontmatter parsing, no slash-command dispatch). The core `Tool` interface MUST give `call` an extensible/generic context object now, so the SDK can later inject a `SkillTool` and a command registry with zero core changes. Skill loading, frontmatter, session/command registries, and slash-command dispatch all belong to the SDK (and, for `/`-invocation UX, partly the UI layer). This sharpens — does not change — the three-package architecture decision.

---

## 2026-06-27 — Entry point: `Agent` class only; completion events carry final messages

**Phase:** brainstorm (spec self-review)

**Decision:** Two API-shape refinements settled during spec self-review:

1. **Canonical entry point is the `Agent` class.** `new Agent({ provider, tools, platform, systemPrompt?, maxTurns? })` then `agent.run(prompt, { messages? })`. There is NO standalone `run()` free function (the draft showed both inconsistently; the free function is removed).
2. **Completion events carry the final message list.** The terminal events — `agent_done`, `max_turns_exceeded`, `agent_error` — each include `messages: Message[]` (and their existing fields). A pure `for await` loop therefore receives completion reason AND final history without needing the generator's return value. The generator still *returns* a `Terminal` (reason + messages) as optional sugar for callers who drive `.next()` manually.

**Rationale:** Self-review found the draft's multi-turn examples technically broken: `for await` discards a generator's return value (JS language semantics), and `gen.return(x)` does not surface the generator body's own return value — so the shown `await gen.return()` / `terminal.messages` threading could not work. Putting `messages` on the completion events resolves this ergonomically (the common `for await` consumer just reads the last event), while keeping the `AsyncGenerator<AgentEvent, Terminal>` shape for advanced callers. Picking the `Agent` class as the sole entry point removes the dual-API inconsistency and matches how config (provider/tools/platform) is naturally set once while per-call data (messages) varies per run.

**Consequences:** Engineering phase implements one entry point (`Agent.run`). Completion-detection and history-threading both work through the event stream; the `Terminal` return is a convenience, not the only path to the final messages. The §8 open question about "how Terminal is surfaced under `for await`" is now resolved. The free `run()` function is struck from the spec.

---

## 2026-06-27 — Repository layout: monorepo

**Phase:** engineering (pre-spec direction)

**Decision:** The project uses a **monorepo** (workspace) layout from the start, even though only the core package ships in M1. Each of the three packages — core (`tiny-agentic`), the Agent SDK, and the UI/TUI — is its own workspace package under a `packages/` directory (or equivalent), with the one-way dependency rule (UI → SDK → core) enforced by package boundaries.

**Rationale:** The three-package architecture is already decided; a monorepo lets those package boundaries exist and be enforced from day one (a package cannot import "upward" if the dependency isn't declared), keeps versioning/tooling/CI in one place, and makes cross-package refactors atomic. Starting single-package and splitting later would force a disruptive restructure exactly when the SDK and UI work begins. The cost (workspace tooling setup) is paid once, early, when the repo is small.

**Consequences:** The engineering phase must choose the concrete workspace tool (e.g., npm/pnpm/yarn workspaces, or Nx/Turborepo) and define the `packages/` layout, shared `tsconfig`/build setup, and the inter-package dependency declarations. M1 implements only the core package, but its `package.json`, exports map, and build live inside the monorepo structure. The "monorepo vs. single-package" open question from the brainstorm spec (§8) is now resolved; the specific tooling is the architect's call.

---

---

## 2026-06-27 — Workspace tooling: pnpm workspaces

**Phase:** engineering

**Decision:** Use **pnpm workspaces** (no Nx or Turborepo in M1). `pnpm-workspace.yaml` declares `packages/*`. No Turborepo task runner in M1 — added when multi-package parallel builds are needed (M2+).

**Rationale:** pnpm's symlink-based `node_modules` enforces the one-way dependency rule at module resolution time: a package cannot import from another workspace package unless the dependency is explicitly declared in `package.json`. npm workspaces use flat hoisting, which allows accidental "upward" imports. Yarn Berry/PnP provides equivalent isolation but has significant tooling compatibility overhead. Turborepo/Nx are task orchestrators, not replacements for workspace isolation — deferred to when the build graph has multiple active packages.

**Consequences:** The one-way dependency rule (UI → SDK → core) is machine-enforced by pnpm's resolution + declared `package.json` dependencies + a `no-restricted-imports` lint rule as a compile-time double-check.

---

## 2026-06-27 — Build tool: tsup; test runner: Vitest; module system: ESM

**Phase:** engineering

**Decision:** `tsup` (esbuild-backed) is the build tool for the core package. Vitest is the test runner. The entire project uses ESM (`"type": "module"` in all `package.json` files, `"module": "Node16"` in TypeScript config). Node >= 18 is required.

**Rationale:** `tsup` handles multiple entry points, declaration files, and source maps in one command — simpler than raw `tsc` or esbuild for a library with multiple `exports` map entries. Vitest runs TypeScript natively in ESM mode without the `--experimental-vm-modules` flag ceremony that Jest requires. ESM-throughout avoids dual-module hazards and matches the project's target (Node 18+ only).

**Consequences:** All imports use the `.js` extension (TypeScript ESM convention). No CommonJS output in M1. The `exports` map in `package.json` is the canonical entry-point definition.

---

## 2026-06-27 — ToolCallContext extension mechanism: TypeScript interface merging

**Phase:** engineering

**Decision:** `ToolCallContext` is declared as an `interface` in `types/tool.ts`. The SDK layer extends it by reopening the interface via `declare module 'tiny-agentic' { interface ToolCallContext { ... } }`. The core constructs `{}` cast to `ToolCallContext` and passes it to every `Tool.call`.

**Rationale:** A generic `Tool<TInput, TContext>` approach would force `Agent` to be generic over the context type, bleeding the SDK's types into the core's public API and violating the one-way dependency rule at the type level. Interface merging keeps the extension fully in the SDK layer with zero core changes. The alternative of a plain `Record<string, unknown>` context was rejected for type safety.

**Consequences:** The `ToolCallContext` interface is the one explicitly open extension point in the core. All other core types are closed (`type` aliases, not `interface`). The SDK must not add required (non-optional) fields to `ToolCallContext` — doing so would break existing `Tool` implementations that do not provide those fields.

---

## 2026-06-27 — AbortSignal threading: second argument to Provider.stream()

**Phase:** engineering

**Decision:** The `AbortSignal` for cancellation is passed as a second argument to `Provider.stream(request, signal?)`, not as a field on `ProviderRequest`.

**Rationale:** `ProviderRequest` is a pure data type (model inputs). The `AbortSignal` is operational context — it is created per `run()` call by the engine and not part of the model's input. Mixing operational signals into data types creates coupling and makes serialization/logging of `ProviderRequest` awkward (signals are not serializable). The second-argument pattern matches the browser `fetch(url, { signal })` convention.

**Consequences:** `Provider` interface signature: `stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent>`. All provider implementations must accept and thread the signal to their underlying HTTP client.

---

## 2026-06-27 — Platform M1 method set: readFile, writeFile, exec (three methods only)

**Phase:** engineering

**Decision:** The `Platform` interface in M1 has exactly three methods: `readFile`, `writeFile`, and `exec`. No `glob`, `listDir`, `stat`, or other methods in M1. Additional methods are added in M2 as more built-in tools are defined.

**Rationale:** The three methods are the exact minimum required by M1: `exec` is used by the env context builder for git commands; `readFile` and `writeFile` back the two M1 built-in tools (`read_file`, `write_file`). Adding speculative methods now would require implementing them in `NodePlatform`, `MockPlatform`, and every future `Platform` implementation before any tool needs them. The interface is intentionally narrow.

**Consequences:** Implementing `Platform` is cheap in M1 (three methods). Adding methods in M2 is a breaking change for existing `Platform` implementations (all must add the new method), which is acceptable — M2 is under active development and `MockPlatform` in tests will break compile, providing an early warning.

---

## 2026-06-27 — ToolSchema JSON Schema target: openApi3 via zod-to-json-schema

**Phase:** engineering

**Decision:** Tool input schemas are serialized using `zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" })`. The output is included verbatim in `ProviderRequest.tools[n].inputSchema`.

**Rationale:** The `openApi3` target produces cleaner schemas (no `$schema` header, simpler nullable representation) than JSON Schema 7. Both the Anthropic Messages API and the OpenAI Chat Completions API accept OpenAPI 3 JSON Schema shapes in their tool definitions. `$refStrategy: "none"` inlines all `$ref` definitions, which providers require (they do not resolve `$ref`s).

**Consequences:** `zod-to-json-schema` is a direct dependency of the core package (not a peer dependency). Consumers do not call it directly; they write Zod schemas and the framework serializes them.

---

## 2026-06-27 — `Platform` gains `cwd()`; env context never touches `process`

**Phase:** engineering (spec self-review)

**Decision:** The `Platform` interface gains a `cwd(): string` method. The env-context builder obtains the working directory via `platform.cwd()`, never `process.cwd()`. `NodePlatform.cwd()` returns `process.cwd()`; a browser/mock platform supplies its own. No module in the core except `platform/node.ts` may reference `process`, `fs`, `child_process`, or any Node global.

**Rationale:** Self-review found `buildEnvContext` using `process.cwd()` directly — a Node global that does not exist in a browser. That leak defeats the entire reason platform injection was chosen (the Q4 decision: keep the core environment-agnostic so the same tools/loop run in Node or browser). Routing cwd through the `Platform` seam closes the leak and keeps the platform the single point of environment access.

**Consequences:** `Platform` M1 method set is now `cwd`, `readFile`, `writeFile`, `exec`. `NodePlatform`, `MockPlatform`, and any test stub must implement `cwd()`. Success criterion "no core filesystem imports" extends to "no `process` reference in core outside `platform/node.ts`" — enforce via the same lint rule.

---

## 2026-06-27 — Provider contract owns retry; SDKs delegate; `withRetry` is the no-SDK fallback

**Phase:** engineering (spec self-review)

**Decision:** Retry of transient errors (429, 5xx, connection) is part of the `Provider` contract, expressed as a uniform `maxRetries` option on every provider. SDK-backed providers delegate to their vendor SDK's built-in retry: `AnthropicProvider` passes `maxRetries` to `new Anthropic({ maxRetries })` (M1); `OpenAIProvider` will pass it to `new OpenAI({ maxRetries })` (M2). Both SDKs implement equivalent policy (exponential backoff + jitter, retry on 429/5xx/connection, honor `Retry-After`). The shared `withRetry(operation, { maxRetries, isRetryable, delayMs?, logger? })` utility remains in the codebase as a **generic, provider-agnostic** helper (error classification injected via `isRetryable`) for any future provider whose backend lacks built-in retry; it is NOT wired into `AnthropicProvider` in M1.

**Rationale:** Self-review found the original design hand-wrapped `client.messages.stream()` in `withRetry`, which (a) wraps only stream *construction*, not consumption — so 429/5xx errors that surface during iteration are never retried (the retry was effectively a no-op), and (b) hardcoded an `isRetryable` that mis-classified Anthropic `APIConnectionError` (no `status` field → treated as non-retryable). Both vendor SDKs already implement correct streaming retry. Consistency across providers comes from the *interface* (every provider exposes `maxRetries` and promises transient-error retry), not from a shared code path — and error shapes differ per vendor, so any shared retry would need per-provider `isRetryable` anyway. Delegating to the SDKs is both correct and less code.

**Consequences:** `AnthropicProvider.stream()` no longer wraps the call in `withRetry`; it constructs `new Anthropic({ apiKey, baseURL, maxRetries })` and iterates the stream directly. `retry.ts` becomes a generic utility (takes `isRetryable` as a parameter; no `@anthropic-ai/sdk` import) and is unit-tested in isolation but unused by M1's provider. Custom hand-rolled streaming retry, if ever desired for learning, is a deliberate later task — not M1.

---

---

## 2026-06-27 — Anthropic mapper is its own task (task-05), separate from the provider (task-06)

**Phase:** plan

**Decision:** `anthropic-mapper.ts` is implemented and fully tested before `anthropic.ts` is written. The mapper has its own task (task-05) with a dedicated test file (`anthropic-mapper.test.ts`).

**Rationale:** The mapper is the highest-risk module in M1 — it implements a stateful per-block JSON accumulation state machine against the Anthropic SDK's exact streaming event shapes. Any surprise about those event shapes (SDK version differences, undocumented behavior) needs to surface in an isolated context before the provider depends on it. Testing the mapper in isolation (with fixture event sequences) is far more precise than testing it through a live provider mock.

**Consequences:** The task ordering is: types → platform utilities → tool registry + env context → mapper → provider → loop → agent. This adds one extra task boundary but eliminates the risk of discovering mapper issues while debugging a full provider integration.

---

## 2026-06-27 — retry.ts is a tested utility but not wired into AnthropicProvider in M1

**Phase:** plan

**Decision:** `withRetry` is implemented (task-06) and unit-tested with fake timers / zero-delay options, but `AnthropicProvider.stream()` does NOT call it. The Anthropic SDK's `maxRetries` handles all retry logic for M1.

**Rationale:** Per the engineering spec §5.3 and the "Provider contract owns retry" decisions log entry: wrapping stream construction in `withRetry` is a no-op because 429/5xx errors surface during stream iteration, not construction. The SDK's built-in retry covers both. `withRetry` exists as a documented fallback for future providers without built-in retry.

**Consequences:** Any implementer who reads the code and wonders "why is withRetry never called?" should be directed here and to the engineering spec §5.3.

---

## 2026-06-27 — Built-in tools (readFileTool, writeFileTool) placed in task-08 with the Agent

**Phase:** plan

**Decision:** The two built-in tools are implemented in task-08 (the same task as the Agent class and the complete index.ts), not in a dedicated earlier task.

**Rationale:** The built-in tools are two-line wrappers over `defineTool` + `Platform` calls. They add no significant complexity to task-08 and their wiring is naturally tested by the integration example (task-10). Putting them in their own task would create an artificially small task with minimal value.

**Consequences:** Any implementer of task-08 should implement readFileTool and writeFileTool first (they are the simplest thing in the task) before tackling Agent.

---

## 2026-06-27 — Lint boundary verification is a dedicated task (task-09)

**Phase:** plan

**Decision:** ESLint boundary checks and typecheck across all packages are their own task (task-09), not folded into task-01 (which creates the config) or task-08 (the last production code task).

**Rationale:** The boundary rules (`no-restricted-imports`, `no-restricted-globals`) are only meaningful against a complete import graph. Running them on a partial codebase (tasks 01–07) would either pass trivially (no imports yet) or require premature fixes to stubs. Running them at the end of all production code work (after task-08) ensures the check is complete and actionable.

**Consequences:** Task-09 may require fixes to production code from tasks 02–08. Those fixes are small (e.g., removing an accidental `process.cwd()` call outside platform/node.ts) and are expected to be caught here rather than in task-10.

---

## 2026-06-27 — skipLibCheck: true + @types/node pinned to the runtime floor (Node 22)

**Phase:** engineering (refine pass)

**Decision:** Three coupled settings:
1. **`skipLibCheck: true`** in `tsconfig.base.json` (was `false`).
2. **`@types/node` pinned to `^22`** as a devDependency of `packages/core` (was unspecified). Adds `"types": ["node"]` to the base config.
3. **Node floor bumped to `>=22.0.0`** in `engines` (was `>=18.0.0`); `.node-version` → `22.x`; `target` stays `ES2022`.

**Rationale:** The core needs `@types/node` to type `AbortSignal` (used in `Provider.stream(request, signal?)`), which is absent from `lib: ["ES2022"]`. Discovered during the implement phase: with `skipLibCheck: false`, `tsc` also type-checks third-party bundled `.d.ts` pulled in transitively — notably vite's declarations via vitest, which reference the `WebSocket` global. A runtime-accurate `@types/node` then fails on globals only present in a newer `@types/node`, while a too-new `@types/node` would type the core against a Node newer than the supported runtime. `skipLibCheck: true` is idiomatic for a TS library (third-party `.d.ts` are not ours to type-check; `tsc` still fully checks our own `src/`) and is the resolution that lets `pnpm -r typecheck` pass with a runtime-accurate `@types/node` (verified: `tsc --noEmit --skipLibCheck` passes cleanly). For the floor: the original spec targeted Node 18, but Node 18 reached EOL April 2025 and Node 20 reached EOL April 2026 — both are end-of-life as of this pass (2026-06). Node 22 is the lowest LTS line still receiving security support, so it is the correct runtime floor; `@types/node` is pinned to the same major (`^22`) so types track the supported runtime. (The task suggested Node 20, but 20 is also now EOL — 22 is the defensible choice.)

**Rejected alternatives:** (a) Keep `skipLibCheck: false` and pin `@types/node@26` — types the core against a Node newer than the runtime floor and couples typecheck health to whichever `@types/*` the test toolchain drags in. (b) Drop `@types/node` and hand-declare `AbortSignal` — fragile, drifts from the real lib types. (c) Keep Node 18/20 floor — both are EOL, no security patches.

**Consequences:** `pnpm -r typecheck` passes with a runtime-accurate `@types/node@22`. `@types/node` contributes types only (devDependency, stripped at build), not a runtime dependency. Our own source remains fully type-checked. The Node floor bump (18→22) is a documentation/CI change only — no source change, since `target: ES2022` was already satisfied by Node 18+.

---

## 2026-06-27 — Malformed streamed tool input uses an `inputParseError` boolean flag + dedicated message

**Phase:** engineering (refine pass)

**Decision:** Unparseable streamed tool input (Anthropic `input_json_delta` that does not `JSON.parse`) is signalled by a dedicated optional boolean — `inputParseError: true` on the provider-agnostic `tool_use` ProviderEvent — while the event's `input` stays a normal, JSON-serializable value (an empty object `{}`). It is NOT signalled by a value placed in `input` (neither an `input: null` that fails Zod, nor a `unique symbol` sentinel). The mapper's `InputAccumulator.finishBlock(index)` returns a discriminated `{ kind: "ok" | "parse_error", ... }`; on `parse_error` the mapper still yields a `tool_use` ProviderEvent (preserving the `tool_use`/`tool_result` pairing the Anthropic message shape requires) with `input: {}` and `inputParseError: true`. The loop threads the flag onto its `pendingToolUses` entry as `parseError`; `runTools` checks `tu.parseError` **before Zod validation** and emits the exact tool-result error `"Tool '<name>': could not parse tool input as JSON"`. `runTools` imports nothing from `types/provider.ts` for this.

**Rationale:** Reconciles the engineering design with the refined brainstorm (§6.1, §5.6), which specifies that exact message — distinct from the Zod `"... invalid input — <zod message>"` path. Two earlier designs are rejected:

1. **`input: null` to fail Zod** — produced the wrong message, conflated "couldn't parse JSON" with "parsed but failed schema," and gave the model a less actionable error.
2. **A `PARSE_ERROR` `unique symbol` in `input`** — a symbol is **not JSON-serializable**. The loop persists the assistant turn (including each tool_use block's `input`) into `workingMessages`; when that turn is threaded back into the next request, `JSON.stringify` **silently drops** the symbol-valued `input`, producing a `tool_use` block with no `input` → Anthropic 400 → `agent_error`. So the parse-error path that should let the model retry instead killed the run a turn later, and the internal sentinel leaked onto the public surface (`tool_use_start.toolInput` stringified to `undefined`).

An empty-object `input` plus a boolean flag keeps the persisted history valid on every turn (it always round-trips through `JSON.stringify`) and keeps the signal entirely off the public event surface — `tool_use_start.toolInput` is the serializable `{}`, never a sentinel.

**Consequences:** No `PARSE_ERROR`/`ParseError` export exists; `types/provider.ts` defines `tool_use` as `{ type: "tool_use"; id; name; input: unknown; inputParseError?: boolean }`. `runTools` no longer imports from `types/provider.ts`; `ToolUseEntry` gains `parseError?: boolean` and the loop's `pendingToolUses` entries carry `parseError: boolean`. `InputAccumulator.finishBlock` returns a discriminated result. The malformed-input edge case (6.1) is owned jointly by the mapper task (sets `input: {}` + `inputParseError: true`) and the runTools task (flag → message), each with a test assertion (mapper asserts `inputParseError === true` and `input` deep-equals `{}`; runTools passes `parseError: true` and asserts the message). Nothing new is exported from the public `index.ts`.

---

## 2026-06-27 — Provider default max_tokens = 32000

**Phase:** engineering (refine pass)

**Decision:** `AnthropicProvider`'s default `max_tokens` is **32000**. `ProviderRequest.maxTokens` stays optional; the provider always sends a concrete value with precedence `request.maxTokens ?? options.maxTokens ?? 32000` (resolved to `this.maxTokens = options.maxTokens ?? 32000` at construction, then `request.maxTokens ?? this.maxTokens` in the mapper).

**Rationale:** The Anthropic Messages API *requires* `max_tokens`, so a default must exist; the brainstorm refine flagged it had no home in either doc. 32000 is a generous M1 cap that comfortably covers agentic turns (tool calls + reasoning) without risking truncation, while staying well under model output limits. The reference escalates to 64k on its non-streaming fallback, which M1 omits, so the streaming default is the only value M1 needs. A per-request override (`ProviderRequest.maxTokens`) and a per-provider override (`AnthropicProviderOptions.maxTokens`) both exist for callers who need a different cap.

**Consequences:** `AnthropicProviderOptions.maxTokens` documented as "default: 32000"; `ProviderRequest.maxTokens` documented as "defaults to 32000 in AnthropicProvider if not set." Spec §5.1 and the `anthropic.ts` / `anthropic-mapper.ts` skeletons agree on the same precedence chain.

---

## 2026-06-27 — M2 seams confirmed: tool-cancellation via ToolCallContext; provider_retry not feasible while SDK-delegated

**Phase:** engineering (refine pass)

**Decision:** Three brainstorm-flagged forward items confirmed as M2, with their seams pinned:
1. **Stream-idle watchdog (§6.17):** none in M1 — rely on the Anthropic SDK's built-in request timeout. A future engine watchdog attaches at the `for await` over `provider.stream(...)` in `loop/loop.ts`.
2. **Cooperative tool cancellation (§6.18):** reserve the seam as an **optional `signal?: AbortSignal` field on `ToolCallContext`** (the already-extensible, all-optional SDK seam), **not** a fourth positional `Tool.call` argument. Keeps `call`'s arity stable at three and is non-breaking to add in M2.
3. **`provider_retry` event:** **not feasible in M1** while retry is delegated to the Anthropic SDK (no public per-retry hook). The `LogEntry` `retry_attempt` variant is best-effort — it fires only from the unused-in-M1 `withRetry` path, so no `retry_attempt` log is emitted during M1 Anthropic runs. The states-matrix `provider_retry` note reads "not available while retry is SDK-delegated," not "future improvement."

**Rationale:** Each keeps M1 scope minimal while not foreclosing the M2 addition. Routing tool cancellation through `ToolCallContext` reuses the one intentionally-open core extension point (interface merging, all-optional fields) rather than churning every `Tool.call` signature. The `provider_retry` infeasibility follows directly from the "Provider contract owns retry" decision — surfacing retries as events would contradict SDK delegation.

**Consequences:** No M1 code change from this decision; it records where the M2 seams live so M1 does not paint them into a corner. `LogEntry`/`AgentEvent`/`ProviderEvent` unions stay as-is (no `provider_retry`/`event_received`).

---

_See `docs/project/research/` for the subsystem analysis underpinning these decisions._

---

## 2026-06-28 — ESLint ignores `_`-prefixed unused identifiers

**Phase:** implement (task-03, Opus redo)

**Decision:** `eslint.config.js` configures `@typescript-eslint/no-unused-vars` with `argsIgnorePattern`/`varsIgnorePattern`/`caughtErrorsIgnorePattern: "^_"`.

**Rationale:** The code-architecture skeletons pervasively use leading-underscore names for required-but-unused identifiers — `_ctx` in a `Tool.call` that needs no context, `_req`/`_signal` in `MockProvider.stream`, `_encoding` on `NodePlatform.readFile`. `typescript-eslint`'s recommended `no-unused-vars` has no underscore exception by default, so each such param errored. Adding the ignore patterns once (the conventional setting) is cleaner than dropping/renaming params task-by-task, and preserves call-site self-documentation. Surfaced when task-03's `_encoding` failed lint.

**Consequences:** Tasks 05/07/08 (mock providers, tool calls with unused context) lint cleanly with their `_`-prefixed params. The code-architecture doc's ESLint snippet was updated to match.

---

## 2026-06-28 — Built-in file tools gain optional line-range parameters

**Phase:** implement (task-08, Opus redo) — user-requested scope addition

**Decision:** `read_file` and `write_file` accept optional line-range parameters:
- `read_file({ path, offset?, limit? })` — `offset` 1-based start line, `limit` max lines. No range → whole file `{ content }`; range → `{ content, offset, lineCount, totalLines, truncated }`.
- `write_file({ path, content, offset?, limit? })` — no `offset` → full overwrite (create/replace), `{ written, path }`; `offset` set → read-modify-write splice replacing lines `[offset, offset+limit)` (limit default = through EOF, `0` = insert), `{ written, path, replacedFrom, replacedLines }`. Range mode requires an existing file.

**Rationale:** Large files blow up the model's context; reading or rewriting an entire file to touch a few lines is wasteful. The Claude Code reference's `Read` tool has exactly this (`offset`/`limit`). The read side is a pure post-`readFile` line slice; the write side is a read-modify-write splice. Neither needs a new `Platform` method (both use the existing `readFile`/`writeFile`), so the platform seam is unchanged. Full-content overwrite stays the `write_file` default for backward compatibility; richer partial edits (find/replace) remain a future `Edit` tool, out of M1.

**Consequences:** Supersedes the original "exactly two minimal path-only tools" shape in the brainstorm/engineering §11. The `defineTool` schemas now carry `offset`/`limit`; the return shapes are richer (objects, still JSON-serializable). Engineering spec §11 and the code-architecture builtin skeletons updated to match; task-08 brief + tests cover the new params.

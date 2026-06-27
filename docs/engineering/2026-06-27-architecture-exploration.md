# tiny-agentic — Architecture Exploration

**Date:** 2026-06-27
**Milestone:** 1 — the `tiny-agentic` core package
**Status:** Rejected-design archive. Read the canonical spec (`2026-06-27-engineering-spec.md`) for adopted decisions.

This document records the architectural alternatives considered during the engineering phase and explains why each was rejected. The purpose is to prevent re-litigating closed questions during implementation and to explain the reasoning to future maintainers.

---

## A. Monorepo workspace tooling

### Alternatives considered

**A1: npm workspaces**
Available since npm 7. Zero additional dependencies. The simplest choice.

Rejected because: npm workspaces use a flat `node_modules` hoisting strategy that can allow a package to import from another workspace package even if no `dependency` is declared in `package.json`. This is exactly the hole through which one package accidentally imports "upward" in the hierarchy. The hard one-way dependency rule is important enough to enforce at the module resolution level, not just as a convention.

**A2: pnpm workspaces** (adopted)
pnpm uses a symlink-based layout where each package's `node_modules` contains only its declared dependencies. An undeclared import will fail at runtime with a `MODULE_NOT_FOUND` error and at TypeScript compilation time (if project references are configured to match). This makes the one-way rule machine-enforced.

**A3: Yarn Berry (PnP)**
Provides strict isolation via the Plug'n'Play module resolution (no `node_modules` directory). However, PnP requires `.pnp.cjs` shims and patched version of many tools (esbuild, vitest) that do not natively understand the PnP resolution algorithm. The setup cost is high, many tools break, and the isolation benefit is identical to pnpm workspaces without the compatibility tax.

**A4: Turborepo**
Turborepo is a task runner that adds build caching and parallel pipeline execution on top of an existing workspace tool (npm, pnpm, or yarn). It is not a replacement for workspace isolation — it would be used *in addition to* pnpm. For M1 with one package being built and one test suite running, the caching benefit is negligible. Deferred to M2+ when the three packages are all actively built.

**A5: Nx**
Similar to Turborepo with more opinionated conventions and a richer plugin system. Nx's setup overhead (workspace.json, project.json, executor plugins) is significant for a repo that currently builds one package. Deferred.

---

## B. Build tool

### Alternatives considered

**B1: tsc only**
The TypeScript compiler produces `.d.ts` declaration files and `.js` output. Sufficient for a pure library.

Rejected because: `tsc` does not bundle, making it slow for watch mode and requiring manual entry-point wiring when there are multiple `exports` map entries. `tsc` also does not handle the `dist/` cleanup and the `tsup` config is simpler than the equivalent tsc config for multiple outputs.

**B2: tsup** (adopted)
esbuild-backed, handles `exports` map, emits `.d.ts`, fast watch mode. Single `tsup.config.ts` per package. Standard for TypeScript library packaging in 2025-2026.

**B3: Rollup + dts plugin**
Rollup produces smaller bundles by tree-shaking but requires manual plugin wiring (`@rollup/plugin-typescript`, `rollup-plugin-dts`). The resulting config is more brittle than `tsup`. No bundle-size benefit at this scale — the core package is a library, not an application, and tree-shaking is the consumer's job.

**B4: esbuild directly**
Fast but produces no `.d.ts` files by default. Requires a second pass with `tsc --emitDeclarationOnly`. More moving parts than `tsup`, which handles this internally.

---

## C. Test runner

### Alternatives considered

**C1: Jest**
The most widely used test runner in the Node/TypeScript ecosystem. Has a large plugin ecosystem.

Rejected because: Jest requires `--experimental-vm-modules` for ESM support (or a Babel transform, which introduces a build step and makes TypeScript types unavailable at test time). The setup overhead for an ESM project is non-trivial and the resulting configuration is fragile across Jest major versions. The project uses ESM throughout; this friction is unjustifiable.

**C2: Vitest** (adopted)
Designed for ESM-first projects. Native TypeScript support via Vite's transform. Jest-compatible assertion API. Fast parallel execution. No `--experimental-vm-modules` flag. Standard for modern TypeScript projects.

**C3: Node.js `node:test`**
Available since Node 18. Zero dependencies. However, lacks the rich assertion library, snapshot testing, and IDE integration of Vitest. The `node:test` + `assert` combination requires significantly more boilerplate per test case for the kind of event-sequence assertions this project needs.

---

## D. `ToolCallContext` extension mechanism

### Alternatives considered

**D1: TypeScript interface merging** (adopted)
`ToolCallContext` is declared as an `interface` in core. The SDK can merge additional fields by placing a declaration in its own package:

```ts
// in tiny-agentic-sdk:
declare module 'tiny-agentic' {
  interface ToolCallContext {
    skillRegistry?: SkillRegistry;
  }
}
```

This requires zero changes to the core. The core constructs `{}` and passes it typed as `ToolCallContext`; the SDK merges its fields globally.

Trade-off: interface merging is ambient — it affects all code in the compilation unit, not just the SDK's code. A tool author who uses both the core and the SDK sees the merged interface. This is acceptable because `ToolCallContext` is explicitly documented as the SDK extension point; it is not a general-purpose type that other code would confuse with the SDK's extension.

**D2: Generic type parameter `Tool<TInput, TContext extends ToolCallContext>`**
Would provide per-tool type safety: a tool that requires SDK context declares `call(input, platform, context: ToolCallContext & { skillRegistry: SkillRegistry })`.

Rejected because: this forces `Agent` to be generic over `TContext` too, since it constructs and passes the context to all tools. A `Tool<TInput, TContext>[]` array with different `TContext` bounds per element is not representable in TypeScript without existential types or complex union discrimination. In practice this would mean every `Agent` call site must specify a context generic, or the generic defaults to `ToolCallContext` (the base) which loses the benefit. The ergonomics are significantly worse than interface merging for this use case.

**D3: A `context` map / plain object `Record<string, unknown>`**
Fully dynamic — no static typing.

Rejected because: the project's commitment to type safety (no `any` on the public surface) rules this out. The SDK would need to cast from `unknown` at every access point, defeating the purpose of TypeScript.

**D4: Callback injection at `Agent` construction**
The `Agent` constructor accepts a `buildContext: () => ToolCallContext` function. The engine calls it per tool invocation.

Rejected because: this adds API surface at the `Agent` layer (a core type) to accommodate an SDK concern. The core should have no knowledge of how to build a richer context; interface merging keeps the construction point in the core (`{}`) and the type definition in the SDK (merged interface), with no core API change.

---

## E. `Terminal` surfacing under `for await`

### Context

JavaScript's `for await...of` loop cannot read the generator's return value. The original brainstorm draft showed `await gen.return()` — which does not work: `.return(x)` terminates the generator but does not execute the generator body's `return` statement. The generator's own return value is inaccessible without `.next()` driving.

### The solution adopted

Yield the terminal information as the last `AgentEvent` before the generator's `return`. The terminal event carries `messages: Message[]` (and `error`, `turnsUsed` where applicable). The generator ALSO returns an equivalent `Terminal` value for callers who drive `.next()` manually. The two representations carry identical data — the event is the ergonomic path for `for await` consumers, the return value is for advanced callers.

This matches exactly how the reference's `query()` works: it yields `Message` objects (the final assistant message) as events while also returning a `Terminal` via the typed return value.

### Alternative considered: callback-based completion

The `run()` method accepts an `onComplete: (terminal: Terminal) => void` callback alongside the generator return. Rejected: callbacks break the single-surface design and require the consumer to synchronize with both the event stream and the callback.

---

## F. Env context caching strategy

### Context

`buildEnvContext(platform)` calls `platform.exec("git ...")` which has non-trivial latency (spawning a process). Should this be memoized?

### Considered options

**F1: No caching (call per `run()`)** (adopted for M1)
Simple. Ensures that if the cwd changes between runs, the context is fresh. The cost is one process spawn per agent run (not per turn — the env context is built once at the start of `run()` and included in the system prompt for the entire run). For a developer running 5–10 agent calls in a session, this is acceptable.

**F2: Memoize in `Agent` per process lifetime**
One call per `Agent` instance. Cheaper but stale if cwd changes.

**F3: Memoize in `Agent` with a TTL (e.g., 10 seconds)**
Adds clock dependency and complexity.

The reference (`context.ts`) memoizes per session (via `lodash.memoize`), clearing the cache on `/clear`. This is the correct behavior for a long-running REPL session where git status should not be re-queried on every keystroke. For our stateless `Agent.run()`, the SDK's `Session` wrapper is the right place to add cross-run memoization. The core does not need it.

---

## G. Message type: own type vs. importing from `@anthropic-ai/sdk`

### Context

The Anthropic SDK exports `Anthropic.MessageParam` which describes the same structure as our `Message` type. Should we import it directly?

### Decision

Define our own `Message` type in `types/messages.ts`. Do not import from `@anthropic-ai/sdk` in the core types.

Rationale: importing `@anthropic-ai/sdk` types into the core's canonical types would make the SDK a hard dependency of the core package — even for consumers who use a different provider (OpenAI, or a future provider). The core's `Message` type must be provider-agnostic. The `anthropic-mapper.ts` is the translation layer; it performs the structural cast between `Message` and `Anthropic.MessageParam`. Since the shapes are structurally compatible (same field names and types), the cast is safe and TypeScript's structural subtyping makes it trivial.

---

## H. `ProviderRequest` tool schema: include or exclude disabled tools

### Context

Should the `ToolSchema[]` in `ProviderRequest` include all registered tools, or should some be filtered?

### Decision for M1

Include all tools. The `ToolRegistry.toSchemas()` method serializes all tools passed to the `Agent` constructor into `ToolSchema[]`, and all are included in every `ProviderRequest`. No filtering in M1.

Future consideration: in M2+, when tools have permission modes or the SDK adds deferred tool loading (reference's `ToolSearch`), the registry will support filtering. This is not needed in M1 where all tools are always enabled.

---

*Exploration complete. These rejected designs are the historical record for this milestone. Future milestones (M2: OpenAI provider, permission seam; M3+: sub-agents) will add their own exploration docs.*

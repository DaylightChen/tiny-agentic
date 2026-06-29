# Task 02 — OpenAIProvider, packaging, and exports

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Implement `packages/core/src/providers/openai.ts` — the `OpenAIProvider` class that wires the task-01 mapper to the `openai` SDK behind the existing `Provider` interface — and make it shippable and importable:

- Add `openai` as an **optional peer dependency** (`peerDependencies` + `peerDependenciesMeta.optional: true`) and a `devDependency` (so tests can mock it), plus a `./providers/openai` export sub-path, in `packages/core/package.json`. Exact mirror of the `@anthropic-ai/sdk` entries.
- Add a `"providers/openai": "src/providers/openai.ts"` build entry in `packages/core/tsup.config.ts`, mirroring the `providers/anthropic` entry.
- **Do not touch `packages/core/src/index.ts`** — it must stay free of any `openai` import so an Anthropic-only consumer installs nothing extra and gets no warning.
- Write the mock-SDK provider test suite `packages/core/src/__tests__/openai.test.ts`, mirroring `anthropic.test.ts`.

At the end of this task, a developer can `pnpm add openai`, `import { OpenAIProvider } from "tiny-agentic/providers/openai"`, construct `new OpenAIProvider({ apiKey, model, baseURL?, maxRetries?, maxTokens?, logger? })`, and pass it to `new Agent({ provider, ... })` with zero other code changes — the M2 proof that the `Provider` seam holds for a genuinely different backend.

## Context files

Read these before starting:

- `docs/feature/openai-provider/engineering/2026-06-29-openai-provider-engineering.md` — primary input. Specifically:
  - §"OpenAIProvider class — wiring detail" (the full class skeleton: constructor guards/defaults, `signal` as 2nd arg, `maxRetries` to `new OpenAI`, `request_sent` logger hook, the trailing `accumulator.flush()`)
  - §"Architectural fit" (the `package.json` / `tsup.config.ts` edits; `index.ts` unchanged)
  - §"New interfaces / contracts" (the `OpenAIProviderOptions` shape and defaults)
  - §"Success criteria" (functional + non-functional bullets — the acceptance criteria trace to these)
- `docs/feature/openai-provider/decisions.md` — LOCKED: `maxRetries` default 3 (not the SDK's native 2); expose `baseURL` (Azure out of scope); `maxTokens` default 32000.
- `docs/feature/openai-provider/plan/implementation-plan.md` — §"Open questions": the `openai` peer-dep version range is a residual **implement-time pin**. The spec floated `^4.x` but that is stale; the current `openai` major is **6.x**. Pin the major available now (run `npm view openai version` to confirm; expected `^6.0.0`) in both `peerDependencies` and `devDependencies`, and confirm the chunk shape (`tool_calls[].index`, `delta.content`, `finish_reason`) and `max_completion_tokens` field match that major before finalizing.
- `packages/core/src/providers/openai-mapper.ts` (task-01 output) — imports `mapRequest`, `translateChunk`, `ToolCallAccumulator`. **Do not modify it.**
- `packages/core/src/providers/anthropic.ts` — the class this mirrors exactly. Copy its structure: constructor guard (`:22-25`), defaults + conditional logger assignment (`:26-31`), conditional `baseURL` spread for `exactOptionalPropertyTypes` (`:34-38`), the `request_sent` logger hook before the call (`:46`), `signal` as 2nd arg (`:53`), the no-`withRetry` comment (`:4`, `:50-52`). The one structural difference: a trailing `for (const ev of accumulator.flush()) yield ev;` after the `for await` loop, because OpenAI has no terminal event.
- `packages/core/src/__tests__/anthropic.test.ts` — the test file this mirrors. Copy its `vi.mock` hoisting pattern (`:8-29`), the `drain` helper (`:32-36`), the 7.14 logger-off test (`:47-64`), the logger-fires test (`:66-75`), the AbortSignal-passthrough test (`:77-90`), and the constructor-validation tests (`:92-106`).
- `packages/core/src/types/provider.ts` — `Provider`, `ProviderRequest`, `ProviderEvent`, `Logger` (`:48-65`). **Do not modify.**
- `packages/core/package.json` — current `@anthropic-ai/sdk` entries to mirror: `exports` (`:15-18`), `peerDependencies` (`:37-40`), `peerDependenciesMeta` (`:41-45`), `devDependencies` (`:46-52`).
- `packages/core/tsup.config.ts` — current `providers/anthropic` entry (`:6`) to mirror.
- `packages/core/src/index.ts` — confirm it does **not** and must **not** import `providers/openai` (mirror of how it omits `providers/anthropic`, `:7-18`).

## Downstream dependencies

This is the final task of the feature; nothing downstream in this scope depends on it. But preserve these contracts for future work and for API parity:

- `OpenAIProvider` `implements Provider` — the constructor signature and `stream(request, signal?)` shape must stay assignable to `Provider` (TypeScript enforces via `implements`).
- `OpenAIProviderOptions` must be field-for-field parallel to `AnthropicProviderOptions` (`apiKey`, `model`, optional `maxRetries`/`baseURL`/`maxTokens`/`logger`) so a developer's mental model transfers (spec §Accessibility — "API ergonomic parity").
- The `./providers/openai` export sub-path and the `tsup` `providers/openai` build entry are the public import surface — keep their paths exactly as specified.

## Steps

1. **Edit `packages/core/package.json`** — mirror the `@anthropic-ai/sdk` arrangement exactly:
   - Add to `exports` (after the `./providers/anthropic` block):
     ```json
     "./providers/openai": {
       "import": "./dist/providers/openai.js",
       "types": "./dist/providers/openai.d.ts"
     },
     ```
   - Add `"openai": "<pinned-range>"` to `peerDependencies` (alongside `@anthropic-ai/sdk`).
   - Add an `"openai": { "optional": true }` entry to `peerDependenciesMeta`.
   - Add `"openai": "<pinned-range>"` to `devDependencies`.
   - `<pinned-range>`: run `npm view openai version`, pin the current major as `^<major>.0.0` (expected `^6.0.0` at planning time). Use the **same** range in both `peerDependencies` and `devDependencies`.
   - Run `pnpm install` so the new `devDependency` is present for the test/typecheck steps.

2. **Edit `packages/core/tsup.config.ts`** — add to the `entry` map, after the `providers/anthropic` line:
   ```ts
   "providers/openai": "src/providers/openai.ts",
   ```

3. **Create `packages/core/src/providers/openai.ts`** — implement per the spec's §"OpenAIProvider class — wiring detail". Mirror `anthropic.ts:15-61`:
   ```ts
   import OpenAI from "openai";
   import type { Provider, ProviderRequest, ProviderEvent, Logger } from "../types/provider.js";
   import { mapRequest, translateChunk, ToolCallAccumulator } from "./openai-mapper.js";
   // withRetry is NOT imported — the OpenAI SDK retries internally via maxRetries.

   export type OpenAIProviderOptions = {
     apiKey: string;
     model: string;
     maxRetries?: number; // default: 3 (LOCKED — match Anthropic, not the SDK's native 2)
     baseURL?: string;    // LOCKED — exposed; covers OpenAI-compatible endpoints
     maxTokens?: number;  // default: 32000 (LOCKED — mirrors Anthropic)
     logger?: Logger;
   };

   export class OpenAIProvider implements Provider {
     private readonly client: OpenAI;
     private readonly model: string;
     private readonly maxRetries: number;
     private readonly maxTokens: number;
     private readonly logger?: Logger;

     constructor(options: OpenAIProviderOptions) {
       if (!options.apiKey) throw new Error("OpenAIProvider: OPENAI_API_KEY is required");
       this.maxRetries = options.maxRetries ?? 3;
       this.maxTokens  = options.maxTokens  ?? 32000;
       if (options.logger) this.logger = options.logger; // exactOptionalPropertyTypes: assign only when present
       this.model = options.model;
       this.client = new OpenAI({
         apiKey: options.apiKey,
         maxRetries: this.maxRetries,                          // SDK owns retry
         ...(options.baseURL ? { baseURL: options.baseURL } : {}), // conditional spread — never pass baseURL: undefined
       });
     }

     async *stream(request: ProviderRequest, signal?: AbortSignal): AsyncGenerator<ProviderEvent> {
       const params = mapRequest(request, this.model, this.maxTokens);
       this.logger?.({ level: "info", event: "request_sent", request });
       const accumulator = new ToolCallAccumulator();

       const rawStream = await this.client.chat.completions.create(
         { ...params, stream: true },
         { signal },                                           // AbortSignal as 2nd arg (mirror anthropic.ts:53)
       );

       for await (const chunk of rawStream) {
         for (const ev of translateChunk(chunk, accumulator)) yield ev;
       }
       // OpenAI has no terminal event — flush the synthesized message_stop (+ any
       // accumulated tool_use) after the iterator ends.
       for (const ev of accumulator.flush()) yield ev;
     }
   }
   ```
   Wiring specifics that are load-bearing:
   - **`await` the `create` call.** Unlike Anthropic's `messages.stream()` (sync-returning), `client.chat.completions.create({ stream: true })` returns a `Promise<Stream<...>>`, so it must be `await`ed before the `for await`. Verify the SDK's actual return shape for the pinned major and note any deviation in the completion doc.
   - **`signal`** is the second argument to `create(params, { signal })` (the `fetch`-style request-options convention).
   - **`maxRetries`** goes only to `new OpenAI({ maxRetries })`; the SDK owns retry. Do **not** wrap in `withRetry`, do **not** import it.
   - **`request_sent`** logger hook fires once, before the `create` call. There is no per-retry hook (SDK limitation) — `retry_attempt` is not emitted on this path.
   - **`exactOptionalPropertyTypes`** — assign `logger` only when present; spread `baseURL` conditionally. Never pass an explicit `undefined`.
   - Do **not** request `stream_options.include_usage`, `n`, or any sampling param.

4. **Create `packages/core/src/__tests__/openai.test.ts`** — mirror `anthropic.test.ts`. Hoisted `vi.mock("openai", ...)` returning a default-exported class whose `chat.completions.create` returns an async-iterable of OpenAI-shaped chunks (capture the call args in a spy to assert signal passthrough). Because `create` is `await`ed in the provider, the mock's `create` should be an `async` function (or return a resolved promise of) the async-iterable. Sketch:
   ```ts
   import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
   import type { ProviderEvent } from "../types/provider.js";

   const createSpy = vi.fn();

   vi.mock("openai", () => {
     async function* fakeStream() {
       yield { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] };
       yield { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
     }
     return {
       default: class {
         chat = {
           completions: {
             create: async (...args: unknown[]) => { createSpy(...args); return fakeStream(); },
           },
         };
       },
     };
   });

   import { OpenAIProvider } from "../providers/openai.js";
   ```
   Test cases (mirror `anthropic.test.ts` plus OpenAI-specific ones):
   - **Logger off by default (success criterion / 7.14 parity):** construct `new OpenAIProvider({ apiKey: "k", model: "m" })` (no logger); spy `console.log`/`.error`/`.warn`; drain `stream({ systemPrompt: "", messages: [], tools: [] })`. Assert the drained events contain a `message_stop` (stream ran to completion through the trailing flush) **and** zero console calls.
   - **Logger fires:** with `logger: vi.fn()`, drain a stream; assert the logger was called with `expect.objectContaining({ event: "request_sent" })`.
   - **AbortSignal passthrough:** pass `controller.signal` to `stream(...)`; assert `createSpy` was called once and its **second** argument matches `{ signal: controller.signal }`. (Mirror `anthropic.test.ts:77-90`; States matrix: Partial.)
   - **maxRetries default + passthrough:** assert (via a spy on the mocked `OpenAI` constructor, or by capturing constructor args in the mock) that `new OpenAI` received `maxRetries: 3` when no `maxRetries` option is given, and the overridden value when one is. (Success criterion: `maxRetries` defaults to 3 and is passed to `new OpenAI`.)
   - **baseURL conditional:** when `baseURL` is provided, the mocked `OpenAI` constructor receives it; when absent, the constructor options object has **no** `baseURL` key (not `baseURL: undefined`). (Success criterion.)
   - **Constructor validation:** `new OpenAIProvider({ apiKey: "", model: "m" })` throws `"OpenAIProvider: OPENAI_API_KEY is required"`; same for `apiKey: undefined as unknown as string`.
   - **End-to-end equivalence (mock SDK):** drive four scenarios through `stream()` and assert the emitted `ProviderEvent` sequence matches the equivalent Anthropic-path expectation — (a) a text-only turn → `text_delta`(s) then one `message_stop`; (b) a single tool call → `tool_use` then `message_stop`; (c) two concurrent tool calls → two `tool_use` (ascending index) then `message_stop`; (d) a malformed-arguments tool call → `tool_use` with `inputParseError: true` and `input` `{}` then `message_stop`. (Success criterion: "same `AgentEvent` sequence as the Anthropic path for an equivalent scenario.")
   - **Error propagation (States matrix: Error):** make the mocked `create` (or its iterator) throw; assert `stream()` lets the error propagate (the generator throws) rather than swallowing it — the loop's `try/catch` turns it into `agent_error`, which is out of scope to re-test here.

   Adjust the mock's yielded chunk fixtures per scenario (parametrize `fakeStream` or use multiple `vi.mock` factories / `mockImplementation` resets in `beforeEach`).

5. **Create `examples/openai-run.ts`** — the OpenAI counterpart to `examples/basic-run.ts`. Mirror that file's structure exactly (same turns: simple Q&A, multi-turn continuation, tool use reading a file, `collectText` demo, same `AgentEvent` switch handling), changing only the provider wiring:
   - Header comment: `Run: OPENAI_API_KEY=<key> pnpm tsx examples/openai-run.ts` + the `Not run in CI — requires a real OpenAI API key.` note (mirror `basic-run.ts:1-10`).
   - `import { OpenAIProvider } from "tiny-agentic/providers/openai";`
   - Read `process.env["OPENAI_API_KEY"]`, error + `process.exit(1)` if absent (mirror `basic-run.ts:17-21`). **Do not hardcode a key.**
   - `new OpenAIProvider({ apiKey, model: "gpt-4o-mini", logger: ... })` — use a currently-valid Chat Completions model id; comment that any valid model works, including reasoning models (o-series / GPT-5), since `maxTokens` maps to `max_completion_tokens`. Keep the same `request_sent` logger as `basic-run.ts:30-34`.
   - Turn-3 tool-use prompt references `examples/openai-run.ts` (the file reading itself).
   - Not run in CI and not part of any test; imports must resolve against the built `./providers/openai` export. (If `examples/` is in the workspace `tsc` include, it must also typecheck.)

6. **Verify the UI-free / index-clean boundary (non-functional success criteria):**
   - `grep -rn "openai" packages/core/src/index.ts` returns nothing — `index.ts` does not import the provider.
   - Confirm neither `openai.ts` nor `openai-mapper.ts` imports any TUI/CLI/UI module (only `openai`, the mapper, and canonical framework types).
   - Build and confirm the new entry exists: `pnpm --filter tiny-agentic build` produces `dist/providers/openai.js` and `dist/providers/openai.d.ts`.

7. **Run the full gate:**
   - `pnpm --filter tiny-agentic test` — all `openai.test.ts` tests green, all prior tests (Anthropic, mapper, loop, etc.) still green (no regression).
   - `pnpm --filter tiny-agentic typecheck` — exits 0 under `exactOptionalPropertyTypes`.
   - `pnpm --filter tiny-agentic build` — succeeds with the new `providers/openai` entry.

## Acceptance criteria

- [ ] `pnpm --filter tiny-agentic test` passes with all `openai.test.ts` tests green and **no regression** in any prior test suite.
- [ ] `pnpm --filter tiny-agentic typecheck` exits 0 under `exactOptionalPropertyTypes`.
- [ ] `pnpm --filter tiny-agentic build` succeeds and emits `packages/core/dist/providers/openai.js` and `.d.ts`.
- [ ] `new OpenAIProvider({ apiKey: "", model: "m" })` throws `"OpenAIProvider: OPENAI_API_KEY is required"` (verified in `openai.test.ts`).
- [ ] With no logger, draining `stream()` produces a `message_stop` and **zero** console output; with a logger, `request_sent` fires.
- [ ] `stream()` passes `signal` as the second argument to `chat.completions.create` (verified via `createSpy`).
- [ ] `maxRetries` defaults to 3 and is passed to `new OpenAI({ maxRetries })`; `baseURL` is threaded only when provided (no `baseURL: undefined`).
- [ ] The mock-SDK end-to-end test yields the expected `ProviderEvent` sequence for text-only, single-tool, multi-tool, and parse-error scenarios.
- [ ] `OpenAIProvider` does **not** import or call `withRetry`, `runTools`, or `chat.completions.stream()`/`.runTools()` — verify: `grep -n "withRetry\|runTools\|\.stream(" packages/core/src/providers/openai.ts` returns nothing.
- [ ] `index.ts` is unchanged and imports no `openai` — `grep -n "openai" packages/core/src/index.ts` returns nothing.
- [ ] `package.json` has `openai` in `peerDependencies`, `peerDependenciesMeta.openai.optional: true`, and `devDependencies` (same pinned range), plus the `./providers/openai` export; `tsup.config.ts` has the `providers/openai` entry.
- [ ] `examples/openai-run.ts` exists, mirrors `examples/basic-run.ts`, imports `OpenAIProvider` from `tiny-agentic/providers/openai`, reads `OPENAI_API_KEY` from the env (no hardcoded key), and its imports resolve.

## Output files

- Created: `packages/core/src/providers/openai.ts`
- Created: `packages/core/src/__tests__/openai.test.ts`
- Modified: `packages/core/package.json` (openai peer dep + optional meta + devDep + `./providers/openai` export)
- Modified: `packages/core/tsup.config.ts` (added `providers/openai` build entry)
- Created: `examples/openai-run.ts` (OpenAI counterpart to `examples/basic-run.ts`)
- Modified: `pnpm-lock.yaml` (from `pnpm install` after adding the `openai` devDependency)

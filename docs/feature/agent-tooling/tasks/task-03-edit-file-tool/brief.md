# Task 03 — `edit_file` Tool

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

Implement the `editFileTool` built-in in `packages/core/src/tools/builtin/editFile.ts` and its unit test suite in `packages/core/src/__tests__/editFile.test.ts`.

`editFileTool` lets the model make surgical string-replacement edits to files. It enforces uniqueness (a single `old_string` match unless `replace_all: true`), handles file creation (empty `old_string` + missing file = create), and returns exact error strings for every failure path. All file access goes through the injected `Platform`; no direct `fs` imports.

At the end of this task, `packages/core/src/tools/builtin/editFile.ts` exists, all `editFile.test.ts` tests pass, and all 140 prior tests continue to pass. The file is not yet exported from `index.ts` (that is task-05).

## Context files

- `packages/core/src/tools/builtin/readFile.ts` — canonical `defineTool` pattern
- `packages/core/src/tools/builtin/writeFile.ts` — canonical pattern with read-modify-write logic (note: `writeFile` calls `platform.readFile` inside `call` — same approach)
- `packages/core/src/__tests__/builtin-tools.test.ts` — `MockPlatform` pattern with ENOENT simulation
- `packages/core/src/types/tool.ts` — current state after task-01 (has `signal?: AbortSignal`; `editFile` does not use it)
- `docs/feature/agent-tooling/engineering/2026-06-29-agent-tooling-engineering.md` — §8.2 (full `edit_file` input schema and execution contract in detail — the 4-step ordered logic), §3.2 (states matrix for `edit_file`), §3.4 (edge cases), §3.5 (exact microcopy strings), §9 (engineering edge cases), §12 (test strategy for `editFile.test.ts`)

## Downstream dependencies

- **Task-05 (wiring and exports)** imports `editFileTool` from `tools/builtin/editFile.ts` and re-exports it from `index.ts`. Keep the named export `editFileTool` stable.
- **Task-04 (permission gate)** calls `tool.call` for `editFile` after the gate; `editFile.ts` is independent of the gate.

## Steps

1. **Create `packages/core/src/tools/builtin/editFile.ts`**. The tool must:

   - Use `defineTool` from `../../types/tool.js` and `z` from `zod`.
   - **Input schema** (exact fields per spec §8.2):
     ```ts
     z.object({
       file_path: z.string().describe("Absolute or relative path to the file."),
       old_string: z.string().describe("Exact text to find and replace. Empty string creates the file."),
       new_string: z.string().describe("Text to replace old_string with."),
       replace_all: z.boolean().default(false).optional()
         .describe("If true, replace all occurrences. If false (default), old_string must appear exactly once."),
     })
     ```
   - **Tool description**: `"Make a targeted edit to a file by replacing an exact string. old_string must match exactly once (unless replace_all is true). An empty old_string creates the file if it does not exist."`
   - **`call` implementation** — implement the four steps in this exact order (spec §8.2):

     **Step 1 — No-op guard** (before any file I/O):
     ```ts
     if (input.old_string === input.new_string) {
       throw new Error("No changes to make — old_string and new_string are identical.");
     }
     ```

     **Step 2 — File creation path** (empty `old_string`):
     ```ts
     if (input.old_string === "") {
       // Try to read the file. If it throws (ENOENT), the file doesn't exist → create it.
       try {
         await platform.readFile(input.file_path);
         // File exists — reject:
         throw new Error("old_string must not be empty when the file already exists.");
       } catch (err) {
         if (err instanceof Error && err.message.includes("old_string must not be empty")) {
           throw err; // re-throw our own error, not ENOENT
         }
         // Any other error = file missing (ENOENT). Create it:
         await platform.writeFile(input.file_path, input.new_string);
         return { edited: true, path: input.file_path };
       }
     }
     ```

     **Step 3 — Normal edit path** (non-empty `old_string`):
     ```ts
     // Check file existence:
     let content: string;
     try {
       content = await platform.readFile(input.file_path);
     } catch {
       throw new Error("File does not exist.");
     }
     // Count occurrences (exact substring, no regex):
     const count = content.split(input.old_string).length - 1;
     if (count === 0) {
       throw new Error("String to replace not found in file.");
     }
     if (count > 1 && !input.replace_all) {
       throw new Error(
         `Found ${count} matches of old_string but replace_all is false. Provide more context to make the match unique.`
       );
     }
     // Perform replacement:
     const newContent = input.replace_all
       ? content.split(input.old_string).join(input.new_string)
       : content.replace(input.old_string, input.new_string); // replaces first occurrence
     await platform.writeFile(input.file_path, newContent);
     return { edited: true, path: input.file_path };
     ```

   - All `throw new Error(...)` calls are caught by `runTools`'s try/catch and become `isError: true` tool results. This is the correct pattern — do not wrap in try/catch inside `call`.

2. **Create `packages/core/src/__tests__/editFile.test.ts`**. Use the `MockPlatform` pattern from `builtin-tools.test.ts` (the `Map`-backed platform with ENOENT for missing files). Call `editFileTool.call(input, platform, ctx)` directly; no need for `runTools`.

   Required test cases (per spec §12 test strategy):
   - **Unique match** — file has `"hello world"`, `old_string: "world"`, `new_string: "earth"` → `writeFile` called with `"hello earth"`, returns `{ edited: true, path }`.
   - **No match** — `old_string: "xyz"` not in file → throws / rejects with `"String to replace not found in file."`.
   - **Two matches, `replace_all: false`** — file has `"aXbXc"`, `old_string: "X"` → rejects with `"Found 2 matches of old_string but replace_all is false. Provide more context to make the match unique."`.
   - **Two matches, `replace_all: true`** — same file → `writeFile` called with `"a_b_c"` (both replaced), returns `{ edited: true, path }`.
   - **`old_string === new_string`** — rejects with `"No changes to make — old_string and new_string are identical."`. `readFile` must NOT be called (verify via spy).
   - **`old_string === ""`, file missing** — platform's `readFile` throws ENOENT → `writeFile` called with `new_string` as full content, returns `{ edited: true, path }`.
   - **`old_string === ""`, file exists** — rejects with `"old_string must not be empty when the file already exists."`. `writeFile` must NOT be called.
   - **File missing, non-empty `old_string`** — platform's `readFile` throws ENOENT → rejects with `"File does not exist."`.
   - **Input schema validation** — `z.object` requires `file_path`, `old_string`, `new_string`; `replace_all` defaults to `false`. Verify `safeParse` accepts valid input and rejects missing required fields.

3. **Run `pnpm test`** from `packages/core`. All 140 existing tests plus new `editFile.test.ts` tests must pass.

4. **Run `pnpm typecheck`** from `packages/core`. Zero errors expected.

5. **Verify the boundary** — `editFile.ts` must have no direct `fs`/`process` imports:
   ```
   grep -n "child_process\|require('fs')\|from 'fs'\|from \"fs\"\|process\." packages/core/src/tools/builtin/editFile.ts
   ```
   Expected: no matches.

## Acceptance criteria

- [ ] `pnpm test` (in `packages/core`) passes: all prior tests still pass, plus `editFile.test.ts` tests.
- [ ] `pnpm typecheck` reports zero errors.
- [ ] `editFileTool.name` is `"edit_file"` (verified by import in test).
- [ ] Unique match: `writeFile` is called with correct replaced content, returns `{ edited: true, path }` (asserted in `editFile.test.ts`).
- [ ] No match: rejects with `"String to replace not found in file."` (asserted in `editFile.test.ts`).
- [ ] Two matches, `replace_all: false`: rejects with `"Found 2 matches of old_string but replace_all is false. Provide more context to make the match unique."` (asserted in `editFile.test.ts`).
- [ ] Two matches, `replace_all: true`: both occurrences replaced, single `writeFile` call (asserted in `editFile.test.ts`).
- [ ] `old_string === new_string`: rejects with `"No changes to make — old_string and new_string are identical."`, `readFile` never called (asserted in `editFile.test.ts`).
- [ ] `old_string === ""`, file missing: `writeFile` called with `new_string`, returns `{ edited: true, path }` (asserted in `editFile.test.ts`).
- [ ] `old_string === ""`, file exists: rejects with `"old_string must not be empty when the file already exists."` (asserted in `editFile.test.ts`).
- [ ] File missing, non-empty `old_string`: rejects with `"File does not exist."` (asserted in `editFile.test.ts`).
- [ ] `editFile.ts` has no direct `fs`/`process` imports (verified by grep in step 5).

## Output files

- Created: `packages/core/src/tools/builtin/editFile.ts`
- Created: `packages/core/src/__tests__/editFile.test.ts`

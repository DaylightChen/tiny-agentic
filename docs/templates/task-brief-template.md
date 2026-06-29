# Task NN — [Name]

> Written in the plan phase. Immutable during implement-phase execution. An agent with zero prior context must be able to execute this task by reading only this file and the files it references.

## Goal

[1-2 paragraphs: what this task builds and why it matters in the larger system. Be concrete about the outcome — describe the artifact (file, module, behavior) that exists at the end of this task that did not exist at the start.]

## Context files

[Exact file paths the agent should read before starting. Not "read the codebase" — the specific files that carry the contracts, conventions, or upstream output this task builds on.]

- `path/to/file.ts` — why it matters
- `docs/project/engineering/spec.md#section` — relevant section of the engineering spec

## Downstream dependencies

[What later tasks will depend on from this task's output — specific interfaces, file paths, or behaviors that must be preserved. This gives the implementer and tester just enough big picture to avoid breaking downstream work without loading the full plan.]

- Task NN+1 will import `Foo` from `path/to/file.ts` — keep the exported shape stable
- Task NN+3 expects `serialize()` to be deterministic for a given input

## Steps

[Bite-sized steps with exact file paths and code sketches where useful. Each step should be a verifiable unit of work.]

1. **[Step name]** — [What to do, which files to touch, key decisions baked in]
2. **[Step name]** — ...
3. ...

## Acceptance criteria

[Verifiable conditions that define "done" — test commands with expected output, not subjective judgment.]

- [ ] `<test command>` passes with [expected output]
- [ ] `<type-check command>` reports no errors
- [ ] Manually: [observable behavior that can be checked]

## Output files

[Which files are created or modified by this task. The reviewer uses this list to bound the diff.]

- Created: `path/to/new-file.ts`
- Modified: `path/to/existing-file.ts`

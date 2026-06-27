# Execution Methodology

> Defines how the `implement` phase executes tasks. Used by the orchestrator and sub-agents during implementation.

## 1. Per-Task Dev Loop

Each task follows a repeating development loop. A task may go through multiple cycles of this loop until all acceptance criteria are met.

```
implement → test → code review → fix
    ↑                               |
    └───────────────────────────────┘
```

### 1.1 Stages

1. **Implement** — Write the production code as specified in the task steps. The implementer focuses solely on writing correct, clean implementation code. It does not write or run tests.

2. **Test** — A separate agent writes tests for the implementation and runs the full test suite. This includes:
   - Writing new tests that cover the task's acceptance criteria
   - Running new tests and all existing tests
   - Reporting failures with specifics (which test, what failed, expected vs actual)

3. **Code review** — A separate agent reviews the implementation and tests against:
   - The task's acceptance criteria
   - Code quality (DRY, YAGNI, no unnecessary abstractions)
   - Test coverage and test quality
   - Consistency with existing codebase patterns
   - No regressions in existing functionality

4. **Fix** — Address any issues found during testing or code review. The implementer receives the specific failures and review feedback, makes targeted fixes, then the test and review stages run again.

### 1.2 Loop Termination

The loop ends when **either**:

- All acceptance criteria pass, all tests pass (new and existing), and code review finds no issues — changes are then committed; **or**
- The iteration cap is reached (see §1.3) and the orchestrator escalates to the user.

### 1.3 Iteration cap

The dev loop is bounded at **5 iterations**. If iteration 5 ends without reviewer approval, the orchestrator stops and escalates rather than looping further. Repeated failures past 5 iterations almost always mean the task brief or upstream design is wrong, not that one more loop will resolve it. The orchestrator records an Escalation section in `log.md` and surfaces concrete options to the user:

- **Revise the brief** — the planner's spec for this task may be wrong
- **Revise upstream design** — the engineering spec / UX spec may be wrong
- **Defer to `docs/known-issues.md`** and proceed (only acceptable for non-blocking issues)
- **Force-approve and commit** — only if the user explicitly decides the recurring finding is bikeshedding

See §3 for the escalation protocol.

### 1.4 Commit Discipline

- Commit at the end of each completed task
- Commit message references the task number and summarizes what was built
- All tests must pass before committing

## 2. Sub-Agent Driven Development

Each task is executed by fresh sub-agents. This provides:

- **Clean context** — each agent starts with only the task document and referenced files, not accumulated conversation history
- **Focused execution** — each agent works on one concern at a time with clear boundaries
- **Independent review** — the code review stage uses a separate sub-agent that evaluates the work without implementation bias

### 2.1 Agent Roles

| Role | Responsibility |
|------|---------------|
| **Orchestrator** (main session) | Dispatches agents, coordinates the dev loop, decides whether to proceed or iterate, commits |
| **Implementer** (sub-agent) | Writes production code for a single task. Does not write or run tests. |
| **Tester** (sub-agent) | Writes tests for the implementation, runs the full test suite, reports results |
| **Reviewer** (sub-agent) | Reviews implementation and tests against task criteria and code quality standards |

### 2.2 Context Levels by Agent Role

Not every agent needs the same amount of context. The task document serves all three roles, but they read different sections:

| Agent | What it reads |
|-------|---------------|
| **Implementer** | Goal, context files, steps, downstream dependencies. Knows what it's building, what contracts to honor, and what later tasks depend on. |
| **Tester** | Goal, acceptance criteria, downstream dependencies, output files. Knows what to verify, what integration points to protect, and what invariants downstream tasks assume. |
| **Reviewer** | Everything above, plus the **full implementation plan** (`docs/plan/`). The reviewer is the only agent that sees the big picture. Its job is to catch decisions that satisfy this task but create problems for later tasks. |

### 2.3 Handoff Protocol

1. Orchestrator dispatches the **implementer** with the task document
2. Implementer writes production code and reports what was built
3. Orchestrator dispatches the **tester** with the task document and the files changed
4. Tester writes tests, runs the full suite, and reports pass/fail results
5. If tests fail: orchestrator dispatches a new **implementer** with the failure details to fix
6. If tests pass: orchestrator dispatches the **reviewer** with the diff, tests, and task criteria
7. If reviewer finds issues: orchestrator dispatches a new **implementer** to fix, then re-tests and re-reviews
8. If reviewer approves: orchestrator commits and moves to the next task

## 3. Escalation Protocol

If a task discovers a problem that cannot be resolved within its own scope:

1. **Stop implementation** — do not hack around it or make assumptions
2. **Document the issue** — what specifically broke, why, and what upstream task or design decision is affected
3. **Flag to the user** — the orchestrator surfaces the issue for human decision before proceeding

Examples of cross-boundary issues:
- A library API doesn't behave as the engineering spec assumed
- A data structure from an earlier task doesn't support an operation this task needs
- A performance problem that requires architectural changes

## 4. Verification Before Completion

Before marking any task as complete:

1. Run all tests and confirm green output
2. Run type checking (e.g., `tsc --noEmit`) and confirm no errors
3. Manually verify the acceptance criteria listed in the task document
4. Ensure no regressions in previously completed functionality

Evidence (actual command output) is required before claiming success. "It should work" is not acceptable.

## 5. Task Directory Structure

Each task lives in its own directory under `docs/tasks/`:

```
docs/tasks/task-NN-name/
├── brief.md    # The task plan (goal, steps, criteria) — immutable during execution
└── log.md      # Execution log — created at task start, filled during implementation
```

**`brief.md`** is the task plan written in the plan phase. It stays clean and unmodified during execution. This is what agents read.

**`log.md`** is created when execution begins by copying the template from `docs/templates/log-template.md`. It is the only file that gets written to during execution.

## 6. Documentation During Implementation

The execution log (`log.md`) captures everything that happens during a task's dev loop. It is structured by iteration, with each iteration recording the implement, test, and review stages.

What must be captured:

- **Actual command output** — paste real test runner and type-check output, not summaries. "All tests pass" is not evidence; the output is.
- **Specific test failures** — which test, expected vs actual, not just pass/fail counts.
- **Decisions made during implementation** that weren't specified in the brief.
- **Deviations from the plan** — what was done differently, and why. Captured in the iteration where the deviation occurred, not just at the end.
- **Issues encountered and how they were resolved** — including dead ends and approaches that were tried and abandoned.
- **Escalations** — cross-boundary problems that required user input (see Section 3).
- **Per-criterion verification** — the Completion section lists every acceptance criterion from the brief with evidence of how it was verified.

See `docs/templates/log-template.md` for the full template with all required sections.

### 7. Completion Marker

When a task's dev loop finishes and the commit lands, the orchestrator writes a `completion.md` file in the task directory. This file marks the task as done and is required by the implement phase's `outputCheck` — without it, `/phased-dev:advance-phase` cannot verify the implement phase is complete.

The file uses **YAML frontmatter** for machine-readable fields (`status`, `commit`, `completedAt`, `iterations`) and a short prose body for human readers. The frontmatter is the canonical record — commands and tooling read it without parsing markdown. See `docs/templates/task-completion-template.md` for the template.

This ensures future sessions can understand not just what was built, but how and why.

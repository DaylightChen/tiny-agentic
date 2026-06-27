# Planning Methodology

> Defines how the `plan` phase structures and organizes tasks. Used by the planner to produce the implementation plan.

## 1. Execution Model: Sequential

Tasks execute one at a time, strictly in order. The committed output of task N is the starting state for task N+1.

**Why sequential over parallel:**

- **No merge conflicts** — only one task modifies the codebase at a time
- **No interface drift** — each task codes against real, committed output of the previous task, not against an interface contract that may diverge from reality
- **Simpler context handoff** — the codebase *is* the context; no need to reconcile branches
- **Early problem detection** — each task validates assumptions from previous tasks; design issues surface immediately rather than at integration time

## 2. Task Ordering Principles

Tasks are ordered to minimize risk and maximize early validation:

1. **Vertical slice first** — The first task scaffolds the project and proves the core stack works end-to-end. This flushes out toolchain issues before any feature work.
2. **Foundation before features** — Shared types, core models, and serialization are established before feature work. Feature tasks code against real, tested foundations.
3. **Risk-ordered** — High-risk components are scheduled early. If something turns out harder than expected, the plan can adapt while there's still room.
4. **Integration built-in** — Each task builds on all prior committed work. Later tasks naturally exercise integration with earlier output, so integration testing accumulates organically rather than requiring separate integration phases.

## 3. Task Sizing

Each task must be completable within a single Claude Code session, including all dev loop iterations (implement → test → code review → fix). This means:

- Small enough that one agent can hold the full scope in context
- Large enough to produce a meaningful, self-contained unit of working software
- A task that is too large should be split; a task that is too small should be merged with adjacent work

## 4. Task Document Structure

Each task lives in its own directory under `docs/tasks/`:

```
docs/tasks/task-NN-name/
├── brief.md    # The task plan — written in the plan phase, immutable during the implement phase
└── log.md      # Execution log — created at implement-phase task start, see execution methodology
```

The `brief.md` is a self-contained task plan. An agent with zero prior context must be able to execute the task by reading only `brief.md` and the files it references.

Every `brief.md` includes:

| Section | Purpose |
|---------|---------|
| **Goal** | What this task builds and why it matters in the larger system |
| **Context files** | Exact file paths the agent should read before starting (not "read the codebase") |
| **Downstream dependencies** | What later tasks will depend on from this task's output — specific interfaces, file paths, or behaviors that must be preserved. This gives the implementer and tester just enough big picture to avoid breaking downstream work without loading the full plan. |
| **Steps** | Bite-sized steps with exact file paths, code sketches, and test commands |
| **Acceptance criteria** | Verifiable conditions that define "done" — test commands with expected output, not subjective judgment |
| **Output files** | Which files are created or modified by this task |

## 5. Coverage Validation

The complete set of tasks must cover all requirements from the product design spec (brainstorm output), the UX spec if present (ux output), and the engineering spec (engineering output). After writing the plan:

1. Walk through every section of the product design spec — each feature or behavior must map to at least one task
2. **If a UX spec is present:** walk through every section of the UX spec — each deliverable (component, screen, flow, microcopy entry, a11y item) must map to at least one task
3. Walk through every section of the engineering spec — each architectural component must map to at least one task
3. If a requirement isn't covered, add a task or expand an existing one

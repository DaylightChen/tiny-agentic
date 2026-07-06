# Implementation Plan — [Project / Feature Name]

> Written in the plan phase by the `planner` agent. Lives at the scope's `paths.plan` (project: `docs/project/plan/implementation-plan.md`; feature: `docs/feature/<name>/plan/implementation-plan.md`). The agent should rewrite this skeleton — sections below are the required shape, not boilerplate to preserve.

## Goal

[One paragraph: what the full task list achieves end-to-end. Be concrete about the artifact / system / behavior that exists when every task in this plan is committed.]

## Task list

[Numbered, ordered, sequential. Each line: task number, name, one-line summary. The order is the execution order — see Dependency rationale below for why.]

1. **task-01-[name]** — [one-line summary]
2. **task-02-[name]** — ...
3. ...

## Dependency rationale

[Why this order, not another? Address explicitly:]

- **Vertical slice first** — which task scaffolds the stack end-to-end and proves the toolchain works?
- **Foundation before features** — which tasks establish shared types / core models / serialization that later tasks code against?
- **Risk-ordered** — which novel or hard components are scheduled early, so a surprise in task 3 doesn't unwind work in task 13?

For each non-obvious ordering choice, write one sentence on why it goes where it does.

## Coverage check

[Mandatory walk-through. Every requirement from the upstream design(s) must map to a task or an explicit `N/A` / deferral. The reader should be able to scan this table and convince themselves nothing is missing.]

### Coverage by upstream section

| Upstream source / section | Task(s) | Notes |
|---|---|---|
| [e.g.] Product spec — Core feature A | task-03, task-04 | |
| [e.g.] Product spec — Edge case "large input" | task-07 | |
| [e.g.] Engineering spec — Module X | task-02 | |
| ... | ... | |

[If a UX spec is present (design-heavy pipelines), add explicit rows for every component, screen, flow, microcopy group, a11y-contract item, and interaction pattern. See planning-methodology §5 and the planner agent's coverage-validation rules.]

### Explicit deferrals

[Anything in the upstream design intentionally not covered by a task. Each row needs a justification and a `known-issues.md` entry or follow-up plan.]

- ...

## Open questions

[Anything you couldn't decide while planning and need user input on before tasks can be executed.]

- ...

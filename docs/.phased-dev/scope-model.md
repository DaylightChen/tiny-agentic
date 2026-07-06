# Scope Model

> Reference for the scope abstraction. Read this if you are a command or agent that needs to look up the current phase, pipeline, or output paths.

## Files

- `docs/.phased-dev/state.json` — global state. Records which scope is currently **active**. Single source of truth for "where is the workflow."
- `docs/.phased-dev/scopes/<id>.json` — one file per scope. Records that scope's pipeline, current phase, phase status, and output paths.

Scope IDs:

- `project` → file at `docs/.phased-dev/scopes/project.json`
- `feature/<name>` → file at `docs/.phased-dev/scopes/feature/<name>.json`

The **scope ID** stays the same regardless of pipeline. What varies is the scope JSON's `type` and `pipeline` fields:

- `type: "project"` — standard 5-phase pipeline (`research → brainstorm → engineering → plan → implement`); the scope's `paths` field includes `researchDir`
- `type: "project-design-heavy"` — 6-phase pipeline with a dedicated UX phase (`research → brainstorm → ux → engineering → plan → implement`); the scope's `paths` field includes `researchDir` and `uxDir`
- `type: "feature"` — 4-phase pipeline (`research → engineering → plan → implement`); the scope's `paths` field includes `researchDir`
- `type: "feature-design-heavy"` — 5-phase pipeline with a dedicated UX phase (`research → ux → engineering → plan → implement`); the scope's `paths` field includes `researchDir` and `uxDir`

Every pipeline now opens with a `research` phase (the `researcher` agent gathers prior art, feasibility, and domain constraints before any framing). Its output is upstream *evidence* for the brainstormer/architect, not a deliverable that the planner maps to tasks.

Adding a new pipeline type means adding a new template at `templates/scopes/<type>.json` and (if it introduces a new phase) a new agent. Existing commands operate on the scope's `pipeline` array as data, so they work unchanged.

## `state.json`

```json
{
  "schemaVersion": 1,
  "activeScope": "project",
  "scopes": ["project", "feature/auth-revamp"]
}
```

- `activeScope` — the scope ID that commands implicitly operate on. Changed by `/phased-dev:switch-scope`.
- `scopes` — list of all scope IDs that exist. Lets `/phased-dev:list-scopes` enumerate without filesystem globbing.

## `scopes/<id>.json`

```json
{
  "schemaVersion": 1,
  "id": "project",
  "type": "project",
  "name": null,
  "pipeline": [
    { "phase": "research",    "agent": "researcher",   "outputCheck": "docs/project/research/*.md" },
    { "phase": "brainstorm",  "agent": "brainstormer", "outputCheck": "docs/project/brainstorm/*.md" },
    { "phase": "engineering", "agent": "architect",    "outputCheck": "docs/project/engineering/*.md" },
    { "phase": "plan",        "agent": "planner",      "outputCheck": ["docs/project/plan/implementation-plan.md", "docs/project/tasks/task-*/brief.md"] },
    { "phase": "implement",   "agent": null,           "outputCheck": ["docs/project/tasks/task-*/brief.md", "docs/project/tasks/task-*/completion.md"] }
  ],
  "currentPhase": "research",
  "phaseStatus": "not_started",
  "paths": { /* scope-specific output paths */ },
  "history": []
}
```

### Field semantics

- **`id`** — unique scope identifier. `project` or `feature/<name>`.
- **`type`** — `project`, `project-design-heavy`, `feature`, or `feature-design-heavy`. Determines which pipeline template was used.
- **`name`** — null for project scope; feature name for feature scope.
- **`pipeline`** — ordered list of phases for this scope. Each entry:
  - `phase` — phase name (string).
  - `agent` — agent to dispatch when `/phased-dev:start-phase` is invoked during this phase. `null` for `implement` (which uses per-task dispatch via `/phased-dev:start-task`).
  - `outputCheck` — either a single glob (string) or a list of globs (array). When an array, **every** glob must match at least one file before this phase is considered "complete." Used by `/phased-dev:advance-phase` to verify before advancing, and by `/phased-dev:start-phase` to verify upstream phases. The plan phase uses an array (plan file AND at least one brief) so that an incomplete planner run can't advance.
- **`currentPhase`** — the phase currently being worked on (matches a `phase` value in `pipeline`).
- **`phaseStatus`** — one of:
  - `not_started` — phase hasn't begun
  - `in_progress` — an agent has been dispatched but hasn't reported completion
  - `complete_awaiting_approval` — the phase's agent has reported done; user approval pending
  - `complete` — terminal phase (`implement`) when all tasks committed (optional; not strictly enforced)
- **`paths`** — scope-specific output paths. Agents read these instead of hardcoding paths. Different per scope type:
  - Project (standard): `researchDir`, `brainstormDir`, `engineeringDir`, `plan`, `tasks`, `decisions`
  - Project (design-heavy): same as standard plus `uxDir` (the UX phase's output directory)
  - Feature (standard): `researchDir`, `engineeringDir`, `plan`, `tasks`, `decisions`
  - Feature (design-heavy): same as standard feature plus `uxDir` (scoped under the feature's directory)
- **`history`** — list of phase transitions, appended by `/phased-dev:advance-phase`. Format: `{ "phase": "brainstorm", "completedAt": "...", "approvedAt": "..." }`. Can be truncated by `/phased-dev:rewind-phase`.

## Completion markers

Each task in the `implement` phase writes a `completion.md` file in its task directory after the commit lands. The implement phase's `outputCheck` requires both `brief.md` and `completion.md` to exist for each task — this prevents `/phased-dev:advance-phase` from advancing before all tasks are done.

Each `completion.md` carries a **YAML frontmatter** with machine-readable fields: `status`, `commit`, `completedAt`, `iterations`. Commands (`phase-status`, `list-scopes`, future tooling) read the frontmatter directly; the markdown body is human-readable prose only. See `templates/task-completion-template.md`.

## Status mirrors

- `docs/project/STATUS.md` — human-readable mirror of the **project scope**. Regenerated by `/phased-dev:advance-phase` and `/phased-dev:start-task`.
- `docs/feature/<name>/STATUS.md` — human-readable mirror of each **feature scope**. Created by `/phased-dev:start-feature`, regenerated by `/phased-dev:advance-phase` and `/phased-dev:start-task`.

Both mirrors include a **Task Progress** table during the `implement` phase: initialized by `/phased-dev:advance-phase` (all tasks "pending") and updated by `/phased-dev:start-task` (each task marked "done" with commit SHA after completion). The table gives a single-file view of task status without needing to glob `completion.md` files. Division of responsibility: `advance-phase` creates the table; `start-task` only updates rows (does not re-initialize).

Agents read JSON; commands write JSON and regenerate the markdown mirrors.

## Reading the active scope

Any command or agent that needs to know "where am I":

```bash
# 1. Read state.json
ACTIVE=$(jq -r .activeScope docs/.phased-dev/state.json)

# 2. Read the active scope's config
jq . "docs/.phased-dev/scopes/${ACTIVE}.json"
```

Or with the Read tool: read `docs/.phased-dev/state.json`, get `activeScope`, then read `docs/.phased-dev/scopes/<activeScope>.json`.

## Writing the scope

Only commands write to scope files. Agents are **read-only** with respect to scope state.

- `/phased-dev:init-project` — creates `project.json` (using either `templates/scopes/project.json` or `project-design-heavy.json` depending on the user's pipeline choice)
- `/phased-dev:start-feature` — creates `feature/<name>.json`, sets it as active
- `/phased-dev:start-phase` — sets `phaseStatus` to `in_progress` before dispatch; to `complete_awaiting_approval` when the agent reports done
- `/phased-dev:advance-phase` — moves `currentPhase` forward, resets `phaseStatus`, appends to `history`
- `/phased-dev:rewind-phase` — moves `currentPhase` back to a target upstream phase, resets `phaseStatus` to `not_started`, truncates `history` from the target onward
- `/phased-dev:switch-scope` — updates `state.json` only (not the scope JSON)
- `/phased-dev:start-task` — at completion, updates the active scope's status mirror (`docs/project/STATUS.md` for project; `docs/feature/<name>/STATUS.md` for feature) and writes per-task `completion.md`; the scope JSON itself is not modified per task

This split (commands write, agents read) keeps the state machine in one place. If you find yourself wanting an agent to update the JSON, push the update into the command that dispatched it.

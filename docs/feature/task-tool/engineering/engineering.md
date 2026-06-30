# Feature Engineering Spec — [Feature Name]

> Engineering spec for a feature within an existing project. In standard feature pipeline it also covers user-visible behavior (combined product + engineering). In design-heavy feature pipeline the UX is upstream and this doc focuses on engineering. Drafted by the `feature-architect` agent. Lives under `docs/feature/<feature-name>/engineering/`.

## Goal

[One paragraph: what this feature does, who it's for, what changes for the user.]

## Motivation

[Why this feature now? What problem does it solve that the project's current state doesn't address? Reference any user feedback, blocked workflows, or downstream features that depend on it.]

## User-visible behavior

> This is a **lightweight sketch**, not a full UX spec. If you need a rigorous UX specification (component inventory, design language, interaction patterns), use the `design-heavy` pipeline instead. Every subsection below must be addressed. If a subsection genuinely doesn't apply, write `N/A — <one-sentence reason>`; do not omit the heading.

### Primary flow

[Step by step (or screen by screen). For each step: what the user sees, what they do, what they get back.]

1. ...
2. ...

### States matrix

[For each new or modified surface, describe each state. One paragraph for a small feature; a table for a major one.]

| Surface | Empty | Loading | Error | Partial | Offline |
|---------|-------|---------|-------|---------|---------|
| ...     | ...   | ...     | ...   | ...     | ...     |

### Accessibility

- **Keyboard navigation:** can a keyboard-only user complete the primary flow? How?
- **Color-only signals:** none / list any and their non-color alternative

### Edge-case behaviors

[Large inputs, concurrent use, race conditions from the user's perspective. Pair with the States matrix above — that one covers how each state *looks*; this one covers what happens at the boundaries.]

- ...

### Microcopy

[Exact text for new CTAs, empty states, common errors. Existing design-system terminology takes precedence; deviations need justification.]

- Primary CTA: "..."
- Empty state: "..."
- Common error: "..."

## Out of scope

[What this feature explicitly does *not* do. Critical for keeping the implementation plan focused.]

- ...
- ...

## Architectural fit

**Existing modules touched:**

- `path/to/module/` — what changes and why

**New modules / files introduced:**

- `path/to/new-module.ts` — purpose

**New interfaces / contracts:**

```ts
// e.g.
export interface FooStore {
  getX(): X
  setX(x: X): void
}
```

**Modified existing interfaces (back-compat plan):**

- `existing.foo()` — adding optional `bar` parameter, default behavior unchanged

## Data model changes

[New or modified types, schemas, storage. Include migration strategy if applicable.]

## Risks

[What could go wrong with this design? What's likely to be hard? What might force a redesign during the implement phase?]

- **Risk:** [description] — **Mitigation:** [plan]

## Success criteria

**Functional:**

- [ ] User can ...
- [ ] System does ...

**Non-functional:**

- [ ] Operation X completes within N ms for typical input
- [ ] No regressions in feature Y, Z

## Open questions

[Things that need user input before planning can proceed.]

- ...

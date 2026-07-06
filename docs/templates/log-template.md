# Execution Log — Task N: [Name]

> Template for `docs/project/tasks/task-NN-name/log.md`. Copy this file when starting a task. Delete sections that don't apply (e.g., Escalation if none, Iteration 2+ if not needed).

## Iteration 1

### Implement
- **Files created:** (list with paths)
- **Files modified:** (list with paths)
- **Decisions not in plan:** (any implementation choices that weren't specified in the brief)
- **Deviations from plan:** (anything done differently than the brief specified, with rationale)
- **Issues encountered:** (problems hit during implementation and how they were resolved)

### Test
- **New tests written:** (list with paths)
- **Failures:**
  - `test.name` — expected X, got Y (or: none)
- **Full suite output:**
  ```
  $ <test command>
  (paste actual output)
  ```

### Review
- **Verdict:** Approved / Issues found
- **Criteria check:**
  - [criterion from brief] — pass / fail
  - [criterion from brief] — pass / fail
- **Code quality findings:** (DRY, YAGNI, unnecessary abstractions, or: clean)
- **Test quality findings:** (coverage gaps, test design issues, or: adequate)
- **Regressions:** none / (details)
- **Issues to fix:** (numbered list, or: none)

---

## Iteration 2

> Only needed if tests failed or review found issues in Iteration 1.

### Fix
- **What was fixed:** (references specific test failures or review issue numbers from previous iteration)
- **Files modified:** (list with paths)
- **Deviations from plan:** (if any)

### Test
- **Failures:** (or: none)
- **Full suite output:**
  ```
  $ <test command>
  (paste actual output)
  ```

### Review
- **Verdict:** Approved / Issues found
- **Issues to fix:** (or: none)

---

## Escalation

> Only present when a cross-boundary issue is discovered that cannot be resolved within this task's scope. Delete this section if no escalation occurred.

- **What broke:** (specific failure or blocker)
- **Why:** (root cause — library API mismatch, missing upstream interface, performance issue, etc.)
- **Upstream task/decision affected:** (which task or design decision is implicated)
- **Resolution:** (user's decision and outcome, or "blocked pending user input")

---

## Completion

- **Commit:** `abc1234` — "Task N: [summary]"
- **Iterations:** N (how many dev loop cycles)
- **Verification evidence:**
  ```
  $ <test command>
  (paste actual output — must show all tests passing)
  ```
  ```
  $ <type-check command>
  (paste actual output — must show no errors)
  ```
- **Acceptance criteria:**
  - [ ] [criterion 1 from brief] — verified by [test name / manual check / command output]
  - [ ] [criterion 2 from brief] — verified by [how]
- **Regressions:** none / (details of previously passing tests that were affected)
- **Deviations from plan:** none / (summary of all deviations across iterations, with rationale)

# Known Issues

> Track deferred bugs, workarounds, and architectural debt. Each entry should include a reproduction or symptom, the workaround in place (if any), and the conditions for revisiting.

## Format

```
## [Issue title]

**Discovered:** YYYY-MM-DD ([phase name], Task NN if applicable)
**Status:** open / mitigated / resolved
**Symptom:** [What goes wrong, including reproduction steps]
**Workaround:** [What's in place today, if anything]
**Revisit when:** [Trigger condition for picking this up]
```

---

## edit_file does not enforce read-before-edit (feature/agent-tooling)

**Discovered:** 2026-06-29 (engineering, feature/agent-tooling)
**Status:** open (deferred by design)
**Symptom:** The `edit_file` tool does not verify that the model has previously called `read_file` on the file before editing it. A model that issues an `edit_file` call without first reading the file may attempt to replace a string that was accurate at some earlier point in the conversation but has since been changed on disk (by another tool call, concurrent process, etc.).
**Workaround:** The `edit_file` tool performs an atomic read-find-replace-write at call time, so it always edits the current on-disk content. The uniqueness check (`old_string` must appear exactly once) catches many stale-edit attempts. The risk is low in single-agent, single-file workflows.
**Revisit when:** The Agent SDK layer exists and can widen `ToolCallContext` with `readFileState: Map<string, ReadEntry>`. Enforcement should be added in the SDK layer (which populates the map when `read_file` runs) rather than in the core (which would need to couple the loop to a specific tool's semantics).

---

## write_file range mode with an offset past EOF (M1, minor)

`write_file` with an `offset` beyond the file's last line appends the content at the end (JS `Array.splice` treats a `start` past length as "append"). `deleteCount` is clamped to `>= 0` so nothing is corrupted and `replacedLines` is never negative, but there is no gap-filling with blank lines between the old EOF and the inserted content. This is benign and unlikely in practice; revisit if a real use case needs explicit out-of-range handling.

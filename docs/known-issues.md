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

_(no entries yet)_

## write_file range mode with an offset past EOF (M1, minor)

`write_file` with an `offset` beyond the file's last line appends the content at the end (JS `Array.splice` treats a `start` past length as "append"). `deleteCount` is clamped to `>= 0` so nothing is corrupted and `replacedLines` is never negative, but there is no gap-filling with blank lines between the old EOF and the inserted content. This is benign and unlikely in practice; revisit if a real use case needs explicit out-of-range handling.

# 04 — Context / Memory / History / Skills / System Prompt

Files: `src/context.ts`, `src/context/`, `src/memdir/`, `src/history.ts`, `src/skills/`,
`src/state/`, `src/utils/systemPrompt.ts`, `memory-system-spec.md`

## Conversation history

`history.ts:19–75`. Input history stored as JSONL at `~/.claude/history.jsonl`, keyed by
`(project, sessionId)`. `LogEntry = { display, pastedContents, timestamp, project, sessionId }`.
Pasted content inlined if <1KB else stored externally by hash. `MAX_HISTORY_ITEMS=100` per
project, deduped by text. A reverse-line reader powers fast up-arrow lookup.

> Note: this is *input* history (the REPL command line), distinct from the in-flight message
> list the agent loop maintains. The transcript (full conversation) is persisted separately
> for resume.

## Context assembly

`context.ts`:
- **User context** — lazily loads memory files, cached per session.
- **System context** — captures git status (branch, commits, working tree) once at start,
  memoized; truncated at 2000 chars.
- Dynamic context cached until `/clear`.

## Memory system (`memdir/`)

A four-type closed taxonomy (`memdir/memoryTypes.ts`):
1. **user** — stable facts about the person (role, prefs, goals)
2. **feedback** — rule + why + when-to-apply, from corrections and confirmations
3. **project** — ongoing work state, decisions, absolute dates
4. **reference** — pointers to external systems

Storage: index `MEMORY.md` (pointers only, capped 200 lines / 25KB) + per-topic files under
`~/.claude/projects/<slug>/memory/`. `loadMemoryPrompt()` injects behavioral instructions +
the index; recall is **model-ranked** over metadata only, with a freshness caveat appended to
old memories. Full lifecycle blueprint lives in `memory-system-spec.md` (414 lines).

## Skills (`skills/`)

`loadSkillsDir.ts`. Skills are markdown (`SKILL.md` / `.md`) with frontmatter: `name`,
`description`, `when_to_use`, `allowed-tools`, `arguments`, `model`, `effort`, `paths`,
`hooks`, `context` (fork|inline), `agent`. Loaded from bundled, user `~/.claude/skills/`,
project `.claude/skills/`, policy, and MCP. Deduped by realpath, memoized per session.
Conditional skills (with `paths`) activate when a matching file is touched. Invocation
substitutes `${ARG}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_SESSION_ID}`; runs `inline` or as a
`fork` sub-agent.

## System prompt assembly

`utils/systemPrompt.ts`, `constants/systemPromptSections.ts`. Priority chain:
override → coordinator → agent → custom (`--system-prompt`) → default, plus an append section.
Dynamic sections are memoized (`systemPromptSection(name, compute)`) and only break the prompt
cache when their content changes. Cache-stable context (git status, date, CLAUDE.md, memory
index) goes in the prompt prefix; volatile per-turn data (selected memory bodies) is injected
into the user-message prefix to avoid cache invalidation.

## Minimal essence (build first)

1. **In-memory message list** across turns (persisted transcript is later).
2. **System-prompt builder** — assemble a default prompt + env context.
3. **Static env context** — cwd, git status, date, platform (memoized once).

Defer: memory dir + taxonomy, skills, compaction/summarization, JSONL input history,
recall ranking, prompt-cache section machinery.

## Citations

- History — history.ts:19–75
- Context — context.ts (getSystemContext/getUserContext)
- Memory — memdir/memdir.ts:34–102; memdir/memoryTypes.ts; memory-system-spec.md
- Skills — skills/loadSkillsDir.ts:67–804
- System prompt — utils/systemPrompt.ts; constants/systemPromptSections.ts

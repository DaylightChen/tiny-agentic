# 05 — Commands / Hooks / Plugins / MCP / Config

Files: `src/commands.ts`, `src/commands/`, `src/hooks/`, `src/plugins/`, `src/keybindings/`,
`src/migrations/`, `src/constants/`, `src/schemas/`, `src/utils/settings/`, `src/utils/plugins/`

These are the **extensibility & configuration** layers. Almost all of it is product polish for
our purposes — but understanding the seams now prevents painting ourselves into a corner.

## Slash commands

`types/command.ts`: a discriminated union — `prompt` (model-invocable skill, expands to prompt
text), `local` / `local-jsx` (UI commands rendering Ink/React). Each has `name`, `description`,
lazy `load()`, optional `aliases`.

Registry (`commands.ts:258–346`): static builtins + lazily-loaded dynamic sources (skills dir,
bundled skills, plugin commands, MCP commands, workflow scripts), merged with a defined
precedence, filtered by `isCommandEnabled()` / availability gates. Model invokes via `SkillTool`
(`type:'prompt'` only); users invoke via the `/cmd` REPL parser.

## Hooks

`types/hooks.ts`, `utils/hooks/`. **28 events** (SessionStart, PreToolUse, PostToolUse,
PermissionRequest, UserPromptSubmit, FileChanged, WorktreeCreate, …), each with an optional
`matcher`. Configured in `settings.json` under `hooks`:

```json
{ "hooks": { "PreToolUse": [
  { "matcher": "bash_tool", "hooks": [{ "type": "command", "command": "..." }] } ] } }
```

Hook types: `command`, `prompt`, `agent`, `http`, `function`. Source precedence local >
project > user > policy; plugin hooks lowest. The harness fires hooks at lifecycle points;
exit code controls flow (0 ok, 2 block/deny, else warn). Hooks are the **integration
backbone** — plugins register hooks at load, the app fires them, they can spawn subprocesses,
call models, or modify app state.

## Plugins & MCP

`utils/plugins/`. Plugins are directories (in `~/.claude/plugins/repos/`) with a manifest +
skills/hooks/agents/output-styles/MCP servers, fetched from a git marketplace. MCP servers
(declared in plugin manifest or `settings.json` `mcp.servers`, or `.mcpb` bundles) expose
external tools, wrapped as `Command` objects (`loadedFrom:'mcp'`).

## Config / settings

Layered (`utils/settings/`): `userSettings` (`~/.claude/settings.json`) → `projectSettings`
(`.claude/settings.json`) → `localSettings` (`.claude/settings.local.json`, gitignored) →
`flagSettings` (`--settings`) → `policySettings` (managed, read-only). Deep-merged (arrays
append, objects merge); later layers override earlier. Migrations upgrade the schema on
version bumps.

## Minimal essence

For a minimal framework, **most of this is deferred**. The only piece worth an early sliver:

- A tiny **command registry** if we want `/help`-style local commands and prompt-expansion
  skills early. Even that is optional for milestone 1.

Defer everything else: the 28-event hook system, plugins, MCP, marketplace, settings layering,
migrations, keybindings, policy/managed settings.

> Strategic note: hooks + MCP are how Claude Code stays extensible without bloating the core.
> When we do add extensibility, model it the same way — fire typed events / register external
> tools — rather than threading features through the engine.

## Citations

- Commands — commands.ts:258–346; types/command.ts
- Hooks — types/hooks.ts; utils/hooks/hooksSettings.ts:27–271
- Plugins/MCP — utils/plugins/loadPluginCommands.ts; utils/plugins/mcpPluginIntegration.ts
- Settings — utils/settings/settings.ts:74–121; utils/settings/constants.ts

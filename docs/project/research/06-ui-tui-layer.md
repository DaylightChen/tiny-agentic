# 06 — UI / TUI / I-O Layer

Files: `src/components/`, `src/ink/`, `src/ink.ts`, `src/screens/REPL.tsx`, `src/vim/`,
`src/replLauncher.tsx`, `src/interactiveHelpers.tsx`, `src/dialogLaunchers.tsx`, `src/main.tsx`

## Rendering tech

React **Ink** (a custom fork in `src/ink/`). `ink.ts` re-exports `render()`/`createRoot()`
wrapped with a `ThemeProvider`. Entry: `replLauncher.tsx` renders `<App><REPL/></App>`.

## Structure

- **REPL** — `screens/REPL.tsx` (~5000 lines) is the monolithic interaction component, driven
  entirely by React hooks (`useState`/`useEffect`/`useCallback`).
- **Message list** — `VirtualMessageList` renders the scrollable transcript; `MessageResponse`
  adds the `⎿` indent indicator; `Markdown.tsx` renders markdown to the terminal.
- **Input** — `PromptInput/PromptInput.tsx` (vim mode, history, typeahead, keybindings) over a
  low-level `TextInput.tsx`.

## How UI connects to the engine

The core `query()` generator (`query.ts:219`) yields typed events. REPL consumes them via an
`onQueryEvent` callback (`REPL.tsx:2584`) → `handleMessageFromStream()` → React state updates:
`setMessages`, `setStreamMode`, `setStreamingToolUses`, `setStreamingThinking`. Live display:
`SpinnerWithVerb` (50ms frames), streaming tool rows, thinking blocks (auto-hide after 30s),
OTPS metrics.

## Major UI concerns

Input (vim `src/vim/`, history, completion), permission/approval dialogs
(`components/permissions/PermissionRequest.tsx`), markdown (`Markdown.tsx`), diffs
(`FileEditToolDiff.tsx`, `StructuredDiffList.tsx`), spinners/status (`Spinner.tsx`), modal
dialogs (`dialogLaunchers.tsx`), layout (`FullscreenLayout.tsx`, `useTerminalSize()`).

## Decoupling — the key fact

**The core engine is fully headless.** `query()` imports zero React/Ink code and yields typed
events only. The UI is purely a consumer; you could swap Ink for a web UI, a logger, or a
plain stdio loop without touching the engine. Tool permissions flow through a
`ToolPermissionContext` that can be stubbed/auto-approved for headless runs.

```
query.ts (engine)  ──yields StreamEvent──▶  REPL.tsx (UI consumer)  ──▶  React components
```

## Minimal essence (build first)

A plain `readline` loop is enough:

```ts
while (true) {
  const prompt = await readline("agent> ")
  for await (const event of query(prompt)) {
    if (event.type === 'text')     process.stdout.write(event.text)
    if (event.type === 'tool_use') console.log(`[tool: ${event.name}]`)
  }
}
```

Deps: just Node `readline`. Streaming text to stdout, tool calls printed inline. This keeps the
engine the star and lets us add an Ink TUI much later as pure polish.

Defer: the entire Ink TUI — markdown rendering, diffs, spinners, vim, dialogs, approval UI,
fullscreen scrolling.

## Citations

- Engine generator — query.ts:219
- REPL consumer — screens/REPL.tsx:2584
- Render setup — ink.ts, main.tsx, replLauncher.tsx
- Spinner — components/Spinner.tsx:62
- Input — components/PromptInput/PromptInput.tsx

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension (`.vsix`) that adds an Obsidian-style full-text search panel to the activity bar. It searches Markdown files in the current workspace (a "vault") using Obsidian's search-operator syntax (`path:`, `file:`, `tag:`, `line:(...)`, `section:(...)`, `[property]`). Results update live as you type (debounced), no need to press Enter. It operates entirely offline. Installed locally into the VS Code profile **"Obsidian like"**, alongside the sibling extensions in `../obsidianlike`, `../obsidianlike_tasks`, `../obsidianlike_clearunusedimages`, and `../obsidianlike_calendar`.

## Deploy workflow (mandatory after every code change)

```bash
npm run package
code --profile "Obsidian like" --uninstall-extension angelCastro.obsidianlike-search
code --profile "Obsidian like" --install-extension obsidianlike-search-0.0.1.vsix
```

Then reload the VS Code window (Ctrl+Shift+P → "Developer: Reload Window").

`npm run package` = `npm run compile && vsce package --allow-missing-repository` (the `vscode:prepublish` hook also runs `compile`, so packaging always ships a fresh build).

This project is also wired into `..\obsidianlike\make.bat`, which packages/reinstalls all five sibling extensions in sequence and then relaunches VS Code on the real vault.

## Key files

| File | Role |
|---|---|
| `src/extension.ts` | Activation entry point. Registers the webview view provider and the `obsidianlikeSearch.open` command. |
| `src/searchEngine.ts` | Pure query parsing (`parseQuery`) and search (`search`) logic. No `vscode` dependency — easy to unit test in isolation. |
| `src/searchViewProvider.ts` | `WebviewViewProvider` implementation: builds the webview HTML, reads files via `vscode.workspace.findFiles`/`fs.readFile`, runs `searchEngine`, and handles `openMatch` (jump to a result in the editor). |
| `media/main.js` | Webview-side UI logic (vanilla JS, no bundler — loaded as-is). Renders results, handles collapsing, sort order, case-sensitivity toggle. |
| `media/main.css` | Webview styling, themed via VS Code CSS variables (`--vscode-*`) so it matches light/dark themes. |
| `esbuild.js` | Bundles `src/extension.ts` → `dist/extension.js` (CJS, Node target, `vscode` external). |
| `media/obsidian-icon-violeta.png` | Extension icon (marketplace/Extensions view/`.vsix`), copied from `../obsidianlike/media/`. Referenced by top-level `package.json` → `"icon"`. |
| `.vscodeignore` | Excludes `src/`, config files, etc. from the packaged `.vsix` (only `dist/` + `media/` + `package.json` ship). |
| `LICENSE` | Same terms as the sibling extensions — internal use only, not for redistribution. |
| `package.json` | Publisher is `angelCastro` — installed extension ID is `angelCastro.obsidianlike-search`. |

`dist/`, `out/`, and `node_modules/` are gitignored and rebuilt on demand (`npm install && npm run compile`).

**`media/main.js` and `media/main.css` are plain JS/CSS, not compiled or type-checked.** They're loaded as-is by `searchViewProvider.getHtml()`, which renders the DOM structure they depend on (`#searchInput`, `#resultsContainer`, `#resultsHeader`, etc. — see `searchViewProvider.ts`). Nothing enforces that these stay in sync. Once during development these two files were accidentally overwritten with unrelated webview code copied from the `obsidianlike_calendar` sibling project (`#calendar-root`, `.cal-grid`...), silently breaking the panel while `src/*.ts` stayed correct — `npm run compile`/`check-types` caught nothing because the mismatch was between two plain-JS/HTML files. Before editing either file, confirm the element IDs still match `searchViewProvider.ts`'s `getHtml()`.

## Architecture

### Query syntax (`searchEngine.parseQuery`)

- Free terms: plain words/`"quoted phrases"`, all must appear somewhere in the file (filename or body) — AND semantics.
- `-term` / `-"quoted phrase"` — NOT: excludes any file where the term appears (filename or body). Tokenized via the same `-?"[^"]*"|\S+` regex before the other prefix checks, so it also strips a leading `-` off a quoted phrase.
- `path:<text>` — substring match against the file's relative path.
- `file:<text>` — substring match against the filename (without extension).
- `tag:<name>` — matches `#name` in the body or `tags:` in YAML frontmatter.
- `line:(term1 term2)` or `line:term` — all terms must co-occur on the same line.
- `section:(heading text)` — restricts matching to lines under a heading whose text contains the given string (heading = last `#`..`######` line seen before that line).
- `[property]` / `[property:value]` — matches YAML frontmatter keys (`parseFrontmatter`), case-insensitive key, substring value match.
- `line:(...)` and `section:(...)` groups are extracted before whitespace tokenizing (`extractParenGroups`) since they may contain spaces.

### Scoring and results

`search()` returns one `FileResult` per matching file with `score = (titleMatch ? 1 : 0) + matches.length` and `mtime` (last-modified, ms since epoch — `FileInput.mtime`, populated by `handleSearch` via `vscode.workspace.fs.stat`, alongside the `fs.readFile` call, per file). `searchViewProvider.handleSearch` sorts by filename, score, or `mtime` (descending — newest first) depending on the webview's sort selector (`'name' | 'relevance' | 'date'`), but in all three modes files whose **filename** matches the query (`titleMatch`) always sort before files that only matched in the body — that's the primary sort key, the chosen mode is just the tiebreaker. Highlights are built with a ±60-char context window (`CONTEXT_RADIUS`) per match in `buildContext`.

Per line, raw match ranges from every `highlightTerms` entry (free terms, `#tag`s, `line:(...)` terms) are collected first, then merged if they overlap or touch with only whitespace between them (`line.slice(last.end, r.start).trim()` empty), *before* `buildContext` runs — so a multi-word free-text query like `Jose Servet`, which tokenizes into two separate terms, produces one merged snippet when both words occur adjacently, instead of two overlapping snippet cards for the same spot.

### Opening a result (`searchViewProvider.handleOpenMatch`)

Soft dependency on `angelCastro.obsidianlike` (the `../obsidianlike` sibling extension, same "Obsidian like" profile): before falling back to the plain text editor, it checks `vscode.commands.getCommands(true)` for `vaultTool.openNoteAtLine` — a command added to `../obsidianlike/src/extension.ts` specifically for this integration — and if present, delegates to it so the note opens in that extension's custom rendered editor (`vaultTool.markdownEditor`) instead of plain text. That command only supports line-level navigation (`{ type: 'scroll-to-line', line }`, same message its own wikilink/heading navigation already used), not column, so it's always given `message.line` when present; there's no fallback path that keeps column precision AND uses the custom editor. If the command isn't registered (obsidianlike not installed/active), it falls back to `vscode.workspace.openTextDocument` + `showTextDocument` with exact `startCol`/`endCol` selection, same as before this integration existed. **This makes `obsidianlike_search` load-bearing on an implementation detail of a sibling repo** — if `vaultTool.openNoteAtLine` is ever renamed or removed there, this silently degrades to the plain-text fallback (no error, just loses the custom render) rather than breaking.

### Webview UI (`media/main.js`)

Search runs live as the user types: an `input` listener on `#searchInput` debounces 200 ms (`DEBOUNCE_MS`) before posting a `search` message to the extension host. Pressing Enter cancels the debounce and searches immediately. Clearing the field (or the `✕` button) cancels any pending search and clears results synchronously, with no round-trip to the host. Toggling case-sensitivity or changing the sort order re-runs the search immediately (no debounce), since those are discrete user actions rather than a stream of keystrokes.

### Idle state: `#idlePanel` (`#historyPanel` + `#optionsPanel`)

Whenever the search box is empty ("no search started" — `isIdle()`), both the syntax-help panel and a recent-searches panel are shown automatically (`updateIdleVisibility()`, driven from the `input`/`clear` handlers). Once there's text in the box, both hide, except `#optionsPanel` stays visible if the user explicitly opened it via the `⚙` button (`state.optionsOpen`) — that toggle only matters while a search is in progress, since idle already forces it open.

Search history (`state.history`, capped at `MAX_HISTORY = 15`, most-recent-first, deduped) is recorded only on an explicit Enter press (`addToHistory`), not on every debounced keystroke — otherwise every partial query while typing would pollute it. It's persisted via `vscode.setState()`/`getState()` (webview state, survives the view being hidden/reloaded — not extension-host state). Clicking a history entry fills the input and searches immediately; each entry has its own `✕` to remove it (`removeFromHistory`).

### Config (`package.json` → `contributes.configuration`)

- `obsidianlikeSearch.include` — single glob string (default `**/*.md`).
- `obsidianlikeSearch.exclude` — `string[]` (default `["**/node_modules/**", "**/.git/**", "**/.obsidian/**"]`), each entry a glob for a file or folder. `handleSearch` joins them into the single `GlobPattern` `vscode.workspace.findFiles` expects: passthrough if one entry, `{a,b,c}` brace-syntax if several, `undefined` (no exclusion) if the array is empty. Was a single glob string until this array form replaced it — no back-compat shim, since this is an early-stage personal extension.

## Known limitations / future work

- No automated tests yet — `searchEngine.ts` is written to be testable in isolation (no `vscode` import) but nothing currently exercises it.
- No OR/NOT operators, no regex search — only AND-of-substrings like Obsidian's basic search.
- Search re-reads and re-scans every matching file on each query (no index/cache); fine for typical vault sizes, would need revisiting for very large vaults.

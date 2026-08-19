# Find in conversation (#99)

In-webview find over the active transcript. One implementation serves VS Code, desktop, and AFK Pilot. VS Code's `enableFindWidget` is a `createWebviewPanel` API and does not exist on our `WebviewView`; even if it did it would do nothing for desktop or the browser client.

## Entry

- ⋯ → **Find in conversation** (next to Export as Markdown) on every surface.
- Ctrl/Cmd+F in the VS Code sidebar and the desktop app only. Gated on `!IS_REMOTE` — the browser owns that key on afkpilot.com.
- On Mac, find is **Cmd+F**. Ctrl+F stays `grok.composerForward` (`when: isMac && grok.composerFocus`). Do not change that binding.
- Command Palette `grok.findInSession` posts `{type:"findInSession"}`. Host-local, transient (`post`, not `emit`). The keystroke inside a `WebviewView` is untested; the command must work without it.

## Search

The transcript is not virtualized — `#messages` holds the whole session. Collapsed tool / command / subagent rows stay in the DOM (`hidden` / class), so a `TreeWalker` reaches them. A match inside a collapsed row expands that row.

`body.thinking-hidden` (Settings → **Show thinking traces**, or Knowledge work forcing that off) is a preference. Those matches are counted (`N in hidden thinking traces`) and kept out of next/prev until the user includes them. Including them adds `.find-reveal` on that block only — it does not flip the setting.

Regex: `m` so `^`/`$` are line anchors (the issue's `^_+build$` example). Length cap 200, `try/catch` on compile, nested-quantifier reject, invalid → no matches + quiet invalid chrome. No error dialog.

Paint: `CSS.highlights` + `Highlight` + `Range`. No `<mark>` wrappers. Without the API (Safari < 17.2, happy-dom): count + navigate + scroll, no paint.

## Scroll

`goToFindMatch` calls `setStickToBottom(false)` and never `forceScrollToBottom` / `noteUserScrollIntent`. A live turn arriving while find is open cannot re-pin and yank the view off the current match.

## Code

`media/chat.js` (one section, `window.__grokFind` test seam) + `media/chat.css`. Do not add a new `media/*.js` — the relay vendors a fixed file list.

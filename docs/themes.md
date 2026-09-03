# Themes

Settings → App → Appearance picks which look this machine renders with: **System** (follow the OS,
the default), **Light** / **Dark** (force a built-in palette), or a theme. The choice is
per-machine — it lives in `client.json` beside the device token, never in the server's
`settings.json` — because a look chosen for one monitor is not a fact about the account.

Themes come from two folders. `themes/` in the repo is packaged into the app, so a theme merged there
is in every install's picker. This machine's own themes folder (`<userData>/themes/`; "Open themes
folder" in Settings creates it) holds the user's files, listed after the shipped ones; a user file
with the same name as a shipped theme shadows it. The folder is watched: saving, adding or deleting a
file repaints every window and refreshes the picker, so there is nothing to reload.

## Writing a theme

A theme is one JSON file. "Open themes folder" drops a `_example.json` holding every themeable token
with the built-in light and dark values; copy it to `my-theme.json` and edit. The file's base name is
the theme's identity; the `name` field is only what the picker shows.

```json
{
  "name": "Gruvbox",
  "light": { "paper": "#fbf1c7", "ink": "#3c3836", "accent": "#af3a03" },
  "dark":  { "paper": "#282828", "ink": "#ebdbb2", "accent": "#d79921" }
}
```

- `light` and `dark` are each a map of token → color. A file with both follows the OS appearance the
  way System does; a file with one is that palette whatever the OS says. The original single-palette
  spelling, `"appearance": "dark"` plus one `"colors"` block, still works and means the same as a
  lone `dark` block.
- Each palette is laid over the built-in palette of the same appearance, which also decides
  `color-scheme` so native controls (scrollbars, selects) match. A palette may set any of the color
  tokens from the `:root` block of `renderer/styles.css` — `paper`, `content`, `panel`, `ink`,
  `muted`, `line`, `hair`, `accent`, `accent-ink`, `surface`, `field`, `sel`, `inline-bg`, `info`,
  `warn`, `success`, `danger`, `code-bg`, `code-ink`, `drop-chat`, `drop-files` (the authoritative
  list is `THEME_COLOR_TOKENS` in `src/shared/types.ts`). Unknown tokens are ignored. Geometry
  tokens are deliberately not themeable.
- Values are plain CSS colors (hex, `rgb()`, `hsl()`, `oklch()`, …). Anything that isn't — a
  `url(…)`, a `var(…)`, an attempt at extra declarations — is dropped by validation in
  `src/desktop/themes.ts`. A file that can't be parsed still shows in the picker, marked broken,
  with the reason as its tooltip.

A theme meant for the repo should set every token in each palette it carries, so it renders fully
instead of inheriting half its look from the built-in defaults; the unit tests check the shipped
ones for that.

## How it works

Themes are variables-only by design. The production CSP (`default-src 'self'`) refuses stylesheets
loaded from arbitrary disk paths, so the renderer never reads a theme file: the main process reads
and validates both folders (`src/desktop/themes.ts`), and every window applies the resolved
palette's colors as inline custom properties on `<html>` (`src/renderer/theme.ts`) — which
`style-src 'unsafe-inline'` already allows. Which palette of a paired theme paints is decided the
same way in both processes (`src/shared/theme.ts`): the renderer asks `prefers-color-scheme` and
re-applies when it flips, the main process asks `nativeTheme` when it creates a window. Forced
light/dark ride a `data-theme` attribute; with no attribute the stylesheet's `prefers-color-scheme`
blocks follow the OS exactly as before themes existed.

One choice paints all three windows (main, Quick Chat overlay, HUD): each boots through
`startTheme()`, and a change — picked in Settings or saved to the folder (`watchThemes`) — is pushed
to all of them on `client:themeChanged`. The main process also derives each window's
`backgroundColor` from the theme (`resolveWindowBackground`), so first paint doesn't flash the wrong
chrome.

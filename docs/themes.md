# Custom themes

Settings → App → Appearance picks which look this machine renders with: **System** (follow the OS,
the default), **Light** / **Dark** (force a built-in palette), or a custom theme. The choice is
per-machine — it lives in `client.json` beside the device token, never in the server's
`settings.json` — because a look chosen for one monitor is not a fact about the account.

## Writing a theme

A theme is one JSON file in this machine's themes folder (`<userData>/themes/`; "Open themes
folder" in Settings creates it and drops a `_example.json` holding every themeable token with the
built-in light values). Copy the example to `my-theme.json`, edit, then press **Reload** in
Settings — or re-pick the theme — to see it. The file's base name is the theme's identity; the
`name` field is only what the picker shows.

```json
{
  "name": "Gruvbox",
  "appearance": "dark",
  "colors": {
    "paper": "#282828",
    "ink": "#ebdbb2",
    "accent": "#d79921"
  }
}
```

- `appearance` (`"light"` | `"dark"`, required) names the built-in palette that fills every token
  the file doesn't set, and decides `color-scheme` so native controls (scrollbars, selects) match.
- `colors` may set any of the color tokens from the `:root` block of `renderer/styles.css` —
  `paper`, `content`, `panel`, `ink`, `muted`, `line`, `hair`, `accent`, `accent-ink`, `surface`,
  `field`, `sel`, `inline-bg`, `info`, `warn`, `success`, `danger`, `code-bg`, `code-ink`,
  `drop-chat`, `drop-files` (the authoritative list is `THEME_COLOR_TOKENS` in
  `src/shared/types.ts`). Unknown tokens are ignored. Geometry tokens are deliberately not
  themeable.
- Values are plain CSS colors (hex, `rgb()`, `hsl()`, `oklch()`, …). Anything that isn't — a
  `url(…)`, a `var(…)`, an attempt at extra declarations — is dropped by validation in
  `src/desktop/themes.ts`. A file that can't be parsed still shows in the picker, marked broken,
  with the reason as its tooltip.

## How it works

Themes are variables-only by design. The production CSP (`default-src 'self'`) refuses stylesheets
loaded from arbitrary disk paths, so the renderer never reads a theme file: the main process reads
and validates it (`src/desktop/themes.ts`), and every window applies the colors as inline custom
properties on `<html>` (`src/renderer/theme.ts`) — which `style-src 'unsafe-inline'` already
allows. Forced light/dark ride a `data-theme` attribute; with no attribute the stylesheet's
`prefers-color-scheme` blocks follow the OS exactly as before themes existed.

One choice paints all three windows (main, Quick Chat overlay, HUD): each boots through
`startTheme()`, and a change is pushed to all of them on `client:themeChanged`. The main process
also derives each window's `backgroundColor` from the theme (`resolveWindowBackground`), so first
paint doesn't flash the wrong chrome.

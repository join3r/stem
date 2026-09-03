# Example themes

Ready-to-use theme files for Stem's custom-theme system (see `docs/themes.md`).

These are **not loaded automatically** — the app only reads themes from this
machine's themes folder (`<userData>/themes/`). To try one, copy the file there
(Settings → App → Appearance → **Open themes folder**) and press **Reload**.

Each file sets every color token from `THEME_COLOR_TOKENS` (`src/shared/types.ts`),
so it renders fully rather than inheriting half its palette from the built-in
light/dark defaults.

## Themes

- `tokyonight-storm.json` — TokyoNight Storm (dark). Palette from the
  [folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim) Storm variant.

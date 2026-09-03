# Themes shipped with Stem

Every `*.json` file in this folder is packaged into the app (`themes/**` in `electron-builder.yml`)
and listed in Settings → App → Appearance on every install, so a theme merged here reaches everyone
on the next release. The format is in `docs/themes.md`.

Files starting with `_` or `.` are skipped. A user's own file of the same name, in their machine's
themes folder, shadows the shipped one — that is how someone tweaks a shipped theme.

A shipped theme should set every color token from `THEME_COLOR_TOKENS` (`src/shared/types.ts`), so
it renders fully rather than inheriting half its palette from the built-in light/dark defaults;
`tests/unit/themes.test.ts` checks that. A theme that carries both a `light` and a `dark` palette
follows the OS appearance; one with a single palette is that palette whatever the OS says.

## Themes

- `tokyonight-storm.json` — TokyoNight Storm (dark). Palette from the
  [folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim) Storm variant.

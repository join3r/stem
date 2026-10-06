# Themes shipped with Stem

Every `*.json` file in this folder is packaged into the app (`themes/**` in `electron-builder.yml`)
and listed in Settings → App → Appearance on every install, so a theme merged here reaches everyone
on the next release. The format is in `docs/themes.md`.

Files starting with `_` or `.` are skipped. A user's own file of the same name, in their machine's
themes folder, shadows the shipped one — that is how someone tweaks a shipped theme.

A shipped theme should set every color token from `THEME_COLOR_TOKENS` (`src/shared/types.ts`), so
it renders fully rather than inheriting half its palette from the built-in light/dark defaults;
`tests/unit/themes.test.ts` checks that. A theme that carries both a `light` and a `dark` palette
follows the OS appearance; one with a single palette is that palette whatever the OS says. An
optional `style` block sets fonts, the type/space/shadow multipliers, radii and shadow recipes.

## Themes

- `tokyonight-storm.json` — TokyoNight Storm (dark). Palette from the
  [folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim) Storm variant.
- `catppuccin.json` — Catppuccin (Latte / Mocha). [catppuccin/catppuccin](https://github.com/catppuccin/catppuccin)
- `dracula.json` — Dracula (dark). [draculatheme.com](https://draculatheme.com/contribute)
- `everforest.json` — Everforest (light / dark, medium). [sainnhe/everforest](https://github.com/sainnhe/everforest)
- `gruvbox.json` — Gruvbox (light / dark), tighter corners and lighter shadows. [morhetz/gruvbox](https://github.com/morhetz/gruvbox)
- `kanagawa.json` — Kanagawa (Lotus / Wave). [rebelot/kanagawa.nvim](https://github.com/rebelot/kanagawa.nvim)
- `nord.json` — Nord (Snow Storm / Polar Night), near-flat shadows. [nordtheme.com](https://www.nordtheme.com/docs/colors-and-palettes)
- `one.json` — One (Light / Dark), after Atom's One themes.
- `rose-pine.json` — Rosé Pine (Dawn / main). [rose-pine/rose-pine-theme](https://github.com/rose-pine/rose-pine-theme)
- `solarized.json` — Solarized (light / dark). [ethanschoonover.com/solarized](https://ethanschoonover.com/solarized/)

Where a source color failed the app's contrast floor (muted text ≥ 4.5:1 on the conversation
background), the theme darkens or lightens it, so a few values are near the original palette rather than in it.

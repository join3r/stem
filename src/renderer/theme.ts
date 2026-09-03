import { resolvePalette } from '../shared/theme';
import { THEME_TOKENS, type ThemeState } from '../shared/types';

// The renderer's half of theming (the other half is src/desktop/themes.ts).
// Three mechanisms, layered so each wins over the last:
//
//   1. no `data-theme` attribute — the stylesheet's prefers-color-scheme media
//      query follows the OS, exactly as before themes existed ('system').
//   2. `data-theme="light" | "dark"` on <html> — the forced built-in palettes
//      (styles.css carries attribute-guarded copies of both token blocks).
//   3. inline custom properties on <html> — a custom theme's colors (and its
//      `style` tokens: fonts, scales, radii, shadows), laid over the built-in
//      palette of the same appearance. Inline because the
//      production CSP refuses stylesheets from arbitrary disk paths; the colors
//      arrive over IPC already validated (desktop/themes.ts). A theme carrying
//      both a light and a dark palette picks by the OS appearance, and is
//      re-applied when that flips.
//
// One module for all three windows: the same bundle serves the main app, the
// Quick Chat overlay and the HUD, and each boots through startTheme().

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');

/** Paint the given theme, replacing whatever was applied before. */
export function applyThemeState(state: ThemeState): void {
  const root = document.documentElement;
  for (const token of Object.keys(THEME_TOKENS)) root.style.removeProperty(`--${token}`);
  const palette = resolvePalette(state.custom, darkQuery().matches);
  const mode = palette ? palette.appearance : state.selected;
  if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
  else root.removeAttribute('data-theme');
  if (palette) {
    for (const [token, value] of Object.entries(palette.colors)) {
      root.style.setProperty(`--${token}`, value);
    }
    // Fonts, scales, radii, shadows: one block for both appearances.
    for (const [token, value] of Object.entries(state.custom?.style ?? {})) {
      root.style.setProperty(`--${token}`, value);
    }
  }
}

/** Apply the stored theme and keep following changes. Never blocks first paint. */
export function startTheme(): void {
  let current: ThemeState | null = null;
  const apply = (state: ThemeState) => {
    current = state;
    applyThemeState(state);
  };
  void window.stem
    .getThemeState()
    .then(apply)
    .catch(() => undefined); // no theme is just the default look
  window.stem.onThemeChanged(apply);
  // A paired theme follows the OS: re-resolve when the appearance flips. The
  // built-in modes need nothing here — the stylesheet's media query handles them.
  darkQuery().addEventListener('change', () => {
    if (current?.custom) applyThemeState(current);
  });
}

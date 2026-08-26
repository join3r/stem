import { THEME_COLOR_TOKENS, type ThemeState } from '../shared/types';

// The renderer's half of theming (the other half is src/desktop/themes.ts).
// Three mechanisms, layered so each wins over the last:
//
//   1. no `data-theme` attribute — the stylesheet's prefers-color-scheme media
//      query follows the OS, exactly as before themes existed ('system').
//   2. `data-theme="light" | "dark"` on <html> — the forced built-in palettes
//      (styles.css carries attribute-guarded copies of both token blocks).
//   3. inline custom properties on <html> — a custom theme's colors, laid over
//      whichever built-in palette its `appearance` names. Inline because the
//      production CSP refuses stylesheets from arbitrary disk paths; the colors
//      arrive over IPC already validated (desktop/themes.ts).
//
// One module for all three windows: the same bundle serves the main app, the
// Quick Chat overlay and the HUD, and each boots through startTheme().

/** Paint the given theme, replacing whatever was applied before. */
export function applyThemeState(state: ThemeState): void {
  const root = document.documentElement;
  for (const token of THEME_COLOR_TOKENS) root.style.removeProperty(`--${token}`);
  const custom = state.custom && !state.custom.problem ? state.custom : null;
  const mode = custom ? custom.appearance : state.selected;
  if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
  else root.removeAttribute('data-theme');
  if (custom) {
    for (const [token, value] of Object.entries(custom.colors)) {
      root.style.setProperty(`--${token}`, value);
    }
  }
}

/** Apply the stored theme and keep following changes. Never blocks first paint. */
export function startTheme(): void {
  void window.stem
    .getThemeState()
    .then(applyThemeState)
    .catch(() => undefined); // no theme is just the default look
  window.stem.onThemeChanged(applyThemeState);
}

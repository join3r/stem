import type { CustomTheme } from './types';

// The one decision both halves of theming make the same way: which of a theme's
// palettes paints right now. The main process asks it for a window's chrome
// color (desktop/themes.ts), the renderer for the inline token overrides
// (renderer/theme.ts); a theme carrying both palettes follows `systemDark`, one
// carrying a single palette is that palette whatever the OS says.

export interface ResolvedPalette {
  appearance: 'light' | 'dark';
  colors: Record<string, string>;
}

/** The palette a usable theme paints with under this OS appearance; null for a broken or empty one. */
export function resolvePalette(theme: CustomTheme | null | undefined, systemDark: boolean): ResolvedPalette | null {
  if (!theme || theme.problem) return null;
  if (theme.light && theme.dark) {
    return systemDark ? { appearance: 'dark', colors: theme.dark } : { appearance: 'light', colors: theme.light };
  }
  if (theme.dark) return { appearance: 'dark', colors: theme.dark };
  if (theme.light) return { appearance: 'light', colors: theme.light };
  return null;
}

/** True when the theme follows the OS appearance (it carries both palettes). */
export function followsSystem(theme: CustomTheme): boolean {
  return Boolean(theme.light && theme.dark);
}

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { host } from '../server/host';
import { log } from '../server/log';
import { readClientSettings } from './settings';
import { THEME_COLOR_TOKENS, type CustomTheme, type ThemeState } from '../shared/types';

// Custom themes: a folder of small JSON files, each overriding some of the color
// tokens at the top of renderer/styles.css. Client-owned end to end — the choice
// is in client.json and the files are on this disk — because a look chosen for
// this monitor is not a fact about the account, and two clients of one server
// are free to differ.
//
// The renderer never reads a theme file itself: the production CSP is
// `default-src 'self'`, so a stylesheet loaded off an arbitrary disk path would
// be refused. Instead this file reads and validates the JSON and the renderer
// applies the colors as inline custom properties (renderer/theme.ts), which
// `style-src 'unsafe-inline'` already allows.

/** What ThemeSettings.selected stores for a custom theme: `custom:<id>`. */
const CUSTOM_PREFIX = 'custom:';

/**
 * A color value a theme file is allowed to carry: hex, rgb()/hsl()/oklch()-style
 * functions, or a bare keyword — and nothing that could smuggle a URL or extra
 * declarations. Applied via CSSOM setProperty (which already refuses to escape
 * the declaration), so this is belt on top of braces.
 */
const SAFE_COLOR = /^[#a-zA-Z0-9(),./%\s-]{1,100}$/;

/** The window-chrome colors the built-in palettes paint (--panel light / dark-ish). */
const BUILTIN_BG = { light: '#efece5', dark: '#1b1916' } as const;

export function themesDir(): string {
  // STEM_THEMES_DIR lets tests point at a throwaway folder, like its neighbours
  // under server/workspace/paths.ts.
  return process.env.STEM_THEMES_DIR ?? join(host().stateRoot(), 'themes');
}

/** `custom:<id>` → `<id>`, or null when `selected` is a built-in mode. */
export function customThemeId(selected: string): string | null {
  return selected.startsWith(CUSTOM_PREFIX) ? selected.slice(CUSTOM_PREFIX.length) : null;
}

/**
 * One theme file, read and validated. Never throws: a file that cannot be used
 * comes back with `problem` set, so the picker can say why rather than the
 * theme silently vanishing from the list after a typo.
 */
async function readThemeFile(id: string): Promise<CustomTheme> {
  const theme: CustomTheme = { id, name: id, appearance: 'light', colors: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(themesDir(), `${id}.json`), 'utf8'));
  } catch (e) {
    const reason = e instanceof SyntaxError ? 'is not valid JSON' : 'could not be read';
    return { ...theme, problem: `${id}.json ${reason}` };
  }
  const doc = raw as { name?: unknown; appearance?: unknown; colors?: unknown };
  if (!doc || typeof doc !== 'object') return { ...theme, problem: `${id}.json is not a JSON object` };
  if (typeof doc.name === 'string' && doc.name.trim()) theme.name = doc.name.trim();
  if (doc.appearance !== 'light' && doc.appearance !== 'dark') {
    return { ...theme, problem: `"appearance" must be "light" or "dark"` };
  }
  theme.appearance = doc.appearance;
  const colors = (doc.colors ?? {}) as Record<string, unknown>;
  if (typeof colors !== 'object' || Array.isArray(colors)) {
    return { ...theme, problem: `"colors" must be an object of token → color` };
  }
  for (const token of THEME_COLOR_TOKENS) {
    const value = colors[token];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (SAFE_COLOR.test(trimmed) && !/url|var/i.test(trimmed)) theme.colors[token] = trimmed;
  }
  return theme;
}

/** Every theme in the folder, broken ones included (with `problem` set). */
export async function listThemes(): Promise<CustomTheme[]> {
  let entries: string[];
  try {
    entries = await readdir(themesDir());
  } catch {
    return []; // no folder yet — nobody has made a theme
  }
  const ids = entries
    .filter((name) => name.endsWith('.json') && !name.startsWith('_') && !name.startsWith('.'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
  return Promise.all(ids.map(readThemeFile));
}

/** The stored choice plus the theme file it names, read fresh from disk. */
export async function currentThemeState(): Promise<ThemeState> {
  const { theme } = await readClientSettings();
  const id = customThemeId(theme.selected);
  if (!id) return { selected: theme.selected, custom: null };
  const custom = await readThemeFile(id);
  if (custom.problem) log('themes', 'the selected theme is unusable', { id, problem: custom.problem });
  return { selected: theme.selected, custom };
}

/**
 * The BrowserWindow backgroundColor this theme wants, so first paint doesn't
 * flash the wrong chrome. `systemDark` answers for `'system'` (the caller reads
 * nativeTheme at window-creation time — it can change while the app runs).
 * A custom theme paints its own `panel` when it sets one as plain hex — the one
 * form Electron's backgroundColor reliably takes.
 */
export function resolveWindowBackground(state: ThemeState, systemDark: boolean): string {
  const custom = state.custom && !state.custom.problem ? state.custom : null;
  if (custom) {
    const panel = custom.colors.panel ?? custom.colors.paper;
    if (panel && /^#[0-9a-fA-F]{3,8}$/.test(panel)) return panel;
    return BUILTIN_BG[custom.appearance];
  }
  if (state.selected === 'light' || state.selected === 'dark') return BUILTIN_BG[state.selected];
  return systemDark ? BUILTIN_BG.dark : BUILTIN_BG.light;
}

/**
 * The starting point a new theme is copied from: every themeable token, filled
 * with the built-in light palette. Underscore-prefixed so the lister skips it —
 * it is documentation, not a theme — and rewritten on every reveal so it always
 * matches the tokens this build understands.
 */
const EXAMPLE = {
  name: 'My theme (copy this file, e.g. to my-theme.json)',
  appearance: 'light',
  colors: {
    paper: '#f6f4ef',
    content: '#faf8f3',
    panel: '#efece5',
    ink: '#23211d',
    muted: '#6d675d',
    line: '#e0dccf',
    hair: 'rgba(35, 33, 29, 0.10)',
    accent: '#9a6230',
    'accent-ink': '#ffffff',
    surface: '#fffdf9',
    field: '#fffdf9',
    sel: 'rgba(154, 98, 48, 0.16)',
    'inline-bg': '#efeae0',
    info: '#2b6cb0',
    warn: '#b7791f',
    success: '#3a7d4f',
    danger: '#c53030',
    'code-bg': '#2b2723',
    'code-ink': '#f4efe7',
    'drop-chat': '#9a6230',
    'drop-files': '#2f8f7d'
  }
};

/** Create the themes folder (and its example file) so "open" lands somewhere useful. */
export async function ensureThemesDir(): Promise<string> {
  const dir = themesDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '_example.json'), `${JSON.stringify(EXAMPLE, null, 2)}\n`, 'utf8').catch(
    () => undefined
  );
  return dir;
}

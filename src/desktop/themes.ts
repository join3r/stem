import { existsSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { host } from '../server/host';
import { log } from '../server/log';
import { readClientSettings } from './settings';
import { resolvePalette } from '../shared/theme';
import {
  THEME_COLOR_TOKENS,
  THEME_STYLE_TOKENS,
  THEME_TOKENS,
  type CustomTheme,
  type ThemeState,
  type ThemeToken
} from '../shared/types';

// Custom themes: small JSON files, each overriding some of the color tokens at
// the top of renderer/styles.css. Two folders feed the picker: `themes/` in the
// app itself (shipped with every build — a theme merged into the repo reaches
// everyone on the next release) and this machine's own themes folder, where a
// file of the same id shadows the bundled one. The choice is client-owned end
// to end — it is in client.json and the user's files are on this disk — because
// a look chosen for this monitor is not a fact about the account, and two
// clients of one server are free to differ.
//
// The renderer never reads a theme file itself: the production CSP is
// `default-src 'self'`, so a stylesheet loaded off an arbitrary disk path would
// be refused. Instead this file reads and validates the JSON and the renderer
// applies the colors as inline custom properties (renderer/theme.ts), which
// `style-src 'unsafe-inline'` already allows.

/** What ThemeSettings.selected stores for a custom theme: `custom:<id>`. */
const CUSTOM_PREFIX = 'custom:';

/**
 * What a theme file may say for each kind of token — and nothing that could
 * smuggle a URL or extra declarations. Applied via CSSOM setProperty (which
 * already refuses to escape the declaration), so this is belt on top of braces.
 */
const SAFE = {
  /** hex, rgb()/hsl()/oklch()-style functions, or a bare keyword */
  color: /^[#a-zA-Z0-9(),./%\s-]{1,100}$/,
  /** a font-family list: names, quotes, commas */
  font: /^[a-zA-Z0-9\s,'"_-]{1,200}$/,
  /** a plain length */
  length: /^\d+(\.\d+)?(px|rem|em)$/,
  /** a box-shadow list, or none */
  shadow: /^(none|[#a-zA-Z0-9(),./%\s-]{1,300})$/
} as const;
const UNSAFE = /url|var|;|\\/i;

/** The multipliers: a unitless number, kept where the app stays usable. */
const NUMBER_RANGE: Record<string, [number, number]> = {
  'type-scale': [0.5, 2],
  'space-scale': [0.5, 2],
  'shadow-scale': [0, 2]
};

/** The validated value for one token, or null when the file's value cannot be used. */
function safeValue(token: ThemeToken, value: unknown): string | null {
  const kind = THEME_TOKENS[token];
  if (kind === 'number') {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
    const [lo, hi] = NUMBER_RANGE[token] ?? [0, 1];
    return Number.isFinite(n) && n >= lo && n <= hi ? String(n) : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return SAFE[kind].test(trimmed) && !UNSAFE.test(trimmed) ? trimmed : null;
}

/** The window-chrome colors the built-in palettes paint (--panel light / dark-ish). */
const BUILTIN_BG = { light: '#efece5', dark: '#1b1916' } as const;

/** The user's themes folder. */
export function themesDir(): string {
  // STEM_THEMES_DIR lets tests point at a throwaway folder, like its neighbours
  // under server/workspace/paths.ts.
  return process.env.STEM_THEMES_DIR ?? join(host().stateRoot(), 'themes');
}

/** The themes shipped inside the app (`themes/` at the repo root, listed in electron-builder.yml). */
export function bundledThemesDir(): string {
  return process.env.STEM_BUNDLED_THEMES_DIR ?? join(host().appRoot(), 'themes');
}

/** `custom:<id>` → `<id>`, or null when `selected` is a built-in mode. */
export function customThemeId(selected: string): string | null {
  return selected.startsWith(CUSTOM_PREFIX) ? selected.slice(CUSTOM_PREFIX.length) : null;
}

/** The tokens a block sets, validated; anything else is dropped without comment. */
function readBlock(raw: unknown, allowed: readonly ThemeToken[]): Record<string, string> | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'must be an object of token → value';
  const values = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const token of allowed) {
    if (!(token in values)) continue;
    const value = safeValue(token, values[token]);
    if (value !== null) out[token] = value;
  }
  return out;
}
const readPalette = (raw: unknown) => readBlock(raw, THEME_COLOR_TOKENS);

/**
 * One theme file, read and validated. Never throws: a file that cannot be used
 * comes back with `problem` set, so the picker can say why rather than the
 * theme silently vanishing from the list after a typo.
 *
 * Two shapes are accepted. The original — `"appearance": "dark"` plus one
 * `"colors"` block — is a single-appearance theme. The paired form carries a
 * `"light"` block, a `"dark"` block, or both, each a token → color map; with
 * both, the theme follows the OS the way the System setting does. Either shape
 * may add a `"style"` block of non-color tokens (fonts, scales, radii, shadows).
 */
async function readThemeFile(dir: string, id: string, source: CustomTheme['source']): Promise<CustomTheme> {
  const theme: CustomTheme = { id, name: id, source };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8'));
  } catch (e) {
    const reason = e instanceof SyntaxError ? 'is not valid JSON' : 'could not be read';
    return { ...theme, problem: `${id}.json ${reason}` };
  }
  const doc = raw as {
    name?: unknown;
    appearance?: unknown;
    colors?: unknown;
    light?: unknown;
    dark?: unknown;
    style?: unknown;
  };
  if (!doc || typeof doc !== 'object') return { ...theme, problem: `${id}.json is not a JSON object` };
  if (typeof doc.name === 'string' && doc.name.trim()) theme.name = doc.name.trim();
  if (doc.style !== undefined) {
    const style = readBlock(doc.style, THEME_STYLE_TOKENS);
    if (typeof style === 'string') return { ...theme, problem: `"style" ${style}` };
    theme.style = style;
  }

  const paired = doc.light !== undefined || doc.dark !== undefined;
  if (paired) {
    for (const appearance of ['light', 'dark'] as const) {
      if (doc[appearance] === undefined) continue;
      const palette = readPalette(doc[appearance]);
      if (typeof palette === 'string') return { ...theme, problem: `"${appearance}" ${palette}` };
      theme[appearance] = palette;
    }
    return theme;
  }
  if (doc.appearance !== 'light' && doc.appearance !== 'dark') {
    return { ...theme, problem: `"appearance" must be "light" or "dark" (or give "light" / "dark" palettes)` };
  }
  const palette = readPalette(doc.colors ?? {});
  if (typeof palette === 'string') return { ...theme, problem: `"colors" ${palette}` };
  theme[doc.appearance] = palette;
  return theme;
}

/** The theme ids in one folder — `.json` files, minus the example and dotfiles. */
async function themeIds(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // no folder — no bundled themes in this build, or nobody has made one
  }
  return entries
    .filter((name) => name.endsWith('.json') && !name.startsWith('_') && !name.startsWith('.'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

/**
 * Every theme: the bundled ones first, then the user's, each group sorted by
 * id, broken ones included (with `problem` set). A user file shadows a bundled
 * theme of the same id — it is the natural way to tweak a shipped theme.
 */
export async function listThemes(): Promise<CustomTheme[]> {
  const [bundledIds, userIds] = await Promise.all([themeIds(bundledThemesDir()), themeIds(themesDir())]);
  const shadowed = new Set(userIds);
  const bundled = bundledIds.filter((id) => !shadowed.has(id)).map((id) => readThemeFile(bundledThemesDir(), id, 'bundled'));
  const user = userIds.map((id) => readThemeFile(themesDir(), id, 'user'));
  return Promise.all([...bundled, ...user]);
}

/** The theme `selected` names, read fresh from disk: the user's file if there is one, else the bundled one. */
async function readSelectedTheme(id: string): Promise<CustomTheme> {
  if (existsSync(join(themesDir(), `${id}.json`))) return readThemeFile(themesDir(), id, 'user');
  if (existsSync(join(bundledThemesDir(), `${id}.json`))) return readThemeFile(bundledThemesDir(), id, 'bundled');
  return { id, name: id, source: 'user', problem: `${id}.json is gone from the themes folder` };
}

/** The stored choice plus the theme file it names, read fresh from disk. */
export async function currentThemeState(): Promise<ThemeState> {
  const { theme } = await readClientSettings();
  const id = customThemeId(theme.selected);
  if (!id) return { selected: theme.selected, custom: null };
  const custom = await readSelectedTheme(id);
  if (custom.problem) log('themes', 'the selected theme is unusable', { id, problem: custom.problem });
  return { selected: theme.selected, custom };
}

/**
 * The BrowserWindow backgroundColor this theme wants, so first paint doesn't
 * flash the wrong chrome. `systemDark` answers for `'system'` and for a theme
 * that carries both palettes (the caller reads nativeTheme at window-creation
 * time — it can change while the app runs). A custom theme paints its own
 * `panel` when it sets one as plain hex — the one form Electron's
 * backgroundColor reliably takes.
 */
export function resolveWindowBackground(state: ThemeState, systemDark: boolean): string {
  const palette = resolvePalette(state.custom, systemDark);
  if (palette) {
    const panel = palette.colors.panel ?? palette.colors.paper;
    if (panel && /^#[0-9a-fA-F]{3,8}$/.test(panel)) return panel;
    return BUILTIN_BG[palette.appearance];
  }
  if (state.selected === 'light' || state.selected === 'dark') return BUILTIN_BG[state.selected];
  return systemDark ? BUILTIN_BG.dark : BUILTIN_BG.light;
}

/**
 * Follow the user's themes folder: `onChange` fires (debounced) whenever a file
 * in it is added, edited or removed, so a saved edit shows up without a reload
 * button. The folder may not exist yet — then its parent is watched for the
 * folder to appear (ensureThemesDir creates it on "Open themes folder") and the
 * watch moves inside. Returns a stop function.
 */
export function watchThemes(onChange: () => void): () => void {
  const dir = themesDir();
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const fire = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, 150);
  };
  const swap = (next: FSWatcher | null) => {
    watcher?.close();
    watcher = next;
  };

  const watchDir = (): boolean => {
    try {
      const w = watch(dir, () => {
        // The folder itself went away: fall back to waiting for it to return.
        if (!existsSync(dir)) {
          watchParent();
          fire();
          return;
        }
        fire();
      });
      w.on('error', () => {
        if (!stopped) watchParent();
      });
      swap(w);
      return true;
    } catch {
      return false;
    }
  };
  const watchParent = (): void => {
    try {
      const w = watch(dirname(dir), (_event, name) => {
        if (name?.toString() !== basename(dir) || !existsSync(dir)) return;
        if (watchDir()) fire();
      });
      w.on('error', () => undefined); // nothing left to fall back to; Reload-by-repick still works
      swap(w);
    } catch {
      swap(null);
    }
  };

  if (!watchDir()) watchParent();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    swap(null);
  };
}

/**
 * The starting point a new theme is copied from: every color token, filled with
 * the built-in palettes — both of them, so the copy follows the OS until its
 * author deletes the block they do not want — plus the style knobs most themes
 * reach for (the full list is THEME_STYLE_TOKENS). Underscore-prefixed so the
 * lister skips it — it is documentation, not a theme — and rewritten on every
 * reveal so it always matches the tokens this build understands.
 */
const EXAMPLE = {
  name: 'My theme (copy this file, e.g. to my-theme.json)',
  style: {
    'font-ui': "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
    'font-mono': "'SF Mono', ui-monospace, monospace",
    'type-scale': '1',
    'space-scale': '1',
    'shadow-scale': '1',
    'radius-sm': '4px',
    radius: '6px',
    'radius-md': '8px',
    'radius-lg': '12px'
  },
  light: {
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
  },
  dark: {
    paper: '#1c1a17',
    content: '#242119',
    panel: '#161411',
    ink: '#f0ece4',
    muted: '#9b948a',
    line: '#3d382f',
    hair: 'rgba(240, 236, 228, 0.16)',
    accent: '#c79257',
    'accent-ink': '#22150a',
    surface: '#2e2a23',
    field: '#2e2a23',
    sel: 'rgba(199, 146, 87, 0.22)',
    'inline-bg': '#2f2b25',
    info: '#2b6cb0',
    warn: '#b7791f',
    success: '#5fae74',
    danger: '#c53030',
    'code-bg': '#161310',
    'code-ink': '#f4efe7',
    'drop-chat': '#c79257',
    'drop-files': '#4cc0a8'
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

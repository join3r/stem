// Custom themes: what a theme file may say, what happens to one that says it
// wrong, where the two folders (bundled + the user's) meet, the folder watch,
// and the window chrome color every BrowserWindow is born with. The validation
// is the point — a theme file is user-authored JSON applied to every window, so
// unknown tokens, unsafe values and path-shaped ids must all die here rather
// than reach a stylesheet.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundledThemesDir,
  currentThemeState,
  ensureThemesDir,
  listThemes,
  resolveWindowBackground,
  themesDir,
  watchThemes
} from '../../src/desktop/themes';
import { resolvePalette } from '../../src/shared/theme';
import { updateClientTheme } from '../../src/desktop/settings';
import { clientStorePath } from '../../src/desktop/client-store';
import type { CustomTheme, ThemeState } from '../../src/shared/types';

const root = join(tmpdir(), `stem-themes-${process.pid}`);
const dir = join(root, 'themes');
const bundled = join(root, 'bundled');

function writeTheme(id: string, doc: unknown, where = dir): void {
  writeFileSync(join(where, `${id}.json`), typeof doc === 'string' ? doc : JSON.stringify(doc));
}

beforeEach(() => {
  process.env.STEM_THEMES_DIR = dir;
  process.env.STEM_BUNDLED_THEMES_DIR = bundled;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(bundled, { recursive: true });
  rmSync(clientStorePath(), { force: true });
});

afterEach(() => {
  delete process.env.STEM_THEMES_DIR;
  delete process.env.STEM_BUNDLED_THEMES_DIR;
  rmSync(root, { recursive: true, force: true });
  rmSync(clientStorePath(), { force: true });
});

describe('reading the themes folder', () => {
  it('lists themes sorted, keeping names and validated colors', async () => {
    writeTheme('zephyr', { name: 'Zephyr', appearance: 'light', colors: { paper: '#ffffff' } });
    writeTheme('abyss', { name: 'Abyss', appearance: 'dark', colors: { ink: 'rgb(230, 230, 230)' } });

    const themes = await listThemes();
    expect(themes.map((t) => t.id)).toEqual(['abyss', 'zephyr']);
    expect(themes[0]).toEqual({ id: 'abyss', name: 'Abyss', source: 'user', dark: { ink: 'rgb(230, 230, 230)' } });
  });

  it('skips the example and dotfiles, and answers with nothing when the folders are absent', async () => {
    writeTheme('_example', { appearance: 'light' });
    writeFileSync(join(dir, '.DS_Store'), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    expect(await listThemes()).toEqual([]);

    rmSync(root, { recursive: true, force: true });
    expect(await listThemes()).toEqual([]);
  });

  it('drops unknown tokens and values that could smuggle CSS', async () => {
    writeTheme('sneaky', {
      appearance: 'light',
      colors: {
        paper: '#fff',
        wallpaper: '#000', // not a token
        ink: 'url(https://evil.example/x.png)',
        accent: 'var(--paper)',
        muted: '#123456; background: red',
        line: 42
      }
    });
    const [theme] = await listThemes();
    expect(theme.light).toEqual({ paper: '#fff' });
    expect(theme.problem).toBeUndefined();
  });

  it('keeps a broken file in the list, with the reason', async () => {
    writeTheme('torn', '{ not json');
    writeTheme('confused', { appearance: 'sepia' });
    writeTheme('flat', { light: ['#fff'] });

    const themes = await listThemes();
    expect(themes.find((t) => t.id === 'torn')?.problem).toContain('not valid JSON');
    expect(themes.find((t) => t.id === 'confused')?.problem).toContain('appearance');
    expect(themes.find((t) => t.id === 'flat')?.problem).toContain('"light"');
  });
});

describe('a theme with a light and a dark palette', () => {
  it('reads both blocks, or just the one it has', async () => {
    writeTheme('pair', { name: 'Pair', light: { paper: '#fff' }, dark: { paper: '#000', wallpaper: 'x' } });
    writeTheme('night', { dark: { paper: '#111' } });
    const themes = await listThemes();
    expect(themes.find((t) => t.id === 'pair')).toEqual({
      id: 'pair',
      name: 'Pair',
      source: 'user',
      light: { paper: '#fff' },
      dark: { paper: '#000' }
    });
    expect(themes.find((t) => t.id === 'night')).toEqual({ id: 'night', name: 'night', source: 'user', dark: { paper: '#111' } });
  });

  it('follows the OS when it has both palettes, and stays put when it has one', () => {
    const pair: CustomTheme = { id: 'p', name: 'p', source: 'user', light: { paper: '#fff' }, dark: { paper: '#000' } };
    expect(resolvePalette(pair, false)).toEqual({ appearance: 'light', colors: { paper: '#fff' } });
    expect(resolvePalette(pair, true)).toEqual({ appearance: 'dark', colors: { paper: '#000' } });
    const night: CustomTheme = { id: 'n', name: 'n', source: 'user', dark: { paper: '#000' } };
    expect(resolvePalette(night, false)).toEqual({ appearance: 'dark', colors: { paper: '#000' } });
    expect(resolvePalette({ ...pair, problem: 'torn' }, true)).toBeNull();
    expect(resolvePalette(null, true)).toBeNull();
  });
});

describe('the style block', () => {
  it('takes fonts, multipliers, lengths and shadows, each by its own rule', async () => {
    writeTheme('styled', {
      appearance: 'light',
      colors: {},
      style: {
        'font-ui': " 'Inter', system-ui, sans-serif ",
        'font-mono': 'JetBrains Mono, monospace',
        'type-scale': 1.1,
        'space-scale': '0.9',
        'shadow-scale': 0,
        radius: '0px',
        'radius-lg': '1.25rem',
        'shadow-pop': 'none',
        'shadow-btn': '0 1px 2px rgba(0, 0, 0, 0.4)'
      }
    });
    const [theme] = await listThemes();
    expect(theme.problem).toBeUndefined();
    expect(theme.style).toEqual({
      'font-ui': "'Inter', system-ui, sans-serif",
      'font-mono': 'JetBrains Mono, monospace',
      'type-scale': '1.1',
      'space-scale': '0.9',
      'shadow-scale': '0',
      radius: '0px',
      'radius-lg': '1.25rem',
      'shadow-pop': 'none',
      'shadow-btn': '0 1px 2px rgba(0, 0, 0, 0.4)'
    });
  });

  it('drops what could break the app or smuggle CSS, and color tokens in the wrong block', async () => {
    writeTheme('wild', {
      appearance: 'light',
      colors: { 'font-ui': 'Comic Sans' }, // not a color token
      style: {
        paper: '#fff', // not a style token
        'font-ui': 'url(evil)',
        'font-mono': 'a; background: red',
        'type-scale': 0.1, // below the floor
        'space-scale': 'big',
        'shadow-scale': 3, // above the ceiling
        radius: '12', // no unit
        'radius-md': '10%',
        'sp-4': 'var(--sp-12)',
        'shadow-pop': 'url(x)'
      }
    });
    const [theme] = await listThemes();
    expect(theme.light).toEqual({});
    expect(theme.style).toEqual({});
    writeTheme('flat', { appearance: 'light', colors: {}, style: 'compact' });
    expect((await listThemes()).find((t) => t.id === 'flat')?.problem).toContain('"style"');
  });
});

describe('themes shipped with the app', () => {
  it('are listed before the user’s, and a user file of the same id shadows the bundled one', async () => {
    writeTheme('storm', { name: 'Storm (shipped)', appearance: 'dark', colors: {} }, bundled);
    writeTheme('aurora', { name: 'Aurora', appearance: 'light', colors: {} }, bundled);
    writeTheme('storm', { name: 'Storm (mine)', appearance: 'dark', colors: { accent: '#f00' } });
    writeTheme('zephyr', { name: 'Zephyr', appearance: 'light', colors: {} });

    const themes = await listThemes();
    expect(themes.map((t) => [t.id, t.source, t.name])).toEqual([
      ['aurora', 'bundled', 'Aurora'],
      ['storm', 'user', 'Storm (mine)'],
      ['zephyr', 'user', 'Zephyr']
    ]);
  });

  it('can be selected, and the user’s copy wins for the selection too', async () => {
    writeTheme('storm', { name: 'Storm (shipped)', appearance: 'dark', colors: {} }, bundled);
    await updateClientTheme({ selected: 'custom:storm' });
    expect((await currentThemeState()).custom).toMatchObject({ name: 'Storm (shipped)', source: 'bundled' });

    writeTheme('storm', { name: 'Storm (mine)', appearance: 'dark', colors: {} });
    expect((await currentThemeState()).custom).toMatchObject({ name: 'Storm (mine)', source: 'user' });
  });

  it('the repo ships valid themes that set every token', async () => {
    delete process.env.STEM_BUNDLED_THEMES_DIR;
    process.env.STEM_APP_ROOT = process.cwd();
    try {
      expect(bundledThemesDir()).toBe(join(process.cwd(), 'themes'));
      const shipped = (await listThemes()).filter((t) => t.source === 'bundled');
      expect(shipped.length).toBeGreaterThan(0);
      for (const theme of shipped) {
        expect(theme.problem, theme.id).toBeUndefined();
        for (const palette of [theme.light, theme.dark]) {
          if (palette) expect(Object.keys(palette).length, theme.id).toBe(21);
        }
      }
    } finally {
      delete process.env.STEM_APP_ROOT;
    }
  });
});

describe('the state a window paints from', () => {
  it('carries no custom theme for the built-in modes', async () => {
    await updateClientTheme({ selected: 'dark' });
    expect(await currentThemeState()).toEqual({ selected: 'dark', custom: null });
  });

  it('resolves the selected custom theme, and says so when its file is gone', async () => {
    writeTheme('zephyr', { name: 'Zephyr', appearance: 'light', colors: {} });
    await updateClientTheme({ selected: 'custom:zephyr' });
    expect((await currentThemeState()).custom?.name).toBe('Zephyr');

    rmSync(join(dir, 'zephyr.json'));
    const state = await currentThemeState();
    expect(state.selected).toBe('custom:zephyr');
    expect(state.custom?.problem).toBeTruthy();
  });
});

describe('the window chrome color', () => {
  const none: ThemeState = { selected: 'system', custom: null };

  it('follows the OS for system and the palette for forced modes', () => {
    expect(resolveWindowBackground(none, false)).toBe('#efece5');
    expect(resolveWindowBackground(none, true)).toBe('#1b1916');
    expect(resolveWindowBackground({ selected: 'dark', custom: null }, false)).toBe('#1b1916');
    expect(resolveWindowBackground({ selected: 'light', custom: null }, true)).toBe('#efece5');
  });

  it('takes a custom theme’s own chrome when it is plain hex, its palette when not', () => {
    const theme = (dark: Record<string, string>): ThemeState => ({
      selected: 'custom:t',
      custom: { id: 't', name: 't', source: 'user', dark }
    });
    expect(resolveWindowBackground(theme({ panel: '#101820' }), false)).toBe('#101820');
    expect(resolveWindowBackground(theme({ paper: '#101820' }), false)).toBe('#101820');
    expect(resolveWindowBackground(theme({ panel: 'rgb(1, 2, 3)' }), false)).toBe('#1b1916');
    // A broken selection falls back to the OS, not to the broken file's appearance.
    const broken: ThemeState = {
      selected: 'custom:t',
      custom: { id: 't', name: 't', source: 'user', dark: {}, problem: 'torn' }
    };
    expect(resolveWindowBackground(broken, false)).toBe('#efece5');
  });

  it('follows the OS through a paired theme', () => {
    const pair: ThemeState = {
      selected: 'custom:p',
      custom: { id: 'p', name: 'p', source: 'bundled', light: { panel: '#eeeeee' }, dark: { panel: '#111111' } }
    };
    expect(resolveWindowBackground(pair, false)).toBe('#eeeeee');
    expect(resolveWindowBackground(pair, true)).toBe('#111111');
  });
});

describe('the example file', () => {
  it('is written on reveal and never shows up as a theme', async () => {
    rmSync(dir, { recursive: true, force: true });
    await ensureThemesDir();
    expect(themesDir()).toBe(dir);
    expect(await listThemes()).toEqual([]);
  });
});

describe('watching the folder', () => {
  // fs.watch on macOS comes up asynchronously: a write in the first moments after
  // watch() can precede the event stream, and a loaded CI box widens that gap.
  // The app never edits a file that soon after boot; the test just waits it out.
  const warmUp = () => new Promise((r) => setTimeout(r, 300));
  const settle = (check: () => boolean) =>
    new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (check()) return resolve();
        if (Date.now() - started > 4000) return reject(new Error('watcher never fired'));
        setTimeout(tick, 25);
      };
      tick();
    });

  it('fires on an edit, and again on a delete', async () => {
    // The debounce collapses a burst most of the time, but how FSEvents spaces
    // two writes is not ours to assert on — only that each change is seen.
    let fired = 0;
    const stop = watchThemes(() => fired++);
    try {
      await warmUp();
      writeTheme('a', { appearance: 'light', colors: {} });
      await settle(() => fired >= 1);
      await new Promise((r) => setTimeout(r, 250));
      const afterEdit = fired;
      rmSync(join(dir, 'a.json'));
      await settle(() => fired > afterEdit);
    } finally {
      stop();
    }
  });

  it('waits for a folder that does not exist yet, then follows it', async () => {
    rmSync(dir, { recursive: true, force: true });
    let fired = 0;
    const stop = watchThemes(() => fired++);
    try {
      await warmUp();
      await ensureThemesDir(); // "Open themes folder" — creates it
      await settle(() => fired >= 1);
      const seen = fired;
      writeTheme('late', { appearance: 'dark', colors: {} });
      await settle(() => fired > seen);
    } finally {
      stop();
    }
  });
});

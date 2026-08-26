// Custom themes: what a theme file may say, what happens to one that says it
// wrong, and the window chrome color every BrowserWindow is born with. The
// validation is the point — a theme file is user-authored JSON applied to every
// window, so unknown tokens, unsafe values and path-shaped ids must all die
// here rather than reach a stylesheet.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  currentThemeState,
  ensureThemesDir,
  listThemes,
  resolveWindowBackground,
  themesDir
} from '../../src/desktop/themes';
import { updateClientTheme } from '../../src/desktop/settings';
import { clientStorePath } from '../../src/desktop/client-store';
import type { ThemeState } from '../../src/shared/types';

const dir = join(tmpdir(), `stem-themes-${process.pid}`);

function writeTheme(id: string, doc: unknown): void {
  writeFileSync(join(dir, `${id}.json`), typeof doc === 'string' ? doc : JSON.stringify(doc));
}

beforeEach(() => {
  process.env.STEM_THEMES_DIR = dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  rmSync(clientStorePath(), { force: true });
});

afterEach(() => {
  delete process.env.STEM_THEMES_DIR;
  rmSync(dir, { recursive: true, force: true });
  rmSync(clientStorePath(), { force: true });
});

describe('reading the themes folder', () => {
  it('lists themes sorted, keeping names and validated colors', async () => {
    writeTheme('zephyr', { name: 'Zephyr', appearance: 'light', colors: { paper: '#ffffff' } });
    writeTheme('abyss', { name: 'Abyss', appearance: 'dark', colors: { ink: 'rgb(230, 230, 230)' } });

    const themes = await listThemes();
    expect(themes.map((t) => t.id)).toEqual(['abyss', 'zephyr']);
    expect(themes[0]).toEqual({ id: 'abyss', name: 'Abyss', appearance: 'dark', colors: { ink: 'rgb(230, 230, 230)' } });
  });

  it('skips the example and dotfiles, and answers with nothing when the folder is absent', async () => {
    writeTheme('_example', { appearance: 'light' });
    writeFileSync(join(dir, '.DS_Store'), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    expect(await listThemes()).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
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
    expect(theme.colors).toEqual({ paper: '#fff' });
    expect(theme.problem).toBeUndefined();
  });

  it('keeps a broken file in the list, with the reason', async () => {
    writeTheme('torn', '{ not json');
    writeTheme('confused', { appearance: 'sepia' });

    const themes = await listThemes();
    expect(themes.find((t) => t.id === 'torn')?.problem).toContain('not valid JSON');
    expect(themes.find((t) => t.id === 'confused')?.problem).toContain('appearance');
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
    const theme = (colors: Record<string, string>): ThemeState => ({
      selected: 'custom:t',
      custom: { id: 't', name: 't', appearance: 'dark', colors }
    });
    expect(resolveWindowBackground(theme({ panel: '#101820' }), false)).toBe('#101820');
    expect(resolveWindowBackground(theme({ paper: '#101820' }), false)).toBe('#101820');
    expect(resolveWindowBackground(theme({ panel: 'rgb(1, 2, 3)' }), false)).toBe('#1b1916');
    // A broken selection falls back to the OS, not to the broken file's appearance.
    const broken: ThemeState = {
      selected: 'custom:t',
      custom: { id: 't', name: 't', appearance: 'dark', colors: {}, problem: 'torn' }
    };
    expect(resolveWindowBackground(broken, false)).toBe('#efece5');
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

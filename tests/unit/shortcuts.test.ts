import { afterAll, describe, expect, it, vi } from 'vitest';
import { BINDINGS, glyphsFor } from '../../src/renderer/shortcuts';

// These run in the node environment, where `window` is undefined — so accel's
// IS_MAC is false and BINDINGS evaluates its Windows/Linux branch. That makes
// this file the non-mac half of the shortcut contract: what a Windows or Linux
// user actually sees on a keycap, and what their keyboard actually fires.

/** The mac-only glyph vocabulary. None of it belongs on a PC keyboard. */
const MAC_GLYPHS = /[⌘⌥⇧⌃✦]/;

/** A keydown as the matchers read it. */
const key = (k: string, mods: Partial<Record<'ctrl' | 'meta' | 'alt' | 'shift', boolean>> = {}) =>
  ({
    key: k,
    ctrlKey: !!mods.ctrl,
    metaKey: !!mods.meta,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift
  }) as KeyboardEvent;

describe('keycaps off macOS', () => {
  it('never shows a Command or Option glyph', () => {
    for (const b of BINDINGS) expect(b.glyphs).not.toMatch(MAC_GLYPHS);
  });

  it('spells every modifier combo as Ctrl+… text', () => {
    for (const b of BINDINGS) {
      if (b.match === null) continue; // display-only (Enter)
      expect(b.glyphs.startsWith('Ctrl+')).toBe(true);
    }
    expect(glyphsFor('switch-chat')).toBe('Ctrl+1–9');
    expect(glyphsFor('archive-thread')).toBe('Ctrl+Shift+A');
    expect(glyphsFor('snooze-thread')).toBe('Ctrl+Shift+S');
    expect(glyphsFor('toggle-read')).toBe('Ctrl+Shift+D');
    // The one mac binding that isn't ⌘-based still has to read plainly here.
    expect(glyphsFor('delete-thread')).toBe('Ctrl+Shift+X');
  });
});

// The other half: re-import the module with the bridge reporting macOS, so the
// glyph branch is covered by the same file rather than only by inspection.
describe('keycaps on macOS', () => {
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const macBindings = async () => {
    vi.stubGlobal('window', { stem: { platform: 'darwin' } });
    vi.resetModules();
    return (await import('../../src/renderer/shortcuts')).BINDINGS;
  };

  it('uses glyphs, and never spells a modifier out', async () => {
    const bindings = await macBindings();
    const cap = (id: string) => bindings.find((b) => b.id === id)?.glyphs;
    expect(cap('archive-thread')).toBe('⌘⇧A');
    expect(cap('snooze-thread')).toBe('⌘⇧S');
    expect(cap('toggle-read')).toBe('⌘⇧D');
    expect(cap('attach')).toBe('⌘U');
    expect(cap('switch-chat')).toBe('⌘1–9');
    expect(cap('delete-thread')).toBe('⌃X');
    for (const b of bindings) expect(b.glyphs).not.toMatch(/Ctrl|Shift\+|Alt/);
  });

  it('binds ⌘, not Ctrl — the two are exclusive on mac', async () => {
    const bindings = await macBindings();
    const archive = bindings.find((b) => b.id === 'archive-thread')!;
    expect(archive.match?.(key('a', { meta: true, shift: true }))).toBe(true);
    expect(archive.match?.(key('a', { ctrl: true, shift: true }))).toBe(false);
  });
});

describe('binding collisions', () => {
  it('gives every binding its own keycap', () => {
    const caps = BINDINGS.map((b) => b.glyphs);
    expect(new Set(caps).size).toBe(caps.length);
  });

  it('leaves the accelerators Electron’s default Windows/Linux menu owns', () => {
    // No app menu is installed off macOS, so Electron's default one is live and
    // claims these before the renderer ever sees the keydown.
    const MENU = [
      'Ctrl+R',
      'Ctrl+Shift+R',
      'Ctrl+Shift+I',
      'Ctrl+W',
      'Ctrl+M',
      'Ctrl+A',
      'Ctrl+Z',
      'Ctrl+Y',
      'Ctrl+X',
      'Ctrl+C',
      'Ctrl+V',
      'Ctrl+0'
    ];
    for (const b of BINDINGS) expect(MENU).not.toContain(b.glyphs);
  });

  it('leaves the sequences a Linux input method swallows', () => {
    // IBus (the GNOME/Ubuntu default) takes Ctrl+Shift+U for Unicode code-point
    // entry and Ctrl+Shift+E for emoji: bind either and the app never sees it.
    for (const b of BINDINGS) expect(['Ctrl+Shift+U', 'Ctrl+Shift+E']).not.toContain(b.glyphs);
  });
});

describe('what the keyboard actually fires', () => {
  const fired = (e: KeyboardEvent) => BINDINGS.filter((b) => b.match?.(e)).map((b) => b.id);

  it('routes each inbox combo to exactly one action', () => {
    expect(fired(key('A', { ctrl: true, shift: true }))).toEqual(['archive-thread']);
    expect(fired(key('s', { ctrl: true, shift: true }))).toEqual(['snooze-thread']);
    expect(fired(key('D', { ctrl: true, shift: true }))).toEqual(['toggle-read']);
  });

  it('routes Ctrl+1 through Ctrl+9 to switch-chat, and nothing else', () => {
    for (const d of '123456789') expect(fired(key(d, { ctrl: true }))).toEqual(['switch-chat']);
    // Shift is unconstrained: AZERTY reaches its digits on the shifted layer.
    expect(fired(key('4', { ctrl: true, shift: true }))).toEqual(['switch-chat']);
    // Ctrl+0 is Electron's reset-zoom; a bare digit is typing.
    expect(fired(key('0', { ctrl: true }))).toEqual([]);
    expect(fired(key('3'))).toEqual([]);
    expect(fired(key('3', { ctrl: true, alt: true }))).toEqual([]);
  });

  it('leaves Ctrl+Shift+U unbound, so IBus can have it', () => {
    expect(fired(key('u', { ctrl: true, shift: true }))).toEqual([]);
    expect(fired(key('u', { ctrl: true }))).toEqual(['attach']);
  });

  it('ignores the Command key, which on Windows/Linux is the Super key', () => {
    for (const k of ['a', 's', 'u', 'n', 'f']) expect(fired(key(k, { meta: true }))).toEqual([]);
  });

  it('ignores combos that add Alt, so AltGr typing is never swallowed', () => {
    expect(fired(key('a', { ctrl: true, shift: true, alt: true }))).toEqual([]);
    expect(fired(key('u', { ctrl: true, alt: true }))).toEqual([]);
  });

  it('lets unmodified typing through untouched', () => {
    for (const k of ['a', 's', 'u', 'e', 'n']) expect(fired(key(k))).toEqual([]);
  });
});

// Key and chord parsing for the extension's `press` (src/browser-extension/keys.js):
// the Input.dispatchKeyEvent sequence, and the macOS editing commands without
// which a synthetic Cmd-A or Backspace does nothing on a Mac.
import { describe, expect, it } from 'vitest';
import { keyPresses as parseKeys } from '../../src/browser-extension/keys.js';

// The result is a union with { error }; these cases all parse.
const keyPresses = (spec: string, opts?: { mac?: boolean }) => parseKeys(spec, opts) as any;

const types = (r: { events: { type: string; key: string }[] }) => r.events.map((e) => `${e.type}:${e.key}`);

describe('keyPresses', () => {
  it('presses Enter with its text so forms submit', () => {
    const r = keyPresses('Enter') as any;
    expect(types(r)).toEqual(['keyDown:Enter', 'keyUp:Enter']);
    expect(r.events[0]).toMatchObject({ code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    // insertNewline is left to the key's own text; sending both types two lines.
    expect(r.events[0].commands).toBeUndefined();
  });

  it('sends named keys as rawKeyDown with the Mac command', () => {
    const r = keyPresses('Backspace') as any;
    expect(r.events[0]).toMatchObject({ type: 'rawKeyDown', key: 'Backspace', windowsVirtualKeyCode: 8, commands: ['deleteBackward'] });
    expect(keyPresses('ArrowDown').events[0]).toMatchObject({ code: 'ArrowDown', windowsVirtualKeyCode: 40, commands: ['moveDown'] });
    expect(keyPresses('Backspace', { mac: false }).events[0].commands).toBeUndefined();
  });

  it('wraps a chord in modifier downs and ups, in order', () => {
    const r = keyPresses('Control+Shift+T') as any;
    expect(types(r)).toEqual(['rawKeyDown:Control', 'rawKeyDown:Shift', 'rawKeyDown:T', 'keyUp:T', 'keyUp:Shift', 'keyUp:Control']);
    expect(r.events[0].modifiers).toBe(2);
    expect(r.events[1].modifiers).toBe(10);
    expect(r.events[2]).toMatchObject({ code: 'KeyT', windowsVirtualKeyCode: 84, modifiers: 10 });
    expect(r.events[2].text).toBeUndefined();
    expect(r.events.at(-1).modifiers).toBe(0);
  });

  it('maps Cmd editing chords to their commands, letter case aside', () => {
    expect(keyPresses('Meta+A').events[1]).toMatchObject({ key: 'a', code: 'KeyA', modifiers: 4, commands: ['selectAll'] });
    expect(keyPresses('cmd+a').events[1]).toMatchObject({ commands: ['selectAll'] });
    expect(keyPresses('Meta+C').events[1].commands).toEqual(['copy']);
    expect(keyPresses('Meta+V').events[1].commands).toEqual(['paste']);
    expect(keyPresses('Meta+X').events[1].commands).toEqual(['cut']);
    expect(keyPresses('Meta+Z').events[1].commands).toEqual(['undo']);
    expect(keyPresses('Meta+Shift+Z').events[2].commands).toEqual(['redo']);
  });

  it('types characters, implying Shift for capitals and shifted symbols', () => {
    expect(keyPresses('a').events[0]).toMatchObject({ type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 });
    expect(keyPresses('A').events[0]).toMatchObject({ key: 'A', code: 'KeyA', text: 'A', modifiers: 8 });
    expect(keyPresses('?').events[0]).toMatchObject({ code: 'Slash', windowsVirtualKeyCode: 191, text: '?', modifiers: 8 });
    expect(keyPresses('7').events[0]).toMatchObject({ code: 'Digit7', windowsVirtualKeyCode: 55, text: '7' });
    expect(keyPresses('é').events[0]).toMatchObject({ key: 'é', text: 'é', code: '' });
  });

  it('knows Space, F-keys, aliases and the plus key', () => {
    expect(keyPresses('Space').events[0]).toMatchObject({ key: ' ', code: 'Space', text: ' ' });
    expect(keyPresses('F5').events[0]).toMatchObject({ key: 'F5', windowsVirtualKeyCode: 116 });
    expect(keyPresses('F12').events[0]).toMatchObject({ windowsVirtualKeyCode: 123 });
    expect(keyPresses('esc').events[0]).toMatchObject({ key: 'Escape', windowsVirtualKeyCode: 27 });
    expect(keyPresses('Return').events[0]).toMatchObject({ key: 'Enter' });
    expect(keyPresses('PageDown').events[0]).toMatchObject({ windowsVirtualKeyCode: 34 });
    expect(keyPresses('Control++').events[1]).toMatchObject({ code: 'Equal', modifiers: 2 | 8 });
    expect(types(keyPresses('Shift') as any)).toEqual(['rawKeyDown:Shift', 'keyUp:Shift']);
  });

  it('refuses what it cannot press, with a usable sentence', () => {
    expect(keyPresses('').error).toMatch(/press needs a key/);
    expect(keyPresses('Hyper').error).toMatch(/Unknown key "Hyper"/);
    expect(keyPresses('A+Meta').error).toMatch(/only Meta, Control, Alt and Shift can come before the last key/);
    expect(keyPresses('Meta++A').error).toBeTruthy();
  });
});

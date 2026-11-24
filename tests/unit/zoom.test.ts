import { describe, expect, it } from 'vitest';
import { nextZoomFactor, zoomActionFor, ZOOM_STEPS } from '../../src/desktop/zoom';

// ⌘= (no Shift) must zoom in — Electron's zoomIn role only answered ⌘⇧=.
const key = (key: string, code: string, extra: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean }> = {}) => ({
  type: 'keyDown',
  key,
  code,
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...extra
});

describe('zoomActionFor', () => {
  it('maps ⌘+, ⌘=, ⌘-, ⌘0 on macOS', () => {
    expect(zoomActionFor(key('=', 'Equal', { meta: true }), true)).toBe('in');
    expect(zoomActionFor(key('+', 'Equal', { meta: true, shift: true }), true)).toBe('in');
    expect(zoomActionFor(key('-', 'Minus', { meta: true }), true)).toBe('out');
    expect(zoomActionFor(key('0', 'Digit0', { meta: true }), true)).toBe('reset');
    expect(zoomActionFor(key('+', 'NumpadAdd', { meta: true }), true)).toBe('in');
  });

  it('uses Ctrl off macOS', () => {
    expect(zoomActionFor(key('=', 'Equal', { control: true }), false)).toBe('in');
    expect(zoomActionFor(key('=', 'Equal', { meta: true }), false)).toBeNull();
    expect(zoomActionFor(key('=', 'Equal', { control: true }), true)).toBeNull();
  });

  it('trusts the layout character before the physical key', () => {
    // Slovak: + sits on the 1 key, - on the slash key.
    expect(zoomActionFor(key('+', 'Digit1', { meta: true }), true)).toBe('in');
    expect(zoomActionFor(key('-', 'Slash', { meta: true }), true)).toBe('out');
    // A layout that reports something else still zooms by physical key.
    expect(zoomActionFor(key('é', 'Digit0', { meta: true }), true)).toBe('reset');
  });

  it('ignores other keys, key-ups and Alt', () => {
    expect(zoomActionFor(key('1', 'Digit1', { meta: true }), true)).toBeNull();
    expect(zoomActionFor(key('=', 'Equal'), true)).toBeNull();
    expect(zoomActionFor({ ...key('=', 'Equal', { meta: true }), type: 'keyUp' }, true)).toBeNull();
    expect(zoomActionFor(key('=', 'Equal', { meta: true, alt: true }), true)).toBeNull();
    expect(zoomActionFor(key(')', 'Digit0', { meta: true, shift: true }), true)).toBeNull();
  });
});

describe('nextZoomFactor', () => {
  it('steps and clamps', () => {
    expect(nextZoomFactor(1, 'in')).toBe(1.1);
    expect(nextZoomFactor(1, 'out')).toBe(0.9);
    expect(nextZoomFactor(1.75, 'reset')).toBe(1);
    expect(nextZoomFactor(ZOOM_STEPS[ZOOM_STEPS.length - 1], 'in')).toBe(3);
    expect(nextZoomFactor(ZOOM_STEPS[0], 'out')).toBe(0.5);
    expect(nextZoomFactor(1.05, 'in')).toBe(1.1);
  });
});

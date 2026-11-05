import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow, Input } from 'electron';
import { host } from '../server/host';

// Page zoom for the main window: ⌘+ / ⌘= bigger, ⌘- smaller, ⌘0 back to 100%
// (Ctrl off macOS).
//
// Electron's zoomIn menu role listens for CmdOrCtrl+Plus only, which on a US
// keyboard means ⌘⇧= — the plain ⌘= every browser accepts did nothing. Other
// layouts put +, - and 0 on different keys again (Slovak has + on the 1 key). So
// the keys are caught here, in before-input-event, by the character the layout
// produced first and by the physical key second; preventDefault keeps the menu
// from acting on the same press.
//
// The level is remembered in zoom.json next to client.json and put back on every
// load. file:// zoom is per window in Electron, so the Quick Chat overlay and the
// progress pill keep their own fixed size.

export type ZoomAction = 'in' | 'out' | 'reset';

/** Chrome's zoom steps, trimmed to the range a chat window is still usable in. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

type KeyInput = Pick<Input, 'type' | 'key' | 'code' | 'meta' | 'control' | 'alt' | 'shift'>;

/** The zoom a key press asks for, or null when it is not a zoom key. */
export function zoomActionFor(input: KeyInput, mac: boolean): ZoomAction | null {
  if (input.type !== 'keyDown' || input.alt) return null;
  const mod = mac ? input.meta && !input.control : input.control && !input.meta;
  if (!mod) return null;
  switch (input.key) {
    case '+':
    case '=':
      return 'in';
    case '-':
    case '_':
      return 'out';
    case '0':
      return input.shift ? null : 'reset';
  }
  switch (input.code) {
    case 'Equal':
    case 'NumpadAdd':
      return 'in';
    case 'Minus':
    case 'NumpadSubtract':
      return 'out';
    case 'Digit0':
    case 'Numpad0':
      return input.shift ? null : 'reset';
  }
  return null;
}

/** The factor one step from `current`; 1 for a reset. */
export function nextZoomFactor(current: number, action: ZoomAction): number {
  if (action === 'reset') return 1;
  if (action === 'in') return ZOOM_STEPS.find((s) => s > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < current - 0.001) return ZOOM_STEPS[i];
  return ZOOM_STEPS[0];
}

function clampFactor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], value));
}

function zoomFilePath(): string {
  return join(host().stateRoot(), 'zoom.json');
}

let factor = 1;
let loaded: Promise<void> | null = null;

function loadOnce(): Promise<void> {
  loaded ??= readFile(zoomFilePath(), 'utf8')
    .then((text) => {
      factor = clampFactor((JSON.parse(text) as { factor?: unknown }).factor);
    })
    .catch(() => {
      factor = 1;
    });
  return loaded;
}

function save(): void {
  void writeFile(zoomFilePath(), JSON.stringify({ factor }) + '\n').catch(() => {});
}

let target: BrowserWindow | null = null;

/** Step the main window's zoom; also what the View menu items call. */
export function applyZoom(action: ZoomAction): void {
  void loadOnce().then(() => {
    factor = nextZoomFactor(factor, action);
    save();
    if (target && !target.isDestroyed()) target.webContents.setZoomFactor(factor);
  });
}

/** Catch the zoom keys on the main window and keep its zoom across loads. */
export function installZoom(win: BrowserWindow, mac: boolean): void {
  target = win;
  const contents = win.webContents;
  const restore = (): void => {
    void loadOnce().then(() => {
      if (!win.isDestroyed()) contents.setZoomFactor(factor);
    });
  };
  contents.on('did-finish-load', restore);
  contents.on('before-input-event', (event, input) => {
    const action = zoomActionFor(input, mac);
    if (!action) return;
    event.preventDefault();
    applyZoom(action);
  });
  win.on('closed', () => {
    if (target === win) target = null;
  });
}

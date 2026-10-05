import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserWindow } from 'electron';

// Where this build keeps the renderer and the preload script. electron-vite
// bundles the whole main process into dist/main/index.js, so import.meta.url
// resolves there and dist/preload + dist/renderer are its siblings. One module
// knows that, so there is one place to correct if the layout ever moves.
//
// All three windows load the SAME index.html; a URL flag picks which surface the
// renderer mounts (none = the main app, `quickchat` = the overlay, `hud` = the
// status pill).
const distMain = fileURLToPath(new URL('.', import.meta.url));

/** The Stem browser extension as built (copied from src/browser-extension), and its native-messaging host. */
export const BROWSER_EXTENSION_DIR = join(distMain, '../browser-extension');
export const BROWSER_NATIVE_HOST_SCRIPT = join(distMain, 'browser-native-host.js');

/** The sandboxed preload every window shares (CommonJS — sandboxed preloads must be). */
export const PRELOAD_SCRIPT = join(distMain, '../preload/index.cjs');

/** The built renderer, loaded off this client's own disk and never over the wire. */
const RENDERER_DIR = join(distMain, '../renderer');

/** Load the renderer into `win`; `surface` selects which one it mounts. */
export function loadRenderer(win: BrowserWindow, surface?: 'quickchat' | 'hud'): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    win.loadURL(surface ? `${devUrl}/?${surface}` : devUrl);
    return;
  }
  win.loadFile(join(RENDERER_DIR, 'index.html'), surface ? { search: surface } : undefined);
}

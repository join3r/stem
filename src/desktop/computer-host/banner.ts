import { BrowserWindow, screen } from 'electron';
import { workspaceVisibilityOptions } from '../platform';

// The "Stem is controlling this Mac" pill: a small always-on-top window at the
// top centre of the main display for as long as a run is on. It is the one
// thing the person at the machine sees that says why the cursor is moving —
// or, once the run has selected a window, which app is being worked on behind
// their back ("Stem is controlling Discord"). The Stop button matters in that
// second case: with the run inside one app, the person's own mouse and
// keyboard no longer end it, so the button does. (Driving the whole screen,
// the click itself is human input and the helper's tap ends the run first.)
// The page is a sandboxed data URL; Stop navigates to a sentinel URL and
// the main process intercepts that, so no preload or IPC surface is needed.

const WIDTH = 340;
const HEIGHT = 44;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent;font:13px -apple-system,BlinkMacSystemFont,sans-serif;-webkit-user-select:none}
  .pill{display:flex;align-items:center;gap:10px;height:36px;margin:4px;padding:0 6px 0 14px;border-radius:18px;
    background:rgba(20,20,24,.92);color:#fff;box-shadow:0 4px 18px rgba(0,0,0,.35)}
  .dot{width:8px;height:8px;border-radius:50%;background:#ff5f57;animation:p 1.2s infinite}
  @keyframes p{50%{opacity:.35}}
  .txt{flex:1;white-space:nowrap}
  button{height:26px;padding:0 12px;border:0;border-radius:13px;background:#fff;color:#111;font:600 12px -apple-system,sans-serif;cursor:pointer}
</style></head><body><div class="pill"><span class="dot"></span><span class="txt" id="txt">Stem is controlling this Mac</span>
<button onclick="location.href='https://stop.stem-banner.invalid/'">Stop</button></div></body></html>`;

// An https URL, not a custom scheme: Chromium routes unknown schemes to the OS
// instead of raising will-navigate. The host never resolves; it is cancelled first.
const STOP_URL = 'https://stop.stem-banner.invalid/';

export interface ComputerBanner {
  show(): void;
  hide(): void;
  /** Name what is being controlled: an app, or null for the whole Mac. */
  setTarget(app: string | null): void;
  /** The person pressed Stop. */
  onStop(handler: () => void): void;
  destroy(): void;
}

function labelFor(app: string | null): string {
  return app ? `Stem is controlling ${app}` : 'Stem is controlling this Mac';
}

export function createComputerBanner(): ComputerBanner {
  let win: BrowserWindow | null = null;
  let label = labelFor(null);
  let stopHandler: (() => void) | null = null;

  function applyLabel(w: BrowserWindow): void {
    const js = `document.getElementById('txt').textContent = ${JSON.stringify(label)};`;
    void w.webContents.executeJavaScript(js).catch(() => undefined);
  }

  function ensure(): BrowserWindow {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      // Never key, so every click is a first click: without this macOS swallows
      // it and the buttons do nothing.
      acceptFirstMouse: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    const opts = workspaceVisibilityOptions();
    if (opts) win.setVisibleOnAllWorkspaces(true, opts);
    win.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (url === STOP_URL) stopHandler?.();
    });
    win.webContents.on('did-finish-load', () => {
      if (win && !win.isDestroyed()) applyLabel(win);
    });
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`);
    return win;
  }

  return {
    show() {
      const w = ensure();
      const area = screen.getPrimaryDisplay().workArea;
      w.setPosition(Math.round(area.x + (area.width - WIDTH) / 2), area.y + 8);
      w.showInactive();
    },
    hide() {
      if (win && !win.isDestroyed()) win.hide();
    },
    setTarget(app) {
      label = labelFor(app);
      if (win && !win.isDestroyed()) applyLabel(win);
    },
    onStop(handler) {
      stopHandler = handler;
    },
    destroy() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    }
  };
}

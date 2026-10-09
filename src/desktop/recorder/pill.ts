import { BrowserWindow, screen } from 'electron';
import { workspaceVisibilityOptions } from '../platform';

// The recording pill: the computer-control banner's look (top centre, dark,
// always on top, every Space) with what a person recording needs — a timer,
// the last thing written down in plain words, where a typed value was traced
// to ("← Mail"), and Note / Pause / Stop. Hovering it drops down the last few
// steps. Like the banner it is a sandboxed data: page with no preload; every
// button navigates to a sentinel URL the main process cancels and acts on.
// The page's script goes in through executeJavaScript once it loads: the
// packaged app's CSP (script-src 'self') covers data: pages too, so an inline
// <script> never runs there, and the timer and buttons were dead.
// A real click on a window that never takes focus does not reach the page on
// macOS, acceptFirstMouse or not, so the helper's tap reports every press and
// pressAt clicks whatever button lies under it.

const WIDTH = 460;
const HEIGHT = 44;
const OPEN_HEIGHT = 44 + 8 + 5 * 22 + 16;
const NOTE_HEIGHT = 44 + 46;

const SENTINEL = 'https://rec.stem-pill.invalid/';

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent;font:13px -apple-system,BlinkMacSystemFont,sans-serif;-webkit-user-select:none;color:#fff;overflow:hidden}
  .pill{display:flex;align-items:center;gap:8px;height:36px;margin:4px;padding:0 5px 0 13px;border-radius:18px;
    background:rgba(20,20,24,.94);box-shadow:0 4px 18px rgba(0,0,0,.35)}
  .dot{flex:none;width:9px;height:9px;border-radius:50%;background:#ff5f57;animation:p 1.2s infinite}
  .paused .dot{animation:none;background:#9a9aa2}
  @keyframes p{50%{opacity:.35}}
  @media (prefers-reduced-motion:reduce){.dot{animation:none}}
  .time{flex:none;font-variant-numeric:tabular-nums;color:#c9c9cf;font-size:12px}
  .txt{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tag{flex:none;padding:2px 7px;border-radius:9px;background:rgba(199,146,87,.25);color:#f1c48f;font-size:11px;font-weight:600}
  .tag:empty{display:none}
  .warn{flex:none;padding:2px 7px;border-radius:9px;background:rgba(255,95,87,.22);color:#ffb3ae;font-size:11px;font-weight:600}
  .warn:empty{display:none}
  button{flex:none;height:26px;padding:0 10px;border:0;border-radius:13px;background:rgba(255,255,255,.12);color:#fff;font:600 12px -apple-system,sans-serif;cursor:pointer}
  button.stop{background:#fff;color:#111}
  .list{margin:0 12px;padding:8px 12px;border-radius:12px;background:rgba(20,20,24,.94);display:none}
  .open .list{display:block}
  .list div{height:22px;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#d6d6dc;font-size:12px}
  .note{margin:0 12px;display:none;gap:6px;padding:6px;border-radius:12px;background:rgba(20,20,24,.94)}
  .noting .note{display:flex}
  .noting .list{display:none}
  .note input{flex:1;height:26px;border:0;border-radius:8px;padding:0 9px;background:rgba(255,255,255,.12);color:#fff;font:13px -apple-system,sans-serif;outline:none}
</style></head><body><div id="root">
<div class="pill" id="pill"><span class="dot"></span><span class="time" id="time">0:00</span>
<span class="txt" id="txt">Recording — do the task as usual</span><span class="tag" id="tag"></span><span class="warn" id="warn"></span>
<button id="noteBtn">Note</button><button id="pauseBtn">Pause</button><button class="stop" id="stopBtn">Stop</button></div>
<div class="list" id="list"></div>
<form class="note" id="noteForm"><input id="noteInput" placeholder="A note for Stem (optional)" maxlength="500"><button type="submit">Add</button></form>
</div></body></html>`;

const SCRIPT = `(() => {
  // A press can arrive twice (the page's own click and the helper's report).
  let last = { what: '', at: 0 };
  const go = (what, q) => {
    if (what !== 'hover') {
      if (last.what === what && Date.now() - last.at < 600) return;
      last = { what, at: Date.now() };
    }
    location.href = '${SENTINEL}' + what + (q ? '?' + new URLSearchParams(q) : '');
  };
  window.press = (x, y) => {
    const el = document.elementFromPoint(x, y)?.closest('button, input');
    if (el?.tagName === 'INPUT') el.focus();
    else if (el) el.click();
  };
  document.getElementById('stopBtn').onclick = () => go('stop');
  document.getElementById('pauseBtn').onclick = () => go('pause');
  document.getElementById('noteBtn').onclick = () => go('note-open');
  document.getElementById('noteForm').onsubmit = (e) => { e.preventDefault(); go('note', { text: document.getElementById('noteInput').value }); };
  document.getElementById('noteInput').onkeydown = (e) => { if (e.key === 'Escape') go('note-cancel'); };
  let over = false;
  document.getElementById('root').onmouseenter = () => { if (!over) { over = true; go('hover', { on: '1' }); } };
  document.getElementById('root').onmouseleave = () => { if (over) { over = false; go('hover', { on: '0' }); } };
  window.render = (s) => {
    const root = document.getElementById('root');
    root.className = [s.paused ? 'paused' : '', s.open ? 'open' : '', s.noting ? 'noting' : ''].join(' ');
    document.getElementById('time').textContent = s.time;
    document.getElementById('txt').textContent = s.text;
    document.getElementById('tag').textContent = s.tag || '';
    document.getElementById('warn').textContent = s.warning || '';
    document.getElementById('pauseBtn').textContent = s.paused ? 'Resume' : 'Pause';
    const list = document.getElementById('list');
    list.replaceChildren(...(s.recent.length ? s.recent : ['Nothing yet']).map((t) => { const d = document.createElement('div'); d.textContent = t; return d; }));
    if (s.noting && document.activeElement?.id !== 'noteInput') { const i = document.getElementById('noteInput'); i.value = ''; i.focus(); }
  };
})();`;

export interface PillView {
  paused: boolean;
  /** "1:42" */
  time: string;
  /** The last step in plain words, or what to do now. */
  text: string;
  /** Where the last value was traced to ("← Mail"), if anywhere. */
  tag: string | null;
  /** Something about the recording itself the person should know ("No pictures"). */
  warning: string | null;
  /** The last few steps, newest last. */
  recent: string[];
}

export interface RecorderPillHandlers {
  stop(): void;
  togglePause(): void;
  note(text: string): void;
}

export interface RecorderPill {
  show(): void;
  hide(): void;
  render(view: PillView): void;
  /** A left press at screen point (x, y); clicks the pill's button there, if any. */
  pressAt(x: number, y: number): void;
  destroy(): void;
}

export function createRecorderPill(handlers: RecorderPillHandlers): RecorderPill {
  let win: BrowserWindow | null = null;
  let view: PillView | null = null;
  let open = false;
  let noting = false;

  function place(w: BrowserWindow): void {
    const height = noting ? NOTE_HEIGHT : open ? OPEN_HEIGHT : HEIGHT;
    const area = screen.getPrimaryDisplay().workArea;
    w.setBounds({ x: Math.round(area.x + (area.width - WIDTH) / 2), y: area.y + 8, width: WIDTH, height });
  }

  function paint(): void {
    if (!win || win.isDestroyed() || !view) return;
    const js = `window.render && window.render(${JSON.stringify({ ...view, open, noting })});`;
    void win.webContents.executeJavaScript(js).catch(() => undefined);
  }

  function setNoting(on: boolean): void {
    if (!win || win.isDestroyed()) return;
    noting = on;
    // The note field needs the keyboard; the rest of the time the pill must
    // never take focus from the app being recorded.
    win.setFocusable(on);
    place(win);
    if (on) win.focus();
    paint();
  }

  function onSentinel(url: URL): void {
    const what = url.pathname.replace(/^\//, '');
    if (what === 'stop') handlers.stop();
    else if (what === 'pause') handlers.togglePause();
    else if (what === 'note-open') setNoting(true);
    else if (what === 'note-cancel') setNoting(false);
    else if (what === 'note') {
      const text = (url.searchParams.get('text') ?? '').trim();
      if (text) handlers.note(text.slice(0, 500));
      setNoting(false);
    } else if (what === 'hover') {
      open = url.searchParams.get('on') === '1';
      if (win && !win.isDestroyed() && !noting) place(win);
      paint();
    }
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
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    const opts = workspaceVisibilityOptions();
    if (opts) win.setVisibleOnAllWorkspaces(true, opts);
    win.webContents.on('will-navigate', (event, raw) => {
      event.preventDefault();
      if (!raw.startsWith(SENTINEL)) return;
      try {
        onSentinel(new URL(raw));
      } catch {
        /* a malformed sentinel is ignored */
      }
    });
    win.webContents.on('did-finish-load', () => {
      if (!win || win.isDestroyed()) return;
      void win.webContents.executeJavaScript(SCRIPT).then(paint, () => undefined);
    });
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`);
    return win;
  }

  return {
    show() {
      const w = ensure();
      open = false;
      noting = false;
      w.setFocusable(false);
      place(w);
      w.showInactive();
      paint();
    },
    hide() {
      if (win && !win.isDestroyed()) win.hide();
    },
    render(next) {
      view = next;
      paint();
    },
    pressAt(x, y) {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      const b = win.getBounds();
      if (x < b.x || y < b.y || x >= b.x + b.width || y >= b.y + b.height) return;
      const js = `window.press && window.press(${x - b.x}, ${y - b.y});`;
      void win.webContents.executeJavaScript(js, true).catch(() => undefined);
    },
    destroy() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    }
  };
}

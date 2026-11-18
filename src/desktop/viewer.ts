import { BrowserWindow, dialog, net, protocol, session, shell, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

// Stem's own file viewer: a file the user clicks in a reply (a file: link, or a
// `files/…` link fetched from the server) opens in a window of Stem instead of
// another app, when Chromium can show it. Before this, an agent-written HTML
// page opened in the default browser from file://, where it could read other
// local files in some browsers.
//
// Each viewer window is closed off on its own:
// - sandboxed renderer, no preload, no Node;
// - its own in-memory session, gone when the window closes;
// - every request outside the one document is cancelled (no network at all),
//   and a CSP with connect-src 'none' says the same thing a second time;
// - no navigation, no new windows, no downloads, no permissions. A web link on
//   the page opens in the user's browser only after the user says yes in a
//   Stem dialog that shows the whole address: the page's script can navigate
//   on its own, and a URL it builds could carry what the document holds.
//
// HTML, images, audio, video and text go through the `stem-view:` scheme, which
// serves only that one file. PDF is the exception: Electron's PDF viewer runs
// only in the default session (in a private one the load fails with ERR_FAILED,
// checked on Electron 42), so a PDF loads from file: in the default session,
// sandboxed and with the same navigation guards. That viewer is the one Chrome
// uses for every PDF on the web, and a PDF runs no page script in it.

export const VIEWER_SCHEME = 'stem-view';
const ORIGIN = `${VIEWER_SCHEME}://doc`;

/** Call before app ready: media needs `stream` to seek, and `standard` gives the page a real origin. */
export function registerViewerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: VIEWER_SCHEME, privileges: { standard: true, secure: true, stream: true } }
  ]);
}

export type ViewKind = 'html' | 'pdf' | 'image' | 'heic' | 'video' | 'audio' | 'text' | 'table' | 'quicklook';

const KINDS: Record<string, ViewKind> = {
  '.html': 'html', '.htm': 'html',
  '.pdf': 'pdf',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image', '.bmp': 'image',
  '.heic': 'heic', '.heif': 'heic',
  '.mp4': 'video', '.mov': 'video', '.m4v': 'video', '.webm': 'video',
  '.mp3': 'audio', '.m4a': 'audio', '.wav': 'audio', '.ogg': 'audio', '.flac': 'audio',
  '.txt': 'text', '.log': 'text', '.json': 'text', '.md': 'text', '.yaml': 'text', '.yml': 'text', '.xml': 'text',
  '.csv': 'table', '.tsv': 'table'
};

// Quick Look shows these read-only on macOS; it runs no macros.
const QUICK_LOOK = new Set([
  '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.rtf', '.odt', '.ods', '.odp', '.pages', '.numbers', '.key', '.tif', '.tiff'
]);

/** How the viewer shows a file, or undefined when it does not (the caller opens or shows it as before). */
export function viewKind(path: string, platform: NodeJS.Platform = process.platform): ViewKind | undefined {
  const ext = extname(path).toLowerCase();
  if (KINDS[ext]) return KINDS[ext];
  return platform === 'darwin' && QUICK_LOOK.has(ext) ? 'quicklook' : undefined;
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac'
};

/** Text past this is cut, with a note: the viewer is for reading, not for a 200 MB log. */
export const TEXT_MAX_BYTES = 4 * 1024 * 1024;
export const TABLE_MAX_ROWS = 5000;

// The page's own CSP: scripts may run (an explainer is interactive), nothing may leave.
const DOC_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'self' 'unsafe-inline' data: blob:; " +
  "img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; frame-src 'self' data: blob:; " +
  "connect-src 'none'; form-action 'none'; base-uri 'none'";
// Stem's own wrapper pages run no script at all.
const WRAPPER_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; font: 13px -apple-system, system-ui, sans-serif; background: Canvas; color: CanvasText; }
  .center { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .center img, .center video { max-width: 100vw; max-height: 100vh; object-fit: contain; }
  pre { margin: 0; padding: 16px; font: 12px ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
  table { border-collapse: collapse; font: 12px ui-monospace, Menlo, monospace; }
  td { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); padding: 3px 8px; white-space: nowrap; }
  tr:first-child td { font-weight: 600; position: sticky; top: 0; background: Canvas; }
  .note { padding: 8px 16px; opacity: .7; }`;

function wrapperPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`;
}

/** One CSV/TSV line split into cells, with "quoted, fields" kept whole. */
export function splitRow(line: string, sep: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) {
      cells.push(cell);
      cell = '';
    } else cell += c;
  }
  cells.push(cell);
  return cells;
}

/** The wrapper page for a text or table file. Exported for tests. */
export function textPage(name: string, text: string, kind: 'text' | 'table', cut: boolean): string {
  const note = cut ? `<div class="note">Only the first ${TEXT_MAX_BYTES / 1024 / 1024} MB is shown.</div>` : '';
  if (kind === 'text') return wrapperPage(name, `${note}<pre>${escapeHtml(text)}</pre>`);
  const sep = extname(name).toLowerCase() === '.tsv' ? '\t' : ',';
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const rows = lines.slice(0, TABLE_MAX_ROWS).map((l) => `<tr>${splitRow(l, sep).map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`);
  const more = lines.length > TABLE_MAX_ROWS ? `<div class="note">Only the first ${TABLE_MAX_ROWS} rows are shown.</div>` : '';
  return wrapperPage(name, `${note}${more}<table>${rows.join('')}</table>`);
}

/** The first TEXT_MAX_BYTES of a file, read as such: a 2 GB log never lands in the main process whole. */
export async function readTextHead(path: string): Promise<{ text: string; cut: boolean }> {
  const file = await open(path, 'r');
  try {
    // One byte more tells a file of exactly the limit from a longer one.
    const buf = Buffer.alloc(TEXT_MAX_BYTES + 1);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await file.read(buf, got, buf.length - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    const cut = got > TEXT_MAX_BYTES;
    return { text: buf.subarray(0, Math.min(got, TEXT_MAX_BYTES)).toString('utf8'), cut };
  } finally {
    await file.close();
  }
}

/** What `stem-view://doc/` serves: the page, and for media the file itself. */
async function pageFor(path: string, kind: ViewKind, heicToDataUrl: (path: string) => Promise<string | null>): Promise<string | null> {
  const name = basename(path);
  switch (kind) {
    case 'html':
      return null; // the file itself
    case 'image':
      return wrapperPage(name, `<div class="center"><img src="${ORIGIN}/file" alt="${escapeHtml(name)}"></div>`);
    case 'heic': {
      const url = await heicToDataUrl(path);
      return wrapperPage(name, url ? `<div class="center"><img src="${url}" alt="${escapeHtml(name)}"></div>` : `<div class="note">This picture could not be shown.</div>`);
    }
    case 'video':
      return wrapperPage(name, `<div class="center"><video src="${ORIGIN}/file" controls autoplay></video></div>`);
    case 'audio':
      return wrapperPage(name, `<div class="center"><audio src="${ORIGIN}/file" controls autoplay></audio></div>`);
    case 'text':
    case 'table': {
      const { text, cut } = await readTextHead(path);
      return textPage(name, text, kind, cut);
    }
    default:
      return null;
  }
}

/** Cancel every request but the document's own. */
function lockDown(ses: Session, allowed: (url: string) => boolean): void {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowed(details.url) }));
}

/** The answer from the "open this link?" dialog. */
export interface LinkAnswer {
  open: boolean;
  /** The user ticked "block other links from this page": every later link is refused quietly. */
  block: boolean;
}

/**
 * What a viewer window does with a web address its page tries to open. Nothing
 * opens without the user's yes: Electron does not say whether a click started
 * a navigation, and a page script can navigate by itself. One question at a
 * time; links that come while it is open are dropped, so a page cannot pile
 * up dialogs. Exported for tests.
 */
export function externalLinkGate(ask: (url: string) => Promise<LinkAnswer>, openUrl: (url: string) => void): (url: string) => void {
  let asking = false;
  let blocked = false;
  return (url) => {
    if (blocked || asking || !/^https?:/i.test(url)) return;
    asking = true;
    void ask(url)
      .then((a) => {
        if (a.block) blocked = true;
        if (a.open) openUrl(url);
      })
      .catch(() => undefined) // quiet: no answer (the window closed) opens nothing.
      .finally(() => (asking = false));
  };
}

/** Long enough to see where it goes and what it carries, short enough for a dialog. */
const SHOWN_URL_MAX = 600;

async function askOpenLink(win: BrowserWindow, url: string): Promise<LinkAnswer> {
  if (win.isDestroyed()) return { open: false, block: false };
  const shown = url.length > SHOWN_URL_MAX ? `${url.slice(0, SHOWN_URL_MAX)}…` : url;
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    message: 'Open this link in your browser?',
    detail: `The page you are viewing wants to open:\n\n${shown}\n\nAnything in the address goes to that site.`,
    buttons: ['Cancel', 'Open in Browser'],
    defaultId: 0,
    cancelId: 0,
    checkboxLabel: 'Block other links from this page',
    checkboxChecked: false
  });
  return { open: r.response === 1, block: r.checkboxChecked };
}

function guardContents(win: BrowserWindow, title: string): void {
  const wc = win.webContents;
  const external = externalLinkGate(
    (url) => askOpenLink(win, url),
    (url) => void shell.openExternal(url).catch(() => undefined)
  );
  wc.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => {
    // An in-page #anchor is not a navigation away.
    try {
      const next = new URL(url);
      const cur = new URL(wc.getURL());
      if (next.origin === cur.origin && next.pathname === cur.pathname && next.search === cur.search) return;
    } catch {
      // quiet: an unparsable target is refused like any other.
    }
    event.preventDefault();
    external(url);
  });
  wc.on('will-redirect', (event) => event.preventDefault());
  wc.on('will-attach-webview', (event) => event.preventDefault());
  // The window keeps the file's name: a page must not pass itself off as Stem.
  win.on('page-title-updated', (event) => event.preventDefault());
  win.setTitle(title);
}

export interface ViewerDeps {
  /** HEIC → a JPEG `data:` URL (server/pi/attachments.ts imagePreviewDataUrl). */
  heicToDataUrl: (path: string) => Promise<string | null>;
  /** A window for Quick Look to attach to (macOS). */
  anyWindow: () => BrowserWindow | null;
}

/**
 * Show `path` in Stem. Answers false when the viewer does not show this type,
 * so the caller opens or reveals it the way it did before.
 */
export async function openInViewer(path: string, deps: ViewerDeps): Promise<boolean> {
  const kind = viewKind(path);
  if (!kind) return false;
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return false;
  const name = basename(path);

  if (kind === 'quicklook') {
    const win = deps.anyWindow();
    if (!win) return false;
    win.previewFile(path, name);
    return true;
  }

  // No "persist:": in memory only. Not for PDF (see the note at the top).
  const ses = kind === 'pdf' ? session.defaultSession : session.fromPartition(`stem-viewer-${randomUUID()}`);
  const fileUrl = pathToFileURL(path).href;
  const page = await pageFor(path, kind, deps.heicToDataUrl);

  if (kind !== 'pdf') {
    lockDown(ses, (url) => url.startsWith(`${ORIGIN}/`) || /^(data|blob):/i.test(url));
    ses.protocol.handle(VIEWER_SCHEME, async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/' && page !== null) {
        return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': WRAPPER_CSP } });
      }
      if (pathname === '/' && kind === 'html') {
        return new Response(await readFile(path), { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': DOC_CSP } });
      }
      if (pathname === '/file' && kind !== 'html') {
        // net.fetch on the one file answers range requests, so video can seek.
        const res = await net.fetch(fileUrl, { headers: request.headers, bypassCustomProtocolHandlers: true });
        const headers = new Headers(res.headers);
        const mime = MIME[extname(path).toLowerCase()];
        if (mime) headers.set('content-type', mime);
        return new Response(res.body, { status: res.status, headers });
      }
      return new Response('Not found', { status: 404 });
    });
  }

  const win = new BrowserWindow({
    width: kind === 'audio' ? 520 : 1100,
    height: kind === 'audio' ? 200 : 820,
    title: name,
    autoHideMenuBar: true,
    show: !process.env.STEM_BACKGROUND,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      plugins: kind === 'pdf',
      // Only a page the user opened may run script; Stem's own wrappers need none.
      javascript: kind === 'html' || kind === 'pdf'
    }
  });
  guardContents(win, name);
  await win.loadURL(kind === 'pdf' ? fileUrl : `${ORIGIN}/`);
  return true;
}

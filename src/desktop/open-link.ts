import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import type { Shell } from 'electron';

// How a link clicked in the renderer leaves the app. Web, mail and phone links
// go to the browser / mail client / FaceTime. file:// links (an agent pointing at a CSV it just
// wrote to ~/Downloads) open with the default app only when they are a known
// document type; anything else (folders, extensionless files, apps, scripts,
// installers, macro-enabled Office files, ...) is only revealed in
// Finder/Explorer. An allowlist, not a denylist: a model-written link must
// never launch a program with one click, and an extensionless Mach-O opens in
// Terminal and runs.
export type LinkAction =
  | { kind: 'external'; url: string }
  | { kind: 'open'; path: string }
  | { kind: 'reveal'; path: string }
  | { kind: 'ignore' };

const EXTERNAL_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

const DOCUMENT_EXTENSIONS = new Set([
  '.csv', '.tsv', '.txt', '.md', '.json', '.log', '.xml', '.yaml', '.yml',
  '.pdf', '.html', '.htm',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.svg', '.tif', '.tiff', '.bmp',
  '.mp3', '.m4a', '.wav', '.mp4', '.mov', '.m4v',
  '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.odt', '.ods', '.odp', '.rtf',
  '.pages', '.numbers', '.key',
  '.zip',
]);

export function classifyLink(url: string, home: () => string = homedir): LinkAction {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'ignore' };
  }
  if (EXTERNAL_URL_PROTOCOLS.has(parsed.protocol)) return { kind: 'external', url: parsed.toString() };
  if (parsed.protocol !== 'file:') return { kind: 'ignore' };
  // A host names another machine. POSIX refuses one in fileURLToPath; Windows
  // turns it into a UNC path and would open a file off someone's SMB share.
  if (parsed.hostname) return { kind: 'ignore' };
  let path: string;
  try {
    // file:///~/… is the renderer's spelling of a home-relative path
    // (shared/file-paths.ts): only this side knows where home is.
    if (parsed.pathname === '/~' || parsed.pathname.startsWith('/~/')) {
      const rest = decodeURIComponent(parsed.pathname.slice(3));
      if (rest.split('/').includes('..')) return { kind: 'ignore' };
      path = join(home(), rest); // keeps a trailing slash: still a folder
    } else {
      path = fileURLToPath(parsed);
    }
  } catch {
    return { kind: 'ignore' };
  }
  // A trailing slash is a folder (or a bundle like Foo.app/): never opened.
  const ext = /[/\\]$/.test(path) ? '' : extname(path).toLowerCase();
  return DOCUMENT_EXTENSIONS.has(ext) ? { kind: 'open', path } : { kind: 'reveal', path };
}

/**
 * Act on a renderer link. Two ways in: window.open / navigation (the guards in
 * desktop/index.ts) and the `link:open` channel. The channel exists for file:
 * links — Chromium refuses a file: navigation from a page not itself served
 * from file: (the dev server) before Electron is ever asked.
 */
export function openLink(shell: Pick<Shell, 'openExternal' | 'openPath' | 'showItemInFolder'>, url: string): void {
  const action = classifyLink(url);
  if (action.kind === 'external') void shell.openExternal(action.url).catch(() => undefined);
  // openPath resolves with an error string (never rejects) when the file is
  // missing, e.g. a link to another device's Downloads; nothing to open then.
  else if (action.kind === 'open') void shell.openPath(action.path);
  else if (action.kind === 'reveal') shell.showItemInFolder(action.path);
}

/** The file a file:// link names, for "Show in Finder" and "Copy Path". */
export function linkFilePath(url: string): string | undefined {
  const action = classifyLink(url);
  return action.kind === 'open' || action.kind === 'reveal' ? action.path.replace(/(.)[/\\]+$/, '$1') : undefined;
}

/** Show a file:// link's file selected in Finder/Explorer, whatever its type. */
export function revealLink(shell: Pick<Shell, 'showItemInFolder'>, url: string): void {
  const path = linkFilePath(url);
  if (path) shell.showItemInFolder(path);
}

export function revealLabel(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'Show in Finder';
  if (platform === 'win32') return 'Show in Explorer';
  return 'Show in Folder';
}

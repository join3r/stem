import { BrowserWindow, clipboard, Menu, shell, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { appRelativeLink, linkFilePath, revealLabel, revealLink } from './open-link';
import { SCRATCH_PREFIX } from '../shared/files-links';
import { saveImageToDownloads } from './save-image';

// A native right-click menu for page content: links (open/copy), selected text,
// images, and edit actions in inputs. Without this Electron shows nothing at all
// on right-click. Renderer components that draw their own menus (ChatList,
// MailList, …) call preventDefault() on the DOM contextmenu event, which
// suppresses this webContents event — so the two never stack.

/**
 * The right-clicked image's URL. Chromium drops any URL over 2 MB on its way out
 * of the renderer, so a full-size generated picture's data URL arrives here as
 * '' — read it off the element under the cursor instead.
 */
async function imageSource(contents: WebContents, params: Electron.ContextMenuParams): Promise<string> {
  if (params.srcURL) return params.srcURL;
  const zoom = contents.getZoomFactor();
  const src: unknown = await contents.executeJavaScript(
    `(() => { const el = document.elementFromPoint(${params.x / zoom}, ${params.y / zoom});
      return el instanceof HTMLImageElement ? el.currentSrc || el.src : ''; })()`
  );
  return typeof src === 'string' ? src : '';
}

/**
 * What the menu does with a file on the server (desktop/local: files:open and
 * files:download). `ref` is what GET /files/ takes. Set once at startup, so
 * this file needs no server credentials of its own.
 */
export interface ServerFileActions {
  open(ref: string): Promise<void>;
  reveal(ref: string): Promise<void>;
}
let serverFiles: ServerFileActions | null = null;

export function setServerFileActions(actions: ServerFileActions | null): void {
  serverFiles = actions;
}

/** The chat a right-clicked `scratch/…` link belongs to (renderer/mdx/render.tsx ScratchLink). */
async function linkThread(contents: WebContents, params: Electron.ContextMenuParams): Promise<string> {
  const zoom = contents.getZoomFactor();
  const id: unknown = await contents.executeJavaScript(
    `(() => { const el = document.elementFromPoint(${params.x / zoom}, ${params.y / zoom});
      return el?.closest('a[data-thread]')?.getAttribute('data-thread') ?? ''; })()`
  );
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : '';
}

/**
 * A relative `files/…` or `scratch/…` link resolves against the app's own page,
 * so its URL names a path inside Stem.app. The file is on the server: answer
 * what GET /files/ takes for it. Null for a link into the app's own folder
 * that names no such file; undefined for any other link.
 */
async function serverFileRef(contents: WebContents, params: Electron.ContextMenuParams): Promise<string | null | undefined> {
  if (!params.linkURL) return undefined;
  const link = appRelativeLink(params.linkURL, contents.getURL());
  if (!link.inApp) return undefined;
  if (link.files) return link.files;
  if (!link.scratch) return null;
  const thread = await linkThread(contents, params).catch(() => '');
  return thread ? `${SCRATCH_PREFIX}${thread}/${link.scratch}` : null;
}

export function installContextMenu(contents: WebContents, openExternalUrl: (url: string) => void): void {
  contents.on('context-menu', (_event, params) => {
    void serverFileRef(contents, params)
      .then((ref) => showMenu(contents, params, ref, openExternalUrl))
      .catch((e) => console.warn('[context-menu] could not show the menu', e));
  });
}

function showMenu(
  contents: WebContents,
  params: Electron.ContextMenuParams,
  serverRef: string | null | undefined,
  openExternalUrl: (url: string) => void
): void {
  const items: MenuItemConstructorOptions[] = [];

  const filePath =
    serverRef === undefined && params.linkURL.startsWith('file:') ? linkFilePath(params.linkURL) : undefined;
  if (serverRef && serverFiles) {
    // A file on the server: fetch it, then open it or show it in Downloads.
    const act = (fn: (ref: string) => Promise<void>) => () => {
      void fn(serverRef).catch((e) => console.warn('[context-menu] could not fetch the file', e));
    };
    items.push(
      { label: 'Open', click: act(serverFiles.open) },
      { label: revealLabel(), click: act(serverFiles.reveal) },
      { type: 'separator' }
    );
  } else if (serverRef !== undefined) {
    // A link into the app's own folder: nothing of the user's to open or show.
  } else if (filePath) {
    // A file link from a reply (an agent naming the CSV it just wrote).
    items.push(
      { label: 'Open', click: () => openExternalUrl(params.linkURL) },
      { label: revealLabel(), click: () => revealLink(shell, params.linkURL) },
      { label: 'Copy Path', click: () => clipboard.writeText(filePath) },
      { type: 'separator' }
    );
  } else if (params.linkURL) {
    items.push(
      { label: 'Open Link', click: () => openExternalUrl(params.linkURL) },
      { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' }
    );
  }

  if (params.mediaType === 'image') {
    items.push({ label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) });
    // Chat pictures are data URLs; anything else goes through Chromium's own download.
    items.push({
      label: 'Save Image to Downloads',
      click: () => {
        void imageSource(contents, params)
          .then((src) => {
            if (src.startsWith('data:image/')) return saveImageToDownloads(src, params.altText);
            if (src) contents.downloadURL(src);
          })
          .catch((e) => console.warn('[context-menu] could not save the image', e));
      }
    });
    items.push({ type: 'separator' });
  }

  if (params.isEditable) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 4)) {
      items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
    }
    if (params.misspelledWord) {
      items.push(
        {
          label: 'Add to Dictionary',
          click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
        },
        { type: 'separator' }
      );
    }
    items.push(
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll' }
    );
  } else if (params.selectionText.trim()) {
    items.push({ role: 'copy' });
  }

  while (items.length > 0 && items[items.length - 1].type === 'separator') items.pop();
  if (items.length === 0) return;

  const window = BrowserWindow.fromWebContents(contents) ?? undefined;
  Menu.buildFromTemplate(items).popup({ window });
}

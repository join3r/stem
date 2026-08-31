import { BrowserWindow, clipboard, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron';

// A native right-click menu for page content: links (open/copy), selected text,
// images, and edit actions in inputs. Without this Electron shows nothing at all
// on right-click. Renderer components that draw their own menus (ChatList,
// MailList, …) call preventDefault() on the DOM contextmenu event, which
// suppresses this webContents event — so the two never stack.

export function installContextMenu(contents: WebContents, openExternalUrl: (url: string) => void): void {
  contents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = [];

    if (params.linkURL) {
      items.push(
        { label: 'Open Link', click: () => openExternalUrl(params.linkURL) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      );
    }

    if (params.mediaType === 'image') {
      items.push({ label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) }, { type: 'separator' });
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
  });
}

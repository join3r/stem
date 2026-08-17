import { Menu, type MenuItemConstructorOptions } from 'electron';
import { isMac } from './platform';

// Stem's application menu: Electron's stock menu, minus "Close Window".
//
// Left alone, Electron installs a default menu whose File menu holds exactly one
// item — Close Window, bound to ⌘W (Ctrl+W off macOS). That binding is a browser
// reflex, and Stem is not a browser: there is one main window, it is the app, and
// closing it destroys the renderer (the open chat, the scroll position, the draft
// in the composer) while the process keeps running behind the dock icon. A ⌘W
// aimed at the editor or the browser next door lands here as "where did Stem go?".
//
// The accelerator is also window-agnostic, which makes it worse than an annoyance:
// pressed while the Quick Chat overlay has focus it closes THAT window, and the
// overlay is constructed once at startup and thereafter only ever shown and hidden
// (see quickchat/windows.ts) — so a stray ⌘W left Quick Chat dead until restart.
//
// Hence: no close item anywhere, and therefore no ⌘W. Everything else is the stock
// menu, spelled out with roles so Electron keeps supplying the platform's own
// labels, translations and behavior — Edit in particular *must* keep its roles or
// copy/paste stop working on macOS.
//
// What this does not change: ⌘Q / Ctrl+Q still quits, the red traffic light (and
// the native close button off macOS) still closes the main window, and the way
// back in is unchanged — the dock, the tray, or a plain `stem` (see the
// window-all-closed note in index.ts).

/** The menu template for a platform. Pure data, so it can be asserted in a unit test. */
export function appMenuTemplate(mac: boolean): MenuItemConstructorOptions[] {
  if (mac) {
    // No File menu: Close Window was its only item. macOS's `windowMenu` role is
    // already close-free (Minimize, Zoom, Bring All to Front), so it stays as-is.
    return [{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }];
  }
  // Off macOS the split differs: File holds Quit (keep it) and the `windowMenu`
  // role is the one carrying Close, so that menu is spelled out without it.
  return [
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { label: 'Window', submenu: [{ role: 'minimize' }] }
  ];
}

/** Replace Electron's default menu with Stem's. Call once, after the app is ready. */
export function installAppMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(isMac)));
}

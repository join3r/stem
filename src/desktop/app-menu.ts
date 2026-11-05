import { Menu, type MenuItemConstructorOptions } from 'electron';
import { isMac } from './platform';
import { SHORTCUTS, chordFor, type Chord, type ShortcutId } from '../shared/shortcut-defs';
import type { ManageTabId, MenuCommand } from '../shared/types';

// Stem's application menu.
//
// What is NOT in it: Close Window. Left alone, Electron installs a default menu
// whose File menu holds Close Window, bound to ⌘W (Ctrl+W off macOS). That
// binding is a browser reflex, and Stem is not a browser: there is one main
// window, it is the app, and closing it destroys the renderer (the open chat, the
// scroll position, the draft in the composer) while the process keeps running
// behind the dock icon. A ⌘W aimed at the editor or the browser next door lands
// here as "where did Stem go?". The accelerator is also window-agnostic: pressed
// while the Quick Chat overlay has focus it closed THAT window, and the overlay is
// constructed once at startup and thereafter only ever shown and hidden (see
// quickchat/windows.ts) — so a stray ⌘W left Quick Chat dead until restart.
// Hence: no close item anywhere, and therefore no ⌘W. ⌘Q / Ctrl+Q still quits,
// and the red traffic light (the native close button off macOS) still closes the
// main window.
//
// What IS in it: every action that has a shortcut, so the menu bar is where a
// person discovers them. The keyboard stays the renderer's job — the menu never
// owns a key, it only prints one:
//
//   - Off macOS every Stem item carries `registerAccelerator: false`, so the label
//     shows the keycap and the renderer's keydown listener does the work.
//   - On macOS that flag does not exist, but Electron hands a key to the page
//     first and offers it to the menu only when the page left it unhandled (no
//     preventDefault). The shortcut listener calls preventDefault whenever it ran a
//     handler, so a key reaches the menu only when nothing on screen claimed it —
//     and the menu then sends the same command, which still finds no handler.
//
// Either way a click arrives as a MenuCommand on the main window, and a
// `shortcut` command runs the handler the key would have. The roles (Edit in
// particular) stay roles, so Electron keeps supplying the platform's own labels
// and behavior — copy/paste stop working on macOS without them.

/** A chat the Window menu lists under ⌘1–9. */
export interface MenuChat {
  threadId: string;
  title: string;
}

/** What the template is built from — everything that can change while Stem runs. */
export interface AppMenuState {
  /** The rows ⌘1–9 open right now, top first; empty while the numbers are not live. */
  chats: MenuChat[];
  /** The Quick Chat summon key, when one is bound; printed beside the item. */
  quickChatAccelerator: string | null;
  /** False where this install has no update path (dev builds, e2e). */
  canCheckForUpdates: boolean;
}

export interface AppMenuActions {
  /** Deliver a command to the main window. */
  command(command: MenuCommand): void;
  toggleQuickChat(): void;
  checkForUpdates(): void;
  /** Step the main window's page zoom (see zoom.ts, which also owns the keys). */
  zoom(action: 'in' | 'out' | 'reset'): void;
}

/**
 * Commands that act on what is in front of the user — the open chat's composer,
 * the selected rows. Picked while another window (the Quick Chat overlay) has
 * focus they would reach into a window the user is not looking at, so the caller
 * drops them there instead of revealing the main window.
 */
export const IN_WINDOW_SHORTCUTS: ReadonlySet<ShortcutId> = new Set<ShortcutId>([
  'cycle-effort',
  'toggle-speed',
  'toggle-format',
  'attach',
  'stop',
  'archive-thread',
  'snooze-thread',
  'toggle-read',
  'delete-thread'
]);

/** Electron accelerator for a chord, e.g. 'CmdOrCtrl+Shift+N', 'Ctrl+X'. */
export function chordAccelerator(chord: Chord, key: string = chord.key): string {
  const parts: string[] = [];
  if (chord.mod) parts.push('CmdOrCtrl');
  if (chord.control) parts.push('Ctrl');
  if (chord.shift) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'or', 'the', 'of', 'to']);

/** 'Mark read or unread' → 'Mark Read or Unread': menus are title case. */
export function titleCase(label: string): string {
  return label
    .split(' ')
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Longest chat title the Window menu prints before it ellipsizes. */
const CHAT_TITLE_MAX = 50;

function shortTitle(title: string): string {
  const t = title.trim() || 'Untitled chat';
  return t.length > CHAT_TITLE_MAX ? `${t.slice(0, CHAT_TITLE_MAX - 1)}…` : t;
}

/** Stem items print a key but never own it — see the note at the top. */
const display = { registerAccelerator: false } as const;

export function appMenuTemplate(
  mac: boolean,
  state: AppMenuState,
  actions: AppMenuActions
): MenuItemConstructorOptions[] {
  const shortcut = (id: ShortcutId, label?: string): MenuItemConstructorOptions => {
    const def = SHORTCUTS.find((d) => d.id === id)!;
    return {
      label: label ?? titleCase(def.label),
      accelerator: chordAccelerator(chordFor(def, mac)),
      ...display,
      click: () => actions.command({ kind: 'shortcut', id })
    };
  };
  const tab = (id: ManageTabId, label: string): MenuItemConstructorOptions => ({
    label,
    click: () => actions.command({ kind: 'manage-tab', tab: id })
  });
  const sep: MenuItemConstructorOptions = { type: 'separator' };

  const settings = shortcut('open-settings', mac ? 'Settings…' : 'Settings');
  const updates: MenuItemConstructorOptions = {
    label: 'Check for Updates…',
    enabled: state.canCheckForUpdates,
    click: () => actions.checkForUpdates()
  };
  const quickChat: MenuItemConstructorOptions = {
    label: 'Quick Chat',
    ...(state.quickChatAccelerator ? { accelerator: state.quickChatAccelerator, ...display } : {}),
    click: () => actions.toggleQuickChat()
  };

  // ⌘1–9 by thread id rather than by digit: a click opens the row the label names.
  const chatItems: MenuItemConstructorOptions[] = state.chats.slice(0, 9).map((chat, i) => ({
    label: shortTitle(chat.title),
    accelerator: `CmdOrCtrl+${i + 1}`,
    ...display,
    click: () => actions.command({ kind: 'open-chat', threadId: chat.threadId })
  }));

  const file: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      shortcut('new-conversation'),
      shortcut('new-mail'),
      quickChat,
      sep,
      shortcut('attach', 'Attach Files…'),
      ...(mac ? [] : [sep, settings, updates, sep, { role: 'quit' } as const])
    ]
  };

  const edit: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      sep,
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(mac ? [{ role: 'pasteAndMatchStyle' } as const] : []),
      { role: 'delete' },
      { role: 'selectAll' },
      sep,
      shortcut('focus-chat-search', 'Search Chats'),
      ...(mac
        ? [
            sep,
            {
              label: 'Speech',
              submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }]
            } as MenuItemConstructorOptions
          ]
        : [])
    ]
  };

  const view: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      tab('chats', 'Chats'),
      tab('memory', 'Memory'),
      tab('mcp', 'Tools'),
      tab('personas', 'Personas & People'),
      tab('folders', 'Sources'),
      tab('tasks', 'Scheduled Tasks'),
      sep,
      shortcut('toggle-inspector', 'Toggle Side Panel'),
      shortcut('toggle-format'),
      sep,
      // Not the zoom roles: their ⌘+ needs Shift on a US keyboard. zoom.ts
      // catches the keys before the menu sees them; these only print them.
      { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', ...display, click: () => actions.zoom('reset') },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', ...display, click: () => actions.zoom('in') },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', ...display, click: () => actions.zoom('out') },
      sep,
      { role: 'togglefullscreen' },
      sep,
      {
        label: 'Developer',
        submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }]
      }
    ]
  };

  const chat: MenuItemConstructorOptions = {
    label: 'Chat',
    submenu: [
      shortcut('stop'),
      sep,
      shortcut('cycle-effort'),
      shortcut('toggle-speed'),
      sep,
      shortcut('archive-thread', 'Archive'),
      shortcut('snooze-thread', 'Snooze…'),
      shortcut('toggle-read'),
      sep,
      shortcut('delete-thread', 'Delete Chat…')
    ]
  };

  const chatsSection = chatItems.length ? [sep, ...chatItems] : [];
  // Built by hand rather than with the `windowMenu` role: the role is not
  // extensible, and off macOS it is the one that carries Close.
  const window: MenuItemConstructorOptions = mac
    ? {
        role: 'window',
        submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...chatsSection, sep, { role: 'front' }]
      }
    : { label: 'Window', submenu: [{ role: 'minimize' }, ...chatsSection] };

  if (!mac) return [file, edit, view, chat, window];

  const stem: MenuItemConstructorOptions = {
    label: 'Stem',
    submenu: [
      { role: 'about' },
      sep,
      settings,
      updates,
      sep,
      { role: 'services' },
      sep,
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      sep,
      { role: 'quit' }
    ]
  };
  return [stem, file, edit, view, chat, window];
}

let actions: AppMenuActions | null = null;
let state: AppMenuState = { chats: [], quickChatAccelerator: null, canCheckForUpdates: false };

/** Install Stem's menu. Call once, after the app is ready. */
export function installAppMenu(menuActions: AppMenuActions, initial: Partial<AppMenuState> = {}): void {
  actions = menuActions;
  state = { ...state, ...initial };
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(isMac, state, actions)));
}

/** Rebuild the menu after something it prints changed (the ⌘1–9 rows, the summon key). */
export function updateAppMenu(patch: Partial<AppMenuState>): void {
  const next = { ...state, ...patch };
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  state = next;
  if (actions) Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(isMac, state, actions)));
}

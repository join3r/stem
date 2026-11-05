import { describe, expect, it, vi } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { Menu } from '../electron-stub';
import {
  appMenuTemplate,
  chordAccelerator,
  installAppMenu,
  titleCase,
  updateAppMenu,
  type AppMenuActions,
  type AppMenuState
} from '../../src/desktop/app-menu';
import { SHORTCUTS, chordFor } from '../../src/shared/shortcut-defs';
import type { MenuCommand } from '../../src/shared/types';

// Two things are locked in here. What is NOT in the menu: no Close Window, so
// ⌘W / Ctrl+W cannot destroy the main window (or the Quick Chat overlay, which
// is never rebuilt) — on both platform shapes, since the item lives in File on
// macOS and in Window elsewhere. And what IS: every bound shortcut, printed with
// its key but never owning it, and wired to the same command the key runs.

const STATE: AppMenuState = { chats: [], quickChatAccelerator: null, canCheckForUpdates: true };

function noopActions(): AppMenuActions & { commands: MenuCommand[] } {
  const commands: MenuCommand[] = [];
  return {
    commands,
    command: (c) => commands.push(c),
    toggleQuickChat: vi.fn(),
    checkForUpdates: vi.fn(),
    zoom: vi.fn()
  };
}

/** Every item in a template, submenus included, depth-first. */
function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? items(item.submenu) : [])]);
}

const roles = (t: MenuItemConstructorOptions[]) => items(t).flatMap((i) => (i.role ? [i.role as string] : []));
const byLabel = (t: MenuItemConstructorOptions[], label: string) => items(t).find((i) => i.label === label);
const click = (item: MenuItemConstructorOptions | undefined) =>
  (item!.click as unknown as () => void)();

describe('appMenuTemplate', () => {
  for (const mac of [true, false]) {
    const name = mac ? 'macOS' : 'Windows/Linux';

    it(`has no close item and no ⌘W on ${name}`, () => {
      const t = appMenuTemplate(mac, STATE, noopActions());
      expect(roles(t)).not.toContain('close');
      expect(roles(t)).not.toContain('windowMenu');
      expect(roles(t)).not.toContain('fileMenu');
      for (const i of items(t)) expect(i.accelerator ?? '').not.toMatch(/\+W$/);
    });

    it(`lists every bound shortcut on ${name}, printed but not owned`, () => {
      const t = appMenuTemplate(mac, STATE, noopActions());
      const accelerators = items(t).filter((i) => i.accelerator);
      for (const def of SHORTCUTS) {
        // Send is the composer's Enter; switch-chat appears per row (below).
        if (def.bound === false || def.id === 'switch-chat') continue;
        const want = chordAccelerator(chordFor(def, mac));
        const item = accelerators.find((i) => i.accelerator === want);
        expect(item, `${def.id} → ${want}`).toBeDefined();
        expect(item!.registerAccelerator).toBe(false);
      }
    });

    it(`keeps the Edit roles copy/paste rely on, on ${name}`, () => {
      const r = roles(appMenuTemplate(mac, STATE, noopActions()));
      for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'quit']) expect(r).toContain(role);
    });
  }

  it('puts Settings and updates under Stem on macOS, under File elsewhere', () => {
    const mac = appMenuTemplate(true, STATE, noopActions());
    // macOS's Window menu is the `window` role (so the OS lists open windows there).
    expect(mac.map((m) => m.label ?? m.role)).toEqual(['Stem', 'File', 'Edit', 'View', 'Chat', 'window']);
    expect(items([mac[0]]).map((i) => i.label)).toContain('Settings…');
    const other = appMenuTemplate(false, STATE, noopActions());
    expect(other.map((m) => m.label)).toEqual(['File', 'Edit', 'View', 'Chat', 'Window']);
    expect(roles([other[0]])).toContain('quit');
    expect(items([other[0]]).map((i) => i.label)).toContain('Settings');
  });

  it('sends the shortcut a menu item mirrors', () => {
    const actions = noopActions();
    const t = appMenuTemplate(true, STATE, actions);
    click(byLabel(t, 'New Chat'));
    click(byLabel(t, 'Settings…'));
    click(byLabel(t, 'Memory'));
    expect(actions.commands).toEqual([
      { kind: 'shortcut', id: 'new-conversation' },
      { kind: 'shortcut', id: 'open-settings' },
      { kind: 'manage-tab', tab: 'memory' }
    ]);
  });

  it('lists the ⌘1–9 rows by thread id, and none while they are not live', () => {
    const actions = noopActions();
    const chats = [
      { threadId: 't1', title: 'Groceries' },
      { threadId: 't2', title: 'x'.repeat(80) }
    ];
    const t = appMenuTemplate(true, { ...STATE, chats }, actions);
    const rows = items(t).filter((i) => /^CmdOrCtrl\+[1-9]$/.test(String(i.accelerator)));
    expect(rows.map((r) => r.accelerator)).toEqual(['CmdOrCtrl+1', 'CmdOrCtrl+2']);
    expect(rows[1].label!.length).toBeLessThanOrEqual(50);
    click(rows[1]);
    expect(actions.commands).toEqual([{ kind: 'open-chat', threadId: 't2' }]);

    const none = appMenuTemplate(true, STATE, actions);
    expect(items(none).some((i) => /^CmdOrCtrl\+[1-9]$/.test(String(i.accelerator)))).toBe(false);
  });

  it('prints the Quick Chat key only when one is bound', () => {
    const without = byLabel(appMenuTemplate(true, STATE, noopActions()), 'Quick Chat');
    expect(without!.accelerator).toBeUndefined();
    const withKey = byLabel(
      appMenuTemplate(true, { ...STATE, quickChatAccelerator: 'Alt+Space' }, noopActions()),
      'Quick Chat'
    );
    expect(withKey!.accelerator).toBe('Alt+Space');
    expect(withKey!.registerAccelerator).toBe(false);
  });

  it('greys out Check for Updates where there is no update path', () => {
    const item = byLabel(appMenuTemplate(true, { ...STATE, canCheckForUpdates: false }, noopActions()), 'Check for Updates…');
    expect(item!.enabled).toBe(false);
  });
});

describe('chordAccelerator', () => {
  it('maps the one platform-split chord to the literal Control key', () => {
    const del = SHORTCUTS.find((d) => d.id === 'delete-thread')!;
    expect(chordAccelerator(chordFor(del, true))).toBe('Ctrl+X');
    expect(chordAccelerator(chordFor(del, false))).toBe('Ctrl+Shift+X');
  });

  it('uses the platform mod key otherwise', () => {
    const mail = SHORTCUTS.find((d) => d.id === 'new-mail')!;
    expect(chordAccelerator(chordFor(mail, true))).toBe('CmdOrCtrl+Shift+N');
  });
});

describe('titleCase', () => {
  it('capitalizes all but the small words', () => {
    expect(titleCase('Mark read or unread')).toBe('Mark Read or Unread');
    expect(titleCase('Toggle MDX / Markdown')).toBe('Toggle MDX / Markdown');
  });
});

describe('installAppMenu', () => {
  it('installs the menu it built, and rebuilds on change', () => {
    installAppMenu(noopActions());
    const first = Menu._applicationMenu as MenuItemConstructorOptions[];
    expect(roles(first)).not.toContain('close');
    updateAppMenu({ chats: [{ threadId: 't1', title: 'One' }] });
    const second = Menu._applicationMenu as MenuItemConstructorOptions[];
    expect(second).not.toBe(first);
    expect(items(second).some((i) => i.label === 'One')).toBe(true);
    // Same state again: no rebuild.
    updateAppMenu({ chats: [{ threadId: 't1', title: 'One' }] });
    expect(Menu._applicationMenu).toBe(second);
  });
});

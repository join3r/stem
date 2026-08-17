import { describe, expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { Menu } from '../electron-stub';
import { appMenuTemplate, installAppMenu } from '../../src/desktop/app-menu';

// The whole point of Stem owning an application menu is what is NOT in it: no
// Close Window, so ⌘W / Ctrl+W cannot destroy the main window (or the Quick Chat
// overlay, which is never rebuilt). These lock that in on both platform shapes —
// the item lives in File on macOS and in Window everywhere else, so a template
// that only dropped one of the two would still leave the accelerator live.

/** Every role in a template, submenus included — composite roles stay unexpanded. */
function roles(template: MenuItemConstructorOptions[]): string[] {
  return template.flatMap((item) => [
    ...(item.role ? [item.role as string] : []),
    ...(Array.isArray(item.submenu) ? roles(item.submenu) : [])
  ]);
}

describe('appMenuTemplate', () => {
  it('has no close item on macOS', () => {
    const mac = roles(appMenuTemplate(true));
    expect(mac).not.toContain('close');
    // File held nothing but Close Window on macOS, so the menu itself is gone.
    expect(mac).not.toContain('fileMenu');
    // Everything else is the stock menu, by role.
    expect(mac).toEqual(['appMenu', 'editMenu', 'viewMenu', 'windowMenu']);
  });

  it('has no close item off macOS, and keeps Quit in File', () => {
    const other = roles(appMenuTemplate(false));
    expect(other).not.toContain('close');
    // Off macOS `windowMenu` is the role that carries Close, so it is spelled out.
    expect(other).not.toContain('windowMenu');
    expect(other).toEqual(['fileMenu', 'editMenu', 'viewMenu', 'minimize']);
  });

  it('installs the menu it built', () => {
    installAppMenu();
    expect(Menu._applicationMenu).not.toBeNull();
    expect(roles(Menu._applicationMenu as MenuItemConstructorOptions[])).not.toContain('close');
  });
});

// Folder settings: the dialog that makes a folder, the follow-up question that
// only comes up when auto-filing was switched on, and the same dialog reopened
// from the folder's context menu. Real DOM, real IPC, real chat store; the
// filer itself is off under STEM_E2E, so nothing moves behind the spec's back.
import { test, expect } from './electron';
import type { Page } from '@playwright/test';
import type { Folder } from '../../src/shared/types';

const SHOTS = process.env.STEM_E2E_SHOTS;

async function shot(win: Page, name: string): Promise<void> {
  if (SHOTS) await win.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** The folder tree as the server stores it. */
function storedFolders(win: Page): Promise<Folder[]> {
  return win.evaluate(async () => {
    const stem = (window as unknown as { stem: { listChats(): Promise<{ folders: Folder[] }> } }).stem;
    return (await stem.listChats()).folders;
  });
}

async function openChats(win: Page): Promise<void> {
  await win.locator('.chats-modes').getByRole('button', { name: 'Chats', exact: true }).click();
}

test('a new folder with auto-filing asks about existing chats, and its settings reopen as saved', async ({
  mainWindow: win
}) => {
  await openChats(win);
  await win.getByTitle('New folder', { exact: true }).click();

  const dialog = win.getByRole('dialog', { name: 'New folder' });
  await expect(dialog).toBeVisible();
  // Create stays off until there is a name.
  await expect(dialog.getByRole('button', { name: 'Create' })).toBeDisabled();
  await dialog.getByLabel('Folder name').fill('Cloudfarms');
  await dialog.getByLabel('Folder description').fill('Work on the farm app');
  await dialog.getByLabel('Move matching chats here automatically').check();
  await shot(win, '1-new-folder');
  await dialog.getByRole('button', { name: 'Create' }).click();

  const ask = win.getByRole('dialog', { name: 'Move existing chats too?' });
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('“Cloudfarms”');
  await shot(win, '2-existing-chats');
  await ask.getByRole('button', { name: 'Include existing chats' }).click();
  await expect(ask).toBeHidden();

  const row = win.locator('.group-row').filter({ hasText: 'Cloudfarms' });
  await expect(row).toBeVisible();
  // "Include existing" lifted the new-chats-only floor on the server.
  const stored = await storedFolders(win);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ name: 'Cloudfarms', description: 'Work on the farm app', autoFile: true });
  expect(stored[0].autoFileSince).toBeUndefined();

  // Reopen from the context menu: everything as saved. Switching filing off
  // and saving asks nothing.
  await row.click({ button: 'right' });
  await win.locator('.ctx-menu').getByRole('button', { name: 'Settings…' }).click();
  const edit = win.getByRole('dialog', { name: 'Folder settings' });
  await expect(edit.getByLabel('Folder name')).toHaveValue('Cloudfarms');
  await expect(edit.getByLabel('Folder description')).toHaveValue('Work on the farm app');
  await expect(edit.getByLabel('Move matching chats here automatically')).toBeChecked();
  await shot(win, '3-folder-settings');
  await edit.getByLabel('Move matching chats here automatically').uncheck();
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await expect(win.getByRole('dialog', { name: 'Move existing chats too?' })).toHaveCount(0);
  await expect
    .poll(async () => (await storedFolders(win))[0].autoFile)
    .toBeUndefined();
});

test('a folder without auto-filing is just made; switching it on later asks, and "only new" keeps the floor', async ({
  mainWindow: win
}) => {
  await openChats(win);
  await win.getByTitle('New folder', { exact: true }).click();
  const dialog = win.getByRole('dialog', { name: 'New folder' });
  await dialog.getByLabel('Folder name').fill('Taxes');
  await dialog.getByLabel('Folder name').press('Enter');
  await expect(dialog).toBeHidden();
  await expect(win.getByRole('dialog', { name: 'Move existing chats too?' })).toHaveCount(0);
  const row = win.locator('.group-row').filter({ hasText: 'Taxes' });
  await expect(row).toBeVisible();

  await row.click({ button: 'right' });
  await win.locator('.ctx-menu').getByRole('button', { name: 'Settings…' }).click();
  const edit = win.getByRole('dialog', { name: 'Folder settings' });
  await edit.getByLabel('Move matching chats here automatically').check();
  await edit.getByRole('button', { name: 'Save' }).click();
  const ask = win.getByRole('dialog', { name: 'Move existing chats too?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Only new chats' }).click();
  await expect(ask).toBeHidden();

  const [folder] = await storedFolders(win);
  expect(folder.autoFile).toBe(true);
  expect(folder.autoFileSince).toBeGreaterThan(0);
});

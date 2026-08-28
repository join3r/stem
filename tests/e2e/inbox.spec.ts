// The Inbox tab of the chat list, driven through real DOM and real IPC against
// the scripted FakeBackend. Threads are created the only honest way — by sending
// a turn — so each row has a real backend session whose mtime is what the
// archive/snooze timestamps are compared against, and whose first message is what
// the subject writer is handed.
import { test, expect } from './electron';
import type { Page } from '@playwright/test';

async function send(win: Page, text: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
  await expect(win.locator('.message-assistant:not(.activity-row) .message-body').last()).toContainText(
    `Echo: ${text}`
  );
  // Wait for the turn to SETTLE, not just for the reply text: the triage tests
  // below act on the thread the instant send() returns, and a shortcut landing
  // between the last delta and the settled event races the settle-time read
  // stamp. The idle-only action row is the settled state made visible.
  await expect(win.locator('.message-user').last().locator('.message-actions')).toBeAttached();
}

/** A fresh thread whose first user message is `text`. */
async function newThread(win: Page, text: string): Promise<void> {
  await win.getByTitle('New thread').click();
  await send(win, text);
}

// The fake backend's canned subject is "About <first three words>", so a row
// still matches on the text it was started with.
const row = (win: Page, title: string) => win.locator('.chat-row').filter({ hasText: title });
/**
 * The first snooze preset ("Later today"), whatever day it is.
 *
 * Never by name: which presets the menu OFFERS depends on the weekday, because
 * it drops ones that resolve to the same instant. On a Friday "Tomorrow" and
 * "This weekend" are the same 9am; on a Sunday "Tomorrow" and "Next week" are.
 * A test that clicked "Next week" passed six days a week and hung on the
 * seventh. The first entry is the only one that can never collide — it is the
 * only relative one — so it is the one to drive.
 */
const snoozePreset = (win: Page) => win.locator('.snooze-menu .snooze-preset').first();
/** The Inbox/Chats tabs. Scoped: the rail's Chats tab shares its name. */
const tab = (win: Page, name: string) =>
  win.locator('.chats-modes').getByRole('button', { name, exact: true });
const group = (win: Page, name: RegExp) => win.getByRole('button', { name });

test('the chat list opens on the Inbox with every thread waiting', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');

  await expect(tab(mainWindow, 'Inbox')).toHaveClass(/active/);
  await expect(mainWindow.locator('.chat-row')).toHaveCount(2);
});

test('the tab you were last on is the one that comes back', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await tab(mainWindow, 'Chats').click();
  await expect(tab(mainWindow, 'Chats')).toHaveClass(/active/);

  await mainWindow.reload();
  await mainWindow.waitForLoadState('domcontentloaded');
  await expect(tab(mainWindow, 'Chats')).toHaveClass(/active/);
});

test('a new thread gets a written subject, and the row renames itself', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  // Everywhere is the default: the subject becomes the thread's actual name, so
  // it shows in the Chats tree too, not only in the Inbox.
  await expect(row(mainWindow, 'About alpha')).toBeVisible();
  await tab(mainWindow, 'Chats').click();
  await expect(row(mainWindow, 'About alpha')).toBeVisible();
});

test('an Inbox row previews the newest message, until you turn previews off', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  // The preview follows the thread, so it is the assistant's reply that shows.
  await expect(mainWindow.locator('.chat-preview')).toHaveText(/Echo: alpha/);

  // Set it the way Settings does — persist, then tell the list to re-read.
  await mainWindow.evaluate(async () => {
    const w = window as any;
    await w.stem.updateChatsSettings({ previewLines: 0 });
    window.dispatchEvent(new CustomEvent('stem:chat-settings'));
  });
  await expect(mainWindow.locator('.chat-preview')).toHaveCount(0);
});

test('archiving moves a thread out of the Inbox but leaves it in the Chats tree', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');

  // Hover reveals the per-row triage actions; archive the first thread.
  const alpha = row(mainWindow, 'alpha');
  await alpha.hover();
  await alpha.getByRole('button', { name: 'Archive' }).click();

  await expect(mainWindow.locator('.chat-row')).toHaveCount(1);
  await expect(row(mainWindow, 'beta')).toBeVisible();

  // It's in the Archived group at the foot of the Inbox...
  await group(mainWindow, /Archived \(1\)/).click();
  await expect(row(mainWindow, 'alpha')).toBeVisible();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(2);

  // ...and archiving is Inbox-only: the Chats tree still lists both.
  await tab(mainWindow, 'Chats').click();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(2);
});

test('triaging the thread you are reading advances to the next one', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');

  // Rows are newest-first, so beta is both the open thread and the top row.
  const beta = row(mainWindow, 'beta');
  await beta.hover();
  await beta.getByRole('button', { name: 'Archive' }).click();

  await expect(row(mainWindow, 'alpha')).toHaveClass(/selected/);
  await expect(mainWindow.locator('.message-user').last()).toContainText('alpha');

  // Snoozing the one you land on advances the same way — and there is nothing
  // left to advance to, so you end up in a new chat, ready to write.
  const alpha = row(mainWindow, 'alpha');
  await alpha.hover();
  await alpha.getByRole('button', { name: 'Snooze' }).click();
  await snoozePreset(mainWindow).click();

  await expect(mainWindow.locator('.message-user')).toHaveCount(0);
  await expect(mainWindow.locator('.chat-row.selected')).toHaveCount(0);
});

test('triaging a row you are not reading leaves the open thread alone', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');

  const alpha = row(mainWindow, 'alpha');
  await alpha.hover();
  await alpha.getByRole('button', { name: 'Archive' }).click();

  await expect(row(mainWindow, 'beta')).toHaveClass(/selected/);
  await expect(mainWindow.locator('.message-user').last()).toContainText('beta');
});

test('an archived thread can be moved back to the Inbox', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');

  const inboxRow = row(mainWindow, 'alpha');
  await inboxRow.hover();
  await inboxRow.getByRole('button', { name: 'Archive' }).click();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(0);

  await group(mainWindow, /Archived \(1\)/).click();
  const archivedRow = row(mainWindow, 'alpha');
  await archivedRow.hover();
  await archivedRow.getByRole('button', { name: 'Move to Inbox' }).click();

  await expect(mainWindow.getByRole('button', { name: /Archived/ })).toHaveCount(0);
  await expect(row(mainWindow, 'alpha')).toBeVisible();
});

test('snoozing hides a thread under a Snoozed group it can be woken from', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');

  const alpha = row(mainWindow, 'alpha');
  await alpha.hover();
  await alpha.getByRole('button', { name: 'Snooze' }).click();
  // Presets resolve to real instants; the first is far enough out that the row
  // cannot wake mid-test.
  await snoozePreset(mainWindow).click();

  // Out of the list proper, into a collapsed disclosure that counts it.
  await expect(mainWindow.locator('.chat-row')).toHaveCount(1);
  const toggle = group(mainWindow, /Snoozed \(1\)/);
  await expect(toggle).toBeVisible();

  await toggle.click();
  const snoozed = row(mainWindow, 'alpha');
  await expect(snoozed).toBeVisible();
  await snoozed.hover();
  await snoozed.getByRole('button', { name: 'Un-snooze' }).click();

  await expect(mainWindow.getByRole('button', { name: /Snoozed/ })).toHaveCount(0);
  await expect(mainWindow.locator('.chat-row')).toHaveCount(2);
});

test('inbox state survives a restart', async ({ mainWindow, electronApp }) => {
  await send(mainWindow, 'alpha');
  const alpha = row(mainWindow, 'alpha');
  await alpha.hover();
  await alpha.getByRole('button', { name: 'Archive' }).click();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(0);

  // Reload the renderer: the state has to come back from inbox.json, not from
  // whatever the session store happened to be holding.
  await mainWindow.reload();
  await mainWindow.waitForLoadState('domcontentloaded');
  void electronApp;

  await expect(mainWindow.locator('.chat-row')).toHaveCount(0);
  await group(mainWindow, /Archived \(1\)/).click();
  await expect(row(mainWindow, 'alpha')).toBeVisible();
});

// ---- triage shortcuts ----
// ControlOrMeta is Playwright's platform-correct mod key, so these assert the
// same contract the unit tests assert per-platform: ⌘⇧A / ⌘⇧S / ⌘⇧U on mac,
// Ctrl+Shift+… everywhere else.
const ARCHIVE = 'ControlOrMeta+Shift+A';
const SNOOZE = 'ControlOrMeta+Shift+S';
const READ = 'ControlOrMeta+Shift+D';

test('the archive shortcut triages the open thread and advances', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');

  // beta is the open thread; archiving it should land on alpha.
  await mainWindow.keyboard.press(ARCHIVE);
  await expect(row(mainWindow, 'alpha')).toHaveClass(/selected/);
  await expect(mainWindow.locator('.message-user').last()).toContainText('alpha');
  await group(mainWindow, /Archived \(1\)/).click();
  await expect(row(mainWindow, 'beta')).toBeVisible();
});

test('the archive shortcut still works with the chat list unmounted', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');

  // ⌘\ hides the inspector, which unmounts the list the buttons live in. The
  // shortcut is registered above it, so triage survives.
  await mainWindow.keyboard.press('ControlOrMeta+\\');
  await expect(mainWindow.locator('.inspector')).toHaveCount(0);
  await mainWindow.keyboard.press(ARCHIVE);
  await expect(mainWindow.locator('.message-user').last()).toContainText('alpha');

  await mainWindow.keyboard.press('ControlOrMeta+\\');
  await expect(mainWindow.locator('.chat-row')).toHaveCount(1);
});

test('the snooze shortcut opens a picker that finishes without a mouse', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');

  await mainWindow.keyboard.press(SNOOZE);
  const menu = mainWindow.locator('.snooze-menu');
  await expect(menu).toBeVisible();
  // It takes focus on the first preset, and arrows walk the list.
  await expect(menu.getByRole('button').first()).toBeFocused();
  await mainWindow.keyboard.press('ArrowDown');
  await expect(menu.getByRole('button').nth(1)).toBeFocused();
  await mainWindow.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // Re-open and commit: beta leaves the Inbox and alpha becomes the open thread.
  await mainWindow.keyboard.press(SNOOZE);
  await snoozePreset(mainWindow).click();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(1);
  await expect(mainWindow.locator('.message-user').last()).toContainText('alpha');
});

test('picking a custom date commits on the day, with no second button', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await mainWindow.keyboard.press(SNOOZE);
  await mainWindow.getByRole('button', { name: 'Pick a date…' }).click();

  // Six full weeks, always — the popover must not change height as you page.
  const days = mainWindow.locator('.snooze-day');
  await expect(days).toHaveCount(42);
  // Paging is reachable, and does not close the menu out from under you.
  await mainWindow.getByRole('button', { name: 'Next month' }).click();
  await expect(mainWindow.locator('.snooze-cal')).toBeVisible();

  // The day IS the commit: this used to need a click on the date field, a click
  // in the OS calendar it opened, and then a third on a "Snooze" button back in
  // the menu that was easy to miss entirely.
  await days.filter({ hasNotText: /^$/ }).last().click();
  await expect(mainWindow.locator('.snooze-menu')).toHaveCount(0);
  await expect(mainWindow.locator('.chat-row')).toHaveCount(0);
  await expect(group(mainWindow, /Snoozed \(1\)/)).toBeVisible();
});

test('the snooze shortcut wakes a thread that is already snoozed', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await mainWindow.keyboard.press(SNOOZE);
  await snoozePreset(mainWindow).click();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(0);

  // Select the snoozed row, then the same shortcut sends it back.
  await group(mainWindow, /Snoozed \(1\)/).click();
  await row(mainWindow, 'alpha').click({ modifiers: ['ControlOrMeta'] });
  await mainWindow.keyboard.press(SNOOZE);
  await expect(mainWindow.getByRole('button', { name: /Snoozed/ })).toHaveCount(0);
  await expect(mainWindow.locator('.chat-row')).toHaveCount(1);
});

test('the read shortcut hands the open thread back as unread', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  // Reading a thread marks it read, so the row is not bold to begin with.
  await expect(row(mainWindow, 'alpha')).not.toHaveClass(/unread/);

  await mainWindow.keyboard.press(READ);
  await expect(row(mainWindow, 'alpha')).toHaveClass(/unread/);
  // And back: nothing in the target is unread now, so it marks read again.
  await mainWindow.keyboard.press(READ);
  await expect(row(mainWindow, 'alpha')).not.toHaveClass(/unread/);
});

test('a selection is what the shortcuts act on while one exists', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');
  await newThread(mainWindow, 'gamma');

  await row(mainWindow, 'alpha').click({ modifiers: ['ControlOrMeta'] });
  await row(mainWindow, 'beta').click({ modifiers: ['ControlOrMeta'] });
  await expect(mainWindow.getByText('2 selected')).toBeVisible();

  // gamma is open but not selected, so the selection wins and gamma stays put.
  await mainWindow.keyboard.press(ARCHIVE);
  await expect(mainWindow.locator('.chat-row')).toHaveCount(1);
  await expect(row(mainWindow, 'gamma')).toBeVisible();
  await expect(mainWindow.locator('.message-user').last()).toContainText('gamma');
  await expect(mainWindow.getByText('2 selected')).toHaveCount(0);

  // An all-archived selection reverses: the same key restores it.
  await group(mainWindow, /Archived \(2\)/).click();
  await row(mainWindow, 'alpha').click({ modifiers: ['ControlOrMeta'] });
  await row(mainWindow, 'beta').click({ modifiers: ['ControlOrMeta'] });
  await mainWindow.keyboard.press(ARCHIVE);
  await expect(mainWindow.getByRole('button', { name: /Archived/ })).toHaveCount(0);
  await expect(mainWindow.locator('.chat-row')).toHaveCount(3);
});

test('⌘-click builds a selection the bar acts on in bulk', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');
  await newThread(mainWindow, 'gamma');
  await expect(mainWindow.locator('.chat-row')).toHaveCount(3);

  await row(mainWindow, 'alpha').click({ modifiers: ['ControlOrMeta'] });
  await row(mainWindow, 'beta').click({ modifiers: ['ControlOrMeta'] });
  await expect(mainWindow.getByText('2 selected')).toBeVisible();

  await mainWindow.locator('.inbox-selbar').getByRole('button', { name: 'Archive' }).click();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(1);
  await expect(row(mainWindow, 'gamma')).toBeVisible();
});

// ---- context menu ----
// Right-click is the same menu everywhere a chat row appears. The Inbox half is a
// guard (the hover buttons are the discoverable path, but the menu is what carries
// Rename, Delete and Move to…); the search half is the one that regressed — result
// rows used to be render-only, so a chat you had just found was the one chat you
// could not act on.

/** Search, retrying Enter: indexing a finished turn is async, so the first pass can miss. */
async function search(win: Page, query: string): Promise<void> {
  await win.getByTitle(/Search chats/).click();
  const box = win.getByPlaceholder('Search chats…');
  await box.fill(query);
  await expect(async () => {
    await box.press('Enter');
    await expect(win.locator('.search-result')).not.toHaveCount(0, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test('right-clicking an Inbox row opens the menu, which triages it', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');

  await row(mainWindow, 'alpha').click({ button: 'right' });
  const menu = mainWindow.locator('.ctx-menu');
  await expect(menu).toBeVisible();

  await menu.getByRole('button', { name: 'Archive' }).click();
  await expect(menu).toHaveCount(0);
  await expect(mainWindow.locator('.chat-row')).toHaveCount(1);
  await expect(group(mainWindow, /Archived \(1\)/)).toBeVisible();
});

test('a search result carries the same menu as the row it stands for', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');

  await search(mainWindow, 'alpha');
  await mainWindow.locator('.search-result').first().click({ button: 'right' });
  const menu = mainWindow.locator('.ctx-menu');
  await expect(menu).toBeVisible();
  // The chat half of the menu, not a folder's — including the filing actions the
  // tree offers, so a found chat can be put away without leaving the results.
  await expect(menu.getByRole('button', { name: 'Snooze…' })).toBeVisible();
  await expect(menu.getByText('Move to…')).toBeVisible();

  await menu.getByRole('button', { name: 'Archive' }).click();
  await expect(menu).toHaveCount(0);

  // Search shows archived chats, so the result stays put; the Inbox behind it moved.
  await mainWindow.getByPlaceholder('Search chats…').press('Escape');
  await expect(mainWindow.locator('.chat-row')).toHaveCount(1);
  await expect(row(mainWindow, 'beta')).toBeVisible();
  await expect(group(mainWindow, /Archived \(1\)/)).toBeVisible();
});

test('renaming and deleting from a search result act on that chat', async ({ mainWindow }) => {
  await send(mainWindow, 'alpha');
  await newThread(mainWindow, 'beta');

  await search(mainWindow, 'alpha');
  const result = mainWindow.locator('.search-result').first();
  await result.click({ button: 'right' });
  await mainWindow.locator('.ctx-menu').getByRole('button', { name: 'Rename' }).click();
  // The editor opens in the result row itself — the tree it normally opens in is
  // not on screen — and the new name replaces the indexed one without re-searching.
  const editor = result.locator('.chat-edit');
  await expect(editor).toBeFocused();
  await editor.fill('renamed');
  await editor.press('Enter');
  await expect(result).toContainText('renamed');

  await result.click({ button: 'right' });
  await mainWindow.locator('.ctx-menu').getByRole('button', { name: 'Delete' }).click();
  // The row goes with the chat: results are a snapshot, so nothing else would
  // clear a row that now opens nothing.
  await expect(mainWindow.locator('.search-result')).toHaveCount(0);
  await mainWindow.getByPlaceholder('Search chats…').press('Escape');
  await expect(mainWindow.locator('.chat-row')).toHaveCount(1);
  await expect(row(mainWindow, 'beta')).toBeVisible();
});

// The mail Inbox, driven through real DOM and real IPC against the scripted
// FakeBackend. A composed mail goes through the real router: it starts a turn
// on the persona's hidden thread (the fake echoes it), and the settled turn's
// final message comes back as the reply mail — so these tests cover the whole
// loop, not a mocked list.
import { test, expect } from './electron';
import type { Page } from '@playwright/test';

const tab = (win: Page, name: string) =>
  win.locator('.chats-modes').getByRole('button', { name, exact: true });
const mailRow = (win: Page, text: string) => win.locator('.mail-row').filter({ hasText: text });
const group = (win: Page, name: RegExp) => win.getByRole('button', { name });
const snoozePreset = (win: Page) => win.locator('.snooze-menu .snooze-preset').first();

/** Compose a mail to the built-in Normal persona and wait for its reply. */
async function compose(win: Page, subject: string, body: string): Promise<void> {
  await tab(win, 'Inbox').click();
  await win.getByTitle('New mail', { exact: true }).click(); // the rail pen, not the titlebar button
  await win.getByPlaceholder('What this is about').fill(subject);
  await win.getByPlaceholder(/Write the task/).fill(body);
  await win.getByRole('button', { name: 'Send' }).click();
  // Sending closes the pane (email semantics — the copy is under Sent); the
  // conversation surfaces in the Inbox when the persona's reply (the fake's
  // echo) lands. Open it so callers find the conversation view up, as before.
  await expect(mailRow(win, subject)).toBeVisible({ timeout: 15_000 });
  await mailRow(win, subject).click();
  await expect(win.locator('.mail-view .mail-item').filter({ hasText: `Echo: ${body}` })).toBeVisible();
}

async function sendChat(win: Page, text: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
  await expect(win.locator('.message-assistant:not(.activity-row) .message-body').last()).toContainText(
    `Echo: ${text}`
  );
}

test('composing a mail delivers it and the reply lands as one conversation', async ({ mainWindow }) => {
  await compose(mainWindow, 'First errand', 'fetch the thing');

  // The conversation view reads like email: your mail, then the persona's reply.
  const items = mainWindow.locator('.mail-view .mail-item');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText('You');
  await expect(items.last()).toContainText('Normal');

  // One row in the Inbox; opening it marked it read, so it is not bold.
  await expect(mainWindow.locator('.mail-row')).toHaveCount(1);
  await expect(mailRow(mainWindow, 'First errand')).not.toHaveClass(/unread/);
  // The sent copy lives under Sent.
  await group(mainWindow, /Sent \(1\)/).click();
});

test('the To: chips build a multi-persona conversation with the first pick driving', async ({ mainWindow }) => {
  await tab(mainWindow, 'Inbox').click();
  await mainWindow.getByTitle('New mail', { exact: true }).click();
  // Normal is pre-selected as the default driver; adding Verifier keeps it first.
  const verifierChip = mainWindow.locator('.mail-to-chip', { hasText: 'Verifier' });
  await verifierChip.click();
  await expect(verifierChip).toHaveClass(/on/);
  await expect(
    mainWindow.locator('.mail-to-chip', { hasText: 'Normal' }).locator('.mail-to-driver')
  ).toBeVisible();
  await mainWindow.getByPlaceholder('What this is about').fill('Team errand');
  await mainWindow.getByPlaceholder(/Write the task/).fill('check it twice');
  await mainWindow.getByRole('button', { name: 'Send' }).click();
  // Sending closes the pane; the reply surfaces the row. The conversation lists
  // BOTH participants; only the driver replied (the fake echo).
  await expect(mailRow(mainWindow, 'Team errand')).toBeVisible({ timeout: 15_000 });
  await mailRow(mainWindow, 'Team errand').click();
  await expect(mainWindow.locator('.mail-head-to')).toContainText('Normal, Verifier');
  await expect(
    mainWindow.locator('.mail-view .mail-item').filter({ hasText: 'Echo: check it twice' })
  ).toBeVisible();
});

test('replying resumes the same conversation and the exchange stays threaded', async ({ mainWindow }) => {
  await compose(mainWindow, 'Errand', 'first ask');

  const reply = mainWindow.getByPlaceholder(/Reply to/);
  await reply.fill('follow-up ask');
  await mainWindow.getByRole('button', { name: 'Send' }).click();
  await expect(
    mainWindow.locator('.mail-view .mail-item').filter({ hasText: 'Echo: follow-up ask' })
  ).toBeVisible({ timeout: 15_000 });
  await expect(mainWindow.locator('.mail-view .mail-item')).toHaveCount(4);
  // Still ONE conversation in the list.
  await expect(mainWindow.locator('.mail-row')).toHaveCount(1);
});

test('chats never appear in the Inbox, and mail never appears under Chats', async ({ mainWindow }) => {
  await sendChat(mainWindow, 'plain chat');
  await compose(mainWindow, 'Mail thing', 'do it');

  await tab(mainWindow, 'Inbox').click();
  await expect(mainWindow.locator('.mail-row')).toHaveCount(1);
  await expect(mainWindow.locator('.mail-row')).toContainText('Mail thing');

  await tab(mainWindow, 'Chats').click();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(1);
  // The persona's hidden thread is filtered out of the tree; only the chat shows.
  await expect(mainWindow.locator('.chat-row')).not.toContainText('do it');
});

test('archiving moves a conversation out and a new reply resurrects it', async ({ mainWindow }) => {
  await compose(mainWindow, 'Watch this', 'observe');

  const row = mailRow(mainWindow, 'Watch this');
  await row.hover();
  await row.getByRole('button', { name: 'Archive' }).click();
  await expect(mainWindow.locator('.mail-row')).toHaveCount(0);
  await group(mainWindow, /Archived \(1\)/).click();
  await expect(mailRow(mainWindow, 'Watch this')).toBeVisible();

  // A reply into the archived conversation pulls it back into the Inbox — the
  // email rule, derived from the reply's own timestamp.
  await mailRow(mainWindow, 'Watch this').click();
  const reply = mainWindow.getByPlaceholder(/Reply to/);
  await reply.fill('one more thing');
  await mainWindow.getByRole('button', { name: 'Send' }).click();
  await expect(
    mainWindow.locator('.mail-view .mail-item').filter({ hasText: 'Echo: one more thing' })
  ).toBeVisible({ timeout: 15_000 });
  await expect(mainWindow.getByRole('button', { name: /Archived/ })).toHaveCount(0);
  await expect(mailRow(mainWindow, 'Watch this')).toBeVisible();
});

test('snoozing hides a conversation under Snoozed, and it can be woken', async ({ mainWindow }) => {
  await compose(mainWindow, 'Later problem', 'not now');

  const row = mailRow(mainWindow, 'Later problem');
  await row.hover();
  await row.getByRole('button', { name: 'Snooze' }).click();
  await snoozePreset(mainWindow).click();

  await expect(mainWindow.locator('.mail-row')).toHaveCount(0);
  await group(mainWindow, /Snoozed \(1\)/).click();
  const snoozed = mailRow(mainWindow, 'Later problem');
  await expect(snoozed).toBeVisible();
  await snoozed.hover();
  await snoozed.getByRole('button', { name: 'Un-snooze' }).click();
  await expect(mainWindow.getByRole('button', { name: /Snoozed/ })).toHaveCount(0);
  await expect(mainWindow.locator('.mail-row')).toHaveCount(1);
});

test('mail state survives a reload', async ({ mainWindow, electronApp }) => {
  await compose(mainWindow, 'Persistent errand', 'stay put');
  const row = mailRow(mainWindow, 'Persistent errand');
  await row.hover();
  await row.getByRole('button', { name: 'Archive' }).click();
  await expect(mainWindow.locator('.mail-row')).toHaveCount(0);

  await mainWindow.reload();
  await mainWindow.waitForLoadState('domcontentloaded');
  void electronApp;

  await tab(mainWindow, 'Inbox').click();
  await expect(mainWindow.locator('.mail-row')).toHaveCount(0);
  await group(mainWindow, /Archived \(1\)/).click();
  await expect(mailRow(mainWindow, 'Persistent errand')).toBeVisible();
});

test('the archive shortcut acts on the mail conversation you are reading', async ({ mainWindow }) => {
  await compose(mainWindow, 'Shortcut fodder', 'quick one');
  // The conversation is open; ⌘⇧A archives it and dismisses the view.
  await mainWindow.keyboard.press('ControlOrMeta+Shift+A');
  await expect(mainWindow.locator('.mail-view')).toHaveCount(0);
  await expect(mainWindow.locator('.mail-row')).toHaveCount(0);
  await expect(group(mainWindow, /Archived \(1\)/)).toBeVisible();
});

test('the New conversation button stays enabled over a mail view and dismisses it', async ({ mainWindow }) => {
  await compose(mainWindow, 'Dismiss me', 'hello');
  // The conversation sits over an EMPTY chat draft — the state that used to
  // disable the button and made it look dead.
  const btn = mainWindow.getByTitle(/New conversation/);
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect(mainWindow.locator('.mail-view')).toHaveCount(0);
});

test('the titlebar New mail button and its shortcut open the compose view', async ({ mainWindow }) => {
  // The titlebar button (title carries the keycap, unlike the rail's pen).
  await mainWindow.getByTitle(/New mail \(/).click();
  await expect(mainWindow.getByPlaceholder('What this is about')).toBeVisible();
  // Back to a blank chat, then the shortcut route.
  await mainWindow.getByTitle(/New conversation/).click();
  await expect(mainWindow.getByPlaceholder('What this is about')).toHaveCount(0);
  await mainWindow.keyboard.press('ControlOrMeta+Shift+N');
  await expect(mainWindow.getByPlaceholder('What this is about')).toBeVisible();
});

test('an unread reply bolds the row and badges the rail until read', async ({ mainWindow }) => {
  await compose(mainWindow, 'Badge check', 'ping');
  // Mark it unread from the context menu; the row bolds and the segment counts.
  const row = mailRow(mainWindow, 'Badge check');
  await row.click({ button: 'right' });
  await mainWindow.locator('.ctx-menu').getByRole('button', { name: 'Mark as unread' }).click();
  await expect(row).toHaveClass(/unread/);
  await expect(mainWindow.locator('.chats-modes .seg-count')).toHaveText('1');

  // Mark all read clears it.
  await mainWindow.getByTitle('Mark all as read').click();
  await expect(row).not.toHaveClass(/unread/);
  await expect(mainWindow.locator('.chats-modes .seg-count')).toHaveCount(0);
});

test('deleting a conversation removes it and its hidden thread stays gone', async ({ mainWindow }) => {
  await compose(mainWindow, 'Doomed errand', 'goodbye');
  const row = mailRow(mainWindow, 'Doomed errand');
  await row.click({ button: 'right' });
  await mainWindow.locator('.ctx-menu').getByRole('button', { name: 'Delete conversation' }).click();
  await expect(mainWindow.locator('.mail-row')).toHaveCount(0);
  // Nothing leaked into the Chats tree either.
  await tab(mainWindow, 'Chats').click();
  await expect(mainWindow.locator('.chat-row')).toHaveCount(0);
});

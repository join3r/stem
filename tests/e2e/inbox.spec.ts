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
  await win.getByPlaceholder(/Stem names it/).fill(subject);
  await win.getByPlaceholder(/Write the task/).fill(body);
  await win.getByRole('button', { name: /^Send/ }).click();
  // Sending closes the form, like email: nothing working shows in its place.
  await expect(win.getByPlaceholder(/Write the task/)).toHaveCount(0);
  await expect(win.locator('.mail-view')).toHaveCount(0);
  // The persona's reply (the fake's echo) brings the row into the Inbox;
  // opening it shows the reply.
  await expect(mailRow(win, subject)).toBeVisible({ timeout: 15_000 });
  await mailRow(win, subject).click();
  await expect(win.locator('.mail-view .mail-item').filter({ hasText: `Echo: ${body}` })).toBeVisible();
}

/** Reply in the open conversation: the view closes on send; reopen it once the answer lands. */
async function reply(win: Page, subject: string, body: string): Promise<void> {
  await win.getByPlaceholder(/Reply to/).fill(body);
  await win.getByRole('button', { name: 'Send' }).click();
  await expect(win.locator('.mail-view')).toHaveCount(0);
  await expect(mailRow(win, subject)).toBeVisible({ timeout: 15_000 });
  await mailRow(win, subject).click();
  await expect(win.locator('.mail-view .mail-item').filter({ hasText: `Echo: ${body}` })).toBeVisible({
    timeout: 15_000
  });
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

  // The conversation reads newest first: the persona's reply open on top, your
  // older mail folded to one line beneath it, the reply box above both.
  await expect(mainWindow.locator('.mail-view .mail-items > :first-child')).toHaveClass(/mail-reply/);
  const items = mainWindow.locator('.mail-view .mail-item');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('Normal');
  await expect(mainWindow.locator('.mail-view .mail-fold')).toContainText('You');

  // One row in the Inbox; opening it marked it read, so it is not bold.
  await expect(mainWindow.locator('.mail-row')).toHaveCount(1);
  await expect(mailRow(mainWindow, 'First errand')).not.toHaveClass(/unread/);
  // The sent copy lives under Sent.
  await group(mainWindow, /Sent \(1\)/).click();
});

test('the To: field builds a multi-persona conversation with the first name leading', async ({ mainWindow }) => {
  await tab(mainWindow, 'Inbox').click();
  await mainWindow.getByTitle('New mail', { exact: true }).click();
  // Normal is pre-filled as the lead; typing adds Verifier after it.
  const to = mainWindow.getByRole('combobox', { name: 'Add a persona' });
  await to.fill('Veri');
  await to.press('Enter');
  await expect(mainWindow.locator('.mail-to-token', { hasText: 'Verifier' })).toBeVisible();
  await expect(mainWindow.locator('.mail-to-token.lead')).toContainText('Normal');
  await expect(mainWindow.locator('.mail-to-token.lead .mail-to-lead')).toBeVisible();
  // A click on the still-focused input after a pick shows the list again.
  await to.click();
  await expect(mainWindow.getByRole('listbox', { name: 'Personas' })).toBeVisible();
  await to.press('Escape');
  await mainWindow.getByPlaceholder(/Stem names it/).fill('Team errand');
  await mainWindow.getByPlaceholder(/Write the task/).fill('check it twice');
  await mainWindow.getByRole('button', { name: 'Send to Normal' }).click();
  // The answer brings it into the Inbox. It lists BOTH participants; only the
  // lead replied (the fake echo).
  await expect(mailRow(mainWindow, 'Team errand')).toBeVisible({ timeout: 15_000 });
  await mailRow(mainWindow, 'Team errand').click();
  await expect(mainWindow.locator('.mail-head-to')).toContainText('Normal leads · Verifier');
  await expect(
    mainWindow.locator('.mail-view .mail-item').filter({ hasText: 'Echo: check it twice' })
  ).toBeVisible();
});

test('replying resumes the same conversation and the exchange stays threaded', async ({ mainWindow }) => {
  await compose(mainWindow, 'Errand', 'first ask');
  await reply(mainWindow, 'Errand', 'follow-up ask');
  // Four mails: the newest open, the rest folded to one line each.
  await expect(mainWindow.locator('.mail-view .mail-item, .mail-view .mail-fold')).toHaveCount(4);
  // Still ONE conversation in the list.
  await expect(mainWindow.locator('.mail-row')).toHaveCount(1);
});

// The reply box's To row is New mail's To: field editing the open
// conversation's personas. Driven by mouse as well as keys: a To row that
// worked only through fill()/press() once collapsed under every real click.

/** Click into the reply box (as a user does) and return it, unfolded. */
async function openReply(win: Page) {
  await win.getByPlaceholder(/Reply to/).click();
  const box = win.locator('.mail-reply');
  await expect(box).toHaveClass(/expanded/);
  return box;
}

/** Add a persona to the open conversation by clicking it in the reply's To list. */
async function clickToAdd(win: Page, persona: string) {
  const box = win.locator('.mail-reply');
  await box.getByRole('combobox', { name: 'Add a persona' }).click();
  await box.getByRole('option', { name: new RegExp(persona) }).click();
  await expect(box.locator('.mail-to-token', { hasText: persona })).toBeVisible();
}

/**
 * Each To pill's name, with the room left of it and the room right of it up
 * to the pill's edge (past its buttons, if it has any).
 */
async function pillInsets(win: Page) {
  return win.locator('.mail-reply .mail-to-token').evaluateAll((pills) =>
    pills.map((pill) => {
      const box = pill.getBoundingClientRect();
      const text = [...pill.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
      const range = document.createRange();
      range.selectNodeContents(text!);
      const name = range.getBoundingClientRect();
      return {
        name: text!.textContent!.trim(),
        left: name.left - box.left,
        right: box.right - name.right,
        clipped: pill.scrollWidth > pill.clientWidth + 1
      };
    })
  );
}

test('the reply box\'s To row adds a persona from the keyboard', async ({ mainWindow }) => {
  await compose(mainWindow, 'Add later', 'start alone');
  const box = await openReply(mainWindow);
  const to = box.getByRole('combobox', { name: 'Add a persona' });
  await to.fill('Crit');
  await to.press('Enter');
  // It joins at once: a token in the To row, a name in the header.
  await expect(box.locator('.mail-to-token', { hasText: 'Critic' })).toBeVisible();
  await expect(mainWindow.locator('.mail-head-to')).toContainText('Normal leads · Critic');
  await expect(box.locator('.mail-to-token.lead')).toContainText('Normal');
});

test('the reply box\'s To row works by mouse: clicking names opens the list and a click adds', async ({
  mainWindow
}) => {
  await compose(mainWindow, 'Add by mouse', 'start alone');
  const box = await openReply(mainWindow);
  // Clicking the names (plain text) used to blur the empty reply and fold it
  // away under the click.
  await box.locator('.mail-to-token.lead').click();
  await expect(box).toHaveClass(/expanded/);
  await expect(box.getByRole('combobox', { name: 'Add a persona' })).toBeFocused();
  await expect(box.getByRole('listbox', { name: 'Personas' })).toBeVisible();
  await box.getByRole('option', { name: /Critic/ }).click();
  await expect(box.locator('.mail-to-token', { hasText: 'Critic' })).toBeVisible();
  await expect(mainWindow.locator('.mail-head-to')).toContainText('Normal leads · Critic');
  // Every part of the row keeps the reply open: the label, the line under it.
  await box.locator('.mail-reply-to > span').first().click();
  await expect(box).toHaveClass(/expanded/);
  await box.locator('.mail-to-hint').click();
  await expect(box).toHaveClass(/expanded/);
  // And the list still adds after all that clicking around.
  await clickToAdd(mainWindow, 'Verifier');
  await expect(mainWindow.locator('.mail-head-to')).toContainText('Normal leads · Critic · Verifier');
});

test('the crown in the reply\'s To row makes another persona lead, and the reply goes to it', async ({
  mainWindow
}) => {
  await compose(mainWindow, 'Hand over', 'start with Normal');
  const box = await openReply(mainWindow);
  await clickToAdd(mainWindow, 'Critic');
  await box.getByRole('button', { name: 'Make Critic lead' }).click();
  await expect(box).toHaveClass(/expanded/);
  await expect(box.locator('.mail-to-token.lead')).toContainText('Critic');
  await expect(mainWindow.locator('.mail-head-to')).toContainText('Critic leads · Normal');
  await expect(mainWindow.getByPlaceholder('Reply to Critic')).toBeVisible();

  await mainWindow.getByPlaceholder('Reply to Critic').fill('your turn');
  await mainWindow.getByRole('button', { name: 'Send' }).click();
  await expect(mailRow(mainWindow, 'Hand over')).toBeVisible({ timeout: 15_000 });
  await mailRow(mainWindow, 'Hand over').click();
  const answer = mainWindow.locator('.mail-view .mail-item').filter({ hasText: 'Echo: your turn' });
  await expect(answer).toBeVisible({ timeout: 15_000 });
  await expect(answer).toContainText('Critic');
  await expect(mainWindow.locator('.mail-head-to')).toContainText('Critic leads · Normal');
});

test('the reply\'s To row removes personas but always keeps one, and the change survives a reload', async ({
  mainWindow
}) => {
  await compose(mainWindow, 'Trim down', 'start alone');
  const box = await openReply(mainWindow);
  // One persona: nothing to remove.
  await expect(box.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await clickToAdd(mainWindow, 'Critic');
  await clickToAdd(mainWindow, 'Verifier');
  await box.getByRole('button', { name: 'Remove Critic' }).click();
  await expect(box).toHaveClass(/expanded/);
  await expect(box.locator('.mail-to-token', { hasText: 'Critic' })).toHaveCount(0);
  await expect(mainWindow.locator('.mail-head-to')).toContainText('Normal leads · Verifier');
  // Removing the lead hands the lead to the next name.
  await box.getByRole('button', { name: 'Remove Normal' }).click();
  await expect(box.locator('.mail-to-token.lead')).toContainText('Verifier');
  await expect(box.getByRole('button', { name: /^Remove / })).toHaveCount(0);

  await mainWindow.reload();
  await mainWindow.waitForLoadState('domcontentloaded');
  await tab(mainWindow, 'Inbox').click();
  await mailRow(mainWindow, 'Trim down').click();
  await expect(mainWindow.locator('.mail-head-to')).toHaveText(/^Verifier$/);
});

test('the reply\'s To pills give their names room on both sides', async ({ mainWindow }) => {
  await compose(mainWindow, 'Pill room', 'start alone');
  await openReply(mainWindow);
  const check = async () => {
    const pills = await pillInsets(mainWindow);
    expect(pills.length).toBeGreaterThan(0);
    for (const pill of pills) {
      expect(pill.clipped, `${pill.name} is cut off`).toBe(false);
      expect(pill.left, `${pill.name} touches its left edge`).toBeGreaterThanOrEqual(6);
      // At least the left's room on the right (its buttons add more).
      expect(pill.right, `${pill.name} sits against its right edge`).toBeGreaterThanOrEqual(pill.left - 1);
    }
  };
  // The lone lead pill has no buttons: this is where the name hit the edge.
  await check();
  await clickToAdd(mainWindow, 'Critic');
  await check();
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
  await reply(mainWindow, 'Watch this', 'one more thing');
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
  await expect(mainWindow.getByPlaceholder(/Stem names it/)).toBeVisible();
  // Back to a blank chat, then the shortcut route.
  await mainWindow.getByTitle(/New conversation/).click();
  await expect(mainWindow.getByPlaceholder(/Stem names it/)).toHaveCount(0);
  await mainWindow.keyboard.press('ControlOrMeta+Shift+N');
  await expect(mainWindow.getByPlaceholder(/Stem names it/)).toBeVisible();
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

// ---- the pinned Return-to-chat row ----
const returnRow = (win: Page) => win.locator('.inbox-return');

test('a chat opened while the Inbox is selected pins a Return-to-chat row, and returning stays on the Inbox', async ({ mainWindow }) => {
  // The app starts on the Inbox tab, so sending the draft creates a chat while
  // the Inbox is selected — that is what pins the row.
  await sendChat(mainWindow, 'route my day');
  await tab(mainWindow, 'Inbox').click();

  // The chat IS the centre pane, so the row is the non-actionable current state.
  await expect(returnRow(mainWindow)).toContainText('Currently viewing');
  await expect(returnRow(mainWindow)).toContainText('route my day');
  await expect(returnRow(mainWindow).locator('[aria-current="page"]')).toBeVisible();
  await expect(returnRow(mainWindow).getByRole('button', { name: /Return to chat/ })).toHaveCount(0);
  // Chrome, not mail: none of a mail row's triage anatomy.
  await expect(returnRow(mainWindow).getByRole('button', { name: 'Archive' })).toHaveCount(0);
  await expect(returnRow(mainWindow).getByRole('button', { name: 'Snooze' })).toHaveCount(0);

  // A trip through the mail makes it actionable; it survives open/read/reply chrome.
  await compose(mainWindow, 'Mail errand', 'do the thing');
  const back = returnRow(mainWindow).getByRole('button', { name: /Return to chat/ });
  await expect(back).toBeVisible();
  await back.click();

  // The chat is back in the centre pane and the sidebar never left the Inbox.
  await expect(
    mainWindow.locator('.message-assistant:not(.activity-row) .message-body').last()
  ).toContainText('Echo: route my day');
  await expect(mainWindow.locator('.mail-view')).toHaveCount(0);
  await expect(tab(mainWindow, 'Inbox')).toHaveClass(/active/);
  await expect(mainWindow.locator('.mail-row')).toBeVisible();
  await expect(returnRow(mainWindow)).toContainText('Currently viewing');
});

test('dismissing the Return-to-chat row clears it for good and hands focus to the Inbox segment', async ({ mainWindow }) => {
  await sendChat(mainWindow, 'short-lived target');
  await tab(mainWindow, 'Inbox').click();
  await expect(returnRow(mainWindow)).toBeVisible();

  await returnRow(mainWindow).getByRole('button', { name: 'Dismiss return to chat' }).click();
  await expect(returnRow(mainWindow)).toHaveCount(0);
  await expect(tab(mainWindow, 'Inbox')).toBeFocused();

  // Not merely hidden: tab away and back, still gone.
  await tab(mainWindow, 'Chats').click();
  await tab(mainWindow, 'Inbox').click();
  await expect(returnRow(mainWindow)).toHaveCount(0);
});

test('only an Inbox-selected open replaces the target, and deleting the target clears the row', async ({ mainWindow }) => {
  await sendChat(mainWindow, 'first chat');
  await tab(mainWindow, 'Inbox').click();
  await expect(returnRow(mainWindow)).toContainText('first chat');

  // A chat created from the CHATS tab must not steal the target.
  await tab(mainWindow, 'Chats').click();
  await mainWindow.getByTitle(/New thread/).click();
  await sendChat(mainWindow, 'second chat');
  await tab(mainWindow, 'Inbox').click();
  await expect(returnRow(mainWindow)).toContainText('first chat');
  // The centre pane shows the second chat, so the row is actionable now.
  await expect(returnRow(mainWindow).getByRole('button', { name: /Return to chat/ })).toBeVisible();

  // Deleting the target chat clears the row (nothing left to return to).
  await tab(mainWindow, 'Chats').click();
  await mainWindow.locator('.chat-row').filter({ hasText: 'first chat' }).click({ button: 'right' });
  await mainWindow.locator('.ctx-menu').getByRole('button', { name: /^Delete/ }).click();
  await tab(mainWindow, 'Inbox').click();
  await expect(returnRow(mainWindow)).toHaveCount(0);
});

test('the Return-to-chat target survives a reload', async ({ mainWindow }) => {
  await sendChat(mainWindow, 'durable target');
  await tab(mainWindow, 'Inbox').click();
  await expect(returnRow(mainWindow)).toContainText('durable target');

  await mainWindow.reload();
  await mainWindow.waitForLoadState('domcontentloaded');

  // A fresh window opens on a blank draft, so the persisted target resolves as
  // the actionable state — and it still opens the chat.
  await tab(mainWindow, 'Inbox').click();
  const back = returnRow(mainWindow).getByRole('button', { name: /Return to chat/ });
  await expect(back).toContainText('durable target');
  await back.click();
  await expect(
    mainWindow.locator('.message-assistant:not(.activity-row) .message-body').last()
  ).toContainText('Echo: durable target');
  await expect(returnRow(mainWindow)).toContainText('Currently viewing');
});

test('a reply read on another device drops the unread dot here too', async ({ mainWindow }) => {
  // A reply settles in chat A while chat B is open: A's row gets the solid
  // unread-reply dot and goes bold.
  const box = mainWindow.getByPlaceholder('Ask Stem…');
  await box.fill('[e2e:slow] read me elsewhere');
  await box.press('Enter');
  await tab(mainWindow, 'Chats').click();
  const rowA = mainWindow.locator('.chat-row.selected');
  await expect(rowA).toBeVisible();
  const threadA = await rowA.getAttribute('data-thread-id');
  await mainWindow.getByTitle('New conversation').click();
  const row = mainWindow.locator(`.chat-row[data-thread-id="${threadA}"]`);
  await expect(row.locator('.chat-status.done')).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveClass(/unread/);

  // The phone opens it: the read stamp reaches the server, not this window.
  await mainWindow.evaluate((id) => window.stem.setInboxRead([id!], true).then(() => undefined), threadA);
  await expect(row).not.toHaveClass(/unread/);
  await expect(row.locator('.chat-status.done')).toHaveCount(0);
});

test('a sent mail closes and waits under Sent, not as a Working row', async ({ mainWindow }) => {
  await tab(mainWindow, 'Inbox').click();
  await mainWindow.getByTitle('New mail', { exact: true }).click();
  await mainWindow.getByPlaceholder(/Stem names it/).fill('Slow errand');
  await mainWindow.getByPlaceholder(/Write the task/).fill('[e2e:slow] take your time');
  await mainWindow.getByRole('button', { name: /^Send/ }).click();
  await expect(mainWindow.getByPlaceholder(/Write the task/)).toHaveCount(0);
  await expect(mainWindow.locator('.mail-view')).toHaveCount(0);
  // While the persona works, nothing in the list says Working.
  await expect(mainWindow.locator('.mail-list-group', { hasText: 'Working' })).toHaveCount(0);
  await expect(mainWindow.locator('.mail-row')).toHaveCount(0);
  await expect(group(mainWindow, /Sent \(1\)/)).toBeVisible();
  // The answer brings it up into the Inbox.
  await expect(mailRow(mainWindow, 'Slow errand')).toBeVisible({ timeout: 15_000 });
});

test('a progress question mailed mid-work is answered on the spot and the work keeps going', async ({
  mainWindow
}) => {
  await tab(mainWindow, 'Inbox').click();
  await mainWindow.getByTitle('New mail', { exact: true }).click();
  await mainWindow.getByPlaceholder(/Stem names it/).fill('Long import');
  await mainWindow.getByPlaceholder(/Write the task/).fill('[e2e:hang] import everything');
  await mainWindow.getByRole('button', { name: /^Send/ }).click();
  await expect(mainWindow.locator('.mail-view')).toHaveCount(0);
  // Still working: it waits under Sent. Open it there.
  await group(mainWindow, /Sent \(1\)/).click();
  await mailRow(mainWindow, 'Long import').click();
  await expect(mainWindow.locator('.mail-head .mail-status.working')).toBeVisible();
  // The reply box says a progress question is answered now, not when the run ends.
  const box = await openReply(mainWindow);
  await expect(box.locator('.mail-reply-note')).toContainText('Ask how it’s going and Normal answers right away');
  await box.getByPlaceholder(/Reply to/).fill('[e2e:status] how is it going?');
  await box.getByRole('button', { name: 'Send' }).click();
  // Sending closes the view, like any reply; the answer is there on reopening.
  await expect(mainWindow.locator('.mail-view')).toHaveCount(0);
  // The answer lands in the Inbox (Sent, still open, lists the same conversation).
  await mailRow(mainWindow, 'Long import').first().click();
  await expect(
    mainWindow.locator('.mail-view .mail-item').filter({ hasText: 'Status: still on the first step' })
  ).toBeVisible({ timeout: 15_000 });
  // The question started no work, so the answer carries no (empty) Work panel.
  await expect(
    mainWindow.locator('.mail-view .mail-item').filter({ hasText: 'Status: still on the first step' }).locator('.mail-work')
  ).toHaveCount(0);
  // The work was not stopped or answered: the conversation is still working.
  await expect(mainWindow.locator('.mail-head .mail-status.working')).toBeVisible();
});

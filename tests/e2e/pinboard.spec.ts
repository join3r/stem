// Chat pinboard e2e (docs/chat-pinboard-plan.md): the strip under the chat
// header, its floating list and its docked ("Keep open") mode, driven in the
// real window against the scripted FakeBackend. Pins are made through the
// preload bridge here; the in-chat Pin action has its own spec once it lands.
import { test, expect } from './electron';
import type { Page } from '@playwright/test';

async function send(win: Page, text: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
}

/**
 * A press outside the board. The composer is always on screen and never under
 * the board, whatever the window size — a fixed spot in the transcript is not:
 * on a small CI window it lands on the composer's overlap and never arrives.
 */
async function clickOutside(win: Page): Promise<void> {
  await win.getByPlaceholder('Ask Stem…').click();
}

/** Pin the latest reply, a passage of it, and a note, through the bridge. */
async function seedPins(win: Page): Promise<void> {
  await win.evaluate(async () => {
    const stem = (window as any).stem;
    const { chats } = await stem.listChats();
    const threadId = chats[0].threadId as string;
    const { messages } = await stem.readChatHistory(threadId);
    const reply = [...messages].reverse().find((m: any) => m.role === 'assistant');
    const anchor = reply.runtimeTurnId ?? reply.turnId;
    await stem.addPin(threadId, { kind: 'message', text: reply.content, anchor, role: 'assistant' });
    await stem.addPin(threadId, {
      kind: 'passage',
      text: reply.content.split(' ').slice(0, 3).join(' '),
      anchor,
      role: 'assistant'
    });
    await stem.addPin(threadId, { kind: 'note', text: '2nd coat done Oct 3, wiped with a white pad' });
  });
}

test('the pinboard strip opens, floats, closes on an outside click, and docks', async ({ mainWindow: win }, testInfo) => {
  test.setTimeout(120_000);
  // No pins, no board.
  await send(win, 'Reply with exactly the word RUBIO and nothing else.');
  await expect(win.locator('.message-assistant:not(.activity-row) .message-body').last()).toContainText(/rubio/i, {
    timeout: 60_000
  });
  await expect(win.locator('.message-user').last().locator('.message-actions')).toBeAttached({ timeout: 20_000 });
  await expect(win.locator('.pinboard')).toHaveCount(0);

  await seedPins(win);

  // The push names this chat; the board appears collapsed with a count and summary.
  const strip = win.locator('.pinboard-strip');
  await expect(strip).toBeVisible();
  await expect(win.locator('.pinboard-count')).toHaveText('3');
  await expect(win.locator('.pinboard-summary')).toContainText('2nd coat done Oct');
  await expect(win.locator('.pinboard-drop')).toHaveCount(0);
  await win.screenshot({ path: testInfo.outputPath('1-collapsed.png') });

  // Open: the list floats over the transcript.
  await strip.click();
  await expect(win.locator('.pinboard-item')).toHaveCount(3);
  await win.screenshot({ path: testInfo.outputPath('2-open.png') });

  // A click outside closes a floating board.
  await clickOutside(win);
  await expect(win.locator('.pinboard-drop')).toHaveCount(0);

  // Jump: "Show in chat" scrolls to the source and flashes it, and closes the list.
  await strip.click();
  const messagePin = win.locator('.pinboard-item.kind-message');
  await messagePin.hover();
  await messagePin.getByLabel('Show in chat').click();
  await expect(win.locator('.message-assistant.pin-flash')).toHaveCount(1);
  await expect(win.locator('.pinboard-drop')).toHaveCount(0);

  // Docked: stays open through outside clicks, and survives a reload.
  await strip.click();
  await win.getByRole('button', { name: 'Keep open' }).click();
  await clickOutside(win);
  await expect(win.locator('.pinboard.docked .pinboard-drop')).toBeVisible();
  await win.screenshot({ path: testInfo.outputPath('3-docked.png') });

  // A note: edit it, then remove it (a note takes a second click).
  const note = win.locator('.pinboard-item.kind-note');
  await note.hover();
  await note.getByLabel('Edit note').click();
  const editor = note.locator('textarea');
  await editor.fill('3rd coat skipped');
  await editor.press('Enter');
  await expect(note).toContainText('3rd coat skipped');
  await note.hover();
  await note.getByLabel('Remove note').click();
  await expect(win.locator('.pinboard-item')).toHaveCount(3);
  await note.getByLabel('Click again to remove').click();
  await expect(win.locator('.pinboard-item')).toHaveCount(2);

  // Add a note from the board.
  await win.getByRole('button', { name: 'Add note' }).click();
  await win.locator('.pinboard-editor textarea').fill('Buy more accelerator');
  await win.locator('.pinboard-editor textarea').press('Enter');
  await expect(win.locator('.pinboard-item.kind-note')).toContainText('Buy more accelerator');
  await expect(win.locator('.pinboard-count')).toHaveText('3');
});

test('pins from the chat: /pin, the Pin action, a selected passage, and reorder by drag', async ({ mainWindow: win }, testInfo) => {
  test.setTimeout(120_000);
  await send(win, 'Reply with exactly the words MIX THREE TO ONE and nothing else.');
  const reply = win.locator('.message-assistant:not(.activity-row)').last();
  await expect(reply.locator('.message-body')).toContainText(/MIX THREE TO ONE/, { timeout: 60_000 });
  await expect(win.locator('.message-user').last().locator('.message-actions')).toBeAttached({ timeout: 20_000 });

  // `/pin <text>` starts the board without starting a turn.
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.fill('/pin bought 1 L of oil');
  await composer.press('Enter');
  await expect(win.getByText('Pinned to this chat')).toBeVisible();
  await expect(win.locator('.pinboard-count')).toHaveText('1');
  await expect(composer).toHaveValue('');
  await expect(win.locator('.message-user')).toHaveCount(1);

  // The Pin action pins the whole reply, stays lit, and toggles back off.
  await reply.hover();
  await reply.getByLabel('Pin to this chat').click();
  await expect(win.locator('.pinboard-count')).toHaveText('2');
  await expect(reply.getByLabel('Unpin from this chat')).toBeVisible();
  await reply.getByLabel('Unpin from this chat').click();
  await expect(win.locator('.pinboard-count')).toHaveText('1');
  await reply.hover();
  await reply.getByLabel('Pin to this chat').click();
  await expect(win.locator('.pinboard-count')).toHaveText('2');

  // Select a passage of the reply → the floating Pin button pins exactly it.
  const body = reply.locator('.message-body .mdx, .message-body .message-plain').first();
  await body.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Text | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if ((n as Text).data.includes('THREE TO')) {
        node = n as Text;
        break;
      }
    }
    if (!node) throw new Error('reply text not found');
    const start = node.data.indexOf('THREE TO');
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + 'THREE TO'.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  const offer = win.locator('.selection-pin');
  await expect(offer).toBeVisible();
  await win.screenshot({ path: testInfo.outputPath('4-selection.png') });
  await offer.click();
  await expect(win.locator('.pinboard-count')).toHaveText('3');
  await expect(offer).toHaveCount(0);

  // The passage jumps to exactly its text.
  await win.locator('.pinboard-strip').click();
  const passage = win.locator('.pinboard-item.kind-passage');
  await expect(passage).toContainText('THREE TO');
  await passage.hover();
  await passage.getByLabel('Show in chat').click();
  expect(await win.evaluate(() => (CSS as any).highlights?.has('pin-passage'))).toBe(true);
  await win.screenshot({ path: testInfo.outputPath('5-passage-jump.png') });

  // Drag the passage to the top of the board.
  await win.locator('.pinboard-strip').click();
  const items = win.locator('.pinboard-item');
  await expect(items.first()).toHaveClass(/kind-note/);
  await passage.dragTo(items.first(), { targetPosition: { x: 40, y: 4 } });
  await expect(items.first()).toHaveClass(/kind-passage/);
  await win.screenshot({ path: testInfo.outputPath('6-reordered.png') });

  // Rename: the label becomes the item's name and the collapsed summary's.
  const first = items.first();
  await first.hover();
  await first.getByLabel('Rename').click();
  await first.getByLabel('Pin name').fill('Mix ratio');
  await first.getByLabel('Pin name').press('Enter');
  await expect(first.locator('.pinboard-item-label')).toHaveText('Mix ratio');
  await clickOutside(win);
  await expect(win.locator('.pinboard-summary')).toContainText('(Mix ratio · bought 1 L of');
  await win.screenshot({ path: testInfo.outputPath('7-renamed.png') });
});

test('pins survive a reload and leave with their chat', async ({ mainWindow: win }) => {
  test.setTimeout(120_000);
  await send(win, 'Reply with exactly the word KEEP and nothing else.');
  await expect(win.locator('.message-assistant:not(.activity-row) .message-body').last()).toContainText(/keep/i, {
    timeout: 60_000
  });
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.fill('/pin survives a reload');
  await composer.press('Enter');
  await expect(win.locator('.pinboard-count')).toHaveText('1');

  // A fresh renderer: whatever it shows now came from the server, not from memory.
  await win.reload();
  const threadId = await win.evaluate(async () => (await (window as any).stem.listChats()).chats[0].threadId as string);
  await expect
    .poll(() => win.evaluate(async (id) => (await (window as any).stem.listPins(id)).length, threadId))
    .toBe(1);

  await win.evaluate((id) => (window as any).stem.deleteChat(id), threadId);
  expect(await win.evaluate(async (id) => (await (window as any).stem.listPins(id)).length, threadId)).toBe(0);
});

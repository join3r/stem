// A share_audio turn end to end against the scripted FakeBackend: the sound
// lands in the real audio store, the card fetches it over chats:audio, draws
// its waveform, plays, seeks, and saves straight into Downloads.
import { test, expect } from './electron';
import type { Page } from '@playwright/test';

async function send(win: Page, text: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
}

test('an audio turn shows a player that plays, seeks and saves', async ({ mainWindow }, testInfo) => {
  await send(mainWindow, '[e2e:audio] cut the clip');

  const card = mainWindow.locator('.chat-audio');
  await expect(card).toBeVisible();
  await expect(card.locator('.chat-audio-title')).toHaveText('Test tone · 00:00–00:06');
  await expect(card.locator('.chat-audio-time')).toHaveText('0:06');
  await mainWindow.screenshot({ path: testInfo.outputPath('card.png') });

  // Seek to the middle by a click on the waveform.
  const wave = card.getByRole('slider');
  const box = (await wave.boundingBox())!;
  await mainWindow.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(card.locator('.chat-audio-time')).toHaveText(/^0:0[23] \/ 0:06$/);

  await card.getByRole('button', { name: /^Play / }).click();
  await expect(card.getByRole('button', { name: /^Pause / })).toBeVisible();
  await mainWindow.screenshot({ path: testInfo.outputPath('playing.png') });
  await card.getByRole('button', { name: /^Pause / }).click();
  await expect(card.getByRole('button', { name: /^Play / })).toBeVisible();

  await card.getByRole('button', { name: /Save .* to Downloads/ }).click();
  await expect(card.locator('.chat-audio-save svg.lucide-check')).toBeVisible();
});

test('a reopened chat shows the player again from history', async ({ mainWindow }) => {
  await send(mainWindow, '[e2e:audio] cut the clip');
  await expect(mainWindow.locator('.chat-audio')).toBeVisible();
  await expect(mainWindow.getByTitle('Stop')).toHaveCount(0);
  const history = await mainWindow.evaluate(async () => {
    const stem = (window as unknown as { stem: { listChats(): Promise<{ chats: Array<{ threadId: string }> }>; readChatHistory(id: string): Promise<{ messages: Array<{ audio?: Array<{ id: string }> }> }>; getChatAudio(t: string, id: string): Promise<{ mime: string } | null> } }).stem;
    const [chat] = (await stem.listChats()).chats;
    const h = await stem.readChatHistory(chat.threadId);
    const ids = h.messages.flatMap((m) => m.audio ?? []).map((a) => a.id);
    const bytes = ids.length ? await stem.getChatAudio(chat.threadId, ids[0]) : null;
    return { count: ids.length, mime: bytes?.mime };
  });
  expect(history).toEqual({ count: 1, mime: 'audio/wav' });
});

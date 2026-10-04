// MDX end to end against the echoing FakeBackend: what the user sends comes
// back as the reply, a third at a time, so a message written in MDX exercises
// the streaming renderer, the settled renderer and the interactive components
// through real IPC and renderer state.
import { test, expect } from './electron';
import type { Page } from '@playwright/test';

async function send(win: Page, text: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
}

const reply = (win: Page) => win.locator('.message-assistant:not(.activity-row) .message-body').last();

const MDX = [
  '[e2e:slow] Bills are falling.',
  '',
  '<Chart type="line" title="Monthly bill" unit="€">',
  '```json',
  '[{"month":"Jan","power":92,"water":31},{"month":"Feb","power":88,"water":29},{"month":"Mar","power":71,"water":30}]',
  '```',
  '</Chart>',
  '',
  'That is the trend.',
  '',
  '<Replies>',
  '<Reply>Show the whole year</Reply>',
  '</Replies>'
].join('\n');

test('streams MDX without raw tags, then settles into a chart and reply chips', async ({ mainWindow }) => {
  await send(mainWindow, MDX);

  // Mid-stream the chart is still being written: a placeholder stands in, and
  // neither its tag nor its JSON is ever shown as text.
  const body = reply(mainWindow);
  await expect(body.locator('.mdx-placeholder')).toBeVisible();
  const seen: string[] = [];
  while ((await mainWindow.getByTitle('Stop').count()) > 0) {
    seen.push((await body.textContent()) ?? '');
    await mainWindow.waitForTimeout(100);
  }
  for (const text of seen) {
    expect(text).not.toContain('<Chart');
    expect(text).not.toContain('"power"');
    expect(text).not.toContain('<Repl');
  }

  // Settled: the chart, its legend (two series), and the chips on this reply.
  await expect(body.locator('.chart svg')).toBeVisible();
  await expect(body.locator('.chart-title')).toHaveText('Monthly bill');
  await expect(body.locator('.chart-legend li')).toHaveCount(2);
  const chip = body.getByRole('button', { name: 'Show the whole year' });
  await expect(chip).toBeVisible();

  // A chip sends its text as the user's next message; the chips go with it.
  await chip.click();
  await expect(mainWindow.locator('.message-user').last()).toContainText('Show the whole year');
  await expect(reply(mainWindow)).toContainText('Echo: Show the whole year');
  await expect(mainWindow.locator('.mdx-reply')).toHaveCount(0);
});

test('the chart offers its numbers as a table', async ({ mainWindow }) => {
  await send(mainWindow, MDX.replace('[e2e:slow] ', ''));
  const body = reply(mainWindow);
  await expect(body.locator('.chart svg')).toBeVisible();
  await body.getByRole('button', { name: 'Table' }).click();
  await expect(body.locator('.chart-table td').first()).toHaveText('Jan');
  await expect(body.locator('.chart-table')).toContainText('€92');
});

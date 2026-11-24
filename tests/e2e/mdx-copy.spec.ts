// "Copy message" on an MDX reply, through the real app and the system
// clipboard: Markdown as the text, the same Markdown drawn as HTML, and no
// component tag in either. The echoing FakeBackend sends the message back as
// the reply. The user's clipboard is put back afterwards.
import { test, expect } from './electron';

const MDX = [
  'Before you start:',
  '',
  '<Callout type="warn">',
  'This **erases** the disk.',
  '</Callout>',
  '',
  '<Steps>',
  '<Step>Back up.</Step>',
  '<Step>Run `wipe`.</Step>',
  '</Steps>',
  '',
  '<Replies>',
  '<Reply>Do it now</Reply>',
  '</Replies>'
].join('\n');

test('copies a reply as clean Markdown and HTML', async ({ electronApp, mainWindow }) => {
  // Electron 44+ clipboard: W3C-shaped and async (no readHTML; write takes ClipboardItems).
  const saved = await electronApp.evaluate(async ({ clipboard }) => {
    const items = await clipboard.read();
    const text = await clipboard.readText();
    const htmlItem = items.find((i) => i.types.includes('text/html'));
    const html = htmlItem ? await ((await htmlItem.getType('text/html')) as Blob).text() : '';
    return { text, html };
  });
  try {
    const composer = mainWindow.getByPlaceholder('Ask Stem…');
    await composer.click();
    await composer.fill(MDX);
    await composer.press('Enter');

    const reply = mainWindow.locator('.message-assistant:not(.activity-row)').last();
    await expect(reply.locator('.callout-warn')).toBeVisible();
    await expect(reply.getByRole('button', { name: 'Do it now' })).toBeVisible();

    await reply.hover();
    await reply.getByLabel('Copy message').click();
    await expect(reply.getByLabel('Copied')).toBeVisible();

    const got = await electronApp.evaluate(async ({ clipboard }) => {
      const items = await clipboard.read();
      const htmlItem = items.find((i) => i.types.includes('text/html'));
      const html = htmlItem ? await ((await htmlItem.getType('text/html')) as Blob).text() : '';
      // Windows keeps clipboard text with CRLF line ends.
      return { text: (await clipboard.readText()).replace(/\r\n/g, '\n'), html };
    });
    expect(got.text).toContain('Before you start:');
    expect(got.text).toContain('> **Warning:** This **erases** the disk.');
    expect(got.text).toContain('1. Back up.\n2. Run `wipe`.');
    expect(got.text).not.toMatch(/<\/?[A-Z]/);
    expect(got.text).not.toContain('Do it now');

    expect(got.html).toContain('<blockquote>');
    expect(got.html).toContain('<strong>Warning:</strong>');
    expect(got.html).toMatch(/<ol><li>(<p>)?Back up\./);
    expect(got.html).not.toMatch(/<button|<input|&lt;Callout/);
  } finally {
    await electronApp.evaluate(({ clipboard, ClipboardItem }, s) => {
      const data: Record<string, Blob> = { 'text/plain': new Blob([s.text], { type: 'text/plain' }) };
      if (s.html) data['text/html'] = new Blob([s.html], { type: 'text/html' });
      return clipboard.write([new ClipboardItem(data)]);
    }, saved);
  }
});

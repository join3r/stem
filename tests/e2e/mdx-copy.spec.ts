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
  const saved = await electronApp.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }));
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

    const got = await electronApp.evaluate(({ clipboard }) => ({ text: clipboard.readText(), html: clipboard.readHTML() }));
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
    await electronApp.evaluate(({ clipboard }, s) => clipboard.write(s), saved);
  }
});

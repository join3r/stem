// A shared chat looks like the chat (docs/public-share-design.md): the same
// reply in the app and on the real share page, built by vite.share.config.ts,
// served under the CSP share.heystem.app sends, from a snapshot the app's own
// server made and sealed. Everything the app fetches from Stem as it draws a
// reply (a web picture, a generated picture, a sound, the sources) must be on
// the page too, drawn with the same markup.
//
// The web picture is a real Wikimedia thumbnail: the server fetches only
// public https hosts, so this test needs the network.
import { createServer, type Server } from 'node:http';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Locator, type Page } from '@playwright/test';
import { test, expect } from './electron';
import { keyFragment, sealShare } from '../../src/server/share/seal';
import type { SharePreview } from '../../src/shared/share';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const VIEWER = join(ROOT, 'dist', 'share');
const SHARE_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
// The James Bond chat's first picture.
const PICTURE =
  'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/09/Callum_Turner-69856_%28cropped%29.jpg/250px-Callum_Turner-69856_%28cropped%29.jpg';

const MESSAGE = [
  '[e2e:image] [e2e:audio] [e2e:sources] These are the **seven names** in the latest reporting.',
  '',
  '### Callum Turner',
  '*Fantastic Beasts, Masters of the Air* — reportedly in the screen-test mix.',
  '',
  `![Callum Turner](${PICTURE})`,
  '',
  '<Callout type="info">Amazon has not announced the next Bond.</Callout>',
  '',
  '| Actor | Known for |',
  '| --- | --- |',
  '| Callum Turner | Masters of the Air |',
  '| Jack Lowden | Slow Horses |',
  '',
  '```ts',
  'const agent = "007";',
  '```'
].join('\n');

/** The CSP the share page is served with, read from the deployed Caddy config. */
function viewerCsp(): string {
  const caddy = readFileSync(join(ROOT, 'relay/deploy/global/Caddyfile.snippet'), 'utf8');
  const site = caddy.slice(caddy.indexOf('share.heystem.app {'));
  const m = /Content-Security-Policy "([^"]+)"/.exec(site);
  if (!m) throw new Error('no CSP for share.heystem.app in the Caddyfile');
  return m[1]!;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
};

/** The share page and one share's blob, as Caddy and the relay serve them. */
async function serveViewer(blob: Buffer): Promise<{ server: Server; origin: string }> {
  const csp = viewerCsp();
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      res.setHeader('Content-Security-Policy', csp);
      if (path === `/v1/shares/${SHARE_ID}`) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': blob.length });
        res.end(blob);
        return;
      }
      const file = path.startsWith('/s/') ? 'index.html' : normalize(path).replace(/^[/\\]+/, '');
      try {
        const body = await readFile(join(VIEWER, file));
        res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return { server, origin: `http://127.0.0.1:${addr.port}` };
}

/** Each element of a reply's rendered MDX as tag.classes, in document order: its markup without the bytes. */
function skeleton(mdx: Locator): Promise<string[]> {
  return mdx.evaluate((root) =>
    [...root.querySelectorAll('*')].map((el) => [el.tagName.toLowerCase(), ...[...el.classList].sort()].join('.'))
  );
}

async function send(win: Page, text: string): Promise<void> {
  const composer = win.getByPlaceholder('Ask Stem…');
  await composer.click();
  await composer.fill(text);
  await composer.press('Enter');
}

test('a shared chat shows what the chat shows, with the same markup', async ({ mainWindow }) => {
  test.setTimeout(180_000);
  execSync('npx vite build --config vite.share.config.ts', { cwd: ROOT, stdio: 'inherit' });

  await send(mainWindow, MESSAGE);
  const app = mainWindow.locator('.message-assistant:not(.activity-row)').last();
  await expect(app.locator('.mdx-remote-image')).toBeVisible({ timeout: 30_000 });
  await expect(app.locator('.gen-image img')).toBeVisible();
  await expect(app.locator('.chat-audio-play')).toBeEnabled();
  await expect(app.locator('.sources-summary')).toContainText('Sources (2)');
  await app.locator('.sources-summary').click();
  await expect(app.locator('.source-card')).toHaveCount(2);
  // Site icons arrive on their own; give them the time the page gets.
  await mainWindow.waitForTimeout(1500);
  const appIcons = await app.locator('.source-card img.source-icon').count();
  // The chat scrolls inside the window: one picture of its top, one of its end.
  await mainWindow.locator('.message-user').last().scrollIntoViewIfNeeded();
  await mainWindow.screenshot({ path: test.info().outputPath('app-top.png') });
  await app.locator('.sources').scrollIntoViewIfNeeded();
  await mainWindow.screenshot({ path: test.info().outputPath('app-end.png') });

  // The snapshot the Share dialog would publish, sealed as the server seals it.
  const preview = await mainWindow.evaluate(async () => {
    const stem = (
      window as unknown as {
        stem: {
          listChats(): Promise<{ chats: Array<{ threadId: string }> }>;
          previewShare(source: { kind: 'chat'; threadId: string }, opts: { scope: 'thread' }): Promise<SharePreview>;
        };
      }
    ).stem;
    const { chats } = await stem.listChats();
    return stem.previewShare({ kind: 'chat', threadId: chats[0]!.threadId }, { scope: 'thread' });
  });
  const answer = preview.snapshot.messages.find((m) => m.role === 'assistant')!;
  expect(answer.webImages?.map((w) => w.url)).toEqual([PICTURE]);
  const { blob, key } = sealShare(JSON.stringify(preview.snapshot));

  const { server, origin } = await serveViewer(blob);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const violations: string[] = [];
    page.on('console', (msg) => {
      if (/Content Security Policy|Refused to/i.test(msg.text())) violations.push(msg.text());
    });
    page.on('pageerror', (err) => violations.push(String(err)));
    await page.goto(`${origin}/s/${SHARE_ID}#${keyFragment(key)}`);
    const shared = page.locator('.share-view .message-assistant').last();
    await expect(shared.locator('.mdx-remote-image')).toBeVisible();
    await expect(shared.locator('.mdx-remote-link')).toHaveCount(0);
    await expect(shared.locator('.gen-image img')).toBeVisible();
    // The sound plays from the snapshot: its card is ready, not "no longer available".
    await expect(shared.locator('.chat-audio-play')).toBeEnabled();
    await expect(shared.locator('.chat-audio-failed')).toHaveCount(0);
    await expect(shared.locator('.sources-summary')).toContainText('Sources (2)');
    // The picture really drew, under the page's CSP.
    expect(await shared.locator('.mdx-remote-image').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

    // Same renderer, same reply: the same markup, element for element.
    expect(await skeleton(shared.locator('.mdx'))).toEqual(await skeleton(app.locator('.mdx')));
    await shared.locator('.chat-audio-play').click();
    await expect(shared.locator('.chat-audio-play')).toHaveAttribute('aria-label', /^Pause /);
    await shared.locator('.chat-audio-play').click();
    await expect(shared.locator('.chat-audio-play')).toHaveAttribute('aria-label', /^Play /);
    await shared.locator('.sources-summary').click();
    await expect(shared.locator('.source-card')).toHaveCount(2);
    // The parts around the text too: the picture card, the sound, the open sources.
    for (const part of ['.gen-images', '.chat-audio-list', '.sources', '.sources-cards']) {
      expect(await skeleton(shared.locator(part))).toEqual(await skeleton(app.locator(part)));
    }
    // The header line, less the date: a reader needs to know when, the chat
    // shows the answer's duration there instead.
    const header = async (who: Locator) => (await skeleton(who)).filter((el) => el !== 'span.message-timing');
    expect(await header(shared.locator('.message-who'))).toEqual(await header(app.locator('.message-who')));
    // The site icons the app found, from the snapshot.
    expect(await shared.locator('.source-card img.source-icon').count()).toBe(appIcons);
    await page.locator('.share-view').screenshot({ path: test.info().outputPath('viewer.png') });
    expect(violations).toEqual([]);
  } finally {
    await browser.close();
    server.close();
  }
});

// Small pure helpers in the extension (src/browser-extension/util.js), above
// all which pages Stem refuses to touch. file: is among them by the user's
// choice: the model hands the browser only files Stem holds (`upload`), and a
// file:// tab — opened by Stem or already open — would be a way round that.
import { describe, expect, it } from 'vitest';
import { capText, jpegSize, normalizeUrl, restrictedReason, tabLine } from '../../src/browser-extension/util.js';

describe('restrictedReason', () => {
  it('lets ordinary web pages and a fresh blank tab through', () => {
    expect(restrictedReason('https://mail.example.com/inbox')).toBeNull();
    expect(restrictedReason('http://127.0.0.1:8080/')).toBeNull();
    expect(restrictedReason('about:blank')).toBeNull();
  });

  it('refuses local files, open or not', () => {
    const why = restrictedReason('file:///Users/ada/Documents/taxes.pdf');
    expect(why).toBe('it is a file on this Mac, which Stem never opens — uploads go through `upload` with files Stem holds');
    expect(restrictedReason('FILE:///etc/hosts')).toBe(why);
  });

  it('refuses browser pages and the extension stores', () => {
    for (const u of ['chrome://settings', 'edge://flags', 'arc://extensions', 'chrome-extension://abc/popup.html', 'devtools://devtools/x', 'view-source:https://a.test', 'about:newtab', 'data:text/html,hi', 'javascript:alert(1)']) {
      expect(restrictedReason(u), u).toMatch(/browser page .* which extensions are not allowed to control/);
    }
    expect(restrictedReason('https://chromewebstore.google.com/detail/x')).toMatch(/extension store/);
    expect(restrictedReason('https://chrome.google.com/webstore/category/extensions')).toMatch(/extension store/);
  });
});

describe('normalizeUrl', () => {
  it('adds a scheme to a bare host, http for loopback', () => {
    expect(normalizeUrl('example.com/a?b=1')).toEqual({ url: 'https://example.com/a?b=1' });
    expect(normalizeUrl('localhost:3000/x')).toEqual({ url: 'http://localhost:3000/x' });
    expect(normalizeUrl('127.0.0.1:8080')).toEqual({ url: 'http://127.0.0.1:8080/' });
    expect(normalizeUrl('  https://a.test  ')).toEqual({ url: 'https://a.test/' });
  });

  it('refuses file:, script, browser pages and non-URLs with a sentence', () => {
    expect(normalizeUrl('file:///etc/hosts').error).toMatch(/^Stem can't open that: it is a file on this Mac/);
    expect(normalizeUrl('javascript:alert(1)').error).toMatch(/use `evaluate`/);
    expect(normalizeUrl('chrome://settings').error).toMatch(/browser page/);
    expect(normalizeUrl('two words').error).toMatch(/is not a URL/);
    expect(normalizeUrl('').error).toBe('The URL is empty.');
  });
});

describe('text helpers', () => {
  it('caps long text with a note', () => {
    expect(capText('abc', 5)).toBe('abc');
    expect(capText('abcdefgh', 5)).toBe('abcde\n… (cut at 5 characters)');
  });

  it('identifies a tab on one line', () => {
    expect(tabLine({ id: 4, title: 'Inbox\n(3)', url: 'https://mail.test/' })).toBe('Tab 4 · Inbox (3) — https://mail.test/');
    expect(tabLine({ id: 5, title: '', pendingUrl: 'https://slow.test/' })).toBe('Tab 5 · (untitled) — https://slow.test/');
  });
});

describe('jpegSize', () => {
  it('reads width and height from the SOF marker', () => {
    // SOI, an APP0 segment, then SOF0 for a 741×413 picture.
    const app0 = [0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0)];
    const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x9d, 0x02, 0xe5, 0x03, ...Array(9).fill(0)];
    const b64 = Buffer.from([0xff, 0xd8, ...app0, ...sof0]).toString('base64');
    expect(jpegSize(b64)).toEqual({ width: 741, height: 413 });
    expect(jpegSize(Buffer.from('not a jpeg').toString('base64'))).toBeNull();
  });
});

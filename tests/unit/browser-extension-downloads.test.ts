// Matching a chrome.downloads item to the CDP download start that a run's tab
// reported (src/browser-extension/downloads.js). Anything that doesn't match
// is the user's own download and must never be attributed to a run — a
// run's downloads are copied to the server.
import { describe, expect, it } from 'vitest';
import { DOWNLOAD_MATCH_MS, matchDownload, sameDownload } from '../../src/browser-extension/downloads.js';

const T = 5_000_000;

describe('sameDownload', () => {
  it('matches on the item url or its final url, ignoring fragments', () => {
    expect(sameDownload('https://a.test/report.pdf', { url: 'https://a.test/report.pdf' })).toBe(true);
    expect(sameDownload('https://cdn.test/r.pdf', { url: 'https://a.test/get?id=1', finalUrl: 'https://cdn.test/r.pdf' })).toBe(true);
    expect(sameDownload('https://a.test/r.pdf#page=2', { url: 'https://a.test/r.pdf' })).toBe(true);
    expect(sameDownload('blob:https://a.test/9f1c', { url: 'blob:https://a.test/9f1c' })).toBe(true);
    expect(sameDownload('https://a.test/other.pdf', { url: 'https://a.test/report.pdf' })).toBe(false);
    expect(sameDownload('', { url: '' })).toBe(false);
  });
});

describe('matchDownload', () => {
  const starts = [
    { threadId: 'a', url: 'https://a.test/report.pdf', at: T - 20_000 },
    { threadId: 'b', url: 'https://a.test/report.pdf', at: T - 2_000 },
    { threadId: 'a', url: 'https://a.test/old.zip', at: T - DOWNLOAD_MATCH_MS - 1 }
  ];

  it('takes the most recent start for the same URL', () => {
    expect(matchDownload(starts, { url: 'https://a.test/report.pdf' }, T)).toBe(1);
  });

  it('ignores starts outside the window', () => {
    expect(matchDownload(starts, { url: 'https://a.test/old.zip' }, T)).toBe(-1);
  });

  it('leaves a download with no recorded start unmatched (the user’s own)', () => {
    expect(matchDownload(starts, { url: 'https://bank.test/statement.pdf' }, T)).toBe(-1);
    expect(matchDownload([], { url: 'https://a.test/report.pdf' }, T)).toBe(-1);
  });
});

// The extension's console/network history and the secret scrubber
// (src/browser-extension/logs.js). The scrubber matters most: network details
// are read by the model and stored with the turn on the server, so tokens,
// passwords and session ids must not ride along by accident.
import { describe, expect, it } from 'vitest';
import {
  ConsoleLog,
  NetworkLog,
  Ring,
  formatConsole,
  formatHeaders,
  formatNetworkDetail,
  formatNetworkList,
  isSecretHeader,
  isSecretKey,
  scrubBody,
  scrubUrl
} from '../../src/browser-extension/logs.js';

const T0 = new Date(2026, 9, 5, 14, 0, 0).getTime();

describe('Ring', () => {
  it('keeps the newest items up to its cap', () => {
    const r = new Ring(3);
    for (let i = 1; i <= 5; i++) r.push(i);
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.size).toBe(3);
  });
});

describe('ConsoleLog', () => {
  it('folds console calls, exceptions and log entries, and filters errors', () => {
    const log = new ConsoleLog(10);
    log.handle('Runtime.consoleAPICalled', { type: 'log', timestamp: T0, args: [{ type: 'string', value: 'loaded' }, { type: 'number', value: 42 }] });
    log.handle('Runtime.consoleAPICalled', {
      type: 'warning',
      timestamp: T0 + 1000,
      args: [{ type: 'object', preview: { properties: [{ name: 'a', value: '1' }] } }],
      stackTrace: { callFrames: [{ url: 'https://x.test/app.js?v=3', lineNumber: 9 }] }
    });
    log.handle('Runtime.exceptionThrown', { timestamp: T0 + 2000, exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is undefined' } } });
    log.handle('Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'Failed to load resource', timestamp: T0 + 3000 } });
    expect(log.handle('Page.loadEventFired', {})).toBe(false);
    const all = log.entries();
    expect(all.map((e: { level: string }) => e.level)).toEqual(['log', 'warn', 'error', 'error']);
    expect(all[0].text).toBe('loaded 42');
    expect(all[1]).toMatchObject({ text: '{a: 1}', source: ' (app.js:10)' });
    expect(all[2].text).toBe('Uncaught TypeError: x is undefined');
    expect(all[3].text).toBe('[network] Failed to load resource');
    expect(log.entries({ errorsOnly: true })).toHaveLength(3);
  });

  it('says when messages predate the attach, and what to do when there are none', () => {
    const log = new ConsoleLog();
    log.handle('Runtime.consoleAPICalled', { type: 'log', timestamp: T0 - 60_000, args: [{ type: 'string', value: 'early' }] });
    log.handle('Runtime.consoleAPICalled', { type: 'error', timestamp: T0 + 5_000, args: [{ type: 'string', value: 'late' }] });
    const text = formatConsole(log.entries(), { since: T0 });
    expect(text).toContain('2 console messages (oldest first; 1 from before Stem attached at 14:00:00)');
    expect(text).toMatch(/13:59:00 log {3}early\n14:00:05 error late/);
    expect(formatConsole([], { since: T0 })).toMatch(/^No console messages \(Stem attached at 14:00:00\)\. To catch what the page logs while loading/);
  });
});

describe('NetworkLog', () => {
  const sent = (id: string, url: string, extra: Record<string, unknown> = {}) => ({
    requestId: id,
    request: { url, method: 'GET', headers: {} },
    type: 'Fetch',
    wallTime: T0 / 1000,
    ...extra
  });

  it('gives short ids, tracks status and failures, and splits redirect hops', () => {
    const log = new NetworkLog(10);
    log.handle('Network.requestWillBeSent', sent('100.1', 'https://a.test/old'));
    log.handle('Network.requestWillBeSent', sent('100.1', 'https://a.test/new', { redirectResponse: { status: 301, statusText: 'Moved', headers: {} } }));
    log.handle('Network.responseReceived', { requestId: '100.1', response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: {} } });
    log.handle('Network.loadingFinished', { requestId: '100.1', encodedDataLength: 2048 });
    log.handle('Network.requestWillBeSent', sent('200.1', 'https://a.test/broken'));
    log.handle('Network.loadingFailed', { requestId: '200.1', errorText: 'net::ERR_CONNECTION_REFUSED' });
    const e = log.entries();
    expect(e.map((x: { id: string }) => x.id)).toEqual(['r1', 'r2', 'r3']);
    expect(e[0]).toMatchObject({ status: 301, redirectedTo: 'https://a.test/new', bodyGone: true });
    expect(e[1]).toMatchObject({ status: 200, size: 2048, done: true });
    expect(e[2]).toMatchObject({ failed: 'net::ERR_CONNECTION_REFUSED' });
    expect(log.get('r2').requestId).toBe('100.1');
    const text = formatNetworkList(e, { since: T0 });
    expect(text).toContain('r2 GET 200 fetch 2.0 KB https://a.test/new');
    expect(text).toContain('r3 GET failed (net::ERR_CONNECTION_REFUSED) fetch — https://a.test/broken');
    expect(formatNetworkList(log.entries('broken'), { since: T0, filter: 'broken' })).toContain('1 requests matching "broken"');
  });

  it('evicts the oldest past its cap', () => {
    const log = new NetworkLog(2);
    for (let i = 0; i < 4; i++) log.handle('Network.requestWillBeSent', sent(`r${i}`, `https://a.test/${i}`));
    expect(log.entries().map((x: { url: string }) => x.url)).toEqual(['https://a.test/2', 'https://a.test/3']);
    expect(log.get('r1')).toBeUndefined();
  });
});

describe('secret scrubbing', () => {
  it('hides credential headers by name', () => {
    for (const h of ['Cookie', 'set-cookie', 'Authorization', 'X-CSRF-Token', 'x-xsrf-token', 'X-Api-Key', 'api_key', 'X-Session-Id', 'x-auth-user', 'x-client-secret']) {
      expect(isSecretHeader(h), h).toBe(true);
    }
    for (const h of ['content-type', 'accept', 'user-agent', 'referer', 'x-request-id']) expect(isSecretHeader(h), h).toBe(false);
    const text = formatHeaders({ Cookie: 'sid=abc123', 'content-type': 'text/html' });
    expect(text).toBe('  Cookie: (hidden, 10 characters)\n  content-type: text/html');
  });

  it('matches secret keys, but not words that merely contain a short one', () => {
    for (const k of ['password', 'userPassword', 'new_passwd', 'pwd', 'pass', 'otp', 'otp_code', 'oneTimeCode', 'cvv', 'cvc', 'cardNumber', 'card-number', 'pan', 'card_pan', 'pin', 'client_secret', 'refresh_token', 'access_token', 'id_token', 'sessionId', 'csrfmiddlewaretoken', 'authenticity_token'])
      expect(isSecretKey(k), k).toBe(true);
    for (const k of ['company', 'span', 'expand', 'footprint', 'spinner', 'pinned', 'passengers', 'username', 'email', 'amount', 'name'])
      expect(isSecretKey(k), k).toBe(false);
  });

  it('scrubs form-encoded bodies by key, keeping the rest as sent', () => {
    const r = scrubBody('user=ada%40x.test&password=hunter2+x&remember=on&otp=123456', 'application/x-www-form-urlencoded; charset=UTF-8');
    expect(r.text).toBe('user=ada%40x.test&password=(hidden, 9 characters)&remember=on&otp=(hidden, 6 characters)');
    expect(r.hidden).toBe(2);
  });

  it('scrubs JSON bodies recursively, arrays included', () => {
    const body = JSON.stringify({
      user: { email: 'a@x.test', password: 'p4ss', profile: { company: 'Acme' } },
      tokens: [{ access_token: 'aaa.bbb.ccc', scope: 'read' }],
      card: { cardNumber: 4242424242424242, cvc: '123', holder: 'Ada' },
      session: { id: 'xyz', expires: 1 }
    });
    const r = scrubBody(body, 'application/json');
    const out = JSON.parse(r.text);
    expect(out.user).toEqual({ email: 'a@x.test', password: '(hidden, 4 characters)', profile: { company: 'Acme' } });
    // "tokens" is itself a secret-looking key: the whole value goes.
    expect(out.tokens).toMatch(/^\(hidden, \d+ characters\)$/);
    expect(out.card).toEqual({ cardNumber: '(hidden, 16 characters)', cvc: '(hidden, 3 characters)', holder: 'Ada' });
    expect(out.session).toMatch(/^\(hidden/);
    expect(r.hidden).toBe(5);
  });

  it('leaves non-JSON, non-form bodies and clean JSON untouched', () => {
    expect(scrubBody('password=x', 'text/plain')).toEqual({ text: 'password=x', hidden: 0 });
    const clean = '{ "a": 1 }';
    expect(scrubBody(clean, 'application/json')).toEqual({ text: clean, hidden: 0 });
    expect(scrubBody('{"token":"t"}', '').hidden).toBe(1);
    expect(scrubBody('{"token": "cut off', 'application/json')).toEqual({ text: '{"token": "cut off', hidden: 0 });
  });

  it('scrubs secret query parameters in URLs', () => {
    expect(scrubUrl('https://x.test/cb?code=1&access_token=abc#frag').text).toBe('https://x.test/cb?code=1&access_token=(hidden, 3 characters)#frag');
    expect(scrubUrl('https://x.test/search?q=tokens%20of%20love').hidden).toBe(0);
  });

  it('puts it together in the request detail, with one note', () => {
    const entry = {
      id: 'r4',
      method: 'POST',
      url: 'https://x.test/login?next=/home',
      type: 'XHR',
      status: 200,
      statusText: 'OK',
      mime: 'application/json',
      requestHeaders: { 'Content-Type': 'application/json', Authorization: 'Bearer abc' },
      responseHeaders: { 'set-cookie': 'sid=1; HttpOnly', 'content-type': 'application/json' },
      postData: '{"username":"ada","password":"hunter2"}',
      done: true
    };
    const text = formatNetworkDetail(entry, { body: { body: '{"ok":true,"refresh_token":"rrr"}', base64Encoded: false } });
    expect(text).toContain('Authorization: (hidden, 10 characters)');
    expect(text).toContain('{"username":"ada","password":"(hidden, 7 characters)"}');
    expect(text).toContain('{"ok":true,"refresh_token":"(hidden, 3 characters)"}');
    expect(text).not.toMatch(/hunter2|Bearer abc|sid=1|"rrr"/);
    expect(text.match(/sensitive values are shown as/g)).toHaveLength(1);
    expect(text).toMatch(/\(4 sensitive values are shown as "\(hidden, N characters\)"/);
  });

  it('decodes textual base64 bodies and summarises binary ones', () => {
    const base = { id: 'r1', method: 'GET', url: 'https://x.test/a', type: 'Fetch', status: 200, done: true, requestHeaders: {} };
    const json = formatNetworkDetail({ ...base, mime: 'application/json' }, { body: { body: Buffer.from('{"pin":"1234"}').toString('base64'), base64Encoded: true } });
    expect(json).toContain('{"pin":"(hidden, 4 characters)"}');
    const png = formatNetworkDetail({ ...base, mime: 'image/png' }, { body: { body: Buffer.alloc(3000).toString('base64'), base64Encoded: true } });
    expect(png).toMatch(/Response body: binary image\/png, about 2\.9 KB \(not shown\)\./);
    expect(png).not.toMatch(/sensitive/);
  });
});

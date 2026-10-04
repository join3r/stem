// The Sources panel's favicons are fetched by the server from hosts a model
// cited, so the fetcher must refuse anything that isn't a public site's icon.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { faviconFor, isFetchableHost } from '../../src/server/chats/favicon';

afterEach(() => vi.unstubAllGlobals());

describe('isFetchableHost', () => {
  it('accepts public names and refuses addresses and local names', () => {
    expect(isFetchableHost('www.nytimes.com')).toBe(true);
    expect(isFetchableHost('docs.python.org')).toBe(true);
    for (const bad of ['127.0.0.1', '192.168.1.1', 'localhost', 'router', 'nas.local', 'db.internal', '[::1]', 'a..b', '-x.com', 'x.123']) {
      expect(isFetchableHost(bad), bad).toBe(false);
    }
  });
});

describe('faviconFor', () => {
  it('returns an image as a data URL and re-checks every redirect', async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      if (url === 'https://example-icons.com/favicon.ico') {
        return new Response(null, { status: 301, headers: { location: 'https://cdn.example-icons.com/f.png' } });
      }
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    });
    expect(await faviconFor('example-icons.com')).toBe(`data:image/png;base64,${Buffer.from(png).toString('base64')}`);
    expect(calls).toEqual(['https://example-icons.com/favicon.ico', 'https://cdn.example-icons.com/f.png']);
  });

  it('refuses a redirect to a private address, SVG, and oversized files', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('redirector')) return new Response(null, { status: 302, headers: { location: 'https://10.0.0.1/x.ico' } });
      if (url.includes('svgsite')) return new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } });
      return new Response(new Uint8Array(70 * 1024), { headers: { 'content-type': 'image/x-icon' } });
    });
    expect(await faviconFor('redirector.example')).toBeNull();
    expect(await faviconFor('svgsite.example')).toBeNull();
    expect(await faviconFor('huge.example')).toBeNull();
    expect(await faviconFor('localhost')).toBeNull();
  });
});

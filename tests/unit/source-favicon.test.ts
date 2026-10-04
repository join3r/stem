// The Sources panel's favicons are fetched by the server from hosts a model
// cited, so the fetcher must refuse anything that isn't a public site's icon:
// by name before asking, and by address at connect time (a public name can
// resolve, or be rebound, to a private one).
import { describe, expect, it } from 'vitest';
import { faviconFor, isFetchableHost, isPrivateAddress, publicLookup } from '../../src/server/chats/favicon';

describe('isFetchableHost', () => {
  it('accepts public names and refuses addresses and local names', () => {
    expect(isFetchableHost('www.nytimes.com')).toBe(true);
    expect(isFetchableHost('docs.python.org')).toBe(true);
    for (const bad of ['127.0.0.1', '192.168.1.1', 'localhost', 'router', 'nas.local', 'db.internal', '[::1]', 'a..b', '-x.com', 'x.123']) {
      expect(isFetchableHost(bad), bad).toBe(false);
    }
  });
});

describe('isPrivateAddress', () => {
  it('refuses loopback, private, link-local, CGNAT, multicast and mapped addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::127.0.0.1', '64:ff9b::a00:1', '2002:a00:1::1', '2001:0:4136:e378::1', '203.0.113.5']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });
});

describe('publicLookup', () => {
  const lookup = (host: string, all: boolean) =>
    new Promise<unknown>((resolve, reject) =>
      publicLookup(host, { all } as never, (err: Error | null, address: unknown) => (err ? reject(err) : resolve(address)))
    );

  it('refuses a name that resolves to loopback, in both lookup modes', async () => {
    await expect(lookup('localhost', false)).rejects.toThrow(/private address/);
    await expect(lookup('localhost', true)).rejects.toThrow(/private address/);
  });
});

describe('faviconFor', () => {
  it('never contacts a refused host', async () => {
    expect(await faviconFor('localhost')).toBeNull();
    expect(await faviconFor('10.0.0.1')).toBeNull();
    expect(await faviconFor('printer.local')).toBeNull();
  });
});

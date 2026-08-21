// Which server this client dials, and how it comes by a credential for it.
//
// Both are ordered lists with an override at the top, and both have a failure
// mode that is invisible until someone is standing in front of a machine that
// won't connect: an address that silently loses to a stale one, or a token spent
// against a server that never issued it. So the order is asserted directly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  clearClientIdentity,
  clientStorePath,
  storedServerUrl,
  writeClientIdentity
} from '../../src/desktop/client-store';
import { clientCredentials, pairWithServer, resolveServerUrl } from '../../src/desktop/server-endpoint';
import { serverEndpointPath } from '../../src/server/workspace/paths';

const clientPath = clientStorePath();
const endpointPath = serverEndpointPath();

/** Publishing this file is what "the server shares our disk" means (see mint). */
function shareStateRoot(): void {
  mkdirSync(dirname(endpointPath), { recursive: true });
  writeFileSync(endpointPath, JSON.stringify({ url: 'http://127.0.0.1:1234' }));
}

beforeEach(() => {
  rmSync(clientPath, { force: true });
  rmSync(endpointPath, { force: true });
  delete process.env.STEM_SERVER_TOKEN;
  delete process.env.STEM_PAIRING_CODE;
});

afterEach(() => {
  rmSync(clientPath, { force: true });
  rmSync(endpointPath, { force: true });
  delete process.env.STEM_SERVER_TOKEN;
  delete process.env.STEM_PAIRING_CODE;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('which server to dial', () => {
  it('uses the stored address, and none means the one we start ourselves', async () => {
    expect(await resolveServerUrl()).toEqual({ url: null, pinnedByEnv: false });

    await writeClientIdentity({ deviceId: 'dev-1', token: 'a'.repeat(64) }, 'https://stem.example.com/');
    // Stored with the trailing slash off, so the stored form and the compared
    // form can never disagree about the same address.
    expect(await resolveServerUrl()).toEqual({ url: 'https://stem.example.com', pinnedByEnv: false });
  });

  it('lets STEM_SERVER_URL outrank the stored address, and says that it did', async () => {
    await writeClientIdentity({ deviceId: 'dev-1', token: 'a'.repeat(64) }, 'https://stem.example.com');
    vi.stubEnv('STEM_SERVER_URL', 'http://127.0.0.1:9999');
    // Read once at module load, so this needs a fresh copy of the module.
    vi.resetModules();
    const fresh = await import('../../src/desktop/server-endpoint');

    expect(await fresh.resolveServerUrl()).toEqual({ url: 'http://127.0.0.1:9999', pinnedByEnv: true });
  });
});

describe('which credential to use', () => {
  it('prefers STEM_SERVER_TOKEN over anything stored, and never stores it', async () => {
    await writeClientIdentity({ deviceId: 'dev-1', token: 'stored-token' }, null);
    process.env.STEM_SERVER_TOKEN = 'env-token';

    expect(await clientCredentials('http://127.0.0.1:1234', { external: false })).toEqual({
      url: 'http://127.0.0.1:1234',
      token: 'env-token'
    });
  });

  it('uses the stored identity when it belongs to this address (or to no address)', async () => {
    // An embedded server's port is ephemeral, so its identity is filed under no
    // address at all and applies to whatever this machine starts.
    await writeClientIdentity({ deviceId: 'dev-1', token: 'stored-token' }, null);
    expect((await clientCredentials('http://127.0.0.1:52413', { external: false })).token).toBe('stored-token');

    await writeClientIdentity({ deviceId: 'dev-2', token: 'vps-token' }, 'https://stem.example.com');
    expect((await clientCredentials('https://stem.example.com', { external: true })).token).toBe('vps-token');
  });

  it('refuses a stored identity that belongs to a different server', async () => {
    // Otherwise this is a 401 loop with no way out but deleting client.json by
    // hand: the token means nothing to the server we are actually dialling.
    await writeClientIdentity({ deviceId: 'dev-2', token: 'vps-token' }, 'https://stem.example.com');
    shareStateRoot();

    const minted = await clientCredentials('http://127.0.0.1:52413', { external: false });
    expect(minted.token).not.toBe('vps-token');
  });

  it('mints one off a shared state root, filing it under no address', async () => {
    shareStateRoot();
    const minted = await clientCredentials('http://127.0.0.1:52413', { external: false });
    expect(minted.token).toMatch(/^[0-9a-f]{64}$/);
    // Reachable again next launch, on whatever port the embedded server takes.
    expect((await clientCredentials('http://127.0.0.1:60000', { external: false })).token).toBe(minted.token);
  });

  it('says what to do instead when there is no way to get one', async () => {
    await expect(clientCredentials('https://stem.example.com', { external: true })).rejects.toThrow(
      /Pair instead/
    );
  });
});

describe('pairing', () => {
  it('refuses something that is not a server address before touching the network', async () => {
    await expect(pairWithServer('stem.example.com', 'ABCD-EFGH')).rejects.toThrow(
      /needs to start with http:\/\/ or https:\/\//
    );
  });
});

// A stored address is the difference between "my server is unreachable" (visible,
// fixable) and a silently-booted empty embedded server ("my Stem is gone" — the
// 2026-08-15 and 2026-08-21 incidents, both a stray mint against the real
// profile). So the address only leaves this file by the explicit built-in action.
describe('the stored address is sticky', () => {
  it('survives an identity rewrite that names no address', async () => {
    await writeClientIdentity({ deviceId: 'dev-2', token: 'vps-token' }, 'https://stem.example.com');
    await writeClientIdentity({ deviceId: 'dev-3', token: 'minted-token' }, null);

    expect(await storedServerUrl()).toBe('https://stem.example.com');
  });

  it('survives an embedded mint against a shared state root', async () => {
    await writeClientIdentity({ deviceId: 'dev-2', token: 'vps-token' }, 'https://stem.example.com');
    shareStateRoot();

    // The mismatch mints a fresh embedded credential (asserted above) — but the
    // next ordinary launch must still dial the user's server, not boot its own.
    await clientCredentials('http://127.0.0.1:52413', { external: false });
    expect(await storedServerUrl()).toBe('https://stem.example.com');
  });

  it('leaves only the explicit built-in action to forget it', async () => {
    await writeClientIdentity({ deviceId: 'dev-2', token: 'vps-token' }, 'https://stem.example.com');
    await clearClientIdentity();

    expect(await storedServerUrl()).toBeNull();
  });
});

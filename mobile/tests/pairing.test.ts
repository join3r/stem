import { describe, expect, it, vi } from 'vitest';
import {
  normalizePairingCode,
  normalizeServerUrl,
  pairingCodeProblem,
  parsePairPayload,
  serverUrlProblem
} from '../src/transport/pairing';
import { redeemPairingCode } from '../src/transport/pair-request';
import { createScanLatch } from '../src/ui/scan-latch';

describe('normalizePairingCode', () => {
  it('is the same transformation the server hashes', () => {
    // normalizeCode() in src/server/transport/pairing.ts. If these two ever
    // disagree, a valid code is rejected with no way for anyone to see why.
    expect(normalizePairingCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizePairingCode(' 2345 6789 ')).toBe('23456789');
    expect(normalizePairingCode('AB01CD')).toBe('ABCD');
  });
});

describe('serverUrlProblem', () => {
  it('accepts an address with a scheme and refuses one without', () => {
    expect(serverUrlProblem('https://stem.example.com')).toBeNull();
    expect(serverUrlProblem('stem.example.com')).toContain('http://');
    expect(serverUrlProblem('   ')).toContain('address');
  });

  it('refuses cleartext HTTP for anything but loopback (SEC-004)', () => {
    // Plain http would hand the pairing code and the returned bearer to anyone
    // on the network path. Loopback stays usable (simulator → same machine);
    // a development build (__DEV__) may reach a LAN dev server, but the test
    // runner has no __DEV__, which is exactly the release posture.
    expect(serverUrlProblem('http://192.168.1.4:8080')).toContain('http');
    expect(serverUrlProblem('http://stem.example.com')).toContain('https');
    expect(serverUrlProblem('http://localhost:7070')).toBeNull();
    expect(serverUrlProblem('http://127.0.0.1:7070')).toBeNull();
    expect(serverUrlProblem('http://[::1]:7070')).toBeNull();
  });

  it('normalizes trailing slashes away, so one server is one address', () => {
    expect(normalizeServerUrl('https://stem.example.com//')).toBe('https://stem.example.com');
  });
});

describe('pairingCodeProblem', () => {
  it('counts the characters that survive normalization', () => {
    expect(pairingCodeProblem('ABCD-EFGH')).toBeNull();
    expect(pairingCodeProblem('ABCD')).toContain('4');
    expect(pairingCodeProblem('')).toContain('eight');
  });
});

describe('parsePairPayload', () => {
  it('reads the QR the desktop renders', () => {
    expect(parsePairPayload('stem://pair?url=https%3A%2F%2Fstem.example.com&code=ABCD-EFGH')).toEqual({
      serverUrl: 'https://stem.example.com',
      code: 'ABCDEFGH'
    });
  });

  it('accepts serverUrl as a spelling of url', () => {
    expect(parsePairPayload('stem://pair?serverUrl=https%3A%2F%2F10.0.0.2%3A7070&code=23456789')).toEqual({
      serverUrl: 'https://10.0.0.2:7070',
      code: '23456789'
    });
  });

  it('drops an http QR target before any code is transmitted (SEC-004)', () => {
    expect(parsePairPayload('stem://pair?url=http%3A%2F%2F10.0.0.2%3A7070&code=23456789')).toBeNull();
  });

  it('refuses anything that is not a Stem pairing link', () => {
    expect(parsePairPayload('https://example.com')).toBeNull();
    expect(parsePairPayload('stem://pair')).toBeNull();
    expect(parsePairPayload('stem://pair?url=https://x')).toBeNull(); // no code
    expect(parsePairPayload('stem://pair?url=notaurl&code=ABCDEFGH')).toBeNull();
    expect(parsePairPayload('stem://pair?url=https://x&code=SHORT')).toBeNull();
    expect(parsePairPayload('')).toBeNull();
  });
});

describe('createScanLatch', () => {
  it('lets one scan through however many frames carry the same code', () => {
    // expo-camera calls back per frame, so a code held in view arrives dozens of
    // times. A pairing code is one-shot: the second submission spends a failure
    // against the eight that lock the route, and answers 401 to a pairing that
    // actually worked.
    const latch = createScanLatch();
    expect(latch.accept()).toBe(true);
    expect(latch.accept()).toBe(false);
    expect(latch.accept()).toBe(false);
  });

  it('opens again when the scanner does', () => {
    // A first scan that failed — an expired code — must not leave a camera that
    // can never scan anything again.
    const latch = createScanLatch();
    expect(latch.accept()).toBe(true);
    latch.reset();
    expect(latch.accept()).toBe(true);
    expect(latch.accept()).toBe(false);
  });
});

describe('redeemPairingCode', () => {
  const ok = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  // `kind: 'mobile'` is part of the request, not decoration: it is what keeps the
  // server from ever offering this phone as a host for a pinned MCP server.
  it('posts the normalized code and what this device is, and keeps what comes back', async () => {
    const fetchMock = vi.fn(async () => ok({ ok: true, result: { deviceId: 'dev-1', token: 'secret' } }));
    const stored = await redeemPairingCode('https://stem.example.com/', 'abcd-efgh', fetchMock as unknown as typeof fetch);
    expect(stored).toEqual({ serverUrl: 'https://stem.example.com', deviceId: 'dev-1', token: 'secret' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://stem.example.com/pair');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ code: 'ABCDEFGH', kind: 'mobile' });
  });

  it('repeats the server’s own refusal, which is the only one that explains itself', async () => {
    const fetchMock = vi.fn(
      async () =>
        ({ ok: false, status: 429, json: async () => ({ ok: false, error: 'too many attempts; try again in 15 minutes' }) }) as unknown as Response
    );
    await expect(
      redeemPairingCode('https://stem.example.com', 'ABCDEFGH', fetchMock as unknown as typeof fetch)
    ).rejects.toThrow('too many attempts');
  });

  it('says the address never answered when nothing did', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('Network request failed');
    });
    await expect(
      redeemPairingCode('https://stem.example.com', 'ABCDEFGH', fetchMock as unknown as typeof fetch)
    ).rejects.toThrow('Could not reach https://stem.example.com');
  });

  it('never leaves for the network with an address or a code that cannot work', async () => {
    const fetchMock = vi.fn();
    await expect(redeemPairingCode('stem.example.com', 'ABCDEFGH', fetchMock as unknown as typeof fetch)).rejects.toThrow();
    await expect(redeemPairingCode('https://x', 'ABC', fetchMock as unknown as typeof fetch)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

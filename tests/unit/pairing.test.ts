// Pairing codes: the one way into a Stem server from a machine that cannot read
// its disk, and therefore the one place where a short, human-carried secret is
// exchanged for a real credential.
//
// Everything asserted here is about narrowing that window: the code is spent on
// first use, it expires, wrong guesses are counted and eventually stop being
// answered at all, and — like the registry beside it — the file the codes live in
// cannot be read back into a code.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createPairingCode,
  normalizeCode,
  PairingError,
  pendingPairings,
  redeemPairingCode
} from '../../src/server/transport/pairing';
import { forgetCachedDevices, readDevices, resolveDevice } from '../../src/server/transport/auth';
import { devicesStorePath, pairingStorePath } from '../../src/server/workspace/paths';

const pairingPath = pairingStorePath();
const devicesPath = devicesStorePath();

function reset(): void {
  mkdirSync(dirname(pairingPath), { recursive: true });
  rmSync(pairingPath, { force: true });
  rmSync(devicesPath, { force: true });
  forgetCachedDevices();
}

beforeEach(async () => {
  await readDevices().catch(() => undefined);
  reset();
});

afterEach(() => {
  vi.useRealTimers();
  reset();
});

describe('issuing a code', () => {
  it('is readable aloud, and stored only as a hash', async () => {
    const { code, expiresAt } = await createPairingCode("Vlado's MacBook");

    // Grouped, and drawn from an alphabet with no character that can be
    // misheard as another (no 0/1/I/L/O/U).
    expect(code).toMatch(/^[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}$/);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

    const onDisk = readFileSync(pairingPath, 'utf8');
    expect(onDisk).not.toContain(normalizeCode(code));
    expect(statSync(pairingPath).mode & 0o777).toBe(0o600);
  });

  it('lists what is outstanding, so a stale code is visible rather than guessed at', async () => {
    await createPairingCode('Laptop');
    await createPairingCode('Phone');
    expect((await pendingPairings()).map((p) => p.label).sort()).toEqual(['Laptop', 'Phone']);
  });
});

describe('spending a code', () => {
  it('mints a device carrying the label the code was issued for', async () => {
    const { code } = await createPairingCode("Vlado's MacBook");
    const { device, token } = await redeemPairingCode(code);

    expect(device.label).toBe("Vlado's MacBook");
    expect((await resolveDevice(token))?.id).toBe(device.id);
    // Spent: nothing is left outstanding.
    expect(await pendingPairings()).toEqual([]);
  });

  it('accepts the code however it was typed', async () => {
    const { code } = await createPairingCode('Laptop');
    // Lowercase, spaces instead of the dash — the same code as far as anyone
    // reading it off a screen is concerned.
    const mangled = code.toLowerCase().replace('-', ' ');
    await expect(redeemPairingCode(mangled)).resolves.toBeTruthy();
  });

  it('two devices racing for one code mint exactly one credential', async () => {
    const { code } = await createPairingCode('Laptop');
    const results = await Promise.allSettled([redeemPairingCode(code), redeemPairingCode(code)]);

    // Serialized inside the store: one wins, the other is told the same thing
    // any wrong code is told — never handed a second copy of the credential.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(loser.reason)).toMatch(/not valid/);
    expect((await readDevices()).length).toBe(1);
  });

  it('cannot be spent twice', async () => {
    const { code } = await createPairingCode('Laptop');
    await redeemPairingCode(code);

    await expect(redeemPairingCode(code)).rejects.toThrow(/not valid/);
    // One device, not two: the second attempt minted nothing.
    expect((await readDevices()).length).toBe(1);
  });

  it('expires', async () => {
    const { code } = await createPairingCode('Laptop');
    // Eleven minutes on: past the ten-minute life of a code.
    vi.setSystemTime(Date.now() + 11 * 60_000);

    await expect(redeemPairingCode(code)).rejects.toThrow(/not valid/);
    expect((await readDevices()).length).toBe(0);
    // …and it is pruned rather than left to accumulate.
    expect(await pendingPairings()).toEqual([]);
  });

  it('says the same thing about a wrong code, an expired one and a spent one', async () => {
    const { code } = await createPairingCode('Laptop');
    await redeemPairingCode(code);

    // Telling them apart would let an attacker learn which of their guesses had
    // ever been a real code, which is most of the way to a valid one.
    const spent = await redeemPairingCode(code).catch((e: Error) => e.message);
    const wrong = await redeemPairingCode('ZZZZ-ZZZZ').catch((e: Error) => e.message);
    expect(spent).toBe(wrong);
  });
});

describe('guessing at codes', () => {
  it('stops answering after a handful of wrong ones', async () => {
    const { code } = await createPairingCode('Laptop');

    for (let i = 0; i < 8; i++) {
      await expect(redeemPairingCode('ZZZZ-ZZZZ')).rejects.toThrow(PairingError);
    }

    // Locked out — and the lockout is what makes a 40-bit code safe to expose:
    // even the CORRECT code is refused while it holds.
    const locked = await redeemPairingCode(code).catch((e: PairingError) => e);
    expect((locked as PairingError).status).toBe(429);
    expect((locked as PairingError).message).toMatch(/too many/);
    expect((await readDevices()).length).toBe(0);

    // It lets go on its own, rather than needing an admin to clear it.
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const { code: fresh } = await createPairingCode('Laptop');
    await expect(redeemPairingCode(fresh)).resolves.toBeTruthy();
  });

  it('a lockout that has passed opens a fresh window, not a hair trigger', async () => {
    // Burn a full window of guesses and let the lockout expire on its own.
    for (let i = 0; i < 8; i++) await redeemPairingCode('ZZZZ-ZZZZ').catch(() => undefined);
    vi.setSystemTime(Date.now() + 16 * 60_000);

    // The person now legitimately pairing mistypes once. Before the window
    // reset, the stale failure count sat at MAX forever and this single typo
    // re-locked the route for another fifteen minutes — one attempt per quarter
    // hour, when the cap's own math promises eight per window.
    await expect(redeemPairingCode('YYYY-YYYY')).rejects.toThrow(/not valid/);
    const { code } = await createPairingCode('Laptop');
    await expect(redeemPairingCode(code)).resolves.toBeTruthy();
  });

  it('forgets the failures once somebody gets it right', async () => {
    const { code } = await createPairingCode('Laptop');
    for (let i = 0; i < 7; i++) await redeemPairingCode('ZZZZ-ZZZZ').catch(() => undefined);
    await redeemPairingCode(code);

    // A mistyped code before a successful pairing must not leave the next
    // person one attempt from a lockout.
    const { code: second } = await createPairingCode('Phone');
    for (let i = 0; i < 3; i++) await redeemPairingCode('ZZZZ-ZZZZ').catch(() => undefined);
    await expect(redeemPairingCode(second)).resolves.toBeTruthy();
  });
});

describe('a pairing store that has been damaged', () => {
  it('is treated as empty rather than taken down with it', async () => {
    mkdirSync(dirname(pairingPath), { recursive: true });
    writeFileSync(pairingPath, '{"version":1,"codes":[', 'utf8');

    await expect(redeemPairingCode('ZZZZ-ZZZZ')).rejects.toThrow(/not valid/);
    // And it recovers: a new code written over the wreckage works.
    const { code } = await createPairingCode('Laptop');
    await expect(redeemPairingCode(code)).resolves.toBeTruthy();
  });
});

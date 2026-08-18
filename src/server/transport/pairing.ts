import { randomInt } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hashEquals, hashToken, mintDevice, type MintedDevice } from './auth';
import type { DeviceKind } from '../../shared/types';
import { degrade } from '../degrade';
import { pairingStorePath } from '../workspace/paths';
import {
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH
} from '../../shared/pairing-code';

// How a device that does NOT share this server's disk gets a credential.
//
// The shape is deliberately the smallest thing that works: a short code, said
// once, spent once. Somebody with access to the server asks for a code
// (`stem-server pair --label "…"`, or Settings → Server → Devices on a device that is
// already paired), carries it to the new device by whatever means they like, and
// the new device spends it on POST /pair — the transport's only unauthenticated
// route — receiving a device id and a bearer token it keeps from then on.
//
// WHY THE CODES ARE ON DISK. The Phase 2 plan said "held in memory", and that
// would be marginally safer, but it cannot answer `stem-server pair`: that is a
// second, short-lived process (`docker compose exec stem …`), and it has no
// credential with which to ask the running server for anything — the whole
// reason it is being run is that no credential exists yet. A file is the only
// thing the two processes share. What is written is the code's SHA-256, never
// the code, so this file is worth no more to a reader than devices.json is:
// enough to know a pairing is outstanding, not enough to complete one.
//
// Surviving a restart is a small bonus rather than the motivation — a code you
// were given thirty seconds before the container was redeployed still works.

/** Ten minutes: long enough to walk a code to another machine, short enough to matter. */
const CODE_TTL_MS = 10 * 60_000;

/**
 * Consecutive bad codes before /pair stops answering at all. Caddy rate-limits
 * the route in the deployed configuration; this is the layer that does not
 * depend on the proxy being configured correctly, and it is what makes a ~2^39
 * code space safe to expose. At 8 tries per lockout window an attacker gets
 * roughly 800 guesses a day against a code that lives for ten minutes.
 */
const MAX_FAILURES = 8;
const LOCKOUT_MS = 15 * 60_000;

// The alphabet, the length and what a typed code normalizes to live in
// src/shared/pairing-code.ts, because the phone has to agree with this file
// exactly: what is hashed below is the NORMALIZED code, so a client normalizing
// differently sends a hash of something else and is told its good code is wrong.
const ALPHABET = PAIRING_CODE_ALPHABET;
const CODE_LENGTH = PAIRING_CODE_LENGTH;

interface StoredCode {
  /** SHA-256 of the normalized code. The code itself is never persisted. */
  codeHash: string;
  /** The label the resulting device record will carry. */
  label: string;
  expiresAt: string;
  createdAt: string;
}

interface PairingStore {
  version: 1;
  codes: StoredCode[];
  /** Consecutive failed redemptions since the last success. */
  failures: number;
  /** ISO timestamp until which /pair refuses everything, or null. */
  lockedUntil: string | null;
}

/** A code to hand to a person, and when it stops working. */
export interface PairingCode {
  /** Formatted for reading aloud: `ABCD-EFGH`. */
  code: string;
  label: string;
  expiresAt: string;
}

/** A redemption that failed, carrying the HTTP status the route should answer. */
export class PairingError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'PairingError';
  }
}

const EMPTY: PairingStore = { version: 1, codes: [], failures: 0, lockedUntil: null };

/** Serializes reads and writes; two redemptions must not both spend one code. */
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function readStore(): Promise<PairingStore> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(pairingStorePath(), 'utf8'));
  } catch (err) {
    // No file is the ordinary case: nothing is outstanding until somebody asks
    // for a code. A file that exists and cannot be read reads as exactly that,
    // so the device spending a code it was handed a minute ago is told only
    // that the code is wrong — and the failure count that locks the route is
    // back at zero.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('transport.pairing', 'read the pairing store as empty', err);
    }
    return { ...EMPTY, codes: [] };
  }
  const store = parsed as Partial<PairingStore> | null;
  const codes = Array.isArray(store?.codes) ? store.codes : [];
  return {
    version: 1,
    // Expired codes are pruned on every read, so the file cannot grow without
    // bound just because a server boots often with an empty registry.
    codes: codes.filter(
      (c): c is StoredCode =>
        !!c &&
        typeof c.codeHash === 'string' &&
        typeof c.expiresAt === 'string' &&
        Date.parse(c.expiresAt) > Date.now()
    ),
    failures: typeof store?.failures === 'number' && store.failures >= 0 ? store.failures : 0,
    lockedUntil: typeof store?.lockedUntil === 'string' ? store.lockedUntil : null
  };
}

async function writeStore(store: PairingStore): Promise<void> {
  const path = pairingStorePath();
  // quiet: a directory that genuinely could not be made takes the writeFile below
  // down with it, and that throws to the caller.
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600).catch((err) =>
    // `mode` only applies on create, so this is what keeps a rewrite onto an
    // existing or umask-widened file at 0600. This file holds the hash of a live
    // pairing code and the lockout counter that limits guesses at it; a wider
    // mode means anyone with a login on this machine can read both.
    degrade('transport.pairing', 'left the pairing store at a wider mode than 0600', err)
  );
}

/** `ABCD-EFGH` — grouped for reading aloud, ungrouped by normalize(). */
function generateCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * What a typed code means — the shared rule, re-exported under the name this
 * side has always called it so nothing that imports it has to care that the
 * transformation moved.
 */
export const normalizeCode = normalizePairingCode;

/**
 * Mint a code for a device that will be labelled `label`. Any number may be
 * outstanding at once (pairing two devices in an afternoon is normal); each is
 * independently single-use and independently expiring.
 */
export function createPairingCode(label: string): Promise<PairingCode> {
  return enqueue(async () => {
    const store = await readStore();
    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
    const entry: StoredCode = {
      codeHash: hashToken(normalizeCode(code)),
      label: label.trim() || 'Paired device',
      expiresAt,
      createdAt: new Date().toISOString()
    };
    await writeStore({ ...store, codes: [...store.codes, entry] });
    return { code, label: entry.label, expiresAt };
  });
}

/** Codes that are still spendable — Settings shows this so a stale one isn't re-issued. */
export function pendingPairings(): Promise<readonly { label: string; expiresAt: string }[]> {
  return enqueue(async () => {
    const store = await readStore();
    return store.codes.map((c) => ({ label: c.label, expiresAt: c.expiresAt }));
  });
}

/**
 * Spend a code: mints a device and returns its token, the one time that token
 * exists outside the device it belongs to. Throws PairingError for every failure
 * — a wrong code, an expired one, and one already spent are deliberately the
 * same message, since telling them apart would let an attacker probe which of
 * their guesses had ever been a real code.
 */
export function redeemPairingCode(presented: string, kind: DeviceKind = 'desktop'): Promise<MintedDevice> {
  return enqueue(async () => {
    const store = await readStore();
    const lockedUntil = store.lockedUntil ? Date.parse(store.lockedUntil) : 0;
    if (Number.isFinite(lockedUntil) && lockedUntil > Date.now()) {
      throw new PairingError('too many pairing attempts; try again later', 429);
    }

    const normalized = normalizeCode(presented);
    const hash = normalized ? hashToken(normalized) : '';
    // Every code is compared even after a match, so a wrong code takes the same
    // time as a right one regardless of where the right one sits in the list.
    let matched: StoredCode | null = null;
    for (const candidate of store.codes) {
      if (hash && hashEquals(candidate.codeHash, hash)) matched = candidate;
    }

    if (!matched) {
      const failures = store.failures + 1;
      await writeStore({
        ...store,
        failures,
        lockedUntil: failures >= MAX_FAILURES ? new Date(Date.now() + LOCKOUT_MS).toISOString() : store.lockedUntil
      });
      throw new PairingError('that pairing code is not valid', 401);
    }

    // Spend it BEFORE minting, and reset the failure counter: a code is single
    // use even if the mint below throws, because a code that survives a partial
    // failure is a code two devices could race for.
    await writeStore({
      ...store,
      codes: store.codes.filter((c) => c !== matched),
      failures: 0,
      lockedUntil: null
    });
    // The label comes from whoever issued the code; the kind comes from the
    // device spending it, because nobody at the server end knows what is about
    // to be walked over to. It is a claim, not a credential — see DeviceRecord.
    return mintDevice(matched.label, kind);
  });
}

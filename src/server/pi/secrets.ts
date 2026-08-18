import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { degrade } from '../degrade';
import { host } from '../host';
import { secretKeyPath } from '../workspace/paths';
import { SECRET_VALUE_PREFIX } from './protocol';

// Secrets-at-rest for the MCP credential files (mcp.json auth fields and the
// whole mcp-oauth.json token map). Values are AES-256-GCM ciphertexts under a
// random data key; the key itself is stored wrapped by the host's key wrapper
// (Electron's safeStorage → macOS Keychain), so credentials on disk survive
// neither file exfiltration nor a copied backup. The bridge extension runs
// inside the pi process and has no wrapper, so PiRuntime hands it the unwrapped key via
// ENV_SECRET_KEY at spawn — its crypto twin lives in stem-mcp-extension.mjs
// (drift-guarded by tests/unit/pi-protocol.test.ts).
//
// Every read path treats an un-prefixed value as legacy plaintext, and every
// write path falls back to plaintext when no wrapper is available (a Linux box
// without a keyring; a headless server), so encryption is strictly additive: worst
// case is today's 0600-plaintext behavior, never a lockout.

let cachedKey: Buffer | null | undefined;

function loadOrCreateKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const wrapper = host().keyWrapper();
  if (!wrapper) return (cachedKey = null); // no keyring, or headless
  const path = secretKeyPath();
  try {
    const hex = wrapper.unwrap(readFileSync(path));
    if (/^[0-9a-f]{64}$/.test(hex)) return (cachedKey = Buffer.from(hex, 'hex'));
  } catch (error) {
    // missing or unwrappable (keychain reset / copied profile) → mint a fresh
    // key; data under the old key is unreadable either way and degrades to
    // "signed out", never to a crash. No file is simply the first run; a file
    // that is there and will not unwrap is every stored credential on this
    // machine becoming unreadable in one step, which nothing downstream can
    // distinguish from the user never having entered them.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('pi.secrets', 'minted a new key, leaving the credentials under the old one unreadable', error);
    }
  }
  const key = randomBytes(32);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, wrapper.wrap(key.toString('hex')), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // quiet: the temp file is ours and already unreachable; leaving one behind
      // costs a stray byte count, and the next attempt overwrites it.
    }
    // Plaintext mode is the documented floor, but it is not what a machine WITH a
    // keyring was promised: from here on every credential goes to disk readable
    // by anything that can open the file.
    degrade('pi.secrets', 'kept writing credentials as plaintext', error);
    return (cachedKey = null);
  }
  return (cachedKey = key);
}

/** Whether writes will actually be encrypted (a key wrapper exists, key on disk). */
export function secretKeyAvailable(): boolean {
  return loadOrCreateKey() !== null;
}

/** The raw key as hex for the pi child's ENV_SECRET_KEY; null in plaintext mode. */
export function secretKeyHex(): string | null {
  return loadOrCreateKey()?.toString('hex') ?? null;
}

export function isEncryptedSecretValue(value: string): boolean {
  return value.startsWith(SECRET_VALUE_PREFIX);
}

/** Encrypt one string value; returns it unchanged in plaintext mode. */
export function encryptSecretValue(plain: string): string {
  const key = loadOrCreateKey();
  if (!key) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return SECRET_VALUE_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/**
 * Decrypt one stored value. Un-prefixed input is legacy plaintext and passes
 * through verbatim; a prefixed value that cannot be decrypted (lost/rotated
 * key, tampering) returns null so callers drop the credential instead of
 * sending ciphertext upstream.
 */
export function decryptSecretValue(value: string): string | null {
  if (!isEncryptedSecretValue(value)) return value;
  const key = loadOrCreateKey();
  if (!key) return null;
  try {
    const raw = Buffer.from(value.slice(SECRET_VALUE_PREFIX.length), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch (error) {
    // Some callers hand this on to the user (mcp.json headers and env become
    // `lostSecrets`, and the MCP tab says so); the whole-file OAuth envelope does
    // not — the token map just reads as empty and every signed-in server starts
    // asking for a password again with nothing said about why.
    degrade('pi.secrets', 'dropped a stored credential it could not decrypt', error);
    return null;
  }
}

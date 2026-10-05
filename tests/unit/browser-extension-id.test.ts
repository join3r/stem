// The extension's id is not chosen, it is derived: Chrome hashes the public
// key in manifest.json. The desktop needs the id ahead of time (the native
// host manifest's allowed_origins names it), so it is written down in
// src/shared/browser-native.ts — and this checks the two never drift apart,
// e.g. after someone regenerates the key.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BROWSER_EXTENSION_ID } from '../../src/shared/browser-native';

const manifest = JSON.parse(readFileSync(new URL('../../src/browser-extension/manifest.json', import.meta.url), 'utf8'));

describe('browser extension id', () => {
  it('is the id Chrome derives from the manifest key', () => {
    const der = Buffer.from(manifest.key, 'base64');
    const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
    const id = [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('');
    expect(id).toBe(BROWSER_EXTENSION_ID);
    expect(BROWSER_EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  });

  it('ships the agreed manifest shape', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('Stem');
    expect(manifest.incognito).toBe('not_allowed');
    expect(manifest.host_permissions).toBeUndefined();
    expect([...manifest.permissions].sort()).toEqual(['alarms', 'debugger', 'downloads', 'nativeMessaging', 'storage', 'tabs', 'webNavigation']);
  });
});

// The settings seam: which document each field lives in, how an existing
// install's fields get across, and what the renderer is handed at the end.
//
// The property under test throughout is that nothing above the seam can tell.
// `settings:get` and every `settings:update*` answer with one whole AppSettings,
// assembled from two files by src/desktop/settings.ts — so the tests assert on
// the merged document AND on what actually landed in client.json, because a
// merge that reads right while writing nothing would pass the first check alone.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { clientStorePath, writeClientIdentity } from '../../src/desktop/client-store';
import {
  mergeSettings,
  readClientSettings,
  seedReleaseNotesMarker,
  updateClientQuickChat,
  updateClientReleaseNotes,
  updateClientTheme,
  updateClientUpdates,
  withClientSettings
} from '../../src/desktop/settings';
import { readSettings } from '../../src/server/workspace/settings';
import { settingsStorePath } from '../../src/server/workspace/paths';
import type { ClientSettings } from '../../src/shared/types';

const clientPath = clientStorePath();
const settingsPath = settingsStorePath();

/** What an install that predates the split has on disk. */
const PRE_SPLIT = {
  quickChat: {
    shortcut: 'Alt+Space',
    showOnAllDisplays: false,
    followAcrossSpaces: false,
    defaultEffort: 'high',
    finishSound: true
  },
  releaseNotes: { showOnUpdate: false, lastSeenVersion: '0.2.0' },
  escapeAction: 'single'
};

function storedClient(): { settings?: ClientSettings; deviceId?: string; serverUrl?: string } {
  return JSON.parse(readFileSync(clientPath, 'utf8')) as ReturnType<typeof storedClient>;
}

beforeEach(() => {
  mkdirSync(dirname(settingsPath), { recursive: true });
  rmSync(clientPath, { force: true });
  rmSync(settingsPath, { force: true });
});

afterEach(() => {
  rmSync(clientPath, { force: true });
  rmSync(settingsPath, { force: true });
});

describe('carrying an existing install across the split', () => {
  it('takes the hotkey, the overlay flags and the seen-marker out of settings.json', async () => {
    writeFileSync(settingsPath, JSON.stringify(PRE_SPLIT));

    expect(await readClientSettings()).toEqual({
      quickChat: { shortcut: 'Alt+Space', showOnAllDisplays: false, followAcrossSpaces: false },
      releaseNotes: { showOnUpdate: false, lastSeenVersion: '0.2.0' },
      // Not in PRE_SPLIT: the updates and theme blocks postdate the split, so
      // they always start from their defaults rather than migrating from anywhere.
      updates: { checkAutomatically: true },
      theme: { selected: 'system' }
    });
    // And the whole document the renderer sees is unchanged by the move.
    const merged = mergeSettings(await readSettings(), await readClientSettings());
    expect(merged.quickChat.shortcut).toBe('Alt+Space');
    expect(merged.quickChat.defaultEffort).toBe('high');
    expect(merged.releaseNotes).toEqual({ showOnUpdate: false, lastSeenVersion: '0.2.0' });
  });

  it('runs once — a later settings.json that has shed the fields cannot undo it', async () => {
    writeFileSync(settingsPath, JSON.stringify(PRE_SPLIT));
    await readClientSettings();

    // What the server writes from here on: the same file, without the keys it
    // stopped reading. The migration must already be behind us.
    writeFileSync(settingsPath, JSON.stringify({ escapeAction: 'single' }));
    expect((await readClientSettings()).quickChat.shortcut).toBe('Alt+Space');
  });

  it('starts from defaults for a client that has no settings.json to migrate from', async () => {
    // A genuinely remote client: the server's state root is on another machine,
    // so there is nothing to inherit and nothing to inherit is correct. What it
    // is owed of the release notes is a startup decision, not a defaulting rule
    // (see seedReleaseNotesMarker).
    expect(await readClientSettings()).toEqual({
      quickChat: { shortcut: null, showOnAllDisplays: true, followAcrossSpaces: true },
      releaseNotes: { showOnUpdate: true, lastSeenVersion: null },
      updates: { checkAutomatically: true },
      theme: { selected: 'system' }
    });
  });

  it('coerces garbage the way the server used to', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        quickChat: { shortcut: '   ', showOnAllDisplays: 'yes' },
        releaseNotes: { showOnUpdate: 'yes', lastSeenVersion: 'v-next' },
        updates: { checkAutomatically: 'yes' },
        theme: { selected: 'neon' }
      })
    );
    expect(await readClientSettings()).toEqual({
      quickChat: { shortcut: null, showOnAllDisplays: true, followAcrossSpaces: true },
      releaseNotes: { showOnUpdate: true, lastSeenVersion: null },
      updates: { checkAutomatically: true },
      theme: { selected: 'system' }
    });
  });
});

describe('splitting a Quick Chat patch', () => {
  it('keeps only the three fields this machine owns', async () => {
    await updateClientQuickChat({ shortcut: 'Ctrl+Space', finishSound: true, defaultEffort: 'low' });

    const settings = storedClient().settings!;
    expect(settings.quickChat).toEqual({
      shortcut: 'Ctrl+Space',
      showOnAllDisplays: true,
      followAcrossSpaces: true
    });
    // The rest of the patch is the server's business and was never touched here.
    expect(settings.quickChat).not.toHaveProperty('finishSound');
  });

  it('leaves the fields a patch does not mention alone', async () => {
    await updateClientQuickChat({ shortcut: 'Ctrl+Space', showOnAllDisplays: false });
    await updateClientQuickChat({ followAcrossSpaces: false });
    expect((await readClientSettings()).quickChat).toEqual({
      shortcut: 'Ctrl+Space',
      showOnAllDisplays: false,
      followAcrossSpaces: false
    });
  });

  it('clears the hotkey when the user unsets it', async () => {
    await updateClientQuickChat({ shortcut: 'Ctrl+Space' });
    await updateClientQuickChat({ shortcut: null });
    expect((await readClientSettings()).quickChat.shortcut).toBeNull();
  });
});

describe('the "what\'s new" marker', () => {
  it('round-trips the preference and the marker', async () => {
    await updateClientReleaseNotes({ showOnUpdate: false });
    await updateClientReleaseNotes({ lastSeenVersion: '1.4.2' });
    expect((await readClientSettings()).releaseNotes).toEqual({
      showOnUpdate: false,
      lastSeenVersion: '1.4.2'
    });
  });

  it('is seeded to the running version when onboarding completes', async () => {
    // '0.0.0' is the stub host's version. A brand-new user must not be greeted
    // by release notes for the build they just installed.
    await seedReleaseNotesMarker();
    expect((await readClientSettings()).releaseNotes.lastSeenVersion).toBe('0.0.0');
  });

  it('does not move a marker that already exists', async () => {
    await updateClientReleaseNotes({ lastSeenVersion: '0.2.0' });
    await seedReleaseNotesMarker();
    expect((await readClientSettings()).releaseNotes.lastSeenVersion).toBe('0.2.0');
  });
});

describe('the automatic-update toggle', () => {
  it('round-trips, and a patch does not disturb the other blocks', async () => {
    await updateClientQuickChat({ shortcut: 'Alt+Space' });
    await updateClientUpdates({ checkAutomatically: false });
    const settings = await readClientSettings();
    expect(settings.updates).toEqual({ checkAutomatically: false });
    expect(settings.quickChat.shortcut).toBe('Alt+Space');
  });
});

describe('the theme choice', () => {
  it('round-trips built-in modes and custom ids, and a patch does not disturb the other blocks', async () => {
    await updateClientQuickChat({ shortcut: 'Alt+Space' });
    await updateClientTheme({ selected: 'dark' });
    expect((await readClientSettings()).theme).toEqual({ selected: 'dark' });

    await updateClientTheme({ selected: 'custom:nord' });
    const settings = await readClientSettings();
    expect(settings.theme).toEqual({ selected: 'custom:nord' });
    expect(settings.quickChat.shortcut).toBe('Alt+Space');
  });

  it('refuses a custom id that could walk out of the themes folder', async () => {
    await updateClientTheme({ selected: 'custom:../../etc/passwd' });
    expect((await readClientSettings()).theme).toEqual({ selected: 'system' });
    await updateClientTheme({ selected: 'custom:a/b' });
    expect((await readClientSettings()).theme).toEqual({ selected: 'system' });
  });

  it('reaches the merged document the renderer sees', async () => {
    await updateClientTheme({ selected: 'light' });
    const merged = await withClientSettings(await readSettings());
    expect(merged.theme).toEqual({ selected: 'light' });
  });
});

describe('one document out of two files', () => {
  it('merges the machine\'s half over whatever the server answered', async () => {
    await updateClientQuickChat({ shortcut: 'Alt+Space', showOnAllDisplays: false });
    const merged = await withClientSettings(await readSettings());

    expect(merged.quickChat.shortcut).toBe('Alt+Space');
    expect(merged.quickChat.showOnAllDisplays).toBe(false);
    // …without disturbing the server's half of the same block.
    expect(merged.quickChat.defaultEffort).toBe('medium');
    expect(merged.releaseNotes).toEqual({ showOnUpdate: true, lastSeenVersion: null });
  });

  it('survives a re-pairing — a new credential is not a reason to forget a hotkey', async () => {
    await updateClientQuickChat({ shortcut: 'Alt+Space' });
    await writeClientIdentity({ deviceId: 'dev-9', token: 'z'.repeat(64) }, 'https://stem.example.com');

    expect(storedClient().serverUrl).toBe('https://stem.example.com');
    expect((await readClientSettings()).quickChat.shortcut).toBe('Alt+Space');
  });
});

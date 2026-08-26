import { readFile } from 'node:fs/promises';
import { host } from '../server/host';
import { settingsStorePath } from '../server/workspace/paths';
import { readClientDocument, updateClientDocument } from './client-store';
import type {
  AppSettings,
  ClientQuickChatSettings,
  ClientSettings,
  QuickChatSettings,
  ReleaseNotesSettings,
  ServerSettings,
  ThemeSettings,
  UpdatesSettings
} from '../shared/types';

// The settings seam. settings.json is Stem's; client.json holds the handful of
// fields that describe THIS machine (see ClientSettings in shared/types.ts), and
// this file is the only place that knows there are two documents.
//
// Nothing above it does. The renderer still calls `getSettings()` and gets one
// whole AppSettings back; it still calls `updateQuickChat({ shortcut })` and gets
// one whole AppSettings back. The split is applied on the way past, in the proxy's
// wrapped-channel table (src/desktop/proxy.ts) — which is where it has to be,
// because EVERY `settings:*` channel answers with the entire document and a
// merge that covered only `settings:get` would let the next toggle the user
// flipped quietly reset their hotkey in the UI.
//
// Existing installs are handled by a one-time migration rather than a defaulting
// rule: the fields are read out of settings.json the first time this machine
// looks for them, and the server sheds them from that file on its next write.
// Ordering is what makes that safe — desktop/index.ts reads the client settings
// before it starts a server, so the copy is always taken before the shedding.

const DEFAULTS: ClientSettings = {
  quickChat: {
    // Unset until the user records one in Settings.
    shortcut: null,
    showOnAllDisplays: true,
    // Show the progress pill for main-window threads when the main window loses
    // focus (switch Spaces/apps), so an active thread stays visible.
    followAcrossSpaces: true
  },
  // "What's new" popup: on, with nothing recorded as seen yet. A null marker
  // means "show the version you are running, once" — which is right for an
  // install upgrading into this, and wrong for one that has never been set up,
  // so startup seeds it in that case (see seedReleaseNotesMarker).
  releaseNotes: { showOnUpdate: true, lastSeenVersion: null },
  // Looking for new releases: on. The check is a version comparison, not an
  // install — nothing changes on disk without the user acting on it.
  updates: { checkAutomatically: true },
  // Follow the OS appearance until the user picks otherwise (see desktop/themes.ts).
  theme: { selected: 'system' }
};

/** A stored theme choice, or the default for anything unrecognizable. */
function coerceThemeSelected(value: unknown): string {
  if (value === 'system' || value === 'light' || value === 'dark') return value;
  // A custom theme is named by its file's base name; refuse anything that could
  // walk out of the themes folder.
  if (typeof value === 'string' && /^custom:[^/\\]+$/.test(value) && !value.includes('..')) return value;
  return DEFAULTS.theme.selected;
}

/** Same contract as the server's `coerce`: anything unreadable takes the default. */
function coerceClientSettings(raw: Partial<ClientSettings> | undefined): ClientSettings {
  const qc = (raw?.quickChat ?? {}) as Partial<ClientQuickChatSettings>;
  const rn = (raw?.releaseNotes ?? {}) as Partial<ReleaseNotesSettings>;
  const up = (raw?.updates ?? {}) as Partial<UpdatesSettings>;
  const d = DEFAULTS;
  return {
    quickChat: {
      shortcut: typeof qc.shortcut === 'string' && qc.shortcut.trim() ? qc.shortcut : null,
      showOnAllDisplays:
        typeof qc.showOnAllDisplays === 'boolean' ? qc.showOnAllDisplays : d.quickChat.showOnAllDisplays,
      followAcrossSpaces:
        typeof qc.followAcrossSpaces === 'boolean' ? qc.followAcrossSpaces : d.quickChat.followAcrossSpaces
    },
    releaseNotes: {
      showOnUpdate:
        typeof rn.showOnUpdate === 'boolean' ? rn.showOnUpdate : d.releaseNotes.showOnUpdate,
      // Only a dotted-numeric version is a usable marker; anything else (a hand
      // edit, an old tag string) reads as "nothing recorded".
      lastSeenVersion:
        typeof rn.lastSeenVersion === 'string' && /^\d+(\.\d+)*$/.test(rn.lastSeenVersion.trim())
          ? rn.lastSeenVersion.trim()
          : null
    },
    updates: {
      checkAutomatically:
        typeof up.checkAutomatically === 'boolean' ? up.checkAutomatically : d.updates.checkAutomatically
    },
    theme: { selected: coerceThemeSelected((raw?.theme as Partial<ThemeSettings> | undefined)?.selected) }
  };
}

/**
 * What an install that predates the split has: these fields still sitting in
 * settings.json. Reading the server's own file from the client is exactly the
 * thing Phase 1 got rid of, and it is right here for the one case where it is
 * still true — a settings.json in OUR state root was written by a server sharing
 * OUR disk. A genuinely remote client has no such file and migrates from nothing,
 * which is correct: it has never had a hotkey, and what it has already been shown
 * of the release notes is decided at startup instead (see desktop/index.ts).
 */
async function legacyClientSettings(): Promise<Partial<ClientSettings>> {
  try {
    const raw = JSON.parse(await readFile(settingsStorePath(), 'utf8')) as Partial<ClientSettings>;
    return { quickChat: raw?.quickChat, releaseNotes: raw?.releaseNotes };
  } catch {
    return {};
  }
}

/**
 * The block as it stands, running the one-time migration if it has not yet.
 * Every writer below goes through this rather than reading `doc.settings`
 * directly, so a toggle flipped before the first read cannot skip the migration.
 */
async function migrated(doc: { settings?: ClientSettings }): Promise<ClientSettings> {
  return coerceClientSettings(doc.settings ?? (await legacyClientSettings()));
}

/** This machine's settings, migrating them out of settings.json on first use. */
export async function readClientSettings(): Promise<ClientSettings> {
  const doc = await readClientDocument();
  if (doc.settings) return coerceClientSettings(doc.settings);
  // Serialized with every other writer of client.json, which is what makes the
  // migration happen once: a second caller that queued behind the first finds
  // the block already there and keeps it.
  return updateClientDocument(async (d) => {
    d.settings = await migrated(d);
    return d.settings;
  });
}

/** Persist the machine-owned half of a Quick Chat patch; returns the new state. */
export function updateClientQuickChat(patch: Partial<QuickChatSettings>): Promise<ClientSettings> {
  return updateClientDocument(async (doc) => {
    const cur = await migrated(doc);
    // Only the three keys this side owns; the rest of the patch went to the server.
    const mine: Partial<ClientQuickChatSettings> = {};
    if ('shortcut' in patch) mine.shortcut = patch.shortcut ?? null;
    if ('showOnAllDisplays' in patch) mine.showOnAllDisplays = patch.showOnAllDisplays;
    if ('followAcrossSpaces' in patch) mine.followAcrossSpaces = patch.followAcrossSpaces;
    doc.settings = coerceClientSettings({ ...cur, quickChat: { ...cur.quickChat, ...mine } });
    return doc.settings;
  });
}

/** Patch the "what's new" preference or its seen-marker; returns the new state. */
export function updateClientReleaseNotes(patch: Partial<ReleaseNotesSettings>): Promise<ClientSettings> {
  return updateClientDocument(async (doc) => {
    const cur = await migrated(doc);
    doc.settings = coerceClientSettings({ ...cur, releaseNotes: { ...cur.releaseNotes, ...patch } });
    return doc.settings;
  });
}

/** Change which theme this machine renders with; returns the new state. */
export function updateClientTheme(patch: Partial<ThemeSettings>): Promise<ClientSettings> {
  return updateClientDocument(async (doc) => {
    const cur = await migrated(doc);
    doc.settings = coerceClientSettings({ ...cur, theme: { ...cur.theme, ...patch } });
    return doc.settings;
  });
}

/** Turn the automatic release check on or off; returns the new state. */
export function updateClientUpdates(patch: Partial<UpdatesSettings>): Promise<ClientSettings> {
  return updateClientDocument(async (doc) => {
    const cur = await migrated(doc);
    doc.settings = coerceClientSettings({ ...cur, updates: { ...cur.updates, ...patch } });
    return doc.settings;
  });
}

/**
 * Point the "what's new" marker at the running version unless something is
 * already recorded — so a brand-new user isn't greeted by notes for releases
 * they were never on.
 *
 * markOnboardingCompleted did this on the server until Phase 2, and it belongs
 * here now because the version it records is the version installed on THIS
 * machine. It is called at startup for an install that has not been set up yet
 * rather than when the wizard finishes, because the wizard is not the only way
 * onboarding completes — auth adopted from an existing ~/.pi counts it done
 * without anybody clicking anything, and that path used to be covered by hooking
 * the write and no longer can be.
 */
export function seedReleaseNotesMarker(): Promise<void> {
  return updateClientDocument(async (doc) => {
    const cur = await migrated(doc);
    doc.settings = cur.releaseNotes.lastSeenVersion
      ? cur
      : { ...cur, releaseNotes: { ...cur.releaseNotes, lastSeenVersion: host().appVersion() } };
  });
}

/** The two halves as the renderer expects to see them: one settings document. */
export function mergeSettings(server: ServerSettings, client: ClientSettings): AppSettings {
  return {
    ...server,
    quickChat: { ...server.quickChat, ...client.quickChat },
    releaseNotes: client.releaseNotes,
    updates: client.updates,
    theme: client.theme
  };
}

/** Merge this machine's half into whatever the server just answered with. */
export async function withClientSettings(server: unknown): Promise<AppSettings> {
  return mergeSettings(server as ServerSettings, await readClientSettings());
}

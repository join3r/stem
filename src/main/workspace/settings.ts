import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { AppSettings, QuickChatSettings } from '../../shared/types';
import { settingsStorePath } from './paths';

// Stem-owned app settings. Like the chat store, kept deliberately tiny and
// resilient — a corrupt/missing file degrades to defaults rather than breaking
// startup. The defaults match the product spec: medium effort, Fast speed, and
// the overlay floating across all displays; the shortcut is unset until the
// user records one in Settings.

const DEFAULTS: AppSettings = {
  quickChat: {
    shortcut: null,
    defaultModel: null,
    defaultEffort: 'medium',
    defaultServiceTier: 'priority',
    showOnAllDisplays: true,
    // After 5 minutes idle, re-summoning the overlay starts a fresh thread.
    newThreadTimeoutMs: 5 * 60_000
  }
};

function coerce(parsed: Partial<AppSettings> | null): AppSettings {
  const qc = (parsed?.quickChat ?? {}) as Partial<QuickChatSettings>;
  const d = DEFAULTS.quickChat;
  return {
    quickChat: {
      shortcut: typeof qc.shortcut === 'string' && qc.shortcut.trim() ? qc.shortcut : null,
      defaultModel: typeof qc.defaultModel === 'string' && qc.defaultModel.trim() ? qc.defaultModel : null,
      defaultEffort: typeof qc.defaultEffort === 'string' ? qc.defaultEffort : d.defaultEffort,
      // 'priority' (Fast) or explicit null (Standard); anything else → default.
      defaultServiceTier:
        qc.defaultServiceTier === 'priority' ? 'priority' : qc.defaultServiceTier === null ? null : d.defaultServiceTier,
      showOnAllDisplays: typeof qc.showOnAllDisplays === 'boolean' ? qc.showOnAllDisplays : d.showOnAllDisplays,
      newThreadTimeoutMs:
        typeof qc.newThreadTimeoutMs === 'number' && qc.newThreadTimeoutMs >= 0
          ? qc.newThreadTimeoutMs
          : d.newThreadTimeoutMs
    }
  };
}

export async function readSettings(): Promise<AppSettings> {
  try {
    return coerce(JSON.parse(await readFile(settingsStorePath(), 'utf8')) as Partial<AppSettings>);
  } catch {
    return coerce(null);
  }
}

// Serialize writes through a promise chain (see chats.ts) so concurrent IPC
// can't interleave a read-modify-write and lose updates.
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeSettings(settings: AppSettings): Promise<void> {
  const path = settingsStorePath();
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8');
  await rename(tmp, path);
}

/** Patch the Quick Chat settings and persist atomically; returns the full settings. */
export function updateQuickChat(patch: Partial<QuickChatSettings>): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({ quickChat: { ...cur.quickChat, ...patch } });
    await writeSettings(next);
    return next;
  });
}

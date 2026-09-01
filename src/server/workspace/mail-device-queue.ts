import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { degrade } from '../degrade';
import { mailDeviceQueuePath } from './paths';

// Mail waiting for a computer: conversations whose delivery was held because
// the target persona's coding work is pinned to a paired device that was not
// reachable. One entry per conversation — the flush re-derives WHAT to deliver
// from the mail store (the latest user item, exactly like boot redelivery), so
// the entry only records that a wait exists and which device ends it.
// Persisted so a server restart cannot silently drop the wait; the router
// (mail/router.ts) is the only reader and writer.

export interface MailDeviceQueueEntry {
  conversationId: string;
  personaId: string;
  /** Resolved device id (never a label — labels can be renamed mid-wait). */
  deviceId: string;
  deviceLabel: string;
  queuedAt: string;
}

interface QueueStore {
  version: 1;
  entries: MailDeviceQueueEntry[];
}

function coerce(raw: unknown): MailDeviceQueueEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<MailDeviceQueueEntry>;
  for (const key of ['conversationId', 'personaId', 'deviceId'] as const) {
    if (typeof r[key] !== 'string' || !r[key]) return null;
  }
  return {
    conversationId: r.conversationId!,
    personaId: r.personaId!,
    deviceId: r.deviceId!,
    deviceLabel: typeof r.deviceLabel === 'string' ? r.deviceLabel : r.deviceId!,
    queuedAt: typeof r.queuedAt === 'string' && r.queuedAt ? r.queuedAt : new Date().toISOString()
  };
}

async function loadEntries(): Promise<MailDeviceQueueEntry[]> {
  const parsed = JSON.parse(await readFile(mailDeviceQueuePath(), 'utf8')) as Partial<QueueStore>;
  return Array.isArray(parsed.entries)
    ? parsed.entries.map(coerce).filter((e): e is MailDeviceQueueEntry => !!e)
    : [];
}

async function readEntries(): Promise<MailDeviceQueueEntry[]> {
  try {
    return await loadEntries();
  } catch (error) {
    // Absent is the common case; unreadable costs only the waits it recorded,
    // and boot redelivery still covers a wait whose conversation the user has
    // not been answered in.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('mail', 'forgot which mail was waiting for a computer', error);
    }
    return [];
  }
}

// Single writer: serialize read-modify-writes (mirrors harness/sessions.ts).
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeEntries(entries: MailDeviceQueueEntry[]): Promise<void> {
  const path = mailDeviceQueuePath();
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, entries } satisfies QueueStore, null, 2), 'utf8');
  await rename(tmp, path); // atomic on the same volume
}

/** Record a wait (upsert by conversation — a newer send replaces the older wait). */
export function queueMailForDevice(entry: Omit<MailDeviceQueueEntry, 'queuedAt'>): Promise<void> {
  return enqueue(async () => {
    const entries = await readEntries();
    const next = entries.filter((e) => e.conversationId !== entry.conversationId);
    next.push({ ...entry, queuedAt: new Date().toISOString() });
    await writeEntries(next);
  });
}

/** The conversations currently waiting for some device — boot redelivery skips these. */
export async function queuedMailConversationIds(): Promise<Set<string>> {
  return new Set((await readEntries()).map((e) => e.conversationId));
}

/** Every device some mail is waiting for, for the boot sweep. */
export async function queuedMailDeviceIds(): Promise<string[]> {
  return [...new Set((await readEntries()).map((e) => e.deviceId))];
}

/** Remove and return this device's waits — the flush delivers what it can. */
export function takeQueuedMailForDevice(deviceId: string): Promise<MailDeviceQueueEntry[]> {
  return enqueue(async () => {
    const entries = await readEntries();
    const taken = entries.filter((e) => e.deviceId === deviceId);
    if (taken.length) await writeEntries(entries.filter((e) => e.deviceId !== deviceId));
    return taken;
  });
}

/** Drop one conversation's wait (the user stopped it, or it delivered normally). */
export function dropQueuedMail(conversationId: string): Promise<boolean> {
  return enqueue(async () => {
    const entries = await readEntries();
    const next = entries.filter((e) => e.conversationId !== conversationId);
    if (next.length === entries.length) return false;
    await writeEntries(next);
    return true;
  });
}

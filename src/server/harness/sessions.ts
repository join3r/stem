import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { degrade } from '../degrade';
import { harnessSessionsStorePath } from '../workspace/paths';

// The (thread, host, agent, cwd) -> harness sessionId mapping
// (harness-sessions.json), which is what makes a repeated coding_agent call
// continue one conversation. Deliberately a CACHE of each host's own session
// store rather than a second truth: when a host lost its session (state
// wiped, device re-paired), the fresh id from the next ensure overwrites the
// record here, and a mapping that fails to read degrades to "no session yet",
// which just means the next call starts a fresh conversation.

export interface HarnessSessionEntry {
  threadId: string;
  /** 'server' for local runs, otherwise the hosting device's id. */
  host: string;
  agent: string;
  cwd: string;
  sessionId: string;
  updatedAt: string;
}

interface SessionsStore {
  version: 1;
  sessions: HarnessSessionEntry[];
}

function sameKey(a: HarnessSessionEntry, b: Pick<HarnessSessionEntry, 'threadId' | 'host' | 'agent' | 'cwd'>): boolean {
  return a.threadId === b.threadId && a.host === b.host && a.agent === b.agent && a.cwd === b.cwd;
}

function coerce(raw: unknown): HarnessSessionEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<HarnessSessionEntry>;
  for (const key of ['threadId', 'host', 'agent', 'cwd', 'sessionId'] as const) {
    if (typeof r[key] !== 'string' || !r[key]) return null;
  }
  return {
    threadId: r.threadId!,
    host: r.host!,
    agent: r.agent!,
    cwd: r.cwd!,
    sessionId: r.sessionId!,
    updatedAt: typeof r.updatedAt === 'string' && r.updatedAt ? r.updatedAt : new Date().toISOString()
  };
}

async function loadSessions(): Promise<HarnessSessionEntry[]> {
  const parsed = JSON.parse(await readFile(harnessSessionsStorePath(), 'utf8')) as Partial<SessionsStore>;
  return Array.isArray(parsed.sessions)
    ? parsed.sessions.map(coerce).filter((s): s is HarnessSessionEntry => !!s)
    : [];
}

async function readSessions(): Promise<HarnessSessionEntry[]> {
  try {
    return await loadSessions();
  } catch (error) {
    // Absent is a fresh install; unreadable costs only session continuity.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('harness', 'forgot which coding-agent sessions belong to which chats', error);
    }
    return [];
  }
}

// Single writer: serialize read-modify-writes (mirrors workspace/tasks.ts).
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeSessions(sessions: HarnessSessionEntry[]): Promise<void> {
  const path = harnessSessionsStorePath();
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, sessions } satisfies SessionsStore, null, 2), 'utf8');
  await rename(tmp, path); // atomic on the same volume
}

/** The remembered sessionId for this exact (thread, host, agent, cwd), or null. */
export async function lookupSession(
  key: Pick<HarnessSessionEntry, 'threadId' | 'host' | 'agent' | 'cwd'>
): Promise<string | null> {
  const sessions = await readSessions();
  return sessions.find((s) => sameKey(s, key))?.sessionId ?? null;
}

/** Upsert the mapping after a successful ensure (the host's answer wins). */
export function rememberSession(entry: Omit<HarnessSessionEntry, 'updatedAt'>): Promise<void> {
  return enqueue(async () => {
    const sessions = await readSessions();
    const next = sessions.filter((s) => !sameKey(s, entry));
    next.unshift({ ...entry, updatedAt: new Date().toISOString() });
    await writeSessions(next);
  });
}

/** Drop one mapping (fresh_session, or a host that refused the remembered id). */
export function forgetSession(
  key: Pick<HarnessSessionEntry, 'threadId' | 'host' | 'agent' | 'cwd'>
): Promise<void> {
  return enqueue(async () => {
    const sessions = await readSessions();
    await writeSessions(sessions.filter((s) => !sameKey(s, key)));
  });
}

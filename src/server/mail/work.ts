import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChatBackend } from '../backend/types';
import type { BackendEventEnvelope, MailWorkActivity, MailWorkGroup, MailWorkRun } from '../../shared/types';
import { workDetail } from '../../shared/work-detail';
import { mailStorePath } from '../workspace/paths';
import { degrade } from '../degrade';

const root = () => process.env.STEM_MAIL_WORK_DIR ?? join(dirname(mailStorePath()), 'mail-work');
const key = (id: string) => createHash('sha256').update(id).digest('hex');
const folder = (id: string) => join(root(), key(id));
const pathFor = (g: MailWorkGroup) => join(folder(g.conversationId), `${key(g.id)}.json`);
const active = new Map<string, WorkHandle>();
const groups = new Map<string, MailWorkGroup>();
const writes = new Map<string, Promise<boolean>>();
const deleted = new Set<string>();
const listeners = new Set<(value: { conversationId: string }) => void>();
export function onMailWorkChanged(fn: (value: { conversationId: string }) => void): () => void {
  listeners.add(fn); return () => listeners.delete(fn);
}
function changed(group: MailWorkGroup) {
  if (group.conversationId) for (const fn of listeners) fn({ conversationId: group.conversationId });
}
function persist(group: MailWorkGroup): Promise<boolean> {
  if (deleted.has(`${root()}:${group.conversationId}`)) return Promise.resolve(true);
  const path = pathFor(group);
  const data = JSON.stringify(group);
  const next = (writes.get(path) ?? Promise.resolve()).then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, path);
    return true;
  }).catch((e) => {
    const gap = 'Some work history could not be saved. Details may be lost after a restart.';
    if (!group.gaps?.includes(gap)) (group.gaps ??= []).push(gap);
    degrade('mail.work', 'could not preserve work history', e);
    return false;
  });
  writes.set(path, next);
  void next.finally(() => { if (writes.get(path) === next) writes.delete(path); });
  return next;
}

export interface WorkHandle {
  group: MailWorkGroup;
  run: MailWorkRun;
  bindThread(id: string): void;
  activity(value: MailWorkActivity): void;
  finish(status: MailWorkRun['status'], error?: string): Promise<void>;
}

/** Attach before startTurn: even a synchronous failure must leave a work record. */
export async function beginMailWork(runtime: ChatBackend, input: {
  conversationId?: string; sourceItemId?: string; groupId?: string;
  personaId: string; turnId: string; threadId?: string;
}): Promise<WorkHandle> {
  if (input.conversationId && deleted.has(`${root()}:${input.conversationId}`)) throw new Error('This mail conversation was deleted.');
  const id = input.groupId ?? input.sourceItemId ?? input.turnId;
  const cacheKey = `${input.conversationId ?? ''}:${id}`;
  let group = groups.get(cacheKey);
  if (!group) {
    const empty: MailWorkGroup = { id, conversationId: input.conversationId ?? '', sourceItemId: input.sourceItemId, runs: [] };
    try {
      group = JSON.parse(await readFile(pathFor(empty), 'utf8')) as MailWorkGroup;
      if (group.id !== id || group.conversationId !== empty.conversationId || !Array.isArray(group.runs)) throw new Error('Invalid work record');
    } catch (error) {
      group = empty;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        group.gaps = ['Earlier work records could not be read.'];
        degrade('mail.work', 'started a run without its earlier work records', error);
      }
    }
    // Another parallel delivery may have loaded while this one awaited disk.
    group = groups.get(cacheKey) ?? group;
    groups.set(cacheKey, group);
  }
  if (input.conversationId && deleted.has(`${root()}:${input.conversationId}`)) {
    groups.delete(cacheKey);
    throw new Error('This mail conversation was deleted.');
  }
  const g = group;
  const run: MailWorkRun = { id: input.turnId, turnId: input.turnId, personaId: input.personaId,
    threadId: input.threadId, startedAt: Date.now(), status: 'running', activities: [] };
  g.runs.push(run);
  let timer: NodeJS.Timeout | undefined;
  let finished = false;
  let progress = '';
  let progressIndex = 0;
  const flush = () => { timer = undefined; void persist(g).then(() => changed(g)); };
  const schedule = () => { if (!timer) { timer = setTimeout(flush, 200); timer.unref?.(); } };
  const commitProgress = () => {
    if (!progress.trim()) return;
    const id = `progress:${run.id}:${progressIndex}`;
    const at = run.activities.find((a) => a.id === id)?.at ?? Date.now();
    handle.activity({ id, kind: 'progress', label: 'Progress', at, endedAt: Date.now(), status: 'ok', output: progress });
    progress = ''; progressIndex++;
  };
  const onEvent = (event: BackendEventEnvelope) => {
    const p = event.params as { turnId?: string; threadId?: string; turn?: { id?: string }; item?: Record<string, unknown>; delta?: string; activity?: MailWorkActivity; error?: string } | undefined;
    const turn = p?.turnId ?? p?.turn?.id;
    if (turn ? turn !== run.turnId : !p?.threadId || p.threadId !== run.threadId) return;
    if (p?.threadId) run.threadId = p.threadId;
    if (event.method === 'item/agentMessage/delta' && typeof p?.delta === 'string') {
      if (progress.length < 24_000) progress = (progress + p.delta).slice(0, 24_000);
      else if (!progress.endsWith('[Output truncated]')) progress += '\n[Output truncated]';
      const existing = run.activities.find((a) => a.id === `progress:${run.id}:${progressIndex}`);
      handle.activity({ id: `progress:${run.id}:${progressIndex}`, kind: 'progress', label: 'Progress', at: existing?.at ?? Date.now(), status: 'running', output: progress });
    } else if (event.method === 'mail/work/activity' && p?.activity) {
      commitProgress(); handle.activity(p.activity);
    } else if ((event.method === 'item/started' || event.method === 'item/completed') && p?.item) {
      const item = p.item;
      if (item.type === 'reasoning' || item.type === 'agentMessage' || typeof item.id !== 'string') return;
      commitProgress();
      const old = run.activities.find((a) => a.id === item.id);
      const done = event.method === 'item/completed';
      handle.activity({ ...old, id: item.id, kind: 'tool', label: String(item.detail ?? item.name ?? item.type ?? 'Tool'),
        at: old?.at ?? Date.now(), ...(done ? { endedAt: Date.now() } : {}), status: done ? item.status === 'error' ? 'error' : 'ok' : 'running' });
    }
  };
  const handle: WorkHandle = {
    group: g, run,
    bindThread: (threadId) => { run.threadId = threadId; schedule(); },
    activity: (value) => {
      if (finished) return;
      const sanitized = { ...value, label: workDetail(value.label, 500),
        ...(value.input !== undefined ? { input: workDetail(value.input) } : {}),
        ...(value.output !== undefined ? { output: workDetail(value.output) } : {}) };
      const idx = run.activities.findIndex((a) => a.id === value.id);
      const retained = run.activities.reduce((sum, a, i) => sum + (i === idx ? 0 : (a.input?.length ?? 0) + (a.output?.length ?? 0)), 0);
      if (retained + (sanitized.input?.length ?? 0) + (sanitized.output?.length ?? 0) > 4_000_000) {
        if (sanitized.input !== undefined) sanitized.input = '[Input omitted: work detail retention limit reached]';
        if (sanitized.output !== undefined) sanitized.output = '[Output omitted: work detail retention limit reached]';
        const gap = 'This run reached its detail retention limit; some inputs and outputs were omitted.';
        if (!g.gaps?.includes(gap)) (g.gaps ??= []).push(gap);
      }
      if (idx < 0 && run.activities.length >= 2000) {
        const gap = 'This run exceeded 2,000 activity entries; later details were not retained.';
        if (!g.gaps?.includes(gap)) (g.gaps ??= []).push(gap);
        schedule(); return;
      }
      if (idx >= 0) run.activities[idx] = { ...run.activities[idx], ...sanitized };
      else run.activities.push(sanitized);
      schedule();
    },
    finish: async (status, error) => {
      if (finished) return;
      if (status === 'ok' && progress.trim()) {
        // The last text block is the reply; earlier blocks were committed before tools.
        run.activities = run.activities.filter((a) => a.id !== `progress:${run.id}:${progressIndex}`);
      } else commitProgress();
      finished = true;
      runtime.off('event', onEvent);
      if (timer) clearTimeout(timer);
      run.status = status; run.endedAt = Date.now();
      if (error) run.error = workDetail(error);
      for (const a of run.activities) if (a.status === 'running') {
        a.status = a.kind === 'tool' || status !== 'ok' ? 'error' : 'ok'; a.endedAt = run.endedAt;
        if (a.kind === 'tool') a.output = (a.output ? `${a.output}\n` : '') + '[No completed tool result was recorded]';
      }
      const saved = await persist(g);
      active.delete(run.id);
      changed(g);
      if (saved && !g.runs.some((r) => active.has(r.id))) {
        for (const [k, value] of groups) if (value === g) groups.delete(k);
        if (!g.conversationId) await rm(pathFor(g), { force: true });
      }
    }
  };
  active.set(run.id, handle);
  runtime.on('event', onEvent);
  await persist(g); changed(g);
  return handle;
}

/** A notify_user can happen mid-run; moving the group keeps subsequent events attached. */
export async function attachScheduledWork(threadId: string, conversationId: string, itemId: string, personaId: string): Promise<void> {
  const handle = [...active.values()].find((h) => !h.group.sourceItemId && h.run.threadId === threadId);
  if (!handle) return;
  const oldPath = pathFor(handle.group);
  for (const [k, value] of groups) if (value === handle.group) groups.delete(k);
  handle.group.conversationId = conversationId;
  groups.set(`${conversationId}:${handle.group.id}`, handle.group);
  handle.group.notificationItemId ??= itemId;
  handle.group.notificationItemIds = [...new Set([...(handle.group.notificationItemIds ?? []), itemId])];
  handle.run.personaId = personaId;
  await persist(handle.group);
  await writes.get(oldPath);
  if (oldPath !== pathFor(handle.group)) await rm(oldPath, { force: true });
  changed(handle.group);
}

export function recordInnerWork(threadId: string, activity: MailWorkActivity): void {
  for (const h of active.values()) if (h.run.threadId === threadId) h.activity(activity);
}

export async function readRecordedWork(conversationId: string): Promise<MailWorkGroup[]> {
  await Promise.all(writes.values());
  // A failed final save keeps the actual outcome in memory. Retry on read;
  // never mislabel an old on-disk running snapshot as a server restart.
  for (const [cacheKey, g] of groups) if (g.conversationId === conversationId && !g.runs.some((r) => active.has(r.id))) {
    if (await persist(g)) groups.delete(cacheKey);
  }
  let names: string[];
  try { names = await readdir(folder(conversationId)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') names = []; else throw e; }
  const result: MailWorkGroup[] = [];
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const group = JSON.parse(await readFile(join(folder(conversationId), name), 'utf8')) as MailWorkGroup;
      if (group.conversationId !== conversationId || !Array.isArray(group.runs)) continue;
      for (const run of group.runs) if (run.status === 'running' && !active.has(run.id)) {
        run.status = 'failed'; run.error = 'The server stopped before this run recorded its outcome.';
        for (const a of run.activities) if (a.status === 'running') a.status = 'error';
      }
      result.push(group);
    } catch (e) {
      result.push({ id: `unreadable:${name}`, conversationId, runs: [], gaps: ['Part of the saved work history is unreadable.'] });
      degrade('mail.work', 'could not read part of the work history', e);
    }
  }
  for (const g of groups.values()) if (g.conversationId === conversationId) {
    const i = result.findIndex((value) => value.id === g.id);
    const snapshot = structuredClone(g);
    if (i >= 0) result[i] = snapshot; else result.push(snapshot);
  }
  return result.sort((a,b) => (a.runs[0]?.startedAt ?? 0) - (b.runs[0]?.startedAt ?? 0));
}

export async function deleteRecordedWork(conversationId: string): Promise<void> {
  deleted.add(`${root()}:${conversationId}`);
  for (const h of active.values()) if (h.group.conversationId === conversationId) await h.finish('aborted', 'Conversation deleted');
  await Promise.all(writes.values());
  for (const [k, g] of groups) if (g.conversationId === conversationId) groups.delete(k);
  await rm(folder(conversationId), { recursive: true, force: true });
}

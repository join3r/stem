import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatBackend } from '../../src/server/backend/types';
import type { MailWorkGroup } from '../../src/shared/types';
import {
  attachScheduledWork, beginMailWork, deleteRecordedWork, onMailWorkChanged,
  readRecordedWork, recordInnerWork, type WorkHandle
} from '../../src/server/mail/work';
import {
  appendMailItem, createConversation, deleteConversation, onMailChanged,
  onMailReceived, readMail, setMailRead
} from '../../src/server/workspace/mail';

let directory: string;
let emitter: EventEmitter;
let handles: WorkHandle[];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const storedPath = (conversationId: string, groupId: string) => join(directory, hash(conversationId), `${hash(groupId)}.json`);
const begin = async (input: Parameters<typeof beginMailWork>[1]) => {
  const handle = await beginMailWork(emitter as unknown as ChatBackend, input);
  handles.push(handle);
  return handle;
};
const event = (method: string, params: Record<string, unknown>) => emitter.emit('event', { method, params });

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stem-mail-work-test-'));
  vi.stubEnv('STEM_MAIL_WORK_DIR', directory);
  emitter = new EventEmitter();
  handles = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(handles.map((handle) => handle.finish('aborted')));
  await readRecordedWork('cleanup'); // Drain any queued writes before removing the temporary root.
  emitter.removeAllListeners();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('persistent mail work recorder', () => {
  it('keeps simultaneous persona deliveries in one source group through interleaved writes', async () => {
    const [lead, delegate] = await Promise.all([
      begin({ conversationId: 'conversation', sourceItemId: 'request', personaId: 'lead', turnId: 'lead-turn' }),
      begin({ conversationId: 'conversation', sourceItemId: 'request', personaId: 'coder', turnId: 'coder-turn' })
    ]);
    lead.activity({ id: 'consult', kind: 'tool', label: 'Consult coder', at: 1, status: 'ok', output: 'Build requested' });
    delegate.activity({ id: 'build', kind: 'tool', label: 'Build', at: 2, status: 'running', input: 'build app' });
    await Promise.all([lead.finish('ok'), delegate.finish('failed', 'Build failed')]);
    const [group] = await readRecordedWork('conversation');
    expect(group.runs).toHaveLength(2);
    expect(group.runs.find((run) => run.id === 'lead-turn')?.activities[0].output).toBe('Build requested');
    expect(group.runs.find((run) => run.id === 'coder-turn')).toMatchObject({ status: 'failed', activities: [{ input: 'build app', status: 'error' }] });
    const disk = JSON.parse(await readFile(storedPath('conversation', 'request'), 'utf8')) as MailWorkGroup;
    expect(disk.runs).toHaveLength(2);
    expect(disk.runs.every((run) => run.status !== 'running')).toBe(true);
  });

  it('persists live tool evidence without a mail event, unread change, or user notification', async () => {
    const conversation = await createConversation('Fictional build', ['normal']);
    await appendMailItem({ conversationId: conversation.id, from: 'normal', to: ['user'], body: 'Ready' });
    await setMailRead([conversation.id], true);
    const baseline = await readMail();
    const mailChanged = vi.fn();
    const received = vi.fn();
    const workChanged = vi.fn();
    const off = [onMailChanged(mailChanged), onMailReceived(received), onMailWorkChanged(workChanged)];
    try {
      const run = await begin({ conversationId: conversation.id, sourceItemId: 'request', personaId: 'normal', turnId: 'live-turn' });
      event('mail/work/activity', { turnId: 'live-turn', activity: { id: 'tool', kind: 'tool', label: 'Run build', at: 1, status: 'running', input: 'xcodebuild archive' } });
      event('mail/work/activity', { turnId: 'live-turn', activity: { id: 'tool', kind: 'tool', label: 'Run build', at: 1, status: 'ok', endedAt: 2, output: 'Archive saved' } });
      await vi.waitFor(async () => {
        const group = JSON.parse(await readFile(storedPath(conversation.id, 'request'), 'utf8')) as MailWorkGroup;
        expect(group.runs[0].activities[0]).toMatchObject({ input: 'xcodebuild archive', output: 'Archive saved', status: 'ok' });
      });
      expect(run.run.status).toBe('running');
      expect(workChanged).toHaveBeenCalledWith({ conversationId: conversation.id });
      expect(mailChanged).not.toHaveBeenCalled();
      expect(received).not.toHaveBeenCalled();
      expect(await readMail()).toEqual(baseline);
    } finally {
      off.forEach((unsubscribe) => unsubscribe());
      await deleteConversation(conversation.id);
    }
  });

  it.each(['failed', 'aborted'] as const)('retains partial progress when a run is %s', async (status) => {
    const run = await begin({ conversationId: 'conversation', sourceItemId: 'request', personaId: 'normal', turnId: 'partial-turn' });
    event('item/agentMessage/delta', { turnId: 'partial-turn', delta: 'Build passed; ' });
    event('item/agentMessage/delta', { turnId: 'partial-turn', delta: 'upload pending.' });
    await run.finish(status, 'Run ended before upload');
    const [group] = await readRecordedWork('conversation');
    expect(group.runs[0]).toMatchObject({ status, error: 'Run ended before upload', activities: [{ kind: 'progress', output: 'Build passed; upload pending.' }] });
    expect(group.runs[0].endedAt).toBeDefined();
    expect(emitter.listenerCount('event')).toBe(0);
  });

  it('keeps commentary before tools while leaving the successful final answer to the reply mail', async () => {
    const run = await begin({ conversationId: 'conversation', sourceItemId: 'request', personaId: 'normal', turnId: 'reply-turn' });
    event('item/agentMessage/delta', { turnId: 'reply-turn', delta: 'I am checking the archive.' });
    event('mail/work/activity', { turnId: 'reply-turn', activity: { id: 'check', kind: 'tool', label: 'Check archive', at: 1, status: 'ok', output: 'Archive valid' } });
    event('item/agentMessage/delta', { turnId: 'reply-turn', delta: 'Your archive is ready.' });
    await run.finish('ok');
    const [group] = await readRecordedWork('conversation');
    expect(group.runs[0].activities.map((activity) => activity.output)).toEqual(['I am checking the archive.', 'Archive valid']);
  });

  it('captures early events by turn ID before a thread is bound and omits reasoning', async () => {
    const run = await begin({ conversationId: 'conversation', sourceItemId: 'request', personaId: 'normal', turnId: 'early-turn' });
    event('item/started', { turnId: 'different-turn', item: { id: 'wrong', type: 'commandExecution', detail: 'Wrong turn' } });
    event('item/started', { turnId: 'early-turn', item: { id: 'thought', type: 'reasoning', detail: 'Private thought' } });
    event('item/reasoning/textDelta', { turnId: 'early-turn', delta: 'Private thought' });
    event('item/started', { turnId: 'early-turn', item: { id: 'early-tool', type: 'commandExecution', detail: 'Read project' } });
    run.bindThread('bound-thread');
    recordInnerWork('other-thread', { id: 'unrelated', kind: 'tool', label: 'Unrelated', at: 1, status: 'ok' });
    recordInnerWork('bound-thread', { id: 'inner', parentId: 'early-tool', kind: 'tool', label: 'Coding agent build', at: 2, status: 'ok', output: 'Build passed' });
    await run.finish('ok');
    const [group] = await readRecordedWork('conversation');
    expect(group.runs[0].threadId).toBe('bound-thread');
    expect(group.runs[0].activities.map((activity) => activity.id)).toEqual(['early-tool', 'inner']);
    expect(JSON.stringify(group)).not.toContain('Private thought');
  });

  it('marks an orphaned running record failed after restart while retaining its partial evidence', async () => {
    const group: MailWorkGroup = { id: 'request', conversationId: 'conversation', sourceItemId: 'request', runs: [
      { id: 'orphan', personaId: 'normal', startedAt: 1, status: 'running', activities: [
        { id: 'upload', kind: 'tool', label: 'Upload', at: 2, status: 'running', output: 'Archive prepared' }
      ] }
    ] };
    await mkdir(join(directory, hash('conversation')), { recursive: true });
    await writeFile(storedPath('conversation', 'request'), JSON.stringify(group));
    const [recovered] = await readRecordedWork('conversation');
    expect(recovered.runs[0]).toMatchObject({ status: 'failed', activities: [{ status: 'error', output: 'Archive prepared' }] });
    expect(recovered.runs[0].error).toContain('server stopped');
  });

  it('rekeys a scheduled run before delegation so later writes retain both personas', async () => {
    const scheduled = await begin({ personaId: 'schedule', turnId: 'scheduled-turn', threadId: 'schedule-thread' });
    scheduled.activity({ id: 'lookup', kind: 'tool', label: 'Look up news', at: 1, status: 'ok', output: 'Found article' });
    await attachScheduledWork('schedule-thread', 'conversation', 'notification', 'normal');
    const delegate = await begin({ conversationId: 'conversation', groupId: 'scheduled-turn', personaId: 'researcher', turnId: 'delegate-turn' });
    expect(delegate.group).toBe(scheduled.group);
    delegate.activity({ id: 'verify', kind: 'tool', label: 'Verify source', at: 2, status: 'ok', output: 'Verified' });
    scheduled.activity({ id: 'summarize', kind: 'tool', label: 'Summarize', at: 3, status: 'ok', output: 'Summary ready' });
    await Promise.all([scheduled.finish('ok'), delegate.finish('ok')]);
    const [group] = await readRecordedWork('conversation');
    expect(group.notificationItemId).toBe('notification');
    expect(group.runs).toHaveLength(2);
    expect(group.runs[0].activities.map((activity) => activity.id)).toEqual(['lookup', 'summarize']);
    expect(group.runs[1].activities[0].output).toBe('Verified');
    expect(await readRecordedWork('')).toEqual([]);
  });

  it('deletes active work without a delayed flush or late event resurrecting it', async () => {
    const run = await begin({ conversationId: 'conversation', sourceItemId: 'request', personaId: 'normal', turnId: 'deleted-turn' });
    vi.useFakeTimers();
    run.activity({ id: 'pending', kind: 'tool', label: 'Pending write', at: 1, status: 'running' });
    await deleteRecordedWork('conversation');
    event('item/agentMessage/delta', { turnId: 'deleted-turn', delta: 'Late result' });
    run.activity({ id: 'late', kind: 'progress', label: 'Late', at: 2, status: 'ok' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.run.status).toBe('aborted');
    expect(emitter.listenerCount('event')).toBe(0);
    expect(await readRecordedWork('conversation')).toEqual([]);
    expect(await readdir(directory)).not.toContain(hash('conversation'));
  });

  it('does not resurrect work when deletion races its initial disk read', async () => {
    const starting = begin({ conversationId: 'conversation', sourceItemId: 'request', personaId: 'normal', turnId: 'starting-turn' });
    const rejected = expect(starting).rejects.toThrow();
    await deleteRecordedWork('conversation');
    await rejected;
    expect(await readRecordedWork('conversation')).toEqual([]);
    expect(emitter.listenerCount('event')).toBe(0);
  });
});

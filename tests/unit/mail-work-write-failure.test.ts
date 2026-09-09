import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatBackend } from '../../src/server/backend/types';
import type { MailWorkGroup } from '../../src/shared/types';
import { beginMailWork, deleteRecordedWork, readRecordedWork, type WorkHandle } from '../../src/server/mail/work';

const disk = vi.hoisted(() => ({ fail: false, attempts: 0 }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (String(args[0]).endsWith('.json.tmp')) {
        disk.attempts++;
        if (disk.fail) throw Object.assign(new Error('Simulated full disk'), { code: 'ENOSPC' });
      }
      return actual.writeFile(...args);
    }
  };
});

let directory: string;
let runtime: EventEmitter;
let handles: WorkHandle[];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const path = () => join(directory, hash('conversation'), `${hash('request')}.json`);
const begin = async () => {
  const handle = await beginMailWork(runtime as unknown as ChatBackend, {
    conversationId: 'conversation', sourceItemId: 'request', personaId: 'normal', turnId: 'turn'
  });
  handles.push(handle);
  return handle;
};
const readDisk = async () => JSON.parse(await readFile(path(), 'utf8')) as MailWorkGroup;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'stem-mail-work-disk-failure-'));
  vi.stubEnv('STEM_MAIL_WORK_DIR', directory);
  disk.fail = false;
  disk.attempts = 0;
  runtime = new EventEmitter();
  handles = [];
});

afterEach(async () => {
  disk.fail = false;
  await Promise.all(handles.map((handle) => handle.finish('aborted')));
  await deleteRecordedWork('conversation');
  runtime.removeAllListeners();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('mail work write failure recovery', () => {
  it.each(['ok', 'failed'] as const)('keeps the actual %s outcome and evidence when the final save fails', async (status) => {
    const handle = await begin();
    expect((await readDisk()).runs[0].status).toBe('running');
    handle.activity({ id: 'archive', kind: 'tool', label: 'Build archive', at: 1, endedAt: 2, status: 'ok', output: 'Archive saved: /tmp/Fictional.xcarchive' });
    disk.fail = true;
    await handle.finish(status, status === 'failed' ? 'Upload connection closed' : undefined);

    // Disk still contains the initial running snapshot, but the current process
    // knows the outcome. It must not misreport a restart or discard its evidence.
    expect((await readDisk()).runs[0].status).toBe('running');
    const [retained] = await readRecordedWork('conversation');
    expect(retained.runs[0].status).toBe(status);
    expect(retained.runs[0].endedAt).toBeDefined();
    expect(retained.runs[0].activities[0].output).toBe('Archive saved: /tmp/Fictional.xcarchive');
    expect(retained.runs[0].error).toBe(status === 'failed' ? 'Upload connection closed' : undefined);
    expect(retained.gaps?.join(' ')).toContain('could not be saved');
    expect(runtime.listenerCount('event')).toBe(0);
  });

  it('retries the retained completed snapshot on a later read once writes recover', async () => {
    const handle = await begin();
    handle.activity({ id: 'build', kind: 'tool', label: 'Build', at: 1, status: 'ok', output: 'Build passed' });
    disk.fail = true;
    await handle.finish('failed', 'Upload was interrupted');
    const [failedSave] = await readRecordedWork('conversation');
    expect(failedSave.runs[0].error).toBe('Upload was interrupted');
    const attempts = disk.attempts;

    disk.fail = false;
    const [recovered] = await readRecordedWork('conversation');
    expect(disk.attempts).toBeGreaterThan(attempts);
    expect(recovered.runs[0]).toMatchObject({ status: 'failed', error: 'Upload was interrupted', activities: [{ output: 'Build passed' }] });
    expect((await readDisk()).runs[0]).toEqual(recovered.runs[0]);

    // Subsequent reads use the durable final state and do not retry forever.
    const afterRecovery = disk.attempts;
    expect((await readRecordedWork('conversation'))[0].runs[0]).toEqual(recovered.runs[0]);
    expect(disk.attempts).toBe(afterRecovery);
  });

  it('deletes retained failed-save state without resurrecting it when storage recovers', async () => {
    const handle = await begin();
    disk.fail = true;
    await handle.finish('aborted', 'Stopped by user');
    expect((await readRecordedWork('conversation'))[0].runs[0].status).toBe('aborted');
    await deleteRecordedWork('conversation');
    disk.fail = false;
    const attempts = disk.attempts;
    expect(await readRecordedWork('conversation')).toEqual([]);
    expect(disk.attempts).toBe(attempts);
    expect(await readdir(directory)).not.toContain(hash('conversation'));
    expect(runtime.listenerCount('event')).toBe(0);
  });
});

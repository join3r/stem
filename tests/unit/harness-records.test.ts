// The harness run log and session mapping — the REAL files at the throwaway
// STEM_STATE_DIR from tests/setup-unit.ts. Covers the clean-slate baseline,
// start/settle round-trips, corrupt-file degradation, the newest-first cap,
// and the session mapping's cache semantics (overwrite on re-ensure, forget).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  readHarnessRuns,
  recordRunStart,
  settleRun,
  type HarnessRunRecord
} from '../../src/server/harness/records';
import { forgetSession, lookupSession, rememberSession } from '../../src/server/harness/sessions';
import { harnessRunsPath, harnessSessionsStorePath } from '../../src/server/workspace/paths';

const runsPath = harnessRunsPath();
const sessionsPath = harnessSessionsStorePath();

beforeEach(() => {
  mkdirSync(dirname(runsPath), { recursive: true });
  rmSync(runsPath, { force: true });
  rmSync(sessionsPath, { force: true });
});
afterEach(() => {
  rmSync(runsPath, { force: true });
  rmSync(sessionsPath, { force: true });
});

function run(overrides: Partial<HarnessRunRecord> = {}): HarnessRunRecord {
  return {
    runId: 'run-1',
    threadId: 'thread-1',
    agent: 'claude',
    cwd: '/tmp/project',
    sessionId: 'session-1',
    startedAt: new Date().toISOString(),
    status: 'running',
    ...overrides
  };
}

describe('run log', () => {
  it('answers empty for a missing file and for a corrupt one', async () => {
    expect(await readHarnessRuns()).toEqual([]);
    writeFileSync(runsPath, '{ not json', 'utf8');
    expect(await readHarnessRuns()).toEqual([]);
  });

  it('records a start and settles it with the outcome', async () => {
    await recordRunStart(run());
    await settleRun('run-1', { status: 'ok', costUsd: 0.42, usage: { totalTokens: 1234 } });
    const [settled] = await readHarnessRuns();
    expect(settled).toMatchObject({ runId: 'run-1', status: 'ok', costUsd: 0.42, usage: { totalTokens: 1234 } });
    expect(settled.settledAt).toBeTruthy();
    expect(JSON.parse(readFileSync(runsPath, 'utf8')).version).toBe(1);
  });

  it('keeps newest first and drops malformed entries on read', async () => {
    await recordRunStart(run({ runId: 'older' }));
    await recordRunStart(run({ runId: 'newer' }));
    writeFileSync(
      runsPath,
      JSON.stringify({
        version: 1,
        runs: [...JSON.parse(readFileSync(runsPath, 'utf8')).runs, { runId: 'husk' }, 7]
      }),
      'utf8'
    );
    const runs = await readHarnessRuns();
    expect(runs.map((r) => r.runId)).toEqual(['newer', 'older']);
  });

  it('settling an unknown runId is a no-op', async () => {
    await recordRunStart(run());
    await settleRun('nobody', { status: 'failed', error: 'boom' });
    expect((await readHarnessRuns())[0].status).toBe('running');
  });

  it('a settle can also correct the sessionId the ensure answered later', async () => {
    await recordRunStart(run());
    await settleRun('run-1', { status: 'cancelled', sessionId: 'session-2' });
    expect((await readHarnessRuns())[0].sessionId).toBe('session-2');
  });
});

describe('session mapping', () => {
  const key = { threadId: 'thread-1', host: 'server', agent: 'claude', cwd: '/tmp/project' };

  it('answers null before anything is remembered, and for a corrupt file', async () => {
    expect(await lookupSession(key)).toBeNull();
    writeFileSync(sessionsPath, '{ not json', 'utf8');
    expect(await lookupSession(key)).toBeNull();
  });

  it('remembers per (thread, host, agent, cwd) and overwrites on re-ensure', async () => {
    await rememberSession({ ...key, sessionId: 'session-1' });
    await rememberSession({ ...key, agent: 'opencode', sessionId: 'session-oc' });
    await rememberSession({ ...key, host: 'device-9', sessionId: 'session-dev' });
    expect(await lookupSession(key)).toBe('session-1');
    expect(await lookupSession({ ...key, agent: 'opencode' })).toBe('session-oc');
    expect(await lookupSession({ ...key, host: 'device-9' })).toBe('session-dev');
    // The host's truth wins: a fresh id from the next ensure replaces the record.
    await rememberSession({ ...key, sessionId: 'session-replacement' });
    expect(await lookupSession(key)).toBe('session-replacement');
    const stored = JSON.parse(readFileSync(sessionsPath, 'utf8'));
    expect(stored.sessions.filter((s: { agent: string }) => s.agent === 'claude')).toHaveLength(2);
  });

  it('forgets one mapping without touching its neighbours', async () => {
    await rememberSession({ ...key, sessionId: 'session-1' });
    await rememberSession({ ...key, cwd: '/tmp/other', sessionId: 'session-other' });
    await forgetSession(key);
    expect(await lookupSession(key)).toBeNull();
    expect(await lookupSession({ ...key, cwd: '/tmp/other' })).toBe('session-other');
  });

  it('concurrent remembers serialize instead of clobbering', async () => {
    await Promise.all([
      rememberSession({ ...key, sessionId: 'a' }),
      rememberSession({ ...key, cwd: '/tmp/b', sessionId: 'b' }),
      rememberSession({ ...key, cwd: '/tmp/c', sessionId: 'c' })
    ]);
    expect(await lookupSession({ ...key, cwd: '/tmp/b' })).toBe('b');
    expect(await lookupSession({ ...key, cwd: '/tmp/c' })).toBe('c');
    expect(await lookupSession(key)).toBe('a');
  });
});

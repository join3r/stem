import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HarnessActivityRecorder, readHarnessActivities, pruneHarnessActivities, type HarnessActivity } from '../../src/server/harness/activities';
import { recordRunStart, settleRun } from '../../src/server/harness/records';
import { harnessRunsPath } from '../../src/server/workspace/paths';

const context = { threadId: 'thread-1', runId: 'run-1', agent: 'claude', itemId: 'outer-tool-1' };
const dir = `${harnessRunsPath()}.activities`;
beforeEach(async () => {
  await mkdir(dirname(harnessRunsPath()), { recursive: true });
  await rm(harnessRunsPath(), { force: true });
  await rm(dir, { recursive: true, force: true });
  await recordRunStart({ ...context, cwd: '/tmp/project', sessionId: 'session-1', startedAt: new Date().toISOString(), status: 'running' });
});
afterEach(async () => {
  await rm(harnessRunsPath(), { force: true });
  await rm(dir, { recursive: true, force: true });
});

describe('coding-agent work history', () => {
  it('persists actual inner inputs/results and progress before delivery, excluding thoughts and credentials', async () => {
    const delivered: HarnessActivity[] = [];
    const recorder = new HarnessActivityRecorder(context, (row) => delivered.push(row));
    recorder.note({ type: 'text_delta', stream: 'thought', text: 'private reasoning' });
    recorder.note({ type: 'text_delta', tag: 'agent_thought_chunk', text: 'more private reasoning' });
    recorder.note({ type: 'tool_call', toolCallId: 'thinking', kind: 'think', rawInput: 'private reasoning' });
    recorder.note({ type: 'tool_call', toolCallId: 'thinking', status: 'completed', rawOutput: 'private reasoning' });
    recorder.note({ type: 'text_delta', stream: 'output', text: 'Checking ' });
    recorder.note({ type: 'text_delta', stream: 'output', text: 'the build.' });
    recorder.note({ type: 'tool_call', toolCallId: 'build', title: 'Run build', rawInput: { command: 'npm run build', apiKey: 'secret-key' } });
    await recorder.flush();
    let rows = await readHarnessActivities({ threadId: context.threadId, itemId: context.itemId });
    expect(rows).toHaveLength(2);
    expect(rows[0].output).toBe('Checking the build.');
    expect(rows[1]).toMatchObject({ id: 'run-1:tool:build', status: 'running' });
    expect(rows[1].input).toContain('npm run build');
    expect(rows[1].input).toContain('[redacted]');
    expect(delivered).toEqual(rows);
    recorder.note({ type: 'tool_call', toolCallId: 'build', title: 'Terminal', status: 'completed', rawOutput: { stdout: 'Build passed', authorization: 'Bearer abc123' } });
    await recorder.finish('failed', 'Device disconnected');
    await settleRun(context.runId, { status: 'failed' });
    rows = await readHarnessActivities({ runId: context.runId });
    expect(rows[1]).toMatchObject({ title: 'Run build', status: 'completed' });
    expect(rows[1].output).toContain('Build passed');
    expect(rows[2]).toMatchObject({ title: 'Run failed', output: 'Device disconnected' });
    const stored = await readFile(join(dir, (await readdir(dir))[0]), 'utf8');
    expect(stored).not.toMatch(/private reasoning|secret-key|abc123/);
    expect(await readHarnessActivities({ itemId: 'wrong' })).toEqual([]);
    expect(await readHarnessActivities({ threadId: 'wrong' })).toEqual([]);
  });

  it('keeps incomplete actions and marks cancellation without fabricating a result', async () => {
    const recorder = new HarnessActivityRecorder(context);
    recorder.note({ type: 'tool_call', toolCallId: 'upload', title: 'Upload', rawInput: { command: 'upload' } });
    recorder.note({ type: 'tool_call', toolCallId: 'upload', rawOutput: 'Uploading 40%' });
    await recorder.finish('cancelled', 'Stop requested');
    const rows = await readHarnessActivities({ runId: context.runId });
    expect(rows[0]).toMatchObject({ status: 'cancelled', output: 'Uploading 40%' });
    expect(rows[1]).toMatchObject({ status: 'cancelled', output: 'Stop requested' });
  });

  it('bounds long runs, explicitly records retained-history gaps, and prunes evicted runs', async () => {
    const recorder = new HarnessActivityRecorder(context);
    for (let index = 0; index < 300; index += 1) recorder.note({
      type: 'tool_call', toolCallId: `tool-${index}`, title: `Tool ${index}`, status: 'completed', rawOutput: 'x'.repeat(9_000)
    });
    await recorder.finish('ok');
    const rows = await readHarnessActivities({ runId: context.runId });
    expect(rows.length).toBeLessThanOrEqual(251);
    expect(rows[0]).toMatchObject({ kind: 'gap', truncated: true });
    expect(rows.at(-1)).toMatchObject({ title: 'Tool 299', truncated: true });
    expect(rows.at(-1)?.output).toContain('[Output truncated]');
    const snapshot = await readFile(join(dir, (await readdir(dir))[0]), 'utf8');
    expect(Buffer.byteLength(snapshot)).toBeLessThan(1_050_000);
    await rm(harnessRunsPath(), { force: true });
    await pruneHarnessActivities();
    expect(await readdir(dir)).toEqual([]);
  });
});

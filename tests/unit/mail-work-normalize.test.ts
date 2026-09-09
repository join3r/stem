import { describe, expect, it } from 'vitest';
import { newTurnContext, normalizePiEvent } from '../../src/server/pi/normalize';
import type { PiEvent } from '../../src/server/pi/rpc';
import type { MailWorkActivity } from '../../src/shared/types';

const event = (value: Record<string, unknown>) => value as PiEvent;
const row = (events: ReturnType<typeof normalizePiEvent>['events']) =>
  (events.find((e) => e.method === 'mail/work/activity')?.params as { activity: MailWorkActivity } | undefined)?.activity;

describe('mail action events', () => {
  it('preserves full tool targets and partial output before a failed result', () => {
    const ctx = newTurnContext('thread', 'turn'); ctx.isMail = true;
    const start = row(normalizePiEvent(event({ type: 'tool_execution_start', toolCallId: 'build', toolName: 'run_command',
      toolInput: { command: 'xcodebuild archive', cwd: '/fictional/project', env: { ACCESS_TOKEN: 'secret-value' } } }), ctx).events)!;
    expect(start.input).toContain('/fictional/project');
    expect(start.input).not.toContain('secret-value');
    expect(start.status).toBe('running');
    const update = row(normalizePiEvent(event({ type: 'tool_execution_update', toolCallId: 'build',
      partialResult: { content: [{ type: 'text', text: 'Compiled 12 files' }] } }), ctx).events)!;
    expect(update.output).toBe('Compiled 12 files');
    expect(update.status).toBe('running');
    const end = row(normalizePiEvent(event({ type: 'tool_execution_end', toolCallId: 'build', isError: true,
      result: { content: [{ type: 'text', text: 'Signing failed' }] } }), ctx).events)!;
    expect(end.output).toBe('Signing failed'); expect(end.status).toBe('error');
    expect(end.at).toBe(start.at); expect(end.endedAt).toBeGreaterThanOrEqual(start.at);
  });

  it('records scheduled actions but keeps work payloads out of ordinary interactive streams', () => {
    const call = event({ type: 'tool_execution_start', toolCallId: 'search', toolName: 'search', toolInput: { query: 'news' } });
    const ctx = newTurnContext('thread', 'turn');
    expect(row(normalizePiEvent(call, ctx).events)).toBeUndefined();
    const scheduled = newTurnContext('thread', 'scheduled'); scheduled.isScheduled = true;
    expect(row(normalizePiEvent(call, scheduled).events)?.input).toContain('news');
  });
});

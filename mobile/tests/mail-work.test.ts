import { describe, expect, it } from 'vitest';
import type { MailItem, MailWorkGroup } from '@shared/types';
import { partitionMailWork, workDuration, workTimestamp } from '../src/mail/work';

const item = (id: string, from = 'user'): MailItem => ({
  id, conversationId: 'mail', from, to: ['normal'], body: 'Example', at: 100
});
const group = (id: string, sourceItemId?: string, notificationItemId?: string): MailWorkGroup => ({
  id, conversationId: 'mail', sourceItemId, notificationItemId, runs: []
});

describe('mail work placement', () => {
  it('keeps follow-up requests separate and renders a group only once', () => {
    const initial = group('first', 'question', 'reply');
    const followup = group('second', 'followup');
    const result = partitionMailWork([initial, followup], [item('question'), item('reply', 'normal'), item('followup')]);
    expect([...result.byItem.keys()]).toEqual(['question', 'followup']);
    expect(result.byItem.get('question')).toEqual([initial]);
    expect(result.byItem.get('followup')).toEqual([followup]);
    expect(result.unanchored).toEqual([]);
  });

  it('attaches scheduled work to the specific notification that it produced', () => {
    const first = group('scheduled-one', undefined, 'news-one');
    const second = group('scheduled-two', 'hidden-task-source', 'news-two');
    const result = partitionMailWork([first, second], [item('news-one', 'normal'), item('news-two', 'normal')]);
    expect(result.byItem.get('news-one')).toEqual([first]);
    expect(result.byItem.get('news-two')).toEqual([second]);
    expect(result.unanchored).toEqual([]);
  });

  it('retains unlinked history and its gaps without guessing a request from nearby mail', () => {
    const old = { ...group('old', 'missing'), historical: true, gaps: ['Original mail is unavailable.'] };
    const pending = group('scheduled-running');
    const result = partitionMailWork([old, pending], [item('unrelated')]);
    expect(result.byItem.size).toBe(0);
    expect(result.unanchored).toEqual([old, pending]);
  });
});

describe('mail work elapsed time', () => {
  it('shows long jobs in minutes and hours and tolerates clock differences', () => {
    expect(workDuration(1000, 1000 + 30 * 60 * 1000)).toBe('30m 0s');
    expect(workDuration(1000, 1000 + 65 * 60 * 1000)).toBe('1h 5m');
    expect(workDuration(2000, 1000)).toBe('0s');
  });

  it.each([0, -1, undefined, NaN, Infinity, -Infinity, 1e30])('marks missing or invalid historical timestamp %s unavailable', (at) => {
    const known = Date.parse('2026-09-07T10:00:00Z');
    expect(workTimestamp(at)).toBe('Time unavailable');
    expect(workTimestamp(at, true)).toBe('Time unavailable');
    expect(workDuration(at, known)).toBe('Duration unavailable');
    expect(workDuration(known, at)).toBe('Duration unavailable');
  });

  it('formats valid recorded times without replacing them with the current time', () => {
    const at = Date.parse('2026-09-07T10:00:00Z');
    expect(workTimestamp(at)).toBe(new Date(at).toLocaleString());
    expect(workTimestamp(at, true)).toBe(new Date(at).toLocaleTimeString());
  });
});

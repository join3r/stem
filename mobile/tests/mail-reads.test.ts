import { describe, expect, it, vi } from 'vitest';
import type { MailListResult } from '@shared/types';
import { createMailReadTracker } from '../src/mail/reads';

const now = 1_800_000_000_000;
function mail({ forcedUnread = false, readAt = 0, activity = now } = {}): MailListResult {
  return {
    conversations: [{ id: 'm', subject: 'Fictional mail', participants: ['normal'], sessions: {}, status: 'idle', exchangeCount: 0, sendCounts: {}, createdAt: now - 100, updatedAt: activity, userUpdatedAt: activity, userSentAt: now - 100 }],
    items: [], inbox: { baseline: 0, entries: { m: { readAt, ...(forcedUnread ? { forcedUnread: true } : {}) } } }
  };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('mail read synchronization', () => {
  it('opening acknowledges existing forced unread once after the first load', async () => {
    const mark = vi.fn(async () => undefined);
    const tracker = createMailReadTracker(mark);
    tracker.focus('m');
    tracker.update({ conversations: [], items: [], inbox: { baseline: 0, entries: {} } }, true);
    expect(mark).not.toHaveBeenCalled();
    tracker.update(mail({ forcedUnread: true }), true);
    tracker.update(mail({ forcedUnread: true }), true);
    await settle();
    expect(mark).toHaveBeenCalledExactlyOnceWith('m');
  });

  it('preserves a Mac mark-unread push while the same conversation stays open', async () => {
    const mark = vi.fn(async () => undefined);
    const tracker = createMailReadTracker(mark);
    tracker.focus('m');
    tracker.update(mail({ readAt: now }), true);
    tracker.update(mail({ forcedUnread: true, readAt: now }), true);
    tracker.update(mail({ forcedUnread: true, readAt: now, activity: now + 100 }), true);
    expect(mark).not.toHaveBeenCalled();
    tracker.blur();
    tracker.focus('m');
    tracker.update(mail({ forcedUnread: true }), true);
    await settle();
    expect(mark).toHaveBeenCalledExactlyOnceWith('m');
  });

  it('does not undo the local Mark unread before navigation has completed', () => {
    const mark = vi.fn(async () => undefined);
    const tracker = createMailReadTracker(mark);
    tracker.focus('m');
    tracker.update(mail({ readAt: now }), true);
    tracker.preserveUnread();
    tracker.update(mail({ forcedUnread: true }), true);
    tracker.update(mail({ activity: now + 100 }), true);
    expect(mark).not.toHaveBeenCalled();
  });

  it('only acknowledges new replies when both app and conversation are visible', async () => {
    const mark = vi.fn(async () => undefined);
    const tracker = createMailReadTracker(mark);
    tracker.focus('m');
    tracker.update(mail({ readAt: now }), true);
    tracker.update(mail({ activity: now + 100 }), false);
    expect(mark).not.toHaveBeenCalled();
    tracker.update(mail({ activity: now + 100 }), true);
    await settle();
    expect(mark).toHaveBeenCalledTimes(1);
    tracker.blur();
    tracker.update(mail({ activity: now + 200 }), true);
    expect(mark).toHaveBeenCalledTimes(1);
  });

  it('retries a failed opening acknowledgement on refresh without duplicate in-flight writes', async () => {
    let reject!: (error: Error) => void;
    const mark = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const tracker = createMailReadTracker(mark);
    tracker.focus('m');
    tracker.update(mail({ forcedUnread: true }), true);
    tracker.update(mail({ forcedUnread: true }), true);
    expect(mark).toHaveBeenCalledTimes(1);
    reject(new Error('Disconnected'));
    await settle();
    tracker.update(mail({ forcedUnread: true }), true);
    expect(mark).toHaveBeenCalledTimes(2);
  });
});

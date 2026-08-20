import { describe, expect, it } from 'vitest';
import {
  forgetQuickChatThread,
  isQuickChatThread,
  noteTurnSurface
} from '../../src/server/quickchat-threads';

// The skip-Inbox archiver keys off this set (see server/index.ts): a thread is
// auto-archived only while its latest turn came from the Quick Chat overlay.

describe('quick-chat thread tracking', () => {
  it('tracks a thread while its latest turn is a Quick Chat turn', () => {
    noteTurnSurface('t1', true);
    expect(isQuickChatThread('t1')).toBe(true);
    expect(isQuickChatThread('t2')).toBe(false);
  });

  it('reclassifies on a main-window turn — the user picked the conversation up', () => {
    noteTurnSurface('t1', true);
    noteTurnSurface('t1', false);
    expect(isQuickChatThread('t1')).toBe(false);
  });

  it('forgets on an explicit un-archive, so a turn settling after a hand-off cannot re-bury the thread', () => {
    noteTurnSurface('t1', true);
    forgetQuickChatThread('t1');
    expect(isQuickChatThread('t1')).toBe(false);
    // ...until the user quick-chats in it again.
    noteTurnSurface('t1', true);
    expect(isQuickChatThread('t1')).toBe(true);
    forgetQuickChatThread('t1');
  });
});

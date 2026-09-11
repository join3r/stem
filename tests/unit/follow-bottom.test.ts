import { describe, expect, it } from 'vitest';
import {
  FOLLOW_THRESHOLD_PX,
  INITIAL_FOLLOW,
  distanceFromBottom,
  onScrollEvent,
  type FollowState
} from '../../src/renderer/chat/followBottom';

// A 10-screen transcript in a 600px-tall scroller.
const scroller = (scrollTop: number) => ({ scrollTop, scrollHeight: 6000, clientHeight: 600 });
const BOTTOM = 6000 - 600;
// ChatView's first paint jumps to the bottom, which is the first scroll event
// the state ever sees.
const atBottom = () => onScrollEvent(INITIAL_FOLLOW, scroller(BOTTOM));

describe('chat scroller follow-the-bottom (issue #16)', () => {
  it('starts following, and stays pinned while the reader sits at the bottom', () => {
    expect(INITIAL_FOLLOW.following).toBe(true);
    const s = onScrollEvent(INITIAL_FOLLOW, scroller(BOTTOM));
    expect(s.following).toBe(true);
    expect(distanceFromBottom(scroller(BOTTOM))).toBe(0);
  });

  it('releases the follow when the reader scrolls up into the history', () => {
    let s: FollowState = atBottom();
    s = onScrollEvent(s, scroller(2400));
    expect(s.following).toBe(false);
    // A refresh that swaps the message list (window focus) fires no scroll event,
    // so the state — and the reader's place — is untouched.
    expect(onScrollEvent(s, scroller(2400))).toBe(s);
  });

  it('re-engages once the reader scrolls back down to within the threshold', () => {
    let s: FollowState = onScrollEvent(atBottom(), scroller(2400));
    expect(s.following).toBe(false);
    s = onScrollEvent(s, scroller(BOTTOM - FOLLOW_THRESHOLD_PX));
    expect(s.following).toBe(true);
  });

  it('scrolling down without reaching the bottom keeps the follow released', () => {
    let s: FollowState = onScrollEvent(atBottom(), scroller(2400));
    s = onScrollEvent(s, scroller(3000));
    expect(s.following).toBe(false);
  });

  it('our own smooth scroll toward the bottom never unpins a following reader', () => {
    // scrollIntoView({behavior:'smooth'}) fires a series of downward scroll events
    // that pass through positions far from the bottom on the way there.
    let s: FollowState = onScrollEvent(INITIAL_FOLLOW, scroller(1000));
    expect(s.following).toBe(true);
    for (const top of [1500, 2500, 4000, BOTTOM]) {
      s = onScrollEvent(s, scroller(top));
      expect(s.following).toBe(true);
    }
  });

  it('a hop from the bottom straight up (new content with the reader at the bottom then wheel) releases', () => {
    let s: FollowState = atBottom();
    s = onScrollEvent(s, scroller(BOTTOM - FOLLOW_THRESHOLD_PX - 1));
    expect(s.following).toBe(false);
  });
});

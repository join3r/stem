/**
 * "Follow the bottom" state for the chat scroller.
 *
 * The transcript auto-scrolls to the newest message only while the reader is
 * already at (or near) the bottom. Scrolling up releases the follow; scrolling
 * back down to the bottom re-engages it. Anything that changes the message list
 * without the reader asking for it — a history refresh when the window regains
 * focus, a scheduled run landing, another device's message — must not yank a
 * reader out of the older part of a long chat (issue #16).
 */

/** How close to the bottom (px) still counts as "at the bottom". */
export const FOLLOW_THRESHOLD_PX = 80;

export interface FollowState {
  /** Auto-scroll on new content? */
  following: boolean;
  /** scrollTop at the last scroll event, to tell an upward scroll from a downward one. */
  lastTop: number;
}

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export const INITIAL_FOLLOW: FollowState = { following: true, lastTop: 0 };

export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight);
}

/**
 * Fold one scroll event into the follow state.
 *
 * Only an *upward* scroll releases the follow. Programmatic scrolls toward the
 * bottom (our own scrollIntoView, smooth or not) only ever increase scrollTop,
 * so a streaming update landing mid-animation cannot unpin the reader; and
 * content growing under a reader who sits at the bottom fires no scroll event
 * at all, so it cannot either.
 */
export function onScrollEvent(prev: FollowState, m: ScrollMetrics): FollowState {
  const nearBottom = distanceFromBottom(m) <= FOLLOW_THRESHOLD_PX;
  const scrolledUp = m.scrollTop < prev.lastTop;
  let following = prev.following;
  if (nearBottom) following = true;
  else if (scrolledUp) following = false;
  return following === prev.following && m.scrollTop === prev.lastTop ? prev : { following, lastTop: m.scrollTop };
}

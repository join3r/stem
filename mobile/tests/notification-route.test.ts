// Where a tapped notification lands, decided without a router.
//
// The payload cases here are not hypothetical: expo-notifications puts
// `content.data = userInfo["body"]` for remote notifications, and Stem's APNs
// payload is `{aps, stem}` with no `body` key — so on a real push the routing
// data is on `trigger.payload` and `content.data` is empty. Getting that wrong
// means every notification opens the app and then does nothing, which is exactly
// the bug that is invisible in a simulator.

import { describe, expect, it } from 'vitest';
import { readWakeUp, routeForNotification, routeForWakeUp } from '../src/notifications/route';

/** What iOS hands the tap handler for a push the server sent. */
function response(stem: Record<string, unknown>): unknown {
  return {
    actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
    notification: {
      request: {
        identifier: '1',
        content: { title: 'Approval needed', body: 'A command is waiting.', data: null },
        trigger: {
          type: 'push',
          payload: {
            aps: { alert: { title: 'Approval needed', body: 'A command is waiting.' } },
            stem
          }
        }
      }
    }
  };
}

describe('finding the payload', () => {
  it('reads it off the push trigger, where a real APNs payload actually is', () => {
    expect(readWakeUp(response({ kind: 'turn', threadId: 't1', failed: false }))).toEqual({
      kind: 'turn',
      threadId: 't1',
      failed: false
    });
  });

  it('reads it off content.data too, in case the payload ever grows a body wrapper', () => {
    const wrapped = {
      notification: {
        request: { content: { data: { stem: { kind: 'task', taskId: 'k1', threadId: 't2' } } }, trigger: {} }
      }
    };
    expect(readWakeUp(wrapped)).toEqual({ kind: 'task', taskId: 'k1', threadId: 't2' });
  });

  it('accepts the bare wake-up object', () => {
    expect(readWakeUp({ kind: 'approval', approvalKind: 'exec', approvalId: '7', threadId: 't3' })).toEqual({
      kind: 'approval',
      approvalKind: 'exec',
      approvalId: '7',
      threadId: 't3'
    });
  });

  it('refuses anything that is not one of ours', () => {
    expect(readWakeUp(null)).toBeNull();
    expect(readWakeUp({})).toBeNull();
    expect(readWakeUp(response({ kind: 'something-new-from-a-later-server' }))).toBeNull();
    expect(readWakeUp({ stem: { kind: 'turn', threadId: 42 } })).toEqual({ kind: 'turn' });
  });
});

describe('routing', () => {
  it('opens the thread a turn finished in', () => {
    expect(routeForNotification(response({ kind: 'turn', threadId: 't1' }))).toEqual({
      screen: 'thread',
      threadId: 't1'
    });
  });

  it('opens the thread an approval came out of', () => {
    // Not a card: <ApprovalSheet> is mounted above the router and raises whatever
    // is pending on its own. Landing on the thread puts the user behind the
    // question rather than racing the sheet for the screen — and if the approval
    // was answered at the desk meanwhile, the conversation is the honest thing
    // to be looking at.
    expect(routeForNotification(response({ kind: 'approval', approvalKind: 'exec', approvalId: '7', threadId: 't4' })))
      .toEqual({ screen: 'thread', threadId: 't4' });
  });

  it('falls back to the chat list when a wake-up names no thread', () => {
    expect(routeForNotification(response({ kind: 'approval', approvalKind: 'mcp', approvalId: '2' }))).toEqual({
      screen: 'chats'
    });
    expect(routeForNotification(response({ kind: 'task', taskId: 'k1' }))).toEqual({ screen: 'chats' });
  });

  it('goes nowhere for anything it cannot place', () => {
    // A payload from a future server must not move somebody who is reading.
    expect(routeForWakeUp(null)).toBeNull();
    expect(routeForNotification({ hello: 'world' })).toBeNull();
    expect(routeForWakeUp({ kind: 'turn' })).toBeNull();
  });
});


describe('mail notifications', () => {
  it('opens mail rather than a hidden execution thread, including task mail', () => {
    expect(routeForNotification(response({ kind: 'mail', conversationId: 'mail-1', threadId: 'hidden', taskId: 'task-1' }))).toEqual({ screen: 'mail', conversationId: 'mail-1' });
  });
  it('ignores malformed mail destinations', () => {
    expect(routeForNotification(response({ kind: 'mail', conversationId: '' }))).toBeNull();
    expect(routeForNotification(response({ kind: 'mail', conversationId: 17 }))).toBeNull();
  });
});

// Where a tapped notification lands.
//
// The server sends a wake-up and nothing else (src/server/push/index.ts): a kind,
// the ids needed to find the thing, and at most a short label. No message text
// ever crosses APNs, so this file's only job is to turn ids into a screen — the
// real content is read back over SSE the moment the app is open, which is also
// why a route that is slightly wrong is survivable and a route that navigates
// somewhere the user did not ask for is not.
//
// WHERE THE PAYLOAD ACTUALLY IS, because it is not where you would guess.
// expo-notifications puts `content.data = userInfo["body"]` for REMOTE
// notifications (NotificationRecords.swift), and Stem's payload has no `body`
// key — it is `{aps, stem}`, hand-built for APNs rather than for Expo's push
// service. So `content.data` is empty on a real push and the whole userInfo is
// on `trigger.payload` instead. Both are read here, plus the bare object, so this
// keeps working if the payload ever grows a `body` wrapper and so a test can hand
// it the `stem` object on its own.
//
// The routing itself is small and deliberately conservative:
//
//   turn      → the thread. This is the notification that means "your answer is
//               ready", and the answer is in a thread.
//   task      → the thread it spoke in, or the list when a task alert has none.
//   approval  → the thread, if the payload names one. NOT a card: <ApprovalSheet>
//               is mounted above the router and shows whatever is pending on its
//               own, so opening the thread puts the user behind the question they
//               are about to be asked rather than racing the sheet for control of
//               the screen. If the approval was answered at the desk while the
//               phone was in a pocket, the user lands on the conversation it came
//               out of, which is the honest thing to show.
//
// Anything unrecognized routes nowhere at all. A payload from a future server, or
// a notification from something else entirely, must not move a user who was in
// the middle of reading.

/** The `stem` object from the payload, as far as this app is concerned. */
export interface WakeUp {
  kind: 'approval' | 'turn' | 'task' | 'mail';
  conversationId?: string;
  threadId?: string;
  approvalId?: string;
  taskId?: string;
  approvalKind?: string;
  failed?: boolean;
}

/** Where to go. `null` from routeForWakeUp means: stay exactly where you are. */
export type NotificationRoute =
  | { screen: 'thread'; threadId: string }
  | { screen: 'mail'; conversationId: string }
  /** The chat list — the app's root route. */
  | { screen: 'chats' };

const KINDS = new Set(['approval', 'turn', 'task', 'mail']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Find Stem's wake-up in whatever shape the OS handed over, or null. Given the
 * whole notification, one of its data bags, or the `stem` object itself.
 */
export function readWakeUp(source: unknown): WakeUp | null {
  for (const candidate of candidates(source)) {
    const stem = asRecord(candidate.stem) ?? candidate;
    const kind = asString(stem.kind);
    if (!kind || !KINDS.has(kind)) continue;
    return {
      kind: kind as WakeUp['kind'],
      ...(asString(stem.conversationId) ? { conversationId: asString(stem.conversationId) } : {}),
      ...(asString(stem.threadId) ? { threadId: asString(stem.threadId) } : {}),
      ...(asString(stem.approvalId) ? { approvalId: asString(stem.approvalId) } : {}),
      ...(asString(stem.taskId) ? { taskId: asString(stem.taskId) } : {}),
      ...(asString(stem.approvalKind) ? { approvalKind: asString(stem.approvalKind) } : {}),
      ...(typeof stem.failed === 'boolean' ? { failed: stem.failed } : {})
    };
  }
  return null;
}

/** Every place the payload could be hiding, outermost first. */
function* candidates(source: unknown): Generator<Record<string, unknown>> {
  const root = asRecord(source);
  if (!root) return;
  // A whole NotificationResponse, or a whole Notification.
  const notification = asRecord(root.notification) ?? root;
  const request = asRecord(notification.request);
  if (request) {
    const trigger = asRecord(request.trigger);
    const payload = trigger ? asRecord(trigger.payload) : null;
    if (payload) yield payload;
    const content = asRecord(request.content);
    const data = content ? asRecord(content.data) : null;
    if (data) yield data;
  }
  yield root;
}

/**
 * The screen a wake-up asks for, or null when it asks for nothing we can honour.
 * Pure, and separate from the navigating, because "which screen" is the part
 * worth being sure about and a router is the part that needs a device.
 */
export function routeForWakeUp(wake: WakeUp | null): NotificationRoute | null {
  if (!wake) return null;
  if (wake.kind === 'mail') return wake.conversationId ? { screen: 'mail', conversationId: wake.conversationId } : null;
  if (wake.threadId) return { screen: 'thread', threadId: wake.threadId };
  // A turn without a thread cannot happen (the server always sends one) and would
  // mean nothing if it did; an approval or a task without one is a wake-up whose
  // subject is somewhere in the list.
  return wake.kind === 'turn' ? null : { screen: 'chats' };
}

/** The two-step above in one call — what the tap handler uses. */
export function routeForNotification(source: unknown): NotificationRoute | null {
  return routeForWakeUp(readWakeUp(source));
}

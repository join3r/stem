import { degrade } from '../degrade';
import { log } from '../log';
import { devicesWithPushTokens, setDevicePushToken, type DeviceRecord } from '../transport/auth';
import { apnsConfigured, sendApns } from './apns';
import { isAnyDesktopPresent, PRESENCE_WINDOW_MS } from './presence';

// What Stem is allowed to wake a phone for, and what it is allowed to say when
// it does.
//
// A push here is a TAP ON THE SHOULDER and nothing else. It carries a kind, the
// id needed to deep-link to the thing, and at most a short label — a thread
// title, a task name. It never carries a message, a reply, a command line, a
// skill body, or any other text from the conversation. That is not squeamishness
// about a lock screen: a notification leaves this machine, crosses Apple's
// infrastructure and is stored on the way, so anything in it has left Stem's
// control entirely. The phone re-reads the real thing over SSE the moment it is
// opened (see the invariant comments in transport/server.ts), so there is nothing
// a fatter payload would buy beyond a nicer preview.
//
// The rest of this file is about NOT sending:
//
//   - Unconfigured is silent. No APNs key, no pushes, no work — the default for
//     every install that is not the author's phone (see apns.ts).
//   - Somebody at a desk is silent. If a machine reported real input in the last
//     few minutes, the notification would arrive on a phone in the pocket of
//     someone already looking at the answer (see presence.ts).
//   - A short turn is silent. Waking a phone for a turn that took four seconds
//     means waking it for every turn, and the user was there for that one.
//   - `inbox`-mode task notifications are silent, because that mode's whole
//     meaning is "do not interrupt me" (see startup/scheduler.ts).
//
// Everything exported is fire-and-forget by design: the callers are event
// handlers in the middle of doing something that matters more, and a
// notification that could not be sent must never become that thing's failure.

/** Which approval is waiting. Enough to phrase the alert and to route the tap. */
export type ApprovalPushKind = 'exec' | 'mcp' | 'instructions' | 'skill';

/**
 * The one shape that goes out. `kind` picks the wording and the deep link; the
 * ids are ours (a thread id, an approval id, a task id) and mean nothing to
 * anyone who does not already hold a token for this server.
 */
export interface WakeUp {
  kind: 'approval' | 'turn' | 'task';
  /** Approvals and turns: the chat to open. */
  threadId?: string;
  /** Approvals: the card to open, in the id the resolve channels take back. */
  approvalId?: string;
  /** Tasks: which scheduled task spoke. */
  taskId?: string;
  /** Approvals: which card, so the app can route without opening the thread first. */
  approvalKind?: ApprovalPushKind;
  /** Turns: whether it landed or failed. */
  failed?: boolean;
}

/**
 * A label to show, or a way to get one. The thunk form exists so that resolving
 * it — which can mean a directory scan for a thread title — happens ONLY after
 * every reason not to send has been ruled out. On the default path (no APNs
 * configuration) it is never called at all, which is what makes the whole
 * feature genuinely free when it is off.
 */
export type LabelSource = string | (() => string | null | undefined | Promise<string | null | undefined>);

/**
 * The longest label that goes out. iOS truncates a notification body long before
 * this; the cap is here so that a title which somehow grew (a pasted paragraph
 * that became a chat name) cannot turn a label into a leak of the text it came
 * from.
 */
const MAX_LABEL_CHARS = 80;

/**
 * How long a turn must have been running for its ending to be worth a
 * notification. Under this, the person who started it is still watching it — and
 * a push per turn is how a notification channel gets muted for good.
 */
export const MIN_TURN_PUSH_MS = 30_000;

/** Fixed wording per kind. Never derived from anything the model or the user wrote. */
function phrasing(wake: WakeUp): { title: string; fallback: string } {
  if (wake.kind === 'approval') {
    switch (wake.approvalKind) {
      case 'exec':
        return { title: 'Approval needed', fallback: 'A command is waiting for your decision.' };
      case 'mcp':
        return { title: 'Approval needed', fallback: 'An MCP change is waiting for your decision.' };
      case 'instructions':
        return { title: 'Approval needed', fallback: 'A change to your instructions is waiting.' };
      default:
        return { title: 'Approval needed', fallback: 'A skill is waiting for your review.' };
    }
  }
  if (wake.kind === 'turn') {
    return wake.failed
      ? { title: 'A turn stopped', fallback: 'A turn you started did not finish.' }
      : { title: 'Stem finished', fallback: 'A turn you started has finished.' };
  }
  return { title: 'Task alert', fallback: 'A scheduled task has something for you.' };
}

/** One line, trimmed, capped — or nothing, which is always a valid label. */
function tidyLabel(label: string | null | undefined): string | null {
  if (typeof label !== 'string') return null;
  const oneLine = label.replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  return oneLine.length > MAX_LABEL_CHARS ? `${oneLine.slice(0, MAX_LABEL_CHARS - 1)}…` : oneLine;
}

/**
 * The APNs body for one wake-up. Exported because it is the thing worth asserting
 * about: everything a push can possibly say is decided here, in one function, out
 * of a fixed phrase and one short label.
 */
export function wakeUpPayload(wake: WakeUp, label?: string | null): unknown {
  const { title, fallback } = phrasing(wake);
  const shown = tidyLabel(label);
  return {
    aps: {
      alert: { title, body: shown ?? fallback },
      sound: 'default',
      // Group by thread where there is one, so a chat that produces an approval
      // and then finishes does not stack two unrelated-looking rows.
      ...(wake.threadId ? { 'thread-id': wake.threadId } : {})
    },
    // Everything the app routes on. Ids only — see the header comment.
    stem: {
      kind: wake.kind,
      ...(wake.approvalKind ? { approvalKind: wake.approvalKind } : {}),
      ...(wake.threadId ? { threadId: wake.threadId } : {}),
      ...(wake.approvalId ? { approvalId: wake.approvalId } : {}),
      ...(wake.taskId ? { taskId: wake.taskId } : {}),
      ...(wake.kind === 'turn' ? { failed: !!wake.failed } : {})
    }
  };
}

async function resolveLabel(label?: LabelSource): Promise<string | null> {
  if (label === undefined) return null;
  if (typeof label === 'string') return label;
  try {
    return (await label()) ?? null;
  } catch {
    // quiet: a label is decoration; a notification without one is still a
    // notification, and it still routes on the ids beside it.
    return null;
  }
}

/**
 * Send, unless one of the reasons not to applies. The order matters only for
 * cost: the cheapest refusal is first, and nothing is read, resolved or
 * connected until every refusal has been passed.
 */
async function deliver(wake: WakeUp, label?: LabelSource): Promise<void> {
  if (!apnsConfigured()) return;
  if (isAnyDesktopPresent(PRESENCE_WINDOW_MS)) {
    // Logged rather than silent: "why did my phone not buzz" is otherwise an
    // unanswerable question, and this is the answer in almost every case.
    log('push', 'suppressed — somebody was at a machine', { kind: wake.kind });
    return;
  }
  const targets = await devicesWithPushTokens();
  if (targets.length === 0) return;
  const payload = wakeUpPayload(wake, await resolveLabel(label));
  // Once per TOKEN, not once per record. A token addresses an app install, and
  // the registry addresses pairings — one phone can hold two rows (unpair,
  // re-pair) and sending down both would buzz it twice for one event. The write
  // path keeps that from arising (see setDevicePushToken), and this makes the
  // duplicate harmless wherever it came from — a hand-edited devices.json, a
  // restored backup, a bug on either side of that write.
  const byToken = new Map<string, DeviceRecord[]>();
  for (const device of targets) {
    const sharing = byToken.get(device.apnsToken!);
    if (sharing) sharing.push(device);
    else byToken.set(device.apnsToken!, [device]);
  }
  for (const [token, devices] of byToken) {
    const result = await sendApns(token, payload);
    if (result === 'gone') {
      // The token outlived the app it addressed. Drop it now, or every later
      // push spends a request learning the same thing — from every record that
      // still carries it, since one dead address can be written on several.
      for (const device of devices) {
        const dropped = await setDevicePushToken(device.id, null).then(
          () => true,
          (err) => {
            // Without this write the token stays in the registry and every later
            // wake-up spends an APNs request rediscovering that it is gone. Say
            // that, rather than the line below asserting a drop that did not
            // happen — a log that reports work it did not do is worse than none.
            degrade('push', 'kept a dead push token in the device registry', err);
            return false;
          }
        );
        if (dropped) log('push', 'dropped a dead push token', { deviceId: device.id });
      }
      continue;
    }
    log('push', result === 'sent' ? 'sent a wake-up' : 'could not send a wake-up', {
      kind: wake.kind,
      deviceId: devices[0].id
    });
  }
}

/** Start a delivery and forget it. The one way anything in here is ever called. */
function fireAndForget(wake: WakeUp, label?: LabelSource): void {
  void deliver(wake, label).catch((e) =>
    log('push', 'wake-up failed', { kind: wake.kind, error: String((e as Error)?.message ?? e) })
  );
}

/**
 * An approval card just went up. The agent is BLOCKED until somebody answers, so
 * this is the notification the whole feature exists for — everything else could
 * wait for the user to look.
 */
export function pushApprovalRequest(
  approvalKind: ApprovalPushKind,
  approval: { id: string | number; threadId?: string }
): void {
  fireAndForget({
    kind: 'approval',
    approvalKind,
    approvalId: String(approval.id),
    ...(approval.threadId ? { threadId: approval.threadId } : {})
  });
}

/**
 * A turn ended. Only worth a notification if it ran long enough that the person
 * who started it has plausibly walked away — `ranForMs` is measured from the
 * turn's first event (see live-turns.ts), not from the request, because that is
 * the clock every other consumer already reads.
 */
export function pushTurnFinished(turn: {
  threadId: string;
  failed: boolean;
  ranForMs: number;
  label?: LabelSource;
}): void {
  if (!(turn.ranForMs >= MIN_TURN_PUSH_MS)) return;
  fireAndForget({ kind: 'turn', threadId: turn.threadId, failed: turn.failed }, turn.label);
}

/**
 * A scheduled task called notify_user and the mode is not `inbox`. Both louder
 * modes push: `alert` and `nudge` differ in how they disturb the machine at the
 * desk, and the phone is not at the desk.
 */
export function pushTaskAlert(task: { threadId: string; taskId?: string; label?: LabelSource }): void {
  fireAndForget(
    { kind: 'task', threadId: task.threadId, ...(task.taskId ? { taskId: task.taskId } : {}) },
    task.label
  );
}

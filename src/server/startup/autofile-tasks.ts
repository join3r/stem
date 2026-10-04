import * as activity from '../activity';
import { autoFileSweep } from '../chats/autofile';
import type { ChatSummary } from '../../shared/types';
import type { ChatBackend } from '../backend';

/** How often the sweep looks for chats that have gone idle since the last one. */
const SWEEP_INTERVAL_MS = 30 * 60_000;
/** The first sweep after boot: late enough to stay out of startup's way. */
const FIRST_SWEEP_MS = 5 * 60_000;
/**
 * The next sweep when the last one left chats behind, so a folder that asked
 * for older chats works through them in minutes rather than at 20 per half hour.
 */
const FOLLOW_UP_MS = 60_000;

/**
 * Filing idle chats into the folders switched on for it (folder settings; see
 * server/chats/autofile.ts for the policy). A sweep shortly after boot, then
 * one every half hour, sooner while chats are left over. Opportunistic like the
 * recall passes: it skips a tick while the user is busy, and stops mid-sweep
 * when they come back, leaving the rest for the next tick. The returned
 * function asks for a sweep soon — a folder just asked for older chats.
 */
export function initAutoFileTasks(deps: {
  runtime: () => ChatBackend;
  /** True while a turn runs on either surface or the user interacted within `idleMs`. */
  busyWithin: (idleMs: number) => boolean;
  /** The chats the chat list shows — mail sessions and scheduled-run threads already out. */
  listChats: () => Promise<ChatSummary[]>;
  /** A chat moved: the clients re-read the list. */
  onFiled: (threadId: string) => void;
}): (delayMs?: number) => void {
  let sweeping = false;
  // Work is known to be waiting (a kick, or chats the last sweep left), so a
  // busy tick retries in a minute instead of waiting out the half hour.
  let pending = false;
  let followUp: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delayMs: number): void => {
    if (followUp) clearTimeout(followUp);
    followUp = setTimeout(() => {
      followUp = null;
      void runSweep();
    }, delayMs);
  };
  const runSweep = async (): Promise<void> => {
    if (sweeping) return;
    if (deps.busyWithin(30_000)) {
      if (pending) schedule(FOLLOW_UP_MS);
      return;
    }
    sweeping = true;
    let more = false;
    try {
      // The detail names the chats and where they went: a move the user didn't
      // make, and the activity feed is the one place that says it happened.
      await activity.track(
        'chats.autoFile',
        'Filing idle chats',
        () =>
          autoFileSweep({
            // Not priority: nobody is waiting on this.
            complete: (prompt, opts) => deps.runtime().complete(prompt, opts),
            listChats: deps.listChats,
            readMessages: async (id) => (await deps.runtime().readThread(id)).messages,
            onFiled: deps.onFiled,
            shouldYield: () => deps.busyWithin(30_000)
          }),
        (r) => {
          more = r.more;
          return {
            worked: r.filed.length > 0,
            detail: r.filed.map((f) => `${f.title} → ${f.folder}`).join('; ')
          };
        }
      );
    } catch {
      // quiet: autoFileSweep never throws, and track() would have failed the row.
    } finally {
      sweeping = false;
    }
    pending = more;
    if (more) schedule(FOLLOW_UP_MS);
  };
  setTimeout(() => void runSweep(), FIRST_SWEEP_MS);
  setInterval(() => void runSweep(), SWEEP_INTERVAL_MS);
  return (delayMs = 5_000) => {
    pending = true;
    schedule(delayMs);
  };
}

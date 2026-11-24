import { useSyncExternalStore } from 'react';
import type { TurnAttachment } from '../../shared/types';

// A mail draft's attachments go up to the server the moment they are attached,
// not when Send is pressed. Each draft attachment (by object identity) gets one
// background upload here; Send then waits only for whatever is still running —
// usually nothing — and carries the handles, not the bytes.
//
// The draft itself keeps the ORIGINAL attachments (paths, pasted bytes): those
// are what the saved draft stores and what a retry re-uploads from. A handle is
// only good for the server's staging TTL (an hour), so an old one is replaced
// at send time rather than trusted.

export type StageState = 'uploading' | 'done' | 'failed';

interface Entry {
  promise: Promise<TurnAttachment>;
  at: number;
  state: StageState;
  error?: string;
}

/** Comfortably inside the server's 60-minute staging TTL. */
const FRESH_MS = 45 * 60_000;

const entries = new WeakMap<TurnAttachment, Entry>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const l of listeners) l();
}

function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function start(att: TurnAttachment): Entry {
  const entry: Entry = { promise: Promise.resolve(att), at: Date.now(), state: 'uploading' };
  entry.promise = window.stem.stageAttachment(att).then(
    (staged) => {
      entry.state = 'done';
      changed();
      return staged;
    },
    (err: unknown) => {
      entry.state = 'failed';
      entry.error = errorText(err);
      changed();
      throw err;
    }
  );
  // Nobody may be waiting yet; a failure is shown on the chip and retried at send.
  entry.promise.catch(() => undefined);
  entries.set(att, entry);
  changed();
  return entry;
}

/** Start uploading any of these that are not already on their way. */
export function stageInBackground(atts: readonly TurnAttachment[]): void {
  for (const att of atts) {
    if (!entries.has(att)) start(att);
  }
}

/**
 * What a send carries: each attachment as staged on the server. A failed or
 * stale upload is tried once more here; if that fails too, the send fails with
 * the file's name, exactly as an upload at send time always did.
 */
export async function stagedForSend(atts: readonly TurnAttachment[]): Promise<TurnAttachment[]> {
  return Promise.all(
    atts.map((att) => {
      const entry = entries.get(att);
      if (!entry || entry.state === 'failed' || Date.now() - entry.at > FRESH_MS) return start(att).promise;
      return entry.promise;
    })
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Each attachment's upload state, for its chip; re-renders as uploads settle. */
export function useStageStates(atts: readonly TurnAttachment[]): Array<{ state?: StageState; error?: string }> {
  useSyncExternalStore(subscribe, () => version);
  return atts.map((att) => {
    const entry = entries.get(att);
    return entry ? { state: entry.state, error: entry.error } : {};
  });
}

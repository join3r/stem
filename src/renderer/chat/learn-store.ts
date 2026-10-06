// `/learn` progress and outcome, kept per chat for the life of the window.
//
// ChatView is keyed on the active chat, so switching chats remounts the Composer.
// A `/learn` runs for a minute or more (the author reads the whole chat), and its
// "Learning from this chat…" line lived in Composer state: peek at another chat
// and come back, and the request was still running with nothing on screen to say
// so, and its outcome landed on the unmounted component and was never shown
// (2026-10-06, the Cloudfarms invoice chat). The draft store solves the same
// remount for typed text; this one also has to notify, because the result
// arrives while the Composer may be mounted.
import type { SkillLearnResult } from '../../shared/types';

export interface LearnNotice {
  ok: boolean;
  text: string;
}

export interface LearnState {
  learning: boolean;
  /** The outcome, held until the chat that asked is on screen to show it. */
  notice: LearnNotice | null;
}

const IDLE: LearnState = { learning: false, notice: null };
const states = new Map<string, LearnState>();
const listeners = new Set<() => void>();

function put(threadId: string, next: LearnState): void {
  if (!next.learning && !next.notice) states.delete(threadId);
  else states.set(threadId, next);
  for (const listener of listeners) listener();
}

/** Stable per state, as useSyncExternalStore requires. */
export function readLearn(threadId: string | null | undefined): LearnState {
  return (threadId ? states.get(threadId) : undefined) ?? IDLE;
}

export function subscribeLearn(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Run a `/learn` for this chat unless one is already outstanding. Main phrases
 * every outcome for the user, refusals included, so its message is kept as written.
 */
export async function startLearn(threadId: string, run: () => Promise<SkillLearnResult>): Promise<void> {
  if (readLearn(threadId).learning) return;
  put(threadId, { learning: true, notice: null });
  let result: SkillLearnResult;
  try {
    result = await run();
  } catch {
    result = { ok: false, message: 'Couldn’t save a skill — try restarting Stem.' };
  }
  put(threadId, { learning: false, notice: { ok: result.ok, text: result.message } });
}

/** Clear a shown outcome, unless a newer `/learn` has replaced it meanwhile. */
export function dismissLearnNotice(threadId: string, notice: LearnNotice): void {
  const state = states.get(threadId);
  if (state?.notice === notice) put(threadId, { ...state, notice: null });
}

/** Test hook: forget every chat's state. */
export function resetLearn(): void {
  states.clear();
}

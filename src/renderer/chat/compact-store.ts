// `/compact` progress and outcome, kept per chat for the life of the window —
// for the same reason as learn-store.ts: a condense is one long summarizing call,
// and a chat switch remounts the Composer that started it.
import type { CompactChatResult } from '../../shared/types';
import type { LearnNotice as CompactNotice } from './learn-store';

export interface CompactState {
  compacting: boolean;
  notice: CompactNotice | null;
}

const IDLE: CompactState = { compacting: false, notice: null };
const states = new Map<string, CompactState>();
const listeners = new Set<() => void>();

function put(threadId: string, next: CompactState): void {
  if (!next.compacting && !next.notice) states.delete(threadId);
  else states.set(threadId, next);
  for (const listener of listeners) listener();
}

/** Stable per state, as useSyncExternalStore requires. */
export function readCompact(threadId: string | null | undefined): CompactState {
  return (threadId ? states.get(threadId) : undefined) ?? IDLE;
}

export function subscribeCompact(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// 142318 → "142k", 9400 → "9.4k".
function tokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/** The line shown once a condense finished. */
export function compactedText(result: CompactChatResult): string {
  if (result.tokensBefore != null && result.tokensAfter != null) {
    return `Condensed this chat: ${tokens(result.tokensBefore)} → ${tokens(result.tokensAfter)} tokens`;
  }
  return 'Condensed this chat';
}

/** pi's refusals, phrased for the person who typed `/compact`. */
export function compactErrorText(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    ''
  );
  if (/Nothing to compact/i.test(raw)) return 'This chat is too short to condense yet';
  if (/Already compacted/i.test(raw)) return 'Already condensed — nothing new since';
  return `Couldn’t condense this chat: ${raw}`;
}

/** Run a `/compact` for this chat unless one is already outstanding. */
export async function startCompact(threadId: string, run: () => Promise<CompactChatResult>): Promise<void> {
  if (readCompact(threadId).compacting) return;
  put(threadId, { compacting: true, notice: null });
  let notice: CompactNotice;
  try {
    notice = { ok: true, text: compactedText(await run()) };
  } catch (error) {
    notice = { ok: false, text: compactErrorText(error) };
  }
  put(threadId, { compacting: false, notice });
}

/** Clear a shown outcome, unless a newer `/compact` has replaced it meanwhile. */
export function dismissCompactNotice(threadId: string, notice: CompactNotice): void {
  const state = states.get(threadId);
  if (state?.notice === notice) put(threadId, { ...state, notice: null });
}

/** Test hook: forget every chat's state. */
export function resetCompact(): void {
  states.clear();
}

/** Minimal pending-start shape shared by main Chat and Quick Chat cancellation. */
export interface PendingTurnStart {
  promise: Promise<unknown>;
  turnId: string | null;
}

/** Delete a pending start only when the completing callback still owns the key. */
export function deletePendingIfCurrent<K, V>(map: Map<K, V>, key: K, expected: V): boolean {
  if (map.get(key) !== expected) return false;
  map.delete(key);
  return true;
}

/**
 * Move a pending start from a draft key to its real thread without deleting a
 * newer draft start that may have replaced it while the first IPC was pending.
 */
export function rekeyPendingIfCurrent<K, V>(map: Map<K, V>, from: K, to: K, expected: V): boolean {
  if (!deletePendingIfCurrent(map, from, expected)) return false;
  map.set(to, expected);
  return true;
}

/** A prior DRAFT generation may background while the newly reset draft starts. */
export function pendingStartBlocksSend(
  pending: { draftGeneration?: number } | undefined,
  isDraft: boolean,
  currentDraftGeneration: number
): boolean {
  if (!pending) return false;
  if (!isDraft || pending.draftGeneration === undefined) return true;
  return pending.draftGeneration === currentDraftGeneration;
}

/**
 * Resolve the turn id Stop should interrupt. Sends mint their turn id client-side
 * now, so a pending start normally carries it from the first moment — Stop can
 * cancel a turn whose start IPC is still in flight. The await remains as the
 * fallback for pending entries without a pre-minted id (none should exist any
 * more, but pretending the turn stopped locally while the backend continues is
 * the failure mode this guards).
 */
export async function interruptibleTurnId(
  activeTurnId: string | null | undefined,
  pending: PendingTurnStart | null | undefined
): Promise<string | null> {
  if (activeTurnId) return activeTurnId;
  if (!pending) return null;
  if (pending.turnId) return pending.turnId;
  await pending.promise.catch(() => undefined);
  return pending.turnId;
}

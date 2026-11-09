import { useEffect, useRef } from 'react';
import { useSearchHarvest } from '../ui/searchHarvest';
import type { ManageIntent } from '../../shared/types';

// Where a jump into the right-hand panel should land past its tab: the MCP
// editor filled in for an app's official server, or the browser-control rows in
// Settings → Features. Asked from Quick Chat's window chip (a menu command),
// and taken by whichever screen it is for — which may only mount after the tab
// switch, so the intent waits here until it is taken.

let pending: ManageIntent | null = null;
const listeners = new Set<() => void>();

export function requestManageIntent(intent: ManageIntent): void {
  pending = intent;
  for (const l of [...listeners]) l();
}

/**
 * Run `handle` for an intent of this kind, now if one is waiting and on every
 * later one. `take` consumes it (the screen it was for); without it the hook
 * only looks (a parent that has to show the screen first).
 */
export function useManageIntent<K extends ManageIntent['kind']>(
  kind: K,
  handle: (intent: Extract<ManageIntent, { kind: K }>) => void,
  take = true
): void {
  const handleRef = useRef(handle);
  handleRef.current = handle;
  // The hidden copy of Settings that the search reads must not take an intent
  // that is for the copy on the screen.
  const harvest = useSearchHarvest();
  useEffect(() => {
    if (harvest) return;
    const check = () => {
      if (pending?.kind !== kind) return;
      const intent = pending as Extract<ManageIntent, { kind: K }>;
      if (take) pending = null;
      handleRef.current(intent);
    };
    listeners.add(check);
    check();
    return () => {
      listeners.delete(check);
    };
  }, [kind, take, harvest]);
}

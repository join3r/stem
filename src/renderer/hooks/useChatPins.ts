import { useCallback, useEffect, useState } from 'react';
import type { ChatPin, ChatPinInput, ChatPinPatch } from '../../shared/types';

export interface ChatPins {
  pins: ChatPin[];
  /** The last mutation's refusal (a stale reorder, a pin already gone), until the next one. */
  error: string | null;
  add(input: ChatPinInput): Promise<boolean>;
  update(pinId: string, patch: ChatPinPatch): Promise<boolean>;
  remove(pinId: string): Promise<boolean>;
  reorder(pinIds: string[]): Promise<boolean>;
}

const NONE: ChatPin[] = [];

/**
 * One chat's pinboard, kept current: loaded when the chat opens, replaced by
 * each mutation's answer (every pins channel answers with the fresh board), and
 * refetched when `pins:changed` names this chat — another window, another
 * device, or a label the server just wrote. A draft (no thread yet) has none.
 *
 * A server too old to have the channels answers with an error: the chat then
 * simply has no board, exactly as before pins existed.
 */
export function useChatPins(threadId: string | null | undefined): ChatPins {
  const [pins, setPins] = useState<ChatPin[]>(NONE);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPins(NONE);
    setError(null);
    if (!threadId || !window.stem.listPins) return;
    let active = true;
    const load = () => {
      window.stem.listPins(threadId).then(
        (next) => {
          if (active) setPins(next);
        },
        () => {
          // An older server, or a blip: no board rather than a broken one.
        }
      );
    };
    load();
    const off = window.stem.onPinsChanged?.((payload) => {
      if (payload?.threadId === threadId) load();
    });
    return () => {
      active = false;
      off?.();
    };
  }, [threadId]);

  const run = useCallback(
    async (call: (id: string) => Promise<ChatPin[]>): Promise<boolean> => {
      if (!threadId) return false;
      try {
        setPins(await call(threadId));
        setError(null);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));
        // The refusal may mean this board is stale (a reorder racing another
        // device); show the server's truth rather than ours.
        window.stem.listPins(threadId).then(setPins, () => undefined);
        return false;
      }
    },
    [threadId]
  );

  return {
    pins,
    error,
    add: useCallback((input) => run((id) => window.stem.addPin(id, input)), [run]),
    update: useCallback((pinId, patch) => run((id) => window.stem.updatePin(id, pinId, patch)), [run]),
    remove: useCallback((pinId) => run((id) => window.stem.removePin(id, pinId)), [run]),
    reorder: useCallback((pinIds) => run((id) => window.stem.reorderPins(id, pinIds)), [run])
  };
}

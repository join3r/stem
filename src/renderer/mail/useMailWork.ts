import { useEffect, useState } from 'react';
import type { MailWorkGroup } from '../../shared/types';

/** Work has its own subscription: activity never changes inbox/read state. */
export function useMailWork(conversationId: string) {
  const [result, setResult] = useState<{
    conversationId: string;
    groups: MailWorkGroup[];
    error?: string;
  }>({ conversationId, groups: [] });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!window.stem) return;
    let disposed = false;
    let inFlight = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (disposed) return;
      if (inFlight) { dirty = true; return; }
      inFlight = true;
      try {
        const next = await window.stem.getMailWork(conversationId);
        if (!disposed) setResult({ conversationId, groups: next.groups });
      } catch {
        if (!disposed) setResult((prev) => ({
          conversationId,
          groups: prev.conversationId === conversationId ? prev.groups : [],
          error: 'Work history could not be refreshed. The activity shown may be out of date.'
        }));
      } finally {
        inFlight = false;
        if (dirty && !disposed) { dirty = false; schedule(); }
      }
    };
    // Coalesce streams of coding-agent events without starving the visible update.
    const schedule = () => {
      if (timer || disposed) return;
      timer = setTimeout(() => { timer = undefined; void refresh(); }, 200);
    };
    const offWork = window.stem.onMailWorkChanged((event) => {
      if (event.conversationId === conversationId) schedule();
    });
    const offMail = window.stem.onMailChanged(schedule);
    const offResync = window.stem.onResync(schedule);
    const offConnection = window.stem.onConnectionChanged((reachable) => { if (reachable) schedule(); });
    void refresh();
    // Recover events missed while the client was disconnected or asleep.
    const poll = setInterval(() => { void refresh(); }, 15_000);
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(poll);
      offWork();
      offMail();
      offResync();
      offConnection();
    };
  }, [conversationId, retry]);

  return {
    groups: result.conversationId === conversationId ? result.groups : [],
    error: result.conversationId === conversationId ? result.error : undefined,
    refresh: () => setRetry((value) => value + 1)
  };
}

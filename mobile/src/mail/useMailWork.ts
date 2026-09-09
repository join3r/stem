import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { MailWorkGroup } from '@shared/types';
import { useTransport } from '../transport/provider';

/** Activity invalidation is deliberately separate from mail:list and read
 * tracking: new tool output must never mark a message read or unread. */
export function useMailWork(conversationId: string) {
  const { connection, status, pairing } = useTransport();
  const [groups, setGroups] = useState<MailWorkGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let disposed = false;
    let pending = false;
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setGroups([]);
    setError(null);
    setLoading(false);
    const load = async () => {
      if (disposed || !connection.status().paired || !conversationId) return;
      if (pending) { dirty = true; return; }
      pending = true;
      setLoading(true);
      try {
        const result = await connection.rpc('mail:work', conversationId);
        if (!disposed) { setGroups(result.groups); setError(null); }
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      } finally {
        pending = false;
        if (!disposed) {
          setLoading(false);
          if (dirty) { dirty = false; schedule(); }
        }
      }
    };
    const schedule = () => {
      if (disposed || timer) return;
      timer = setTimeout(() => { timer = undefined; void load(); }, 150);
    };
    refreshRef.current = () => void load();
    const off = [
      connection.onPush('mail:workChanged', (payload) => {
        if (payload && typeof payload === 'object' &&
          'conversationId' in payload && payload.conversationId === conversationId) schedule();
      }),
      connection.onPush('mail:changed', schedule),
      connection.onWake(schedule),
      connection.onResync(schedule)
    ];
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
      off.forEach((unsubscribe) => unsubscribe());
      refreshRef.current = () => {};
    };
  }, [connection, conversationId, pairing?.deviceId]);
  useEffect(() => {
    if (status.paired && status.reachable) refresh();
  }, [status.paired, status.reachable, refresh]);
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));
  return { groups, error, loading, refresh };
}

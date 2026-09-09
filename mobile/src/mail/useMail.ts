import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { MailComposeInput, MailListResult, Persona, TurnAttachment } from '@shared/types';
import { useTransport } from '../transport/provider';

const EMPTY: MailListResult = { conversations: [], items: [], inbox: { baseline: 0, entries: {} } };

/** Reads are ordered and invalidated by writes and unpairing. A slow pre-write
 * refresh never restores a conversation which was just archived or deleted. */
export function useMail() {
  const { connection, status, pairing } = useTransport();
  const [mail, setMail] = useState<MailListResult>(EMPTY);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const alive = useRef(true);
  const invalidate = useCallback(() => {
    sequence.current += 1;
  }, []);
  const refresh = useCallback(async () => {
    if (!alive.current || !connection.status().paired) return;
    const seq = ++sequence.current;
    setLoading(true);
    try {
      const [list, people] = await Promise.all([
        connection.rpc('mail:list'),
        connection.rpc('personas:list')
      ]);
      if (seq !== sequence.current) return;
      setMail(list);
      setPersonas(people);
      setError(null);
    } catch (e) {
      if (seq === sequence.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === sequence.current) setLoading(false);
    }
  }, [connection]);
  useEffect(() => {
    alive.current = true;
    invalidate();
    setMail(EMPTY);
    setPersonas([]);
    setError(null);
    setLoading(false);
    return () => {
      alive.current = false;
      invalidate();
    };
  }, [pairing?.deviceId, invalidate]);
  useEffect(() => {
    if (status.paired && status.reachable) void refresh();
  }, [status.paired, status.reachable, refresh]);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh])
  );
  useEffect(() => {
    const off = [
      connection.onPush('mail:changed', () => void refresh()),
      connection.onPush('personas:changed', () => void refresh()),
      connection.onWake(() => void refresh()),
      connection.onResync(() => void refresh())
    ];
    return () => off.forEach((fn) => fn());
  }, [connection, refresh]);
  const write = useCallback(
    async (call: () => Promise<MailListResult>) => {
      const seq = ++sequence.current;
      try {
        const result = await call();
        if (seq === sequence.current) {
          setMail(result);
          setError(null);
          setLoading(false);
        } else void refresh();
        return result;
      } catch (e) {
        if (seq === sequence.current) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
        throw e;
      }
    },
    [refresh]
  );
  return {
    mail,
    personas,
    error,
    loading,
    refresh,
    compose: (input: MailComposeInput) => write(() => connection.rpc('mail:compose', input)),
    reply: (id: string, body: string, attachments?: TurnAttachment[]) =>
      write(() => connection.rpc('mail:reply', id, body, attachments)),
    addParticipant: (id: string, personaId: string) =>
      write(() => connection.rpc('mail:addParticipant', id, personaId)),
    archive: (ids: string[], value: boolean) =>
      write(() => connection.rpc('mail:setArchived', ids, value)),
    snooze: (ids: string[], until: number | null) =>
      write(() => connection.rpc('mail:snooze', ids, until)),
    setRead: (ids: string[], value: boolean) =>
      write(() => connection.rpc('mail:setRead', ids, value)),
    remove: (id: string) => write(() => connection.rpc('mail:delete', id)),
    stop: async (id: string) => {
      await connection.rpc('mail:stop', id);
      await refresh();
    }
  };
}

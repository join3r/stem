// The personas a chat may be sent as, for the composer's picker.
//
// One fetch of `personas:list`, filtered to the rows the user opened to
// clients (`clients: true`) — the server refuses a startTurn as any other, so
// offering more would only manufacture errors. Read when the composer mounts
// and again when pairing lands; NOT kept live over the event stream, because a
// registry edit mid-compose is rare and the next screen visit rereads anyway.
//
// Failure is an empty list on purpose: the picker is an extra, and a phone
// that cannot fetch it still composes plain chats — the row simply isn't
// there, exactly as it isn't when nothing is opened up.

import { useEffect, useState } from 'react';
import type { Persona } from '@shared/types';
import { useTransport } from '../transport/provider';

export function useChatPersonas(): Persona[] {
  const { connection, status } = useTransport();
  const [personas, setPersonas] = useState<Persona[]>([]);

  useEffect(() => {
    if (!status.paired) return;
    let stale = false;
    connection
      .rpc('personas:list')
      .then((list) => {
        if (!stale) setPersonas(list.filter((p) => p.clients === true));
      })
      .catch(() => {
        // An old server has the channel but no `clients` field (the filter
        // yields nothing); a failed read is the same non-event.
        if (!stale) setPersonas([]);
      });
    return () => {
      stale = true;
    };
  }, [connection, status.paired]);

  return personas;
}

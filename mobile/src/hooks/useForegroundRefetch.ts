// "The app is in front again — read your data again, quietly."
//
// The transport says when (Connection.onWake, fired from the AppState listener
// in ../transport/provider.tsx after it has reopened the stream). The data hooks
// (useThread, useChatList) subscribe inside themselves because they own the
// read; this is for a screen that holds its own request, like Settings, so it
// does not have to know the connection has a wake signal at all.
//
// The callback is called with nothing and its result ignored; it should be a
// `background` read (see ReadCause in ../chat/reads.ts) — one that shows what it
// gets and says nothing if nothing answers, because the link is being reopened
// at the same instant and may not be back yet.

import { useEffect } from 'react';
import { useTransport } from '../transport/provider';

export function useForegroundRefetch(refetch: () => void): void {
  const { connection } = useTransport();
  useEffect(() => connection.onWake(refetch), [connection, refetch]);
}

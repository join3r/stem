// The transport, mounted: one Connection for the life of the app, the Keychain
// read that decides whether there is a server to talk to, and the two moments
// only React can see — the app coming back to the foreground, and a screen
// asking to pair or unpair.
//
// Why the connection is created once and never re-created: the event stream owns
// a bookmark (Last-Event-ID) and a backoff attempt count, and both are meant to
// survive everything a UI does. A connection rebuilt on a re-render would resume
// from nothing and reconnect eagerly forever.
//
// Foreground handling is the mobile half of what a desktop gets for free. iOS
// suspends the process; the socket it was reading may or may not still exist
// when it comes back, and the OS does not say which — a dead one looks exactly
// like a quiet one from inside JS. So `background` closes the stream on purpose
// (connection.sleep) and `active` opens a fresh one from the bookmark and tells
// every screen to refetch (connection.wake). `inactive` is ignored: it is the
// app switcher, Face ID, a share sheet — moments the app is about to be active
// again and reconnecting through would only churn the socket.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, AppState } from 'react-native';
import { createOfflineCache, type OfflineCache } from '../offline/cache';
import { clearSubmittedThreads } from '../chat/submitted';
import { clearDrafts } from '../drafts/store';
import { openCacheDatabase } from '../offline/sqlite';
import { createConnection, type Connection, type ConnectionStatus } from './connection';
import { clearPairing, readPairing, writePairing, type StoredPairing } from './credentials';
import { streamingFetch } from './expo-fetch';
import { redeemPairingCode } from './pair-request';
import { unpairDevice } from './unpair';

export interface TransportValue {
  connection: Connection;
  status: ConnectionStatus;
  /**
   * The stored pairing, or null when there is none. Undefined for the one tick
   * before the Keychain has answered — the difference matters, because "not
   * paired" is a screen and "not known yet" is not.
   */
  pairing: StoredPairing | null | undefined;
  /** Spend a code, store what comes back, and point the connection at it. */
  pair(serverUrl: string, code: string): Promise<void>;
  /**
   * Forget the server and its credential — and ask the server to forget this
   * phone, which is best effort and not waited on. See ./unpair.ts.
   */
  unpair(): Promise<void>;
}

const TransportContext = createContext<TransportValue | null>(null);

export function TransportProvider({ children }: { children: ReactNode }): ReactNode {
  // One cache for the life of the app, like the connection and for the same
  // reason: it owns a debounce timer and a run in flight. The database file is
  // opened lazily on first use, so a launch that never reaches a server never
  // touches sqlite at all.
  const cache = useMemo<OfflineCache>(
    () =>
      createOfflineCache({
        open: openCacheDatabase,
        log: (message, meta) => console.log(`[cache] ${message}`, meta ?? '')
      }),
    []
  );
  const connection = useMemo(
    () =>
      createConnection({
        streamingFetch,
        cache,
        log: (message, meta) => console.log(`[transport] ${message}`, meta ?? '')
      }),
    [cache]
  );
  const [status, setStatus] = useState<ConnectionStatus>(() => connection.status());
  const [pairing, setPairing] = useState<StoredPairing | null | undefined>(undefined);
  // The Keychain read races an unpair only in theory, but the theory is cheap to
  // rule out: a pairing that arrived late must not overwrite one the user just
  // cleared.
  const generation = useRef(0);

  useEffect(() => {
    const mine = ++generation.current;
    const offStatus = connection.onStatus(setStatus);
    connection.start();
    void readPairing().then((stored) => {
      if (mine !== generation.current) return;
      setPairing(stored);
      if (stored) connection.setEndpoint({ serverUrl: stored.serverUrl, token: stored.token });
    });
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') connection.wake();
      else if (state === 'background') connection.sleep();
    });
    return () => {
      generation.current += 1;
      offStatus();
      subscription.remove();
      connection.stop();
    };
  }, [connection]);

  const pair = useCallback(
    async (serverUrl: string, code: string) => {
      const stored = await redeemPairingCode(serverUrl, code);
      // Store BEFORE connecting: a credential that works but was never written
      // is one the user has to pair for again after the next launch, and the
      // code they used is spent.
      await writePairing(stored);
      generation.current += 1;
      setPairing(stored);
      connection.setEndpoint({ serverUrl: stored.serverUrl, token: stored.token });
    },
    [connection]
  );

  const unpair = useCallback(
    () =>
      unpairDevice({
        deviceId: pairing?.deviceId ?? null,
        revoke: (deviceId) => connection.rpc('devices:revoke', deviceId),
        log: (message, meta) => console.log(`[transport] ${message}`, meta ?? ''),
        forget: async () => {
          generation.current += 1;
          connection.setEndpoint(null);
          clearSubmittedThreads();
          setPairing(null);
          // The cached chats belong to a server this phone no longer holds a
          // credential for. Leaving them would mean an unpaired phone still
          // shows somebody's conversations the moment it loses its network.
          try {
            try { cache.clear(); } finally { clearDrafts(); }
          } catch {
            Alert.alert('Local cleanup incomplete', 'Disconnected, but some local drafts could not be removed from this device.');
          } finally {
            // Disk cleanup must never leave a usable credential in Keychain.
            await clearPairing();
          }
        }
      }),
    [cache, connection, pairing?.deviceId]
  );

  const value = useMemo<TransportValue>(
    () => ({ connection, status, pairing, pair, unpair }),
    [connection, status, pairing, pair, unpair]
  );
  return <TransportContext.Provider value={value}>{children}</TransportContext.Provider>;
}

export function useTransport(): TransportValue {
  const value = useContext(TransportContext);
  if (!value) throw new Error('useTransport must be used inside <TransportProvider>');
  return value;
}

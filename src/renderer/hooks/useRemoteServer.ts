import { useEffect, useState } from 'react';
import type { ClientInfo } from '../../shared/types';

// Whether Stem's server is on another machine — the one fact a few surfaces have
// to know about the connection.
//
// It is worth knowing because some things a window offers are things only a
// window on the server's own machine can do. "Reveal in Finder" is the whole of
// it today: the path belongs to the server, and a Finder on this laptop cannot
// open a folder on a VPS. The affordance is removed rather than left to fail,
// because a button that always errors is worse than no button — it reads as
// broken software, not as a thing that doesn't apply here.
//
// Fetched once per window and cached: this cannot change while the app is
// running. Settings → Server writes where the NEXT launch will connect, and
// nothing re-points a live connection (the event stream and every bound channel
// hang off the one made at startup).
let cached: Promise<ClientInfo> | null = null;

function clientInfo(): Promise<ClientInfo> {
  cached ??= window.stem.clientInfo();
  return cached;
}

/**
 * True when the server is somebody else's machine. Starts false — i.e. it guesses
 * the default install, where the answer is right and nothing moves. A remote
 * client can see a reveal button for the frame before the answer lands; the
 * alternative guess would make every ordinary install watch its buttons appear
 * late, which is the more visible of the two.
 */
export function useRemoteServer(): boolean {
  const [remote, setRemote] = useState(false);
  useEffect(() => {
    let live = true;
    clientInfo()
      .then((info) => {
        if (live) setRemote(info.remote);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return remote;
}

/**
 * This client's own device id (devices.json registry id), or null before the
 * answer lands / on an unpaired client. The Folders tab uses it to tell "a
 * folder on THIS computer" from one on some other paired machine — same cached
 * fetch as useRemoteServer, same cannot-change-while-running reasoning.
 */
export function useClientDeviceId(): string | null {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    clientInfo()
      .then((info) => {
        if (live) setDeviceId(info.deviceId);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return deviceId;
}

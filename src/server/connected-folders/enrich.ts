import type { ConnectedFolder } from '../../shared/types';
import { readMirrorSkipped } from '../mirror';
import { readDevices } from '../transport/auth';
import { connectedDeviceIds } from '../startup/transport';

// The computed, never-persisted half of a client-connected folder: which device
// owns it (by label — the id means nothing to a person or to the prompt),
// whether that device is reachable RIGHT NOW (an open event stream, the same
// one-fact availability signal the MCP and exec device routers use), and where
// the mirror stands. Evaluated at call time so injection gets a per-turn answer.

/** Attach deviceLabel/deviceConnected/orphaned/syncState to client folders. */
export async function enrichConnectedFolders(folders: ConnectedFolder[]): Promise<ConnectedFolder[]> {
  if (!folders.some((f) => f.origin)) return folders;
  const devices = await readDevices();
  const labels = new Map(devices.map((d) => [d.id, d.label]));
  const connected = connectedDeviceIds();
  return Promise.all(
    folders.map(async (f) => {
      if (!f.origin) return f;
      const label = labels.get(f.origin.deviceId);
      const skipped = (await readMirrorSkipped(f.id)).length;
      return {
        ...f,
        // No label = the device was unpaired. The folder stays, marked — a person
        // decides what happens to it (the MCP pinning rule ⑩, held here too).
        ...(label ? { deviceLabel: label } : { orphaned: true }),
        deviceConnected: connected.has(f.origin.deviceId),
        syncState: f.rootMissing ? 'root-missing' : f.lastSyncedAt ? 'ok' : ('awaiting-sync' as const),
        ...(skipped ? { skippedCount: skipped } : {})
      };
    })
  );
}

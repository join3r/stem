// Do the two ends of the wire still agree about who answers what?
//
// There used to be three tables describing one decision — the server's per-role
// allowlists, the phone client's channel map, and the desktop proxy's list of
// channels that never reach a server at all. Two of them are gone with the phone
// role: the server's surface is now, for every client, exactly its handler
// registry. What is left is the one boundary that still has two sides, and it is
// the one that fails quietly:
//
//   src/desktop/proxy.ts   channels the CLIENT answers itself
//   the server registry    channels the SERVER answers
//
// A channel in both is answered by whichever end is asked first, which is not a
// property anyone designed. A channel in neither is a call that fails at runtime.
// Neither shows up in a type check — the tables are string maps, and strings
// agree with nothing.

import { describe, expect, it } from 'vitest';
import { hasLocalHandler, registerServer, serverChannels } from '../../src/server/ipc';

/**
 * Channels the desktop answers itself — the client-owned bucket of the table in
 * src/desktop/proxy.ts. Copied here rather than imported because importing it
 * would drag Electron into a unit test, and because a copy is exactly what this
 * file is for: if the two ever disagree, that is the finding.
 */
const CLIENT_OWNED = [
  'client:info',
  'client:pair',
  'client:useBuiltIn',
  'releaseNotes:get',
  'releaseNotes:markSeen',
  'settings:updateReleaseNotes',
  'updates:get',
  'updates:check',
  'updates:install',
  'settings:updateUpdates',
  'dialog:openFiles',
  'dialog:openDirectory',
  'files:reveal',
  'files:preview',
  'files:previewData',
  'cfolders:reveal',
  'cfolders:revealWorkspace',
  'quickchat:newThread',
  'quickchat:handoff',
  'quickchat:reveal',
  'quickchat:hide',
  'quickchat:shortcutStatus',
  'main:reveal'
];

describe('the server surface', () => {
  // The whole point is that there is NO table: the handler registry IS the
  // surface. These check that it still resolves that way rather than through a
  // second list that would have to be kept in step with it.

  it('follows the registry, including channels registered after the fact', () => {
    const channel = 'conformance:latecomer';
    expect(hasLocalHandler(channel)).toBe(false);

    registerServer(channel, () => 'ok');

    // Registering a handler is the ONLY act that exposes it to a client. If this
    // ever needs a second edit somewhere, the property the split rests on is gone.
    expect(hasLocalHandler(channel)).toBe(true);
    expect(serverChannels()).toContain(channel);
  });

  it('offers exactly what is registered and nothing more', () => {
    registerServer('conformance:one', () => 1);
    registerServer('conformance:two', () => 2);
    const registered = serverChannels();
    expect(registered).toContain('conformance:one');
    expect(registered).toContain('conformance:two');
    // A channel nobody registered is not smuggled in by naming it: GET /channels
    // answers with the registry itself, and dispatch refuses anything absent.
    expect(registered).not.toContain('conformance:unregistered');
  });

  it('does not answer the channels the desktop answers itself', () => {
    // Client-owned channels are absent from the registry by construction — they
    // are registered with handleLocal (src/desktop/ipc-bridge.ts), which never
    // touches it. Registering one here would put a native file picker on the
    // reachable surface of every paired device.
    for (const channel of CLIENT_OWNED) {
      expect(`${channel}: ${hasLocalHandler(channel)}`).toBe(`${channel}: false`);
    }
  });
});

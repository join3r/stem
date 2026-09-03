// What the connection dot says, decided in one place.
//
// The five booleans in ConnectionStatus can hold thirty-two combinations and
// only six of them mean anything to a person, so the mapping is a function with
// a test rather than a chain of ternaries in a component. The ORDER is the whole
// content of it:
//
//   not paired      before anything else — with no credential the other fields
//                   are about nobody.
//   pairing dead    a 401 outranks "offline", because waiting will not fix it
//                   and the user is the only one who can.
//   live            a stream is open: events would arrive if anything happened.
//                   This is the only state in which the phone is actually current.
//   reconnecting    the stream dropped or the app just came back, and the link
//                   has not been down long enough to call it gone. Dim, not red:
//                   this is the ordinary first second after every unlock, and
//                   painting it as an outage was the bug (see the grace in
//                   ../transport/connection.ts). "Reconnecting" when the server
//                   was answering a moment ago, "Connecting" when it never has.
//   connecting      the server answers RPCs but no stream is open and the grace
//                   has run out — a stream that keeps being refused, say.
//   offline         nothing answered, for long enough to mean it.

import type { ConnectionStatus } from '../transport/connection';

export type ConnectionTone = 'live' | 'warn' | 'bad' | 'dim';

export interface ConnectionDescription {
  label: string;
  tone: ConnectionTone;
}

export function describeConnection(status: ConnectionStatus): ConnectionDescription {
  if (!status.paired) return { label: 'Not paired', tone: 'dim' };
  if (status.unauthorized) return { label: 'Pairing rejected', tone: 'bad' };
  if (status.streaming) return { label: 'Live', tone: 'live' };
  if (status.reconnecting) return { label: status.reachable ? 'Reconnecting' : 'Connecting', tone: 'dim' };
  if (status.reachable) return { label: 'Connecting', tone: 'warn' };
  return { label: 'Offline', tone: 'bad' };
}

// Which threads are working right now, as React state.
//
// Connection owns the fold across snapshots and backend events, so a screen
// opened after the stream's first snapshot receives the current answer too.
//
// Snapshot REPLACES rather than merges, deliberately: it is the entire answer,
// so a thread missing from it is settled, not merely unmentioned. Merging would
// leave a spinner spinning on a turn that finished while the phone was asleep,
// which is the exact failure the frame was added to remove.

import { useEffect, useState } from 'react';
import { liveTurnsFromSnapshot, type LiveTurnMap } from '../transport/live-turns';
import { useTransport } from '../transport/provider';

export function useLiveTurns(): LiveTurnMap {
  const { connection } = useTransport();
  const [live, setLive] = useState<Map<string, string>>(() => new Map());

  useEffect(() => {
    return connection.subscribeLiveTurns((snapshot) => setLive(liveTurnsFromSnapshot(snapshot)));
  }, [connection]);

  return live;
}

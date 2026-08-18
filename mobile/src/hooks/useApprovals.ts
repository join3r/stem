// The eight pushes that make a phone useful for something a desk cannot do
// while you are away from it: answer an approval.
//
// Four request channels and four resolved channels, wired to the one queue in
// ../approvals/queue.ts. Requests arrive because the server broadcasts them to
// every connected client (src/server/index.ts) — the desk is not privileged
// here, and whichever surface answers first releases the tool call for both.
// That is exactly why the resolved channels must be listened to as hard as the
// request ones: an approval answered at the desk has to leave this phone's sheet
// on its own, or the user taps Approve on something that already ran.
//
// Resync clears the queue rather than refetching it: an entry that survived a gap
// in the stream would be one whose resolve we may have missed, and a stale
// approval card is worse than none — it invites an answer to a question nobody is
// still asking. What replaces it is not a refetch either. The `snapshot` frame
// the server sends the instant a stream opens carries the exec cards still
// waiting, and the stream replays them as ordinary `exec:approvalRequest` pushes
// (src/transport/stream.ts), so a card raised while this phone was asleep — or
// during the very gap that forced the resync — arrives again by itself.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolvedInstructionsText } from '@shared/instructions';
import type {
  ApprovalResolvedPayload,
  ExecApprovalRequest,
  ExecDecision,
  InstructionsProposal,
  McpAdminProposal,
  SkillProposal
} from '@shared/types';
import {
  enqueueApproval,
  removeApproval,
  type ApprovalKind,
  type PendingApproval
} from '../approvals/queue';
import { useTransport } from '../transport/provider';

export interface ApprovalsView {
  /** Everything waiting, in arrival order. */
  queue: PendingApproval[];
  /** The one the sheet is asking about — the oldest, so parallel calls answer in order. */
  current: PendingApproval | null;
  /** An answer is in flight. */
  busy: boolean;
  /** The last failed answer, cleared on the next attempt. */
  error: string | null;
  /**
   * A command whose answer arrived too late — the card had already expired (or
   * the desk answered it first) and it was NOT run. Held after the card itself
   * is gone, because the tap it belongs to has to be accounted for.
   */
  missed: string | null;
  /** Acknowledge {@link missed} and close the sheet. */
  dismissMissed(): void;
  /**
   * Answer the current approval. `execDecision` only means anything for a
   * command: "Allow once" and "Always allow this prefix" are both an approval,
   * and the difference is written to the user's allowlist server-side.
   */
  respond(item: PendingApproval, accept: boolean, execDecision?: ExecDecision): void;
}

export function useApprovals(): ApprovalsView {
  const { connection } = useTransport();
  const [queue, setQueue] = useState<PendingApproval[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missed, setMissed] = useState<string | null>(null);

  const add = useCallback((item: PendingApproval) => setQueue((q) => enqueueApproval(q, item)), []);
  const drop = useCallback(
    (kind: ApprovalKind, id: string | number) => setQueue((q) => removeApproval(q, kind, id)),
    []
  );

  useEffect(() => {
    const resolved =
      (kind: ApprovalKind) =>
      (payload: unknown): void =>
        drop(kind, (payload as ApprovalResolvedPayload).id);

    const offs = [
      connection.onPush('exec:approvalRequest', (p) =>
        add({ kind: 'exec', id: (p as ExecApprovalRequest).id, request: p as ExecApprovalRequest })
      ),
      connection.onPush('exec:approvalResolved', resolved('exec')),
      connection.onPush('mcp:adminApproval', (p) =>
        add({ kind: 'mcp', id: String((p as McpAdminProposal).id), proposal: p as McpAdminProposal })
      ),
      connection.onPush('mcp:adminApprovalResolved', resolved('mcp')),
      connection.onPush('instructions:approvalRequest', (p) =>
        add({
          kind: 'instructions',
          id: String((p as InstructionsProposal).id),
          proposal: p as InstructionsProposal
        })
      ),
      connection.onPush('instructions:approvalResolved', resolved('instructions')),
      connection.onPush('skills:approvalRequest', (p) =>
        add({ kind: 'skill', id: String((p as SkillProposal).id), proposal: p as SkillProposal })
      ),
      connection.onPush('skills:approvalResolved', resolved('skill')),
      connection.onResync(() => setQueue([]))
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [add, connection, drop]);

  // Answers are serialized: the sheet shows one card at a time, and letting a
  // second answer overlap would race two writes to the same queue position.
  const inFlight = useRef(false);

  const respond = useCallback(
    async (item: PendingApproval, accept: boolean, execDecision?: ExecDecision) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        switch (item.kind) {
          case 'exec': {
            const answered = await connection.rpc(
              'exec:resolveApproval',
              item.request.id,
              accept ? (execDecision ?? 'allowOnce') : 'deny'
            );
            // False = the card had already expired, or the desk answered it
            // first, and the command went on without this tap. Saying nothing
            // would leave the user certain they had allowed something that was
            // never run — the one thing a phone must not do from a pocket.
            if (answered === false) setMissed(item.request.command);
            break;
          }
          case 'mcp':
            await connection.rpc('mcp:adminDecision', item.proposal.id, accept);
            break;
          case 'instructions': {
            // `append` resolves against what is already there, so the current
            // text has to be read before this can be answered. Read at answer
            // time rather than on arrival: the desk may have edited the
            // instructions while the card sat on the phone.
            const surface = item.proposal.suggestedSurface ?? 'main';
            let text = '';
            if (accept) {
              const settings = await connection.rpc('settings:get');
              text = resolvedInstructionsText(
                item.proposal.action,
                item.proposal.incomingText,
                settings.customInstructions[surface]
              );
            }
            await connection.rpc(
              'instructions:resolveApproval',
              item.proposal.id,
              accept,
              surface,
              text
            );
            break;
          }
          case 'skill':
            await connection.rpc('skills:resolveApproval', item.proposal.id, accept, {
              name: item.proposal.name,
              description: item.proposal.description,
              body: item.proposal.body
            });
            break;
        }
        // The server's own resolved push will say the same thing; dropping it
        // here as well is what makes the sheet close on tap rather than on the
        // round trip back.
        drop(item.kind, item.id);
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [connection, drop]
  );

  return useMemo(
    () => ({
      queue,
      current: queue[0] ?? null,
      busy,
      error,
      missed,
      dismissMissed: () => setMissed(null),
      respond: (item, accept, execDecision) => void respond(item, accept, execDecision)
    }),
    [busy, error, missed, queue, respond]
  );
}

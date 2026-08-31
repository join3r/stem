import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxState } from '../../shared/inbox';
import { withArchived, withRead, withSnooze } from '../../shared/inbox';
import type { MailComposeInput, MailConversation, MailListResult, Persona } from '../../shared/types';

// The renderer's one copy of the mail state: list + personas, refreshed on the
// server's mail:changed push, with the same optimistic-triage treatment the
// chat inbox has — the row moves the instant the user acts (the shared with*
// mirrors), and the mutator's authoritative answer reconciles. Patches in
// flight are re-applied over any list that arrives in the meantime, so a
// refresh can never visibly revert a triage the user already made.

const EMPTY: MailListResult = {
  conversations: [],
  items: [],
  inbox: { baseline: 0, entries: {} }
};

export interface MailApi {
  mail: MailListResult;
  personas: Persona[];
  refresh: () => void;
  /** Resolves with the fresh list so the caller can open the new conversation. */
  compose: (input: MailComposeInput) => Promise<MailListResult>;
  reply: (conversationId: string, body: string) => Promise<void>;
  archive: (ids: string[], archived: boolean) => void;
  snooze: (ids: string[], until: number | null) => void;
  setRead: (ids: string[], read: boolean) => void;
  remove: (conversationId: string) => void;
}

export function useMail(ready: boolean): MailApi {
  const [mail, setMail] = useState<MailListResult>(EMPTY);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const pendingPatches = useRef(new Map<number, (inbox: InboxState) => InboxState>());
  const patchSeq = useRef(0);

  /** Adopt a server-fresh list, keeping optimistic patches in flight on top. */
  const applyServer = useCallback((list: MailListResult) => {
    setMail(() => {
      let inbox = list.inbox;
      for (const patch of pendingPatches.current.values()) inbox = patch(inbox);
      return inbox === list.inbox ? list : { ...list, inbox };
    });
  }, []);

  const refresh = useCallback(() => {
    if (!window.stem) return;
    window.stem.listMail().then(applyServer).catch(() => {
      // quiet-shaped but deliberate: offline, the pane keeps whatever it has.
    });
    window.stem.listPersonas().then(setPersonas).catch(() => {});
  }, [applyServer]);

  useEffect(() => {
    if (ready) refresh();
  }, [ready, refresh]);
  useEffect(() => window.stem?.onMailChanged(() => refresh()), [refresh]);
  // A persona created or renamed in the Manage panel (any client) shows in the
  // composer's To: list without waiting for the next mail event.
  useEffect(
    () =>
      window.stem?.onPersonasChanged(() => {
        window.stem.listPersonas().then(setPersonas).catch(() => {});
      }),
    []
  );

  const mutate = useCallback(
    (patch: (inbox: InboxState) => InboxState, call: () => Promise<MailListResult>) => {
      const seq = ++patchSeq.current;
      pendingPatches.current.set(seq, patch);
      setMail((prev) => ({ ...prev, inbox: patch(prev.inbox) }));
      call()
        .then((list) => {
          pendingPatches.current.delete(seq);
          applyServer(list);
        })
        .catch(() => {
          pendingPatches.current.delete(seq);
          refresh();
        });
    },
    [applyServer, refresh]
  );

  // Read stamps compare against the conversation's own activity clock, the same
  // clock-skew guard the chat inbox applies with thread mtimes.
  const mailRef = useRef(mail);
  mailRef.current = mail;
  const stamps = useCallback(
    () =>
      new Map(mailRef.current.conversations.map((c) => [c.id, c.userUpdatedAt] as const)),
    []
  );

  const archive = useCallback(
    (ids: string[], archived: boolean) =>
      mutate(
        (inbox) => withArchived(inbox, ids, archived, Date.now()),
        () => window.stem.setMailArchived(ids, archived)
      ),
    [mutate]
  );
  const snooze = useCallback(
    (ids: string[], until: number | null) =>
      mutate(
        (inbox) => withSnooze(inbox, ids, until, Date.now()),
        () => window.stem.snoozeMail(ids, until)
      ),
    [mutate]
  );
  const setRead = useCallback(
    (ids: string[], read: boolean) =>
      mutate(
        (inbox) => withRead(inbox, ids, read, stamps(), Date.now()),
        () => window.stem.setMailRead(ids, read)
      ),
    [mutate, stamps]
  );

  const compose = useCallback(
    async (input: MailComposeInput) => {
      const list = await window.stem.composeMail(input);
      applyServer(list);
      return list;
    },
    [applyServer]
  );
  const reply = useCallback(
    async (conversationId: string, body: string) => {
      applyServer(await window.stem.replyMail(conversationId, body));
    },
    [applyServer]
  );
  const remove = useCallback(
    (conversationId: string) => {
      // Optimistic: the row disappears now; the answer reconciles.
      setMail((prev) => ({
        ...prev,
        conversations: prev.conversations.filter((c) => c.id !== conversationId),
        items: prev.items.filter((i) => i.conversationId !== conversationId)
      }));
      window.stem
        .deleteMailConversation(conversationId)
        .then(applyServer)
        .catch(() => refresh());
    },
    [applyServer, refresh]
  );

  return { mail, personas, refresh, compose, reply, archive, snooze, setRead, remove };
}

/**
 * True when the latest user-relevant event is mail TO the user, not the user's
 * own send. A replied-to conversation has been dealt with — the turn is on the
 * personas — so it waits under Sent until new mail for the user lands.
 */
export function hasMailWaiting(c: MailConversation): boolean {
  return c.userUpdatedAt > c.userSentAt;
}

/** The persona's display name for a mail address ('user' handled by callers). */
export function personaName(personas: Persona[], id: string): string {
  if (id.startsWith('task:')) return 'Scheduled task';
  return personas.find((p) => p.id === id)?.name ?? id;
}

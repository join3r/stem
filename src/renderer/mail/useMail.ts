import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxState } from '../../shared/inbox';
import { pruneReplyDrafts } from './mail-drafts';
import { withArchived, withRead, withSnooze } from '../../shared/inbox';
import type {
  MailComposeInput,
  MailConversation,
  MailListResult,
  Persona,
  TurnAttachment
} from '../../shared/types';

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

/**
 * A reply on its way to the server, shown in the conversation the moment the
 * user sends it. It leaves once the server's list carries the real item; a
 * failed one stays, text intact, until the user retries, edits or drops it.
 */
export interface PendingSend {
  id: string;
  conversationId: string;
  body: string;
  attachments?: TurnAttachment[];
  at: number;
  status: 'sending' | 'failed';
  error?: string;
}

export interface MailApi {
  mail: MailListResult;
  personas: Persona[];
  refresh: () => void;
  /** Resolves with the fresh list so the caller can open the new conversation. */
  compose: (input: MailComposeInput) => Promise<MailListResult>;
  /** Never rejects: a failure stays in `pending` as a failed send. */
  reply: (conversationId: string, body: string, attachments?: TurnAttachment[]) => Promise<void>;
  pending: PendingSend[];
  retrySend: (id: string) => void;
  dropSend: (id: string) => void;
  addParticipant: (conversationId: string, personaId: string) => Promise<void>;
  /** Stop the conversation's in-flight work; resolves once the interrupts are sent. */
  stop: (conversationId: string) => Promise<void>;
  archive: (ids: string[], archived: boolean) => void;
  snooze: (ids: string[], until: number | null) => void;
  setRead: (ids: string[], read: boolean) => void;
  remove: (conversationId: string) => void;
}

export function useMail(ready: boolean): MailApi {
  const [mail, setMail] = useState<MailListResult>(EMPTY);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [pending, setPending] = useState<PendingSend[]>([]);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
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
    window.stem.listMail().then((list) => {
      applyServer(list);
      pruneReplyDrafts(new Set(list.conversations.map((c) => c.id)));
    }).catch(() => {
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
  const deliver = useCallback(
    async (send: PendingSend) => {
      try {
        const list = await window.stem.replyMail(send.conversationId, send.body, send.attachments);
        // One batch: the real item lands as the placeholder leaves.
        applyServer(list);
        setPending((prev) => prev.filter((p) => p.id !== send.id));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        setPending((prev) => prev.map((p) => (p.id === send.id ? { ...p, status: 'failed', error } : p)));
      }
    },
    [applyServer]
  );
  const reply = useCallback(
    async (conversationId: string, body: string, attachments?: TurnAttachment[]) => {
      const send: PendingSend = {
        id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        conversationId,
        body,
        ...(attachments?.length ? { attachments } : {}),
        at: Date.now(),
        status: 'sending'
      };
      setPending((prev) => [...prev, send]);
      await deliver(send);
    },
    [deliver]
  );
  const retrySend = useCallback(
    (id: string) => {
      const send = pendingRef.current.find((p) => p.id === id);
      if (!send || send.status !== 'failed') return;
      const again: PendingSend = { ...send, status: 'sending', error: undefined, at: Date.now() };
      setPending((prev) => prev.map((p) => (p.id === id ? again : p)));
      void deliver(again);
    },
    [deliver]
  );
  const dropSend = useCallback((id: string) => {
    setPending((prev) => prev.filter((p) => p.id !== id));
  }, []);
  const addParticipant = useCallback(
    async (conversationId: string, personaId: string) => {
      applyServer(await window.stem.addMailParticipant(conversationId, personaId));
    },
    [applyServer]
  );
  const stop = useCallback(
    async (conversationId: string) => {
      await window.stem.stopMail(conversationId);
      // The drain lands moments later as mail:changed; this refresh just picks
      // up whatever already settled.
      refresh();
    },
    [refresh]
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

  return {
    mail,
    personas,
    refresh,
    compose,
    reply,
    pending,
    retrySend,
    dropSend,
    addParticipant,
    stop,
    archive,
    snooze,
    setRead,
    remove
  };
}

/**
 * True when the latest user-relevant event is mail TO the user, not the user's
 * own send. A replied-to conversation has been dealt with — the turn is on the
 * personas — so it waits under Sent until new mail for the user lands.
 *
 * A server predating the field omits userSentAt; `undefined > x` and
 * `x > undefined` are both false, which would file EVERY conversation under
 * Sent. Fall back to 0 so version skew degrades to the old inbox behavior.
 */
export function hasMailWaiting(c: MailConversation): boolean {
  return c.userUpdatedAt > (c.userSentAt ?? 0);
}

/**
 * The display name for a mail address ('user' handled by callers). An agent
 * (`<roleId>~<name>`, see MailAgent) reads as its name and its role.
 */
export function personaName(personas: Persona[], id: string): string {
  if (id.startsWith('task:')) return 'Scheduled task';
  const at = id.lastIndexOf('~');
  if (at > 0) {
    const role = personas.find((p) => p.id === id.slice(0, at))?.name;
    return role ? `${id.slice(at + 1)} (${role})` : id.slice(at + 1);
  }
  return personas.find((p) => p.id === id)?.name ?? id;
}

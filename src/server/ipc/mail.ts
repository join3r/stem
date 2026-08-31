import { registerServer, type CallerContext } from './guard';
import type { MailRouter } from '../mail/router';
import type { MailComposeInput, TurnAttachment } from '../../shared/types';
import { transportedRawPath } from '../files/staging';
import {
  deleteConversation,
  readMail,
  setMailArchived,
  setMailRead,
  setMailSnooze
} from '../workspace/mail';
import type { ChatBackend } from '../backend/types';

/**
 * Mail: the email-like Inbox. Compose/reply go through the router (they start
 * agent turns); the triage mutators are pure store writes. Every mutator
 * returns the fresh MailListResult, the inbox-mutator contract.
 */
export function registerMailIpc(deps: { router(): MailRouter | null; runtime(): ChatBackend }): void {
  const router = (): MailRouter => {
    const r = deps.router();
    if (!r) throw new Error('Mail is not ready yet — the backend is still starting.');
    return r;
  };
  // SEC-002, same rule as backend:startTurn: a transported client's attachment
  // names an upload handle or inline bytes, never a path on this server.
  const refuseRawPaths = async (e: CallerContext, attachments: TurnAttachment[] | undefined) => {
    const raw = await transportedRawPath(e, (attachments ?? []).map((att) => att.path));
    if (raw) {
      throw new Error(
        'Attachments over the transport carry upload handles or inline bytes, never server paths — POST the file to /upload first.'
      );
    }
  };
  registerServer('mail:list', () => readMail());
  registerServer('mail:compose', async (e, input: MailComposeInput) => {
    await refuseRawPaths(e, input.attachments);
    return router().compose(input);
  });
  registerServer(
    'mail:reply',
    async (e, conversationId: string, body: string, attachments?: TurnAttachment[]) => {
      await refuseRawPaths(e, attachments);
      return router().reply(conversationId, body, attachments);
    }
  );
  registerServer('mail:addParticipant', (_e, conversationId: string, personaId: string) =>
    router().addParticipant(conversationId, personaId)
  );
  registerServer('mail:stop', (_e, conversationId: string) => router().stopConversation(conversationId));
  registerServer('mail:setRead', (_e, ids: string[], read: boolean) => setMailRead(ids, read));
  registerServer('mail:setArchived', (_e, ids: string[], archived: boolean) =>
    setMailArchived(ids, archived)
  );
  registerServer('mail:snooze', (_e, ids: string[], until: number | null) =>
    setMailSnooze(ids, until ?? null)
  );
  registerServer('mail:delete', async (_e, conversationId: string) => {
    const { result, threadIds } = await deleteConversation(conversationId);
    // The hidden persona threads go with the conversation — they are its work
    // product, unreachable from anywhere else. Best-effort: a session file that
    // would not delete only costs disk, never correctness.
    await Promise.all(
      threadIds.map((threadId) =>
        deps
          .runtime()
          .deleteThread(threadId)
          .catch(() => {
            // quiet: an undeletable hidden session is unreachable from the UI
            // and costs only disk; the conversation itself is already gone.
          })
      )
    );
    return result;
  });
}

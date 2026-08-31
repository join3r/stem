import { registerServer } from './guard';
import type { MailRouter } from '../mail/router';
import type { MailComposeInput } from '../../shared/types';
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
  registerServer('mail:list', () => readMail());
  registerServer('mail:compose', (_e, input: MailComposeInput) => router().compose(input));
  registerServer('mail:reply', (_e, conversationId: string, body: string) =>
    router().reply(conversationId, body)
  );
  registerServer('mail:addParticipant', (_e, conversationId: string, personaId: string) =>
    router().addParticipant(conversationId, personaId)
  );
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

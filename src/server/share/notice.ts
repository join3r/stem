// The "someone opened your link" mail for recipient-locked share links
// (docs/public-share-design.md). One private conversation per notice, from
// Stem to the user: private, so memory never learns who opened what.
import { appendMailItem, createConversation } from '../workspace/mail';
import type { ShareOpen, SharedLink } from '../../shared/share';

export function shareOpenedText(link: SharedLink, opens: ShareOpen[]): { subject: string; body: string } {
  const who = opens.map((o) => o.address);
  const names = who.length > 1 ? `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}` : who[0];
  return {
    subject: `Shared link opened: ${link.title}`,
    body:
      `${names} opened the link you shared, “${link.title}”.\n\n` +
      'Settings → Features → Shared links shows who opened each of your links. Revoke a link there to stop it.'
  };
}

export async function mailShareOpened(link: SharedLink, opens: ShareOpen[]): Promise<void> {
  if (!opens.length) return;
  const { subject, body } = shareOpenedText(link, opens);
  const conversation = await createConversation(subject, ['normal'], body, { private: true });
  await appendMailItem({ conversationId: conversation.id, from: 'normal', to: ['user'], body });
}

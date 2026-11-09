import { registerServer } from './guard';
import { ShareService } from '../share/service';
import type { ChatBackend } from '../backend';
import type { InterStemService } from '../interstem/service';
import type { ShareCard, ShareOpen, ShareOptions, SharedLink, ShareSource } from '../../shared/share';

function source(raw: unknown): ShareSource {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.kind === 'chat' && typeof o.threadId === 'string' && o.threadId) return { kind: 'chat', threadId: o.threadId };
  if (o.kind === 'mail' && typeof o.conversationId === 'string' && o.conversationId) {
    return { kind: 'mail', conversationId: o.conversationId };
  }
  throw new Error('Nothing to share.');
}

/** Only the fields the dialog sends, each type-checked: the snapshot rules depend on them. */
function options(raw: unknown): ShareOptions {
  const o = (raw ?? {}) as Record<string, unknown>;
  const card = o.card;
  return {
    ...(o.scope === 'thread' || o.scope === 'pair' || o.scope === 'answer' ? { scope: o.scope } : {}),
    ...(typeof o.anchorId === 'string' && o.anchorId ? { anchorId: o.anchorId } : {}),
    ...(o.includeAttachments === true ? { includeAttachments: true } : {}),
    ...(o.includeModel === false ? { includeModel: false } : {}),
    ...(typeof o.ttlDays === 'number' && Number.isFinite(o.ttlDays) && o.ttlDays > 0 ? { ttlDays: o.ttlDays } : {}),
    ...(card && typeof card === 'object'
      ? { card: { title: String((card as ShareCard).title ?? ''), description: String((card as ShareCard).description ?? '') } }
      : {}),
    ...(Array.isArray(o.recipients) ? { recipients: o.recipients.filter((r): r is string => typeof r === 'string') } : {})
  };
}

/** Public share links (docs/public-share-design.md). */
export function registerShareIpc(deps: {
  runtime(): ChatBackend;
  interStem(): InterStemService | null;
  onOpened?: (link: SharedLink, opens: ShareOpen[]) => Promise<void>;
}): void {
  const service = new ShareService(deps);
  service.startPolling();
  registerServer('share:status', () => service.status());
  registerServer('share:preview', (_e, src: unknown, opts?: unknown) => service.preview(source(src), options(opts)));
  registerServer('share:create', (_e, src: unknown, opts?: unknown) => service.create(source(src), options(opts)));
  registerServer('share:list', () => service.list());
  registerServer('share:revoke', (_e, id: string) => service.revoke(id));
}

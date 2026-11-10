// Public share links (docs/public-share-design.md): build a snapshot of a chat
// or mail conversation (or one answer of it), encrypt it here, upload the blob to the global relay under
// the user's verified address, and keep the link so it can be copied again
// or revoked.
import type { ChatBackend } from '../backend';
import { CLOSED_DOMAIN_SHARE, ShareUnavailableError, type InterStemService } from '../interstem/service';
import { deleteShare, listShares, postShare, RelayError, type Identity } from '../interstem/relay-client';
import { degrade } from '../degrade';
import { readMailConversation } from '../workspace/mail';
import { remoteImageFor } from '../chats/remote-image';
import { faviconFor } from '../chats/favicon';
import { readChatAudio } from '../files/chat-audio';
import { listPersonas } from '../workspace/personas';
import type { ModelSummary, Persona } from '../../shared/types';
import {
  SHARE_CARD_DESC_MAX,
  SHARE_CARD_TITLE_MAX,
  SHARE_MAX_LINKS,
  SHARE_MAX_RECIPIENTS,
  SHARE_MAX_TTL_DAYS,
  normalizeRecipient,
  type ShareOpen,
  type ShareOptions,
  type SharePreview,
  type ShareCard,
  type SharedLink,
  type ShareSource,
  type ShareStatus
} from '../../shared/share';
import { buildSnapshot, chatMessages, mailMessages, ShareInputError, type SnapshotSource } from './snapshot';
import { keyFragment, sealShare } from './seal';
import { ShareStore } from './store';

/** The relay's default blob cap; a bigger snapshot fails before upload. */
export const MAX_SHARE_BYTES = 12 << 20;

export interface ShareDeps {
  runtime(): ChatBackend;
  interStem(): InterStemService | null;
  store?: ShareStore;
  /** Tests swap the relay calls. */
  upload?: typeof postShare;
  remove?: typeof deleteShare;
  relayList?: typeof listShares;
  /**
   * A recipient opened a locked link for the first time. The server posts a
   * mail to the user; absent = no notice.
   */
  onOpened?: (link: SharedLink, opens: ShareOpen[]) => Promise<void>;
  /** Tests swap the mail store and the persona list. */
  readMail?: typeof readMailConversation;
  personas?: () => Promise<Persona[]>;
  /** Tests swap what the app fetches as it draws a reply. */
  webImage?: (threadId: string, url: string) => Promise<string | null>;
  readAudio?: typeof readChatAudio;
  favicon?: typeof faviconFor;
  now?: () => number;
}

/** A model id as the chat header names it (renderer/chat/ChatView.tsx metaTooltip, without the effort). */
function modelLabels(models: ModelSummary[]): (id: string) => string | undefined {
  return (id) => {
    const m = models.find((x) => x.id === id);
    return m ? `${m.displayName} · ${m.providerName}` : undefined;
  };
}

/** One line each, within the relay's limits; nothing left = no card. */
function cleanCard(card: ShareOptions['card']): ShareCard | null {
  if (!card) return null;
  const line = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const out = { title: line(card.title, SHARE_CARD_TITLE_MAX), description: line(card.description, SHARE_CARD_DESC_MAX) };
  return out.title || out.description ? out : null;
}

/** A persona id as the user knows it (renderer/mail/useMail.ts personaName). */
function personaName(personas: Persona[], id: string): string {
  if (id.startsWith('task:')) return 'Scheduled task';
  const at = id.lastIndexOf('~');
  if (at > 0) {
    const role = personas.find((p) => p.id === id.slice(0, at))?.name;
    return role ? `${id.slice(at + 1)} (${role})` : id.slice(at + 1);
  }
  return personas.find((p) => p.id === id)?.name ?? 'Stem';
}

function relayMessage(err: unknown): Error {
  if (!(err instanceof RelayError)) return err instanceof Error ? err : new Error(String(err));
  switch (err.code) {
    case 'too_large':
      return new Error('This is too big to share. Leave out the pictures, or share one answer instead of the whole chat.');
    case 'rate_limited':
      return new Error('You have shared a lot today. Try again tomorrow.');
    case 'quota_full':
      return new Error('Your shared links are using all their space. Revoke some old ones in Settings and try again.');
    case 'too_many_links':
      return new Error(
        `You already have ${SHARE_MAX_LINKS} working links. Revoke some in Settings → Features → Shared links, or wait for old ones to expire.`
      );
    case 'bad_ttl':
      return new Error(`A link can last at most ${SHARE_MAX_TTL_DAYS} days.`);
    case 'suspended':
      return new Error('Sharing is suspended for your address. Write to the Stem team if you think this is a mistake.');
    case 'closed_relay':
      return new Error(CLOSED_DOMAIN_SHARE);
    case 'share_disabled':
      return new Error('The share service is not available right now.');
    case 'bad_recipients':
      return new Error(`Check the email addresses. A link can name at most ${SHARE_MAX_RECIPIENTS} people.`);
    default:
      return new Error(`The share service refused the upload (${err.code}).`);
  }
}

/** Clean, deduplicated recipients; throws on an address that is not one. */
export function cleanRecipients(raw: string[] | undefined): string[] {
  const out: string[] = [];
  for (const r of raw ?? []) {
    if (!r.trim()) continue;
    const a = normalizeRecipient(r);
    if (!a) throw new ShareInputError(`“${r.trim()}” is not an email address.`);
    if (!out.includes(a)) out.push(a);
  }
  if (out.length > SHARE_MAX_RECIPIENTS) throw new ShareInputError(`A link can name at most ${SHARE_MAX_RECIPIENTS} people.`);
  return out;
}

/** How often the server asks the relay who opened its locked links. */
export const OPENS_POLL_MS = 10 * 60_000;

export class ShareService {
  private readonly store: ShareStore;
  private readonly upload: typeof postShare;
  private readonly remove: typeof deleteShare;
  private readonly relayList: typeof listShares;
  private syncing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly readMail: typeof readMailConversation;
  private readonly personas: () => Promise<Persona[]>;
  private readonly now: () => number;

  constructor(private readonly deps: ShareDeps) {
    this.store = deps.store ?? new ShareStore();
    this.upload = deps.upload ?? postShare;
    this.remove = deps.remove ?? deleteShare;
    this.relayList = deps.relayList ?? listShares;
    this.readMail = deps.readMail ?? readMailConversation;
    this.personas = deps.personas ?? listPersonas;
    this.now = deps.now ?? Date.now;
  }

  private async identity(): Promise<{ relay: string; address: string; identity: Identity }> {
    const s = this.deps.interStem();
    if (!s) throw new ShareUnavailableError('no_address', 'Mail with other Stems is not running on this server.');
    return s.shareIdentity();
  }

  async status(): Promise<ShareStatus> {
    const s = this.deps.interStem();
    if (!s) return { available: false, code: 'not_running', message: 'Mail with other Stems is not running on this server.' };
    try {
      const st = await s.status();
      if (st.policy) {
        return { available: false, code: 'policy', message: 'Your organization has turned off sharing outside the company.' };
      }
      const address = await s.defaultSelf();
      if (!address) {
        return {
          available: false,
          code: 'no_address',
          message: 'Sharing needs a verified email address, so every public link traces back to a real person.'
        };
      }
      if (await s.closedDomain(address)) return { available: false, code: 'policy', message: CLOSED_DOMAIN_SHARE };
      return { available: true, address };
    } catch (err) {
      degrade('share', 'could not read the share status', err);
      return { available: false, code: 'not_running', message: 'Could not check your address. Try again in a moment.' };
    }
  }

  private modelList: { at: number; list: Promise<ModelSummary[]> } | null = null;

  /**
   * The model catalog, for the names in the header. Kept a few minutes (the
   * preview rebuilds on every option change) and never waited on for long:
   * without it the header shows the model id.
   */
  private models(rt: ChatBackend): Promise<ModelSummary[]> {
    if (!this.modelList || this.now() - this.modelList.at > 5 * 60_000) {
      const list = Promise.resolve()
        .then(() => rt.listModels())
        .catch((e) => {
          degrade('share', 'could not list the models for the share header', e);
          this.modelList = null;
          return [] as ModelSummary[];
        });
      this.modelList = { at: this.now(), list };
    }
    return Promise.race([this.modelList.list, new Promise<ModelSummary[]>((r) => setTimeout(() => r([]), 3000).unref?.())]);
  }

  private async source(source: ShareSource): Promise<SnapshotSource> {
    const rt = this.deps.runtime();
    const models = await this.models(rt);
    const shared = {
      // What the app fetches from the server as it draws a reply. The page
      // has no server to ask, so the snapshot carries the bytes.
      audio: async (id: string, threadId: string) => {
        const hit = await (this.deps.readAudio ?? readChatAudio)(threadId, id);
        return hit ? { mime: hit.mime, data: hit.data.toString('base64') } : null;
      },
      favicon: this.deps.favicon ?? faviconFor,
      modelLabel: modelLabels(models)
    };
    if (source.kind === 'chat') {
      const h = await rt.readThread(source.threadId);
      const threadId = source.threadId;
      return {
        title: h.title,
        messages: chatMessages(h.messages),
        image: (id, imageThread) => rt.findThreadImage(imageThread ?? threadId, id),
        // The same check the chat's own pictures pass (chats:remoteImage).
        webImage: (url) =>
          this.deps.webImage
            ? this.deps.webImage(threadId, url)
            : remoteImageFor(threadId, url, (t, u) => rt.urlCameFromInput(t, u)),
        ...shared
      };
    }
    const { conversation, items } = await this.readMail(source.conversationId);
    if (!conversation) throw new ShareInputError('That mail conversation is gone.');
    // Another person's mail is theirs to publish, not ours; the memory check is the user's memory.
    if (conversation.external || conversation.outside) throw new ShareInputError('Mail with another person can’t be shared publicly.');
    if (conversation.owner) throw new ShareInputError('This conversation can’t be shared.');
    const personas = await this.personas();
    // No webImage: the mail view shows web pictures as links, so the share does too.
    return {
      title: conversation.subject,
      messages: mailMessages(items, (id) => personaName(personas, id)),
      image: (id, threadId) => (threadId ? rt.findThreadImage(threadId, id) : Promise.resolve(null)),
      ...shared
    };
  }

  async preview(source: ShareSource, opts: ShareOptions = {}): Promise<SharePreview> {
    return buildSnapshot(await this.source(source), opts, this.now());
  }

  async create(source: ShareSource, opts: ShareOptions = {}): Promise<SharedLink> {
    const ttlDays = Math.min(SHARE_MAX_TTL_DAYS, Math.max(1, Math.floor(opts.ttlDays ?? SHARE_MAX_TTL_DAYS)));
    const recipients = cleanRecipients(opts.recipients);
    const { snapshot } = await this.preview(source, opts);
    const { blob, key } = sealShare(JSON.stringify(snapshot));
    if (blob.length > MAX_SHARE_BYTES) throw relayMessage(new RelayError(413, 'too_large'));
    const { relay, identity } = await this.identity();
    let made;
    try {
      made = await this.upload(relay, identity, blob, ttlDays, cleanCard(opts.card), recipients);
    } catch (err) {
      throw relayMessage(err);
    }
    // A relay without locked links ignores the list and makes the link
    // public. Its answer then has no recipients: take the link down at once.
    if (recipients.length && (made.recipients?.length ?? 0) !== recipients.length) {
      await this.remove(relay, identity, made.id).catch((e) => degrade('share', 'could not take down an unlocked link', e));
      throw new Error('The share service cannot lock links to people yet. Nothing was shared.');
    }
    const link: SharedLink = {
      id: made.id,
      url: `${made.url}#${keyFragment(key)}`,
      source,
      scope: opts.scope ?? 'thread',
      kind: snapshot.kind,
      title: snapshot.title,
      createdAt: this.now(),
      expiresAt: made.expires || this.now() + ttlDays * 86_400_000,
      size: blob.length,
      ...(recipients.length ? { recipients, opens: [] } : {})
    };
    await this.store.add(link);
    return link;
  }

  /** The links, after a short try to refresh who opened the locked ones. */
  async list(): Promise<SharedLink[]> {
    const links = await this.store.list(this.now());
    if (links.some((l) => l.recipients?.length)) {
      await Promise.race([this.syncOpens(), new Promise((r) => setTimeout(r, 4000))]);
      return this.store.list(this.now());
    }
    return links;
  }

  /**
   * Ask the relay who opened the locked links, store it, and tell the user
   * about each recipient's first opening. One run at a time.
   */
  syncOpens(): Promise<void> {
    this.syncing ??= this.doSyncOpens()
      .catch((e) => degrade('share', 'could not read who opened the shared links', e))
      .finally(() => (this.syncing = null));
    return this.syncing;
  }

  private async doSyncOpens(): Promise<void> {
    const locked = (await this.store.list(this.now())).filter((l) => l.recipients?.length);
    if (!locked.length) return;
    const { relay, identity } = await this.identity();
    const remote = new Map((await this.relayList(relay, identity)).map((r) => [r.id, r]));
    for (const link of locked) {
      const r = remote.get(link.id);
      if (!r) continue;
      const opens: ShareOpen[] = (r.opens ?? []).map((o) => ({ address: o.address, firstAt: o.first, lastAt: o.last, count: o.count }));
      const before = link.opens ?? [];
      const same =
        opens.length === before.length &&
        opens.every((o) => before.some((b) => b.address === o.address && b.lastAt === o.lastAt && b.count === o.count));
      if (same) continue;
      await this.store.setOpens(link.id, opens);
      const fresh = opens.filter((o) => !before.some((b) => b.address === o.address));
      if (fresh.length && this.deps.onOpened) await this.deps.onOpened(link, fresh);
    }
  }

  /** Check for openings now and then; a no-op while no locked link exists. */
  startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.syncOpens(), OPENS_POLL_MS);
    this.timer.unref?.();
    setTimeout(() => void this.syncOpens(), 30_000).unref?.();
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Take the link down on the relay, then forget it here. */
  async revoke(id: string): Promise<SharedLink[]> {
    const { relay, identity } = await this.identity();
    try {
      await this.remove(relay, identity, id);
    } catch (err) {
      if (!(err instanceof RelayError && err.status === 404)) throw relayMessage(err);
    }
    await this.store.remove(id);
    return this.list();
  }
}

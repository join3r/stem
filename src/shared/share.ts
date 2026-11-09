// Public share links (docs/public-share-design.md). The snapshot is what a
// viewer decrypts and renders; the server builds it (src/server/share), the
// in-app preview and the share.heystem.app viewer both draw it with
// renderer/share/ShareView. No imports: the viewer bundle pulls this in.

export const SHARE_SNAPSHOT_VERSION = 1;

export interface ShareImage {
  mime: string;
  dataUrl: string;
  alt?: string;
}

export interface ShareMessage {
  role: 'user' | 'assistant';
  /** Who wrote it, when not just "Stem" (a mail persona's name). */
  author?: string;
  /** User text is plain; assistant text is MDX. */
  text: string;
  /** ISO timestamp. */
  createdAt?: string;
  /** Assistant only, when the sharer kept it: the model id. */
  model?: string;
  /** Generated pictures (assistant) or attached ones (user, opt-in). */
  images?: ShareImage[];
  sources?: { url: string; title?: string }[];
}

export interface ShareSnapshot {
  v: number;
  kind: 'answer' | 'thread';
  title: string;
  /** Unix ms. */
  sharedAt: number;
  messages: ShareMessage[];
}

/** What is shared from: a chat, or a mail conversation. */
export type ShareSource = { kind: 'chat'; threadId: string } | { kind: 'mail'; conversationId: string };

/**
 * How much: the whole chat or mail thread, the answer with the question
 * before it, or the answer alone. `pair` and `answer` need `anchorId`.
 */
export type ShareScope = 'thread' | 'pair' | 'answer';

/** Links last at most this long; the relay refuses longer (abuse: no permanent hosting). */
export const SHARE_MAX_TTL_DAYS = 30;
export const SHARE_TTL_CHOICES = [30, 7, 1] as const;
/** Live links per address, enforced by the relay. */
export const SHARE_MAX_LINKS = 100;
/** Most people one locked link names, enforced by the relay. */
export const SHARE_MAX_RECIPIENTS = 20;

/** A plausible email address, lowercased and trimmed; null when it is not one. */
export function normalizeRecipient(raw: string): string | null {
  const a = raw.trim().toLowerCase();
  return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(a) && a.length <= 254 ? a : null;
}

/**
 * The link preview chat apps show when the link is pasted (og: tags). Unlike
 * the page it is published in the clear, so the sharer sees and can edit it.
 */
export interface ShareCard {
  title: string;
  description: string;
}

export const SHARE_CARD_TITLE_MAX = 120;
export const SHARE_CARD_DESC_MAX = 300;

function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}

/** MDX/Markdown as one plain line: what a preview can show of an answer. */
export function plainExcerpt(text: string, max = SHARE_CARD_DESC_MAX): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ' ')
    .replace(/[#>*_`~|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clipWords(plain, max);
}

/** The preview a snapshot suggests: its title, and the start of the first answer. */
export function suggestCard(snap: ShareSnapshot): ShareCard {
  const answer = snap.messages.find((m) => m.role === 'assistant');
  return {
    title: clipWords(snap.title.replace(/\s+/g, ' ').trim(), SHARE_CARD_TITLE_MAX),
    description: answer ? plainExcerpt(answer.text) : ''
  };
}

export interface ShareOptions {
  scope?: ShareScope;
  /** The answer the user shared from: a chat turn id, or a mail item id. */
  anchorId?: string;
  /** Include pictures the user attached. Off by default. */
  includeAttachments?: boolean;
  /** Show which model answered. On by default. */
  includeModel?: boolean;
  /** Days until the link stops working (1–30; default 30). */
  ttlDays?: number;
  /** The link preview to publish; absent or null = none (a generic card). */
  card?: ShareCard | null;
  /**
   * Only these addresses may open the link: a visitor must enter a code the
   * relay mails to one of them. Absent or empty = anyone with the link.
   */
  recipients?: string[];
}

/** One recipient's openings of a locked link. */
export interface ShareOpen {
  address: string;
  /** Unix ms. */
  firstAt: number;
  /** Unix ms. */
  lastAt: number;
  count: number;
}

/** A link this Stem published, as listed in Settings. */
export interface SharedLink {
  id: string;
  /** The full link, key fragment included. */
  url: string;
  source: ShareSource;
  scope: ShareScope;
  kind: 'answer' | 'thread';
  title: string;
  /** Unix ms. */
  createdAt: number;
  /** Unix ms. */
  expiresAt: number;
  size: number;
  /** A locked link: the only addresses that may open it. */
  recipients?: string[];
  /** A locked link: who opened it, as the relay last reported. */
  opens?: ShareOpen[];
}

/** What the preview shows next to the rendered snapshot. */
export interface SharePreview {
  snapshot: ShareSnapshot;
  /** Plaintext size before compression, so the dialog can warn early. */
  bytes: number;
  /** Pictures the user attached that the snapshot leaves out (the toggle is off). */
  omittedAttachments: number;
  /** The link preview this snapshot suggests (the dialog lets the user edit it). */
  card: ShareCard;
}

/** Whether this Stem can publish, and under which address. */
export interface ShareStatus {
  available: boolean;
  /** Present when not available. */
  code?: 'no_address' | 'policy' | 'not_running';
  message?: string;
  address?: string;
}

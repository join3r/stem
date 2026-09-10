import type { EpisodicStats, MemoryContents, MemoryNoteResult, MemorySettings, ThreadSummary, TurnAttachment } from '../../shared/types';

import { resolveAttachments } from '../pi/attachments';
import { vacuumRecallDb } from '../recall/scan';
import { recallStore, type FactImageInput } from '../recall/store';
import { listConnectedFolders } from './connected-folders';
const { addFactImages, deleteFact, deleteThreadSummary, getAllFacts, getEpisodicLimitBytes, getEpisodicStats, getFactEvidenceCounts, getFactImageCounts, getMaxRelevantFacts, getMeta, getTidyThreshold, listThreadSummaries: storeListThreadSummaries, resetEpisodic, resetFacts, setEpisodicLimitBytes, setMaxRelevantFacts, setMeta, setTidyThreshold, upsertFact } = recallStore;

// Stem's memory control surface, backed entirely by Stem Recall (recall.sqlite).
//
// This module owns:
//  - the explicit "remember that …" fast-path (writes a durable Level-1 fact),
//  - the on/off toggle + the Manage-panel "Stored memory" view.
// Episodic capture/search/injection live in src/server/recall/.

const RECALL_ENABLED_KEY = 'recall_enabled';

export function isRecallEnabled(): boolean {
  return getMeta(RECALL_ENABLED_KEY) !== 'false';
}

export async function getMemorySettings(): Promise<MemorySettings> {
  const enabled = isRecallEnabled();
  // The legacy three-flag shape is kept for the IPC/UI contract; for Stem Recall
  // the single enabled flag governs both capture (generate) and injection (use).
  return {
    enabled,
    useMemories: enabled,
    generateMemories: enabled,
    episodicLimitBytes: getEpisodicLimitBytes(),
    tidyThreshold: getTidyThreshold(),
    maxRelevantFacts: getMaxRelevantFacts()
  };
}

/** Set the episodic-store size cap (bytes; 0 = unlimited); returns refreshed settings. */
export async function setEpisodicLimit(bytes: number): Promise<MemorySettings> {
  setEpisodicLimitBytes(bytes);
  return getMemorySettings();
}

/** Set the auto-tidy-up fact threshold (0 = manual only); returns refreshed settings. */
export async function setTidyUpThreshold(n: number): Promise<MemorySettings> {
  setTidyThreshold(n);
  return getMemorySettings();
}

/** Cap on relevance-ranked facts injected per turn (pinned facts are extra). */
export async function setMaxRelevantFactCount(n: number): Promise<MemorySettings> {
  setMaxRelevantFacts(n);
  return getMemorySettings();
}

export async function setMemoryEnabled(enabled: boolean): Promise<MemorySettings> {
  setMeta(RECALL_ENABLED_KEY, enabled ? 'true' : 'false');
  return getMemorySettings();
}

// ---- explicit "remember that …" capture ----

interface MemoryCaptureResult {
  captured: boolean;
  shouldAcknowledge: boolean;
  factId?: number;
  path?: string;
}

export function isSensitiveMemoryText(text: string): boolean {
  return /\b(?:password|passcode|pin|api[_ -]?key|token|secret|private key|seed phrase|recovery phrase|credit card|card number|cvv|ssn|social security|national id|government id|birth number)\b/i.test(
    text
  );
}

function explicitSensitivity(text: string): 'standard' | 'sensitive' {
  return /\b(?:health|diagnos|allerg|medic|doctor|hospital|finance|salary|income|debt|mortgage|bank|address|phone|email|appointment|reservation)\b/i.test(text)
    ? 'sensitive'
    : 'standard';
}

function hasExplicitRememberIntent(text: string): boolean {
  // Normalize typographic apostrophes before matching contractions. User input
  // commonly arrives with a curly apostrophe (for example, “Don’t remember”).
  const normalized = text.trim().replace(/[\u2018\u2019]/g, "'");
  if (!normalized) return false;
  // Flatten punctuation for intent grammar while retaining apostrophes used by
  // contractions. This lets an imperative negation keep governing "remember"
  // through scoped adverbials such as "Never, under any circumstances, remember"
  // without making an unrelated earlier "never" negate a later request.
  const intent = normalized
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/\b(?:do|did)\s+you\s+remember\b/i.test(normalized)) return false;
  if (/\bwhat\s+.*\bremember\b/i.test(normalized)) return false;
  if (
    /\b(?:never|don't|do not|can't|cannot)(?:\s+(?:(?:ever|again)|(?:under|in)\s+(?:any|no)\s+circumstances|in\s+(?:any|no)\s+(?:case|event)|for\s+(?:any|no)\s+reason|no\s+matter\s+what))*\s+remember\b/i.test(intent)
  ) return false;
  if (/\b(?:never|don't|do not)\s+want\s+(?:(?:you|stem)\s+)?to\s+(?:ever\s+)?remember\b/i.test(normalized)) return false;
  if (/\b(?:never|don't|do not)\s+(?:ever\s+)?keep\s+(?:this\s+)?in\s+mind\b/i.test(normalized)) return false;
  return (
    /\bplease\s+remember(?:\s+that)?\b/i.test(normalized) ||
    /\bremember\s+that\b/i.test(normalized) ||
    /^remember[:,]?\s+/i.test(normalized) ||
    /\bcan\s+you\s+remember(?:\s+that)?\b/i.test(normalized) ||
    /\bkeep\s+in\s+mind\b/i.test(normalized)
  );
}

function memoryStatement(text: string): string {
  return text
    .trim()
    .replace(/\bplease\s+remember(?:\s+that)?\b/gi, '')
    .replace(/\bcan\s+you\s+remember(?:\s+that)?\b/gi, '')
    .replace(/^remember[:,]?\s+/i, '')
    .replace(/\bremember\s+that\b/gi, '')
    .replace(/\bkeep\s+in\s+mind\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[,.:;\s]+|[,.:;\s]+$/g, '')
    .trim();
}

/**
 * Handle an "I want you to remember X" user message by storing X as a durable
 * fact. Returns shouldAcknowledge so the runtime can short-circuit the turn with
 * a confirmation instead of sending it to the model.
 */
export async function captureMemoryFromUserInput(text: string): Promise<MemoryCaptureResult> {
  if (!isRecallEnabled()) return { captured: false, shouldAcknowledge: false };
  if (!hasExplicitRememberIntent(text)) return { captured: false, shouldAcknowledge: false };

  const statement = memoryStatement(text);
  if (!statement || statement.length > 500 || isSensitiveMemoryText(statement)) {
    return { captured: false, shouldAcknowledge: false };
  }

  const factId = upsertFact(statement, {
    source: 'explicit',
    confidence: 1,
    sensitivity: explicitSensitivity(statement),
    evidence: [{
      messageId: null,
      threadId: null,
      role: 'user',
      timestamp: Math.floor(Date.now() / 1000),
      excerpt: text,
      origin: 'explicit_user'
    }]
  });
  return { captured: true, shouldAcknowledge: true, factId: factId ?? undefined };
}

/** Longest note we store verbatim. Generous because a note may be a pasted wall
 *  of text that the background pass splits into individual facts; the cap only
 *  guards the store against runaway pastes. Truncate rather than refuse: unlike
 *  the chat capture above (which guesses intent), a /note submission is
 *  deliberate. */
const MAX_NOTE_LENGTH = 20_000;

/** Most images one note may carry, and the largest one we keep. A note is one
 *  thing to remember; a photo dump belongs in a chat. The byte cap matches what
 *  the transport already accepts on one RPC and keeps recall.sqlite from growing
 *  by a camera roll's worth per note. */
export const MAX_NOTE_IMAGES = 4;
export const MAX_NOTE_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Turn a note's attachments into storable images. Null when any attachment is
 * not a usable image: an unsupported file, unreadable bytes, too many, or one
 * over the cap. All-or-nothing, so a note never lands with a picture quietly
 * missing — the renderer keeps the draft and says why.
 */
async function noteImagesOf(attachments: TurnAttachment[]): Promise<FactImageInput[] | null> {
  if (attachments.length === 0) return [];
  if (attachments.length > MAX_NOTE_IMAGES) return null;
  const { images, textBlocks, rejected } = await resolveAttachments(attachments);
  if (textBlocks.length > 0 || rejected.length > 0 || images.length !== attachments.length) return null;
  const out: FactImageInput[] = [];
  for (let i = 0; i < images.length; i++) {
    const bytes = Buffer.from(images[i].data, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_NOTE_IMAGE_BYTES) return null;
    out.push({ name: attachments[i].name || `image-${i + 1}`, mime: images[i].mimeType, bytes });
  }
  return out;
}

/**
 * The text an image-only note is stored under until the background pass has
 * described the picture. Stamped so two photo notes never collapse onto one
 * fact through the norm-unique upsert (the description replaces this anyway).
 */
export function imageNotePlaceholder(names: string[], now = new Date()): string {
  return `Image note (${names.join(', ')}) saved ${now.toISOString()}`;
}

/**
 * Store a user-typed quick note (composer `/note` / `//`) as a durable explicit
 * fact — no chat turn, no LLM on the save path. Never throws; the renderer gets
 * a result object it can turn into inline feedback.
 *
 * Attached images are stored with the fact (see fact_images). Their content
 * reaches the fact's TEXT only through the background pass (recall/note.ts),
 * which needs the model — so an image-only note is durable at once under a
 * placeholder statement and gets its real wording when the description lands.
 */
export async function addMemoryNote(text: string, attachments: TurnAttachment[] = []): Promise<MemoryNoteResult> {
  const typed = text.trim().slice(0, MAX_NOTE_LENGTH).trim();
  if (!typed && attachments.length === 0) return { saved: false, reason: 'empty' };
  if (!isRecallEnabled()) return { saved: false, reason: 'disabled' };
  if (isSensitiveMemoryText(typed)) return { saved: false, reason: 'secret' };

  const images = await noteImagesOf(attachments);
  if (images === null) return { saved: false, reason: 'image' };
  const statement = typed || imageNotePlaceholder(images.map((i) => i.name));

  const factId = upsertFact(statement, {
    source: 'explicit',
    confidence: 1,
    sensitivity: explicitSensitivity(statement),
    evidence: [{
      messageId: null,
      threadId: null,
      role: 'user',
      timestamp: Math.floor(Date.now() / 1000),
      excerpt: typed || `[image: ${images.map((i) => i.name).join(', ')}]`,
      origin: 'explicit_user'
    }]
  });
  if (factId == null) return { saved: false, reason: 'empty' };
  addFactImages(factId, images);
  return { saved: true, factId };
}

// ---- Manage panel "Stored memory" view ----

function sourceLabel(source: string, folderLabels: Map<string, string>): string {
  if (source === 'explicit') return 'On request';
  if (source === 'legacy') return 'Legacy';
  if (source.startsWith('folder:')) {
    const label = folderLabels.get(source.slice('folder:'.length));
    return label ? `From ${label}` : 'From a disconnected folder';
  }
  return 'Learned';
}

/**
 * Surface durable facts (Level 1) for the Manage panel. Each fact is rendered as
 * a "note". The deeper episodic store (Level 2) isn't listed here — it's searched,
 * not browsed.
 */
export async function readMemoryFiles(): Promise<MemoryContents> {
  // Browse view: show every fact (newest first), not just the most recent 100 —
  // the old cap silently hid older facts from the Manage panel.
  const facts = getAllFacts().sort((a, b) => b.updatedAt - a.updatedAt);
  const evidenceCounts = getFactEvidenceCounts();
  const imageCounts = getFactImageCounts();
  // Folder-learned facts (source `folder:<id>`) chip as "From <folder label>".
  const folderLabels = new Map(
    (await listConnectedFolders()).map((f) => [f.id, f.label] as const)
  );
  const files = facts.map((f) => ({
    name: `fact-${f.id}`,
    label: 'Fact',
    content: f.text,
    exists: true,
    kind: 'note' as const,
    id: f.id,
    statement: f.text,
    source: sourceLabel(f.source, folderLabels),
    category: f.category,
    sensitivity: f.sensitivity,
    confidence: f.confidence,
    status: f.status,
    pinned: f.pinned,
    validUntil: f.validUntil,
    evidenceCount: evidenceCounts.get(f.id) ?? 0,
    imageCount: imageCounts.get(f.id) ?? 0,
    timesInjected: f.timesInjected,
    timesUsed: f.timesUsed,
    lastUsedAt: f.lastUsedAt
  }));
  return {
    files,
    isEmpty: files.length === 0
  };
}

/** Exposed for a future "forget this" affordance in the UI. */
export async function forgetFact(id: number): Promise<void> {
  deleteFact(id);
}

/** Rolling thread summaries for the Memory → Recall sub-tab (newest activity first). */
export async function listThreadSummaries(): Promise<ThreadSummary[]> {
  return storeListThreadSummaries().map((s) => ({
    id: s.id,
    threadId: s.threadId,
    text: s.text,
    firstTs: s.firstTs,
    lastTs: s.lastTs,
    messageCount: s.messageCount,
    updatedAt: s.updatedAt
  }));
}

/** Delete one thread summary (user affordance — summaries derive from private chats).
 *  Returns the refreshed list. The thread resummarizes from scratch if it gets new
 *  messages later, since the watermark dies with the row. */
export async function removeThreadSummary(id: number): Promise<ThreadSummary[]> {
  deleteThreadSummary(id);
  return listThreadSummaries();
}

/** Wipe the episodic store (Level 2), keeping facts and the on/off toggle.
 *  Returns the refreshed (empty) episodic stats for the Recall sub-tab. */
export async function clearEpisodicMemory(): Promise<EpisodicStats> {
  // The deletes stay transactional on this thread; the multi-second VACUUM runs
  // in the scan worker when available (awaited, so the stats below reflect the
  // reclaimed file), inline otherwise.
  resetEpisodic({ skipVacuum: true });
  await vacuumRecallDb();
  return getEpisodicStats();
}

/** Wipe durable facts (Level 1), keeping the episodic store and the on/off
 *  toggle. Returns the refreshed (empty) facts view for the Facts sub-tab. */
export async function clearFactsMemory(): Promise<MemoryContents> {
  resetFacts();
  return readMemoryFiles();
}

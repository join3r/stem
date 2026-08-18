
import { getEmbeddingsClient } from './retrieval';
import { degrade } from '../degrade';
import { isRecallEnabled } from '../workspace/memory';
import type { LlmClient } from './llm';
import { recallStore, MAX_MERGED_SEGMENT_CHARS, MAX_SEGMENT_CHARS, MAX_SUMMARY_CHARS, type StoredMessage, type SummarySegmentRow } from './store';
const { addSummarySegment, getEpisodicGeneration, getSummaryByThread, getSummarySegments, getThreadMessagesAfter, getThreadsNeedingSummary, markSummaryRebuilt, replaceSummarySegments, upsertSummary, upsertSummaryVector } = recallStore;

// Level 1.5: one rolling English summary per thread — what the conversation
// covered, decided and left open — revised whenever the distill debounce finds
// new messages on a thread, plus a low-priority dormant backfill. Summaries are
// the injected episodic unit (see inject.ts); raw messages stay reachable via
// the MCP search_past_chats drill-down.
//
// Each summary keeps its OWN watermark (summaries.last_message_id), independent
// of distill_cursor_v2: a failed summary refresh never blocks fact extraction,
// and vice versa. On any LLM failure the watermark stays unmoved so the next
// pass retries the same window.
//
// Drift control: rolling revision alone re-compresses the previous summary
// every pass, so early details erode and errors compound. Each refresh
// therefore also stores an immutable per-window mini-summary (summary_segments,
// derived once from the raw window), and every REBUILD_EVERY revisions the
// thread summary is re-derived from those segments instead of from itself —
// keeping it at most two compression hops from the raw transcript. If a
// revision ever lands without its segment (weak model fell back to prose),
// segment coverage has a hole and the rebuild disables itself for that thread
// rather than silently dropping the uncovered window; behavior then degrades
// to the plain rolling summary.

/** Per-call transcript budget; larger backlogs finish over several passes. */
export const MAX_SUMMARY_TRANSCRIPT_CHARS = 12_000;
/** A single huge message can't monopolize the window. */
const MAX_CHARS_PER_MESSAGE = 2_000;
/** Noise gate: don't burn an LLM call on a couple of words. */
const MIN_NEW_MESSAGES = 2;
const MIN_NEW_CHARS = 200;
/** Rolling revisions between rebuild-from-segments passes. */
export const REBUILD_EVERY = 8;
/** Input budget for a rebuild; beyond it the oldest segments get compacted. */
const REBUILD_INPUT_BUDGET_CHARS = 12_000;

export const SUMMARY_INSTRUCTIONS = `You maintain a rolling summary of ONE conversation thread between a user and an assistant.

You are given the prior summary (possibly empty) and the new messages since it was written. Produce TWO things:
1. "segment": a self-contained mini-summary of ONLY the new messages (at most ${MAX_SEGMENT_CHARS - 100} characters).
2. "summary": a REVISED, self-contained summary of the whole thread so far.

Rules for both:
- Write in ENGLISH, regardless of the conversation's language.
- Cover: what was discussed, what was decided or concluded, key entities (people, places, products, amounts), resolved dates, and what remains open.
- Prefer concrete specifics over generalities; drop pleasantries and process chatter.
- Do not invent anything not present in the prior summary or the new messages; when new messages correct earlier information, keep only the corrected version.
- The revised summary: at most ${MAX_SUMMARY_CHARS - 500} characters. Plain prose, no headings or bullets.
- Output ONLY {"segment":"...","summary":"..."} as JSON.`;

export const REBUILD_INSTRUCTIONS = `You are rebuilding the summary of ONE conversation thread between a user and an assistant.

You are given the thread's mini-summaries in chronological order; each covers one consecutive slice of the conversation. Produce a single self-contained summary of the whole thread.

Rules:
- Write in ENGLISH.
- Cover: what was discussed, what was decided or concluded, key entities (people, places, products, amounts), resolved dates, and what remains open.
- Prefer concrete specifics over generalities. When a later slice corrects an earlier one, keep only the corrected version.
- Do not invent anything not present in the mini-summaries.
- At most ${MAX_SUMMARY_CHARS - 500} characters. Plain prose, no headings or bullets.
- Output ONLY {"summary":"..."} as JSON.`;

export const MERGE_INSTRUCTIONS = `You are condensing the OLDEST mini-summaries of one conversation thread into a single combined summary, to bound storage. They are chronological and each covers one consecutive slice.

Rules:
- Write in ENGLISH. Keep concrete specifics (people, places, products, amounts, dates) over generalities; when a later slice corrects an earlier one, keep only the corrected version.
- Do not invent anything not present in the input.
- At most ${MAX_MERGED_SEGMENT_CHARS - 200} characters. Plain prose, no headings or bullets.
- Output ONLY {"summary":"..."} as JSON.`;

/** Extract the revised summary from the model's reply. Null when unusable. */
export function parseSummary(output: string): string | null {
  const trimmed = output.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(trimmed.slice(start, end + 1)) as { summary?: unknown };
      if (typeof obj.summary === 'string' && obj.summary.trim().length >= 20) {
        return obj.summary.replace(/\s+/g, ' ').trim();
      }
    } catch {
      // quiet: models that answer in prose instead of JSON are the reason the
      // fallback below exists — it reads the same reply and usually accepts it.
    }
  }
  // Some models reply with the summary as plain prose despite the JSON ask.
  // Accept it when it can't be mistaken for malformed JSON or a refusal.
  if (!trimmed.startsWith('{') && trimmed.length >= 40) {
    return trimmed.replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY_CHARS);
  }
  return null;
}

/**
 * Extract the dual refresh reply. The summary is required; the segment is
 * best-effort (a summary-only or plain-prose reply still advances the rolling
 * summary, it just marks segment coverage as broken for this thread).
 */
export function parseDualSummary(output: string): { segment: string | null; summary: string | null } {
  const trimmed = output.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(trimmed.slice(start, end + 1)) as { segment?: unknown; summary?: unknown };
      const summary =
        typeof obj.summary === 'string' && obj.summary.trim().length >= 20
          ? obj.summary.replace(/\s+/g, ' ').trim()
          : null;
      const segment =
        typeof obj.segment === 'string' && obj.segment.trim().length >= 20
          ? obj.segment.replace(/\s+/g, ' ').trim()
          : null;
      if (summary || segment) return { segment, summary };
    } catch {
      // quiet: same as parseSummary — the single-summary/prose parser below gets
      // the same text, and a segment-less reply is an expected weak-model shape
      // the caller already handles (it marks the thread's segment coverage gapped).
    }
  }
  return { segment: null, summary: parseSummary(output) };
}

interface SummaryWindow {
  transcript: string;
  messages: StoredMessage[];
  lastIncludedId: number;
}

/** The bounded next window of a thread's messages past the summary watermark. */
function buildWindow(threadId: string, afterId: number): SummaryWindow | null {
  const source = getThreadMessagesAfter(threadId, afterId);
  if (source.length === 0) return null;
  let transcript = '';
  const included: StoredMessage[] = [];
  for (const message of source) {
    const text = message.text.length > MAX_CHARS_PER_MESSAGE
      ? `${message.text.slice(0, MAX_CHARS_PER_MESSAGE)}…`
      : message.text;
    const line = `[${new Date(message.ts * 1000).toISOString().slice(0, 10)} ${message.role}] ${text}`;
    if (transcript && transcript.length + line.length + 1 > MAX_SUMMARY_TRANSCRIPT_CHARS) break;
    transcript += `${transcript ? '\n' : ''}${line}`;
    included.push(message);
  }
  return included.length > 0
    ? { transcript, messages: included, lastIncludedId: included[included.length - 1].id }
    : null;
}

/** Cache the fresh summary vector so search doesn't wait for a backfill pass. Best-effort. */
async function embedSummary(summaryId: number, text: string, intact: () => boolean): Promise<void> {
  try {
    const emb = getEmbeddingsClient();
    if (!emb || !(await emb.available())) return;
    const model = (await emb.modelId()) ?? '';
    if (!model) return;
    const [vec] = await emb.embed([text], 'passage');
    if (vec && intact()) upsertSummaryVector(summaryId, model, vec);
  } catch {
    // quiet: this is a cache warm-up, not the write — the summary itself is
    // already stored, and getSummariesMissingVector hands it to the embed pass.
  }
}

function segmentLine(s: SummarySegmentRow): string {
  const from = new Date(s.firstTs * 1000).toISOString().slice(0, 10);
  const to = new Date(s.lastTs * 1000).toISOString().slice(0, 10);
  return `[${from}${to !== from ? `–${to}` : ''}] ${s.text}`;
}

/**
 * Re-derive the thread summary from its segments (≤2 hops from raw text),
 * compacting the oldest segments first when they outgrow the input budget.
 * Best-effort: returns the rebuilt text, or null to retry on a later pass
 * (the revision counter stays past the threshold until a rebuild succeeds).
 */
async function rebuildFromSegments(threadId: string, llm: LlmClient, intact: () => boolean): Promise<string | null> {
  let segments = getSummarySegments(threadId);
  if (segments.length < 2) {
    // Nothing to gain over the current rolling text — stop retrying for now.
    markSummaryRebuilt(threadId);
    return null;
  }
  let total = segments.reduce((n, s) => n + s.text.length, 0);
  if (total > REBUILD_INPUT_BUDGET_CHARS) {
    // Merge an oldest-first prefix until the projected total (merged row
    // included) fits comfortably; the merged row keeps the combined range.
    const toMerge: SummarySegmentRow[] = [];
    for (const seg of segments.slice(0, -1)) {
      if (total + MAX_MERGED_SEGMENT_CHARS <= REBUILD_INPUT_BUDGET_CHARS * 0.75) break;
      toMerge.push(seg);
      total -= seg.text.length;
    }
    if (toMerge.length >= 2) {
      const reply = await llm.complete(
        `${MERGE_INSTRUCTIONS}\n\nMini-summaries:\n${toMerge.map(segmentLine).join('\n')}`
      );
      const merged = parseSummary(reply);
      if (!merged || !intact()) return null;
      replaceSummarySegments(threadId, toMerge.map((s) => s.id), {
        text: merged,
        firstTs: toMerge[0].firstTs,
        lastTs: toMerge[toMerge.length - 1].lastTs,
        messageCount: toMerge.reduce((n, s) => n + s.messageCount, 0),
        lastMessageId: Math.max(...toMerge.map((s) => s.lastMessageId))
      });
      segments = getSummarySegments(threadId);
    }
  }
  const reply = await llm.complete(
    `${REBUILD_INSTRUCTIONS}\n\nMini-summaries:\n${segments.map(segmentLine).join('\n')}`
  );
  return parseSummary(reply);
}

/**
 * Revise one thread's rolling summary from the messages past its watermark.
 * Returns true when a summary was written. One bounded window per call; a large
 * backlog converges over successive passes. On LLM failure the watermark stays
 * unmoved and the next pass retries.
 */
export async function refreshThreadSummary(threadId: string, llm: LlmClient): Promise<boolean> {
  // Reset recall while a model call is in flight is a hard cancellation: every
  // write below is gated so erased content is never resurrected.
  const episodicGeneration = getEpisodicGeneration();
  const intact = () => getEpisodicGeneration() === episodicGeneration;
  const prior = getSummaryByThread(threadId);
  const window = buildWindow(threadId, prior?.lastMessageId ?? 0);
  if (!window) return false;
  // Noise gate — but never against a backlog: if the window filled to its cap
  // there is real material regardless of message count.
  const newChars = window.transcript.length;
  if (window.messages.length < MIN_NEW_MESSAGES && newChars < MIN_NEW_CHARS) return false;
  if (newChars < MIN_NEW_CHARS && !prior) return false;

  // Legacy seed: a thread summarized before segments existed has a rolling
  // summary but no segments. Adopt that text as the base segment so a rebuild
  // keeps the pre-segment history (it is multiply-compressed, but it is all
  // that remains of those windows in summary space).
  if (prior && !prior.segmentsGap && getSummarySegments(threadId).length === 0) {
    addSummarySegment({
      threadId,
      text: prior.text,
      firstTs: prior.firstTs,
      lastTs: prior.lastTs,
      messageCount: prior.messageCount,
      lastMessageId: prior.lastMessageId,
      maxChars: MAX_MERGED_SEGMENT_CHARS
    });
  }

  let parsed: { segment: string | null; summary: string | null };
  try {
    const today = new Date().toISOString().slice(0, 10);
    const reply = await llm.complete(
      `${SUMMARY_INSTRUCTIONS}\n\nToday's date: ${today}.\n\nPrior summary:\n${prior?.text ?? '(none — this is the first summary of this thread)'}\n\nNew messages:\n${window.transcript}`
    );
    parsed = parseDualSummary(reply);
  } catch (error) {
    // The retry is real, but so is the silence: `false` is also what a thread
    // with nothing new returns, so a model that is down reports as "Summarised
    // 0 chats" on the activity row for as long as it stays down.
    degrade('recall.summarize', 'left the thread summary unrevised', error);
    return false; // watermark unmoved — retried on the next distill touch
  }
  if (!parsed.summary || !intact()) return false;

  const segmentId = parsed.segment
    ? addSummarySegment({
        threadId,
        text: parsed.segment,
        firstTs: window.messages[0].ts,
        lastTs: window.messages[window.messages.length - 1].ts,
        messageCount: window.messages.length,
        lastMessageId: window.lastIncludedId
      })
    : null;

  const id = upsertSummary({
    threadId,
    text: parsed.summary,
    firstTs: window.messages[0].ts,
    lastTs: window.messages[window.messages.length - 1].ts,
    newMessageCount: window.messages.length,
    lastMessageId: window.lastIncludedId,
    segmentStored: segmentId != null
  });
  if (id == null) return false;

  // Periodic anti-drift rebuild: re-derive the summary from the segments once
  // enough rolling revisions accumulated. Best-effort — on failure the counter
  // stays past the threshold and the next refresh retries.
  let finalText = parsed.summary;
  const row = getSummaryByThread(threadId);
  if (row && !row.segmentsGap && row.revisionsSinceRebuild >= REBUILD_EVERY) {
    try {
      const rebuilt = await rebuildFromSegments(threadId, llm, intact);
      if (rebuilt && intact()) {
        upsertSummary({
          threadId,
          text: rebuilt,
          firstTs: row.firstTs,
          lastTs: row.lastTs,
          newMessageCount: 0,
          lastMessageId: row.lastMessageId,
          rebuilt: true
        });
        finalText = rebuilt;
      }
    } catch (error) {
      // Keep the rolling revision; the rebuild retries on a later pass. Until
      // one lands, the whole anti-drift mechanism is off and the summary keeps
      // re-compressing itself — visible only as summaries slowly going vague.
      degrade('recall.summarize', 'kept the rolling summary', error);
    }
  }
  await embedSummary(id, finalText.slice(0, MAX_SUMMARY_CHARS), intact);
  return true;
}

/**
 * Post-turn refresh: summarize the most recently active threads that have new
 * messages past their summary watermark (normally just the thread the user was
 * chatting in). Runs from the distill debounce.
 */
export async function refreshRecentSummaries(llm: LlmClient, maxThreads = 3): Promise<number> {
  if (!isRecallEnabled()) return 0;
  let written = 0;
  for (const { threadId } of getThreadsNeedingSummary(maxThreads, 'newest', {
    messages: MIN_NEW_MESSAGES,
    chars: MIN_NEW_CHARS
  })) {
    if (await refreshThreadSummary(threadId, llm)) written += 1;
  }
  return written;
}

/**
 * Dormant backfill: the same refresh, oldest-activity first, for threads that
 * predate summaries (or fell behind while the app was closed). Bounded per pass;
 * the scheduler in index.ts runs it while the user is idle.
 */
export async function backfillSummaries(llm: LlmClient, maxThreads = 3): Promise<number> {
  if (!isRecallEnabled()) return 0;
  let written = 0;
  for (const { threadId } of getThreadsNeedingSummary(maxThreads, 'oldest', {
    messages: MIN_NEW_MESSAGES,
    chars: MIN_NEW_CHARS
  })) {
    if (await refreshThreadSummary(threadId, llm)) written += 1;
  }
  return written;
}

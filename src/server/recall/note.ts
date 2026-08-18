
import { reconcileExplicitFact } from './reconcile';
import { parseClaims } from './distill';
import { degrade } from '../degrade';
import type { LlmClient } from './llm';
import { recallStore } from './store';
const { getFactDetails, getFactsGeneration, getInjectableFacts, supersedeFact, updateFactText, upsertFact } = recallStore;

// Post-processing for user-typed quick notes (composer `/note` / `//`). The note
// is already durable before anything here runs — this pass only improves it:
// facts are canonical third-person English ("The user ..."), and recall ranking
// works best on that shape, so a raw "radsej taby" note gets rewritten in place.
// A long note (a pasted wall of text) is instead SPLIT into individual facts,
// each one durable on its own, and the raw blob retired once the split lands.
// Every step is best-effort; an unreachable model leaves the raw note as-is.

/** Longest rewrite we accept — a canonical fact is a short statement, so a reply
 *  this long means the model padded or hallucinated rather than rewrote. */
const MAX_REWRITE_LENGTH = 500;

/** Above this, a note is treated as pasted source material to extract facts
 *  FROM rather than a single statement to rewrite — one canonical fact tops out
 *  well under this, so a longer note necessarily holds several. */
export const LONG_NOTE_THRESHOLD = 500;

function rewritePrompt(text: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `A user typed a quick note for a personal assistant's long-term memory. Rewrite it as ONE short third-person English statement about the user ("The user ...").

Note: ${text}
Today's date: ${today}

Rules:
- Write in ENGLISH; keep proper names, place names, and quoted identifiers as-is.
- Resolve relative dates ("tomorrow", "next Friday") to absolute dates using today's date.
- Do not add, infer, or drop information; preserve every specific (names, dates, amounts).
- If the note is already a clean third-person English statement, return it unchanged.
Return ONLY JSON {"text":"The user ..."}.`;
}

/**
 * Rewrite an explicit note into canonical fact form in place. Returns the id of
 * the surviving fact — `factId` when the rewrite was skipped or failed, or the
 * merge target when the canonical text lands on an already-stored claim.
 */
export async function normalizeExplicitNote(factId: number, llm: LlmClient): Promise<number> {
  const factsGeneration = getFactsGeneration();
  const fact = getFactDetails(factId);
  if (!fact || fact.status !== 'active' || fact.source !== 'explicit') return factId;
  const originalText = fact.text;

  let rewritten: string;
  try {
    const raw = await llm.complete(rewritePrompt(originalText));
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return factId;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { text?: unknown };
    if (typeof parsed.text !== 'string') return factId;
    rewritten = parsed.text.trim();
  } catch (error) {
    // The note is durable either way, but nothing retries this: a note typed in
    // Slovak stays in Slovak, and recall ranks it as the shape it is in.
    degrade('recall.note', "kept the note's raw wording", error);
    return factId;
  }
  if (!rewritten || rewritten.length > MAX_REWRITE_LENGTH || rewritten === originalText) return factId;

  // Reset is a hard cancellation barrier and fact ids can be reused afterward;
  // consolidation/user edits can also move the text under us. Re-check the epoch
  // and that the fact is still exactly the note we sent to the model.
  if (getFactsGeneration() !== factsGeneration) return factId;
  const current = getFactDetails(factId);
  if (!current || current.status !== 'active' || current.source !== 'explicit' || current.text !== originalText) {
    return factId;
  }
  return updateFactText(factId, rewritten) ?? factId;
}

function extractPrompt(text: string, known: Array<{ id: number; text: string }>): string {
  const today = new Date().toISOString().slice(0, 10);
  const knownBlock = known.length
    ? `\n\nKnown facts (do not restate):\n${known.map((f) => `[${f.id}] ${f.text}`).join('\n')}`
    : '';
  return `A user pasted a long note for a personal assistant's long-term memory. Break it into separate DURABLE facts about the user.

Note:
${text}

Today's date: ${today}${knownBlock}

Rules:
- Each fact is ONE short third-person ENGLISH statement ("The user ..."). Keep proper names, place names, and quoted identifiers as-is.
- Preserve the specifics worth remembering (names, dates, amounts, booking references); resolve relative dates ("tomorrow", "next Friday") to absolute dates using today's date.
- Keep a coherent list together as a SINGLE fact (places to visit, a packing list, shopping items) — recalling half a list is worse than recalling none. Split only claims about unrelated topics.
- Skip filler, formatting, and anything the known facts already cover.
- Never include credentials, payment secrets, recovery phrases, or government identifiers. Addresses, contact details, health, and finance are allowed but must use sensitivity "sensitive".
- Output ONLY {"claims":[...]} where each claim is:
  {"text":"The user ...","category":"identity|preference|relationship|work|project|health|finance|location|schedule|other","sensitivity":"standard|sensitive","validUntil":"YYYY-MM-DD or null"}
If the note holds nothing durable, output {"claims":[]}.`;
}

/**
 * Split a long explicit note into individual durable facts. Each extracted
 * claim becomes its own explicit fact (the user deliberately submitted this
 * content, so the pieces inherit the note's protection); the raw blob is then
 * superseded so it stops competing with them at inject time. Returns the new
 * fact ids ([] when extraction was skipped, failed, or found nothing — the raw
 * note stays active in those cases).
 */
export async function extractNoteFacts(factId: number, llm: LlmClient): Promise<number[]> {
  const factsGeneration = getFactsGeneration();
  const fact = getFactDetails(factId);
  if (!fact || fact.status !== 'active' || fact.source !== 'explicit') return [];
  const originalText = fact.text;
  const known = getInjectableFacts()
    .filter((f) => f.id !== factId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 80);

  let reply: string;
  try {
    reply = await llm.complete(extractPrompt(originalText, known));
  } catch (error) {
    // [] is also what a genuinely nothing-durable note returns, and the caller
    // cannot tell them apart — it just reconciles the raw blob and moves on,
    // leaving a wall of pasted text competing with the facts inside it.
    degrade('recall.note', 'kept the pasted note as one fact', error);
    return [];
  }
  // Wider text cap than distill's: a coherent list kept as one fact runs longer
  // than a single distilled statement (same ceiling as the rewrite path).
  const claims = parseClaims(reply, MAX_REWRITE_LENGTH);
  if (claims.length === 0) return [];

  // Same staleness discipline as the rewrite path: a reset or a concurrent edit
  // while the model was thinking means these claims describe a note that no
  // longer exists as we read it.
  if (getFactsGeneration() !== factsGeneration) return [];
  const current = getFactDetails(factId);
  if (!current || current.status !== 'active' || current.source !== 'explicit' || current.text !== originalText) {
    return [];
  }

  const ids: number[] = [];
  for (const claim of claims) {
    const id = upsertFact(claim.text, {
      source: 'explicit',
      confidence: 1,
      category: claim.category,
      sensitivity: claim.sensitivity,
      validUntil: claim.validUntil,
      evidence: [{
        messageId: null,
        threadId: null,
        role: 'user',
        timestamp: Math.floor(Date.now() / 1000),
        excerpt: originalText.slice(0, 1000),
        origin: 'explicit_user'
      }]
    });
    if (id != null && id !== factId && !ids.includes(id)) ids.push(id);
  }
  if (ids.length > 0) supersedeFact(factId, ids[0]);
  return ids;
}

/**
 * Full background pass for a freshly saved note. Short note: canonicalize the
 * statement in place, then reconcile it against older contradicting facts. Long
 * note (pasted wall of text): split it into individual facts and reconcile each.
 * Fired off the save acknowledgement path, so it must never surface a rejection.
 */
export async function processExplicitNote(factId: number, llm: LlmClient): Promise<void> {
  try {
    const fact = getFactDetails(factId);
    if (!fact) return;
    if (fact.text.length > LONG_NOTE_THRESHOLD) {
      const ids = await extractNoteFacts(factId, llm);
      for (const id of ids) await reconcileExplicitFact(id, llm);
      // Extraction failing (model down, unparseable reply, concurrent edit)
      // must not leave the raw blob unreconciled: a pasted note contradicting
      // stored facts would silently coexist with them until some later pass.
      if (ids.length === 0) await reconcileExplicitFact(factId, llm);
    } else {
      const survivingId = await normalizeExplicitNote(factId, llm);
      await reconcileExplicitFact(survivingId, llm);
    }
  } catch (error) {
    // Best-effort: the raw note is already durable — but unreconciled, so a note
    // that contradicts stored facts now coexists with them until some later pass
    // happens to compare them.
    degrade('recall.note', 'left the note unreconciled', error);
  }
}

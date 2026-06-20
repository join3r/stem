import { getFacts, getMessagesForDistill, getMeta, setMeta, upsertFact } from './store';
import { isRecallEnabled } from '../workspace/memory';
import type { LlmClient } from './llm';

// Level 1: the reflection pass. Periodically reads conversation that's new since
// its last run and distills durable, stable facts about the user into the facts
// table (always injected). Episodic specifics stay in Level 2 (search) — this is
// only the small "profile" layer.

const WATERMARK = 'distill_watermark';
const MAX_MESSAGES_PER_RUN = 200;
const MAX_TRANSCRIPT_CHARS = 16000;

const INSTRUCTIONS = `You maintain a long-term memory of DURABLE facts about a user, from a chat transcript. This is a PRIVATE personal assistant used by one person on their own device — knowing a lot about the user is the whole point, so capture genuinely personal details that make future help better.

Extract STABLE, reusable facts ABOUT THE USER: their identity, contact details, personal circumstances (address, phone, important dates, health conditions, family/relationships, work), preferences, ongoing situations, projects, constraints, and standing instructions. Phrase each as a short third-person statement ("The user ...").

Rules:
- Only state facts the USER revealed about themselves — directly, or via information retrieved on their behalf (e.g. their own emails). Such personal details ARE wanted; do not omit, redact, or soften them.
- CRITICAL: Never turn the ASSISTANT's own words into a user fact. The assistant's disclaimers, caution, hedging, redactions, or self-imposed behavior ("I left out identifiers", "I ignored spam") are NOT user preferences. Only record a preference or instruction if the USER explicitly stated it.
- Include only things likely still true in future conversations. EXCLUDE one-off task details, ephemeral context, and anything already obvious.
- If the user corrected an earlier assumption, state the corrected truth.
- Do NOT restate facts already in "Known facts" below; output only NEW facts or corrections to existing ones.
- Never include CREDENTIALS (passwords, PINs, API keys, tokens, card numbers, seed/recovery phrases). Ordinary personal identifiers (national ID / birth number, address, phone, email) are allowed.
- Output ONLY a JSON array of strings. No prose, no markdown fences. If there is nothing new and durable, output [].`;

const SECRET_RE =
  /\b(?:password|passcode|api[_ -]?key|auth token|access token|bearer token|secret key|private key|seed phrase|recovery phrase|credit card|card number|cvv)\b/i;

/** Parse the model's reply into clean fact strings (JSON array, with a bullet fallback). */
export function parseFacts(output: string): string[] {
  const raw: string[] = [];
  const trimmed = output.trim();

  // Preferred: a JSON array somewhere in the reply.
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const arr = JSON.parse(trimmed.slice(start, end + 1));
      if (Array.isArray(arr)) for (const v of arr) if (typeof v === 'string') raw.push(v);
    } catch {
      // fall through to bullet parsing
    }
  }
  // Fallback: bullet/numbered lines.
  if (raw.length === 0) {
    for (const line of trimmed.split('\n')) {
      const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (m) raw.push(m[1]);
    }
  }

  const seen = new Set<string>();
  const facts: string[] = [];
  for (const r of raw) {
    const f = r.replace(/\s+/g, ' ').trim();
    const key = f.toLowerCase();
    if (f.length < 3 || f.length > 300 || seen.has(key) || SECRET_RE.test(f)) continue;
    seen.add(key);
    facts.push(f);
  }
  return facts;
}

/**
 * Distill durable facts from messages captured since the last run. Returns the
 * number of facts written. Safe to call repeatedly — advances a watermark so each
 * message is only processed once.
 */
export async function distillNewMessages(llm: LlmClient): Promise<number> {
  if (!isRecallEnabled()) return 0;
  const sinceId = Number.parseInt(getMeta(WATERMARK) ?? '0', 10) || 0;
  const messages = getMessagesForDistill(sinceId, MAX_MESSAGES_PER_RUN);
  if (messages.length === 0) return 0;

  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
    .join('\n')
    .slice(0, MAX_TRANSCRIPT_CHARS);

  // Show the model what it already knows so it returns only new/corrected facts
  // (curbs reworded duplicates the norm-based dedup can't catch).
  const known = getFacts().map((f) => `- ${f.text}`).join('\n');
  const knownBlock = known ? `\n\nKnown facts (do not restate these):\n${known}` : '';

  let facts: string[] = [];
  try {
    const reply = await llm.complete(`${INSTRUCTIONS}${knownBlock}\n\nTranscript:\n${transcript}`);
    facts = parseFacts(reply);
  } catch {
    // Leave the watermark unmoved so a later run retries these messages.
    return 0;
  }

  for (const fact of facts) upsertFact(fact, 'distilled');

  // Advance past everything we just considered (even if 0 facts — they had nothing durable).
  const maxId = messages.reduce((max, m) => Math.max(max, m.id), sinceId);
  setMeta(WATERMARK, String(maxId));
  return facts.length;
}

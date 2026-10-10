import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { degrade } from '../degrade';
import { log } from '../log';
import type { LlmClient } from '../recall/llm';
import { piSessionsDir, skillsRoot } from '../workspace/paths';
import { SKILL_CONTRACT_TEXT, SKILL_SLUG_RE, formatViolations, validateSkill, type SkillDraft } from './contract';
import type { EmbeddingsClient } from '../recall/embeddings';
import { getEmbeddingsClient } from '../recall/retrieval';
import { History } from './curate';
import { findDuplicateSkill } from './dedup';
import { listSkillRecords, readSkillRecord, relabelSkill, saveSkill, type SkillOrigin, type SkillRecord } from './store';

// A one-time repair of where each skill came from, worked out from the chats.
//
// Before 5b2044e every skill the user accepted on an approval card was stored as
// `user-requested`, and an import was indistinguishable from an ask. The curator
// now reshapes only Stem's own ideas (curate.ts CURATED_ORIGINS), so those labels
// decide what it may touch: a card approval wrongly marked as the user's own is
// never tidied, and an import wrongly marked as an ask is patched on use. Worse,
// the older curator merged umbrella-style INTO skills it could not tell apart from
// Stem's, deleting the merged skills and keeping no backup — so some of the user's
// own skills now carry other jobs, and that text is the only copy there is.
//
// pi's session files are the evidence: every `manage_skill` save names who
// initiated it, carries the full text, and is followed by its result. Two passes:
//
// 1. Relabel `user-requested` skills the sessions say otherwise about.
// 2. Untangle: a locked skill whose text differs from what the user last saved has
//    since been changed automatically; one model call moves any other job out into
//    its own `approved` skill and narrows (an import: restores) the original.
//
// When the evidence is missing the label stays. The worst case of that is a messy
// skill nobody tidies, never Stem reshaping something the user cares about.
//
// Runs before the curator until a pass completes cleanly, then never again: the
// marker below. Every rewrite is backed up under `.curator-history/<run>-relabel`.

export const SKILLS_PROVENANCE_FILE = '.skills-provenance.json';
const PROVENANCE_VERSION = 1;

/** One successful `manage_skill` save, as the sessions recorded it. */
export interface SaveEvidence {
  at: string;
  by: 'user' | 'import' | 'assistant';
  description: string;
  body: string;
  /** The text was there before the call — pasted by the user or fetched by a tool — or a skill file was, this turn. */
  copied: boolean;
}

export interface SkillEvidence {
  saves: Map<string, SaveEvidence[]>;
  /** The oldest session's start: before it, an absence of evidence means nothing. */
  historyStart?: string;
}

export interface ProvenanceResult {
  relabeled: Record<string, SkillOrigin>;
  untangled: string[];
  extracted: string[];
  /** Model calls that failed or were not possible; the pass runs again later. */
  pending: string[];
}

// ---- evidence ----

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);

function text(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(rec)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b!.text as string)
    .join('\n');
}

/** Lines long enough to be evidence of copying rather than a shared heading. */
function evidenceLines(t: string): string[] {
  return t
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 25);
}

/**
 * Most of the saved body's substantial lines appeared earlier in the same chat, in
 * something the user sent or a tool returned — an install of text that already
 * existed. The model's own earlier calls do not count: drafting is not importing.
 */
export function copiedFrom(body: string, seen: ReadonlySet<string>): boolean {
  const lines = evidenceLines(body);
  if (lines.length < 3) return false;
  const found = lines.filter((l) => seen.has(l)).length;
  return found / lines.length >= 0.6;
}

const SAVED_RE = /^(Saved|Updated) skill "/;

/**
 * A skill file's front-matter: an existing skill, pasted or fetched. An install is
 * often reworded to fit Stem's contract on the way in, so the line match above
 * misses it; a skill file arriving in the same turn as the save does not.
 */
const SKILL_FILE_RE = /(^|\n)-{3}[ \t]*\r?\nname:[^\n]*\r?\n(?:[^\n]*\r?\n){0,3}description:/;

/** Read one session file's `manage_skill` saves into `saves`. Returns the session's first timestamp. */
export function readSessionSaves(raw: string, saves: Map<string, SaveEvidence[]>): string | undefined {
  let first: string | undefined;
  const seen = new Set<string>();
  /** Since the last user message, a skill file was pasted or fetched. */
  let skillFileInTurn = false;
  const calls = new Map<string, { at: string; name: string; by: SaveEvidence['by']; description: string; body: string; copied: boolean }>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: Rec | undefined;
    try {
      entry = rec(JSON.parse(line));
    } catch {
      // quiet: a torn last line is a chat still being written.
      continue;
    }
    const at = typeof entry?.timestamp === 'string' ? entry.timestamp : undefined;
    if (at && !first) first = at;
    const message = entry?.type === 'message' ? rec(entry.message) : undefined;
    if (!message) continue;
    if (message.role === 'user') {
      const said = text(message.content);
      skillFileInTurn = SKILL_FILE_RE.test(said);
      for (const l of evidenceLines(said)) seen.add(l);
    } else if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content.map(rec)) {
        if (block?.type !== 'toolCall' || block.name !== 'manage_skill' || typeof block.id !== 'string') continue;
        const args = rec(block.arguments) ?? {};
        const action = String(args.action ?? '');
        if (action === 'remove' || typeof args.name !== 'string' || typeof args.content !== 'string') continue;
        const by = args.initiated_by === 'user' || args.initiated_by === 'import' ? args.initiated_by : 'assistant';
        calls.set(block.id, {
          at: at ?? '',
          name: args.name.trim(),
          by,
          description: String(args.description ?? '').trim(),
          body: args.content.trim(),
          copied: skillFileInTurn || copiedFrom(args.content, seen)
        });
      }
    } else if (message.role === 'toolResult') {
      const result = text(message.content);
      const call = typeof message.toolCallId === 'string' ? calls.get(message.toolCallId) : undefined;
      if (call && message.isError !== true && SAVED_RE.test(result.trim())) {
        const list = saves.get(call.name) ?? [];
        list.push({ at: call.at, by: call.by, description: call.description, body: call.body, copied: call.copied });
        saves.set(call.name, list);
      }
      if (!call) {
        if (SKILL_FILE_RE.test(result)) skillFileInTurn = true;
        for (const l of evidenceLines(result)) seen.add(l);
      }
    }
  }
  return first;
}

function sessionFiles(dir: string): string[] {
  let out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // quiet: no sessions yet is a fresh install.
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(sessionFiles(p));
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

export function gatherEvidence(dir = piSessionsDir()): SkillEvidence {
  const saves = new Map<string, SaveEvidence[]>();
  let historyStart: string | undefined;
  for (const file of sessionFiles(dir)) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      // quiet: a session that cannot be read is evidence missing, and missing evidence keeps the label.
      continue;
    }
    // Every session counts toward how far back history reaches; only some are read.
    const first = /"timestamp":"([^"]+)"/.exec(raw.slice(0, 2000))?.[1];
    if (first && (!historyStart || first < historyStart)) historyStart = first;
    if (raw.includes('"manage_skill"')) readSessionSaves(raw, saves);
  }
  for (const list of saves.values()) list.sort((a, b) => a.at.localeCompare(b.at));
  return { saves, historyStart };
}

// ---- pass 1: labels ----

/**
 * The label a `user-requested` skill should have, or undefined to keep it. Only
 * that label is ever corrected: every other one was written by code that knew.
 */
export function inferOrigin(skill: Pick<SkillRecord, 'origin' | 'created'>, saves: SaveEvidence[], historyStart?: string): SkillOrigin | undefined {
  if (skill.origin !== 'user-requested') return undefined;
  const fromUser = saves.filter((s) => s.by !== 'assistant');
  if (fromUser.length > 0) return fromUser.some((s) => s.by === 'import' || s.copied) ? 'imported' : undefined;
  if (saves.length > 0) return 'approved';
  // No call at all: an end-of-turn card leaves none. But a chat the user deleted
  // leaves none either, so only trust the silence where the sessions reach back
  // past the skill's creation.
  if (historyStart && skill.created && historyStart < skill.created) return 'approved';
  return undefined;
}

// ---- pass 2: untangle ----

const norm = (t: string): string => t.replace(/\s+/g, ' ').trim();

/** The text the user last saved themselves, when the skill has drifted from it since. */
export function drifted(skill: Pick<SkillRecord, 'description' | 'body'>, saves: SaveEvidence[]): SaveEvidence | undefined {
  const baseline = [...saves].reverse().find((s) => s.by !== 'assistant');
  if (!baseline) return undefined;
  if (norm(baseline.body) === norm(skill.body) && norm(baseline.description) === norm(skill.description)) return undefined;
  return baseline;
}

const UNTANGLE_INSTRUCTIONS = `A skill in an AI assistant's library was saved by the user (ORIGINAL). Since then it was changed automatically (CURRENT). An older cleanup pass used to merge other skills into broad umbrella skills, so CURRENT may now also carry procedures for OTHER jobs that do not belong to the ORIGINAL's job. Those merged skills were deleted, so CURRENT is the only copy of them.

Your job:
1. "extracted": every job in CURRENT that is not the ORIGINAL's job, each as its own skill following the contract below. Move its steps over verbatim; do not invent steps. Each needs a new name not already in the library. A job one of the library's existing skills already covers is dropped, not extracted. Empty when CURRENT only refines the ORIGINAL's own job (fixed steps, added caveats).
2. "keep": CURRENT narrowed back to the ORIGINAL's job — keep fixes and caveats to the ORIGINAL's own steps, drop what you extracted, keep the ORIGINAL's description unless it no longer fits. null when "extracted" is empty.

${SKILL_CONTRACT_TEXT}

Reply with JSON only:
{"extracted": [{"name": "...", "description": "Use when ...", "body": "..."}], "keep": {"description": "...", "body": "..."} | null}`;

interface Untangle {
  extracted: SkillDraft[];
  keep: { description: string; body: string } | null;
}

export function parseUntangle(output: string): Untangle | null {
  const t = output.trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj: Rec | undefined;
  try {
    obj = rec(JSON.parse(t.slice(start, end + 1)));
  } catch {
    // quiet: the caller retries once with the reason, then leaves the skill alone.
    return null;
  }
  if (!obj || !Array.isArray(obj.extracted)) return null;
  const extracted: SkillDraft[] = [];
  for (const raw of obj.extracted.map(rec)) {
    if (!raw) continue;
    extracted.push({ name: String(raw.name ?? '').trim(), description: String(raw.description ?? '').trim(), body: String(raw.body ?? '').trim() });
  }
  const k = rec(obj.keep);
  const keep = k && typeof k.body === 'string' ? { description: String(k.description ?? '').trim(), body: k.body.trim() } : null;
  return { extracted, keep };
}

/** Why an answer cannot be written, or null when every part is clean. */
export function checkUntangle(skill: Pick<SkillRecord, 'slug' | 'origin'>, answer: Untangle, taken: Set<string>): string | null {
  if (answer.extracted.length === 0) return null;
  const names = new Set<string>();
  for (const part of answer.extracted) {
    if (!SKILL_SLUG_RE.test(part.name) || taken.has(part.name) || names.has(part.name)) return `name "${part.name}" is invalid or already taken`;
    names.add(part.name);
    const v = validateSkill(part, { authored: true });
    if (v.length) return `"${part.name}": ${formatViolations(v)}`;
  }
  // An import goes back to exactly what was installed, so its "keep" is unused.
  if (skill.origin === 'imported') return null;
  if (!answer.keep) return '"keep" is missing although jobs were extracted';
  const v = validateSkill({ name: skill.slug, ...answer.keep });
  return v.length ? `"keep": ${formatViolations(v)}` : null;
}

function untanglePrompt(skill: SkillRecord, baseline: SaveEvidence, library: SkillRecord[]): string {
  const others = library.filter((r) => r.slug !== skill.slug).map((r) => `- ${r.slug}: ${r.description}`);
  return (
    `${UNTANGLE_INSTRUCTIONS}\n\nThe library's other skills:\n${others.join('\n')}\n\n` +
    `ORIGINAL [${skill.slug}]\n${baseline.description}\n\n${baseline.body}\n\n---\n\n` +
    `CURRENT [${skill.slug}]\n${skill.description}\n\n${skill.body}`
  );
}

/** Returns false when the model call failed, so the pass is tried again later. */
async function untangle(
  skill: SkillRecord,
  baseline: SaveEvidence,
  llm: LlmClient,
  history: History,
  result: ProvenanceResult,
  embeddings: EmbeddingsClient | null
): Promise<boolean> {
  const library = listSkillRecords();
  const taken = library.map((r) => r.slug);
  const prompt = untanglePrompt(skill, baseline, library);
  let answer: Untangle | null;
  let why: string | null;
  try {
    answer = parseUntangle(await llm.complete(prompt));
    why = answer ? checkUntangle(skill, answer, new Set(taken)) : 'the reply was not the JSON asked for';
    if (why) {
      answer = parseUntangle(await llm.complete(`${prompt}\n\n---\n\nYour previous answer was rejected: ${why}\nFix it and reply again with the same JSON shape.`));
      why = answer ? checkUntangle(skill, answer, new Set(taken)) : 'the reply was not the JSON asked for';
    }
  } catch (error) {
    degrade('skills.provenance', `left "${skill.slug}" as it is for now`, error);
    return false;
  }
  if (!answer || why) {
    console.warn(`[skills provenance] could not untangle "${skill.slug}": ${why}`);
    return true;
  }

  const restore =
    skill.origin === 'imported' ? { description: baseline.description, body: baseline.body } : answer.extracted.length ? answer.keep : null;
  if (!restore) return true;
  try {
    history.keep(skill.slug);
  } catch (error) {
    degrade('skills.provenance', `left "${skill.slug}" as it is because it could not be backed up first`, error);
    return true;
  }
  // New skills first: a failure partway leaves a duplicate, never a loss.
  for (const part of answer.extracted) {
    // The library already has it (the model missed it, or a person split it out by
    // hand): dropping it from the original is enough.
    const dup = embeddings ? await findDuplicateSkill(part, listSkillRecords(), embeddings) : null;
    if (dup) continue;
    const written = saveSkill(part, { origin: 'approved' });
    if (!written.ok) {
      console.warn(`[skills provenance] untangling "${skill.slug}" stopped at "${part.name}": ${written.error}`);
      return true;
    }
    result.extracted.push(part.name);
  }
  const narrowed = saveSkill({ name: skill.slug, ...restore }, { origin: skill.origin, expectExisting: true });
  if (narrowed.ok) result.untangled.push(skill.slug);
  else console.warn(`[skills provenance] could not narrow "${skill.slug}": ${narrowed.error}`);
  return true;
}

// ---- the pass ----

function markerPath(): string {
  return join(skillsRoot(), SKILLS_PROVENANCE_FILE);
}

export function provenanceDone(): boolean {
  try {
    return (JSON.parse(readFileSync(markerPath(), 'utf8')) as { version?: number }).version === PROVENANCE_VERSION;
  } catch {
    // quiet: no marker yet is the ordinary case — the pass has simply not finished.
    return false;
  }
}

/**
 * Run both passes once. `llm` null (memory off) relabels only and leaves the pass
 * unfinished, so the untangling happens on a later run that can call a model.
 */
export async function migrateSkillProvenance(
  llm: LlmClient | null,
  opts: { evidence?: SkillEvidence; embeddings?: EmbeddingsClient | null } = {}
): Promise<ProvenanceResult> {
  const result: ProvenanceResult = { relabeled: {}, untangled: [], extracted: [], pending: [] };
  if (provenanceDone() || !existsSync(skillsRoot())) return result;
  const { saves, historyStart } = opts.evidence ?? gatherEvidence();
  const embeddings = opts.embeddings === undefined ? getEmbeddingsClient() : opts.embeddings;
  const history = new History('relabel');

  for (const skill of listSkillRecords()) {
    if (skill.source !== 'agent') continue;
    const origin = inferOrigin(skill, saves.get(skill.slug) ?? [], historyStart);
    if (!origin) continue;
    try {
      history.keep(skill.slug);
    } catch (error) {
      degrade('skills.provenance', `kept the label of "${skill.slug}" because it could not be backed up first`, error);
      result.pending.push(skill.slug);
      continue;
    }
    if (relabelSkill(skill.slug, origin).ok) result.relabeled[skill.slug] = origin;
    else result.pending.push(skill.slug);
  }

  for (const slug of listSkillRecords().map((r) => r.slug)) {
    const skill = readSkillRecord(slug);
    if (!skill || skill.source !== 'agent' || (skill.origin !== 'user-requested' && skill.origin !== 'imported')) continue;
    const baseline = drifted(skill, saves.get(slug) ?? []);
    if (!baseline) continue;
    if (!llm || !(await untangle(skill, baseline, llm, history, result, embeddings))) result.pending.push(slug);
  }

  history.prune();
  if (result.pending.length === 0) {
    try {
      writeFileSync(markerPath(), JSON.stringify({ version: PROVENANCE_VERSION, at: new Date().toISOString() }), 'utf8');
    } catch (error) {
      degrade('skills.provenance', 'will check where skills came from again next time', error);
    }
  }
  if (Object.keys(result.relabeled).length || result.untangled.length || result.pending.length) {
    log('skills', 'provenance migration', result);
  }
  return result;
}

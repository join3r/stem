import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { CallerContext } from '../ipc';
import type { RecordingDraft, RecordingSaveResult } from '../../shared/types';
import { host } from '../host';
import { log } from '../log';
import { degrade } from '../degrade';
import { isChatPrivate } from '../workspace/chats';
import { mailSessionThreadIds } from '../workspace/mail';
import { readSettings, skillsRunFor } from '../workspace/settings';
import { whereSkillsRun } from '../workspace/bootstrap';
import { isUploadHandle, resolveUploadHandle, transportedRawPath } from '../files/staging';
import { authorRecording, cleanEdited, cleanExample, withoutShots } from '../skills/record';
import { getDraft, listDrafts, patchDraft, putDraft } from '../skills/record-drafts';
import { validateSkill, formatViolations } from '../skills/contract';
import { findDuplicateSkill } from '../skills/dedup';
import { listSkillRecords, readSkillRecord } from '../skills/store';
import type { LlmClient, LlmImage } from '../recall/llm';
import { userSkillWriter } from './skills';

// The server half of the skill recorder (desktop/recorder/ is the Mac half):
// a recording arrives as one example, becomes or extends a draft card in its
// chat, and is saved through the same SkillBridge `/learn` writes through —
// as the user's own request, since they showed the procedure and pressed Save.

let push: ((draft: RecordingDraft) => void) | null = null;

/** Where draft changes go (the `skills:recordDraft` event). */
export function setRecordingDraftPush(fn: (draft: RecordingDraft) => void): void {
  push = fn;
}

async function store(draft: RecordingDraft): Promise<RecordingDraft> {
  await putDraft(draft);
  push?.(draft);
  return draft;
}

async function changed(draft: RecordingDraft | null): Promise<RecordingDraft | null> {
  if (draft) push?.(draft);
  return draft;
}

/** Private chats, mail and scheduled threads keep nothing; same rule as `/learn`. */
async function refusal(threadId: string): Promise<string | null> {
  const isPrivate = await isChatPrivate(threadId).catch((error: unknown) => {
    degrade('skills.record', 'refused a recording because the chat store could not be read', error);
    return true;
  });
  if (isPrivate) return 'This is a private chat, so Stem saves nothing from it — recordings included.';
  const mailOwned = await mailSessionThreadIds().catch((error: unknown) => {
    degrade('skills.record', 'refused a recording because the mail store could not be read', error);
    return null;
  });
  if (!mailOwned || mailOwned.has(threadId)) return 'Recordings belong to chats, not to mail or scheduled runs.';
  return null;
}

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/**
 * The pictures for values no text explained. A remote client sends upload
 * handles; the desktop sharing this disk sends paths, which are accepted only
 * inside its recordings folder (and only from a caller allowed raw paths at all).
 */
async function pictures(caller: CallerContext, refs: string[]): Promise<LlmImage[]> {
  const wanted = refs.slice(0, MAX_IMAGES);
  if (wanted.length === 0) return [];
  if (await transportedRawPath(caller, wanted)) {
    log('skills', 'recording pictures refused: raw paths from a remote device');
    return [];
  }
  // quiet: no recordings folder here means no local pictures to accept, which is the answer.
  const root = await realpath(join(host().stateRoot(), 'recordings')).catch(() => null);
  const out: LlmImage[] = [];
  for (const ref of wanted) {
    let path: string | null = null;
    if (isUploadHandle(ref)) path = await resolveUploadHandle(ref);
    else if (root && ref.endsWith('.jpg')) {
      // quiet: a picture that is gone is skipped; the author is told the value had no source either way.
      const real = await realpath(ref).catch(() => null);
      if (real && real.startsWith(root + sep)) path = real;
    }
    if (!path) continue;
    const size = await stat(path).then((s) => s.size, () => 0);
    if (size === 0 || size > MAX_IMAGE_BYTES) continue;
    out.push({ data: (await readFile(path)).toString('base64'), mimeType: 'image/jpeg' });
  }
  return out;
}

async function llm(): Promise<LlmClient> {
  const { runtime } = userSkillWriter();
  if (!runtime?.complete) throw new Error('Writing skills is unavailable right now.');
  const settings = await readSettings();
  return { complete: (prompt, images) => runtime.complete!(prompt, { ...skillsRunFor(settings), ...(images?.length ? { images } : {}) }) };
}

/** Write (or rewrite) a draft from its examples; the card shows each state. */
async function author(draft: RecordingDraft, images: LlmImage[]): Promise<RecordingDraft> {
  const started = Date.now();
  await store({ ...draft, status: 'drafting', message: undefined });
  const previous = draft.skill;
  const outcome = await authorRecording(
    await llm(),
    { examples: draft.examples, answers: draft.answers, previous, machine: whereSkillsRun() },
    images
    // quiet: a failed authoring is the card's message and the log line below.
  ).catch((error: unknown) => ({ ok: false as const, reason: 'error' as const, detail: error instanceof Error ? error.message : String(error) }));
  log('skills', 'recording authored', {
    threadId: draft.threadId,
    ok: outcome.ok,
    ...(outcome.ok ? { skill: outcome.draft.name, variables: outcome.variables.length, questions: outcome.questions.length } : { reason: outcome.reason, detail: outcome.detail }),
    examples: draft.examples.length,
    images: images.length,
    ms: Date.now() - started
  });
  const base = { ...draft, examples: withoutShots(draft.examples), updatedAt: new Date().toISOString() };
  if (outcome.ok) {
    return store({ ...base, status: 'ready', skill: outcome.draft, variables: outcome.variables, questions: outcome.questions, message: undefined, duplicateOf: undefined });
  }
  const message =
    outcome.reason === 'declined'
      ? `No task to write up in this recording — ${outcome.detail}.`
      : outcome.reason === 'invalid'
        ? `The draft did not meet the skill rules:\n${outcome.detail}`
        : 'Could not write the skill from this recording.';
  // A rewrite that failed keeps the draft it had.
  return store({ ...base, status: previous ? 'ready' : 'failed', message });
}

/** `skills:record` — a recording from the Mac, new or another example for `draftId`. */
export async function recordSkill(caller: CallerContext, threadId: string, raw: unknown, draftId?: string | null): Promise<RecordingDraft> {
  const refused = await refusal(threadId);
  if (refused) throw new Error(refused);
  const example = cleanExample(raw);
  if (!example) throw new Error('The recording was empty.');
  const images = await pictures(caller, example.unmatched.flatMap((u) => u.shots));
  const existing = draftId ? await getDraft(draftId) : null;
  if (draftId && (!existing || existing.threadId !== threadId)) throw new Error('That draft is gone.');
  const now = new Date().toISOString();
  const draft: RecordingDraft = existing
    ? { ...existing, examples: [...existing.examples, example], status: 'drafting', savedSlug: undefined }
    : { id: randomUUID(), threadId, createdAt: now, updatedAt: now, status: 'drafting', examples: [example], skill: null, variables: [], questions: [], answers: [] };
  return author(draft, images);
}

export async function recordingDrafts(threadId: string): Promise<RecordingDraft[]> {
  return listDrafts(threadId);
}

/** `skills:recordAnswer` — answers to the draft's questions; rewrite with them. */
export async function answerRecordingDraft(draftId: string, answers: unknown): Promise<RecordingDraft | null> {
  const draft = await getDraft(draftId);
  if (!draft || draft.status === 'saved' || draft.status === 'discarded') return draft;
  const given = (Array.isArray(answers) ? answers : [])
    .filter((a): a is { question: string; answer: string } => !!a && typeof a.question === 'string' && typeof a.answer === 'string')
    .map((a) => ({ question: a.question.slice(0, 300), answer: a.answer.trim().slice(0, 1000) }))
    .filter((a) => a.answer);
  if (given.length === 0) return draft;
  return author({ ...draft, answers: [...draft.answers, ...given].slice(-12), questions: [] }, []);
}

export async function discardRecordingDraft(draftId: string): Promise<RecordingDraft | null> {
  return changed(await patchDraft(draftId, (d) => ({ ...d, status: 'discarded' })));
}

/**
 * `skills:recordSave` — the card's Save. A new skill that reads like one already
 * in the library is not written beside it: the card asks first, and the second
 * Save updates that skill instead (`duplicateOf`).
 */
export async function saveRecordingDraft(draftId: string, editedRaw: unknown): Promise<RecordingSaveResult> {
  const { bridge } = userSkillWriter();
  if (!bridge) return { ok: false, message: 'Saving skills is unavailable right now.' };
  const draft = await getDraft(draftId);
  if (!draft) return { ok: false, message: 'That draft is gone.' };
  if (draft.status !== 'ready' || !draft.skill) return { ok: false, message: 'There is no finished draft to save yet.', draft };
  const skill = cleanEdited(editedRaw) ?? draft.skill;
  const violations = validateSkill(skill);
  if (violations.length) return { ok: false, message: `The skill does not meet the rules yet:\n${formatViolations(violations)}`, draft };

  let target = draft.duplicateOf ?? null;
  if (!target) {
    // The same name as a skill already there would quietly replace it; a
    // near-identical one would sit beside it. Both are asked about first.
    const sameName = readSkillRecord(skill.name) ? skill.name : null;
    const dup = sameName ?? (await findDuplicateSkill(skill, listSkillRecords()))?.slug ?? null;
    if (dup) {
      const asked = await changed(await patchDraft(draftId, (d) => ({ ...d, skill, duplicateOf: dup })));
      return { ok: false, message: `This looks like the skill "${dup}" you already have. Save again to update it with this recording.`, draft: asked ?? undefined };
    }
  }
  const result = await bridge.handleRequest(
    {
      op: 'save',
      initiatedBy: 'user',
      name: target ?? skill.name,
      description: skill.description,
      body: skill.body,
      expectExisting: !!target,
      origin: 'recorded'
    },
    { isScheduled: false, threadId: draft.threadId }
  );
  log('skills', 'recording saved', { threadId: draft.threadId, ok: result.ok, skill: target ?? skill.name, updated: !!target });
  if (!result.ok) {
    return { ok: false, message: result.text, draft: (await changed(await patchDraft(draftId, (d) => ({ ...d, skill })))) ?? undefined };
  }
  const saved = await changed(await patchDraft(draftId, (d) => ({ ...d, skill: { ...skill, name: target ?? skill.name }, status: 'saved', savedSlug: target ?? skill.name, message: undefined })));
  return { ok: true, message: result.text, draft: saved ?? undefined };
}

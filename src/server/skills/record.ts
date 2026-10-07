import type { LlmClient, LlmImage } from '../recall/llm';
import type { RecordedStep, RecordingDraft, RecordingExample, RecordingLink, RecordingVariable } from '../../shared/types';
import { SKILL_CONTRACT_TEXT, formatViolations, validateSkill, type SkillDraft } from './contract';
import { parseAuthorReply } from './author';

// Writing a skill from a recording: the person did the task on their Mac while
// Stem watched, and the evidence is THEIR clicks and typing, named by what
// they clicked, plus — for each value they typed — the text it was traced to
// on their screen (desktop/recorder/matcher.ts). The author's real job is the
// one the person did not do out loud: tell what stays the same from what
// changes, and say where each changing value comes from, so that next time
// the model can find the new date in the new email by itself.
//
// Separate from authorSkill (author.ts) because the question differs: there,
// "is anything in this turn worth keeping?"; here the person has already
// shown the procedure on purpose, and the answer also carries the variables
// and any question the evidence cannot settle, which the draft card shows.

export const SKILL_RECORD_INSTRUCTIONS = `The user recorded themselves doing a task on their Mac so that you can do it for them next time. Write it up as a skill.

The evidence is what THEY did, not what an assistant did: every click named by the control's role and label, every value typed into a field, copies and pastes, keys, and switches between apps and windows, in order. Web pages carry their address. Where a typed or pasted value could be traced to text that was on their screen just before, the source is quoted beside it ("← from: Mail · PO-4411: …delivery on October 14…"). A value marked "(no source found)" was not in any text they had in view; pictures of what was on screen just before it may follow. Notes are things the user wrote down while recording, and they outrank your guesses. "[password]" marks a secret that was not recorded: the skill must say the user's sign-in is needed there, never invent one.

Your job:
1. Work out the procedure, and what stays the same from run to run (which app, which menu, which form, which button) versus what changes (a date, an order number, a quantity, which customer).
2. For every value that changes, say where the skill finds it next time, in terms that still hold for a different case: "the delivery date in the supplier's confirmation email", not "October 14". Use the traced sources for this; that link is the most valuable thing in the evidence. A value re-typed in another format (October 14 → 14.10.2026) means the skill must convert it: say into which format.
3. If there is more than one example, or the user repeated the task within one recording, compare them: what differed between runs is a variable, what was the same is fixed.
4. Drop the noise: misclicks, a detour that was immediately undone, scrolling around, windows passed through on the way.
5. Write the steps for an assistant that has two tools on this Mac: \`browser\` for anything in a web page (it works in background tabs of the user's own browser, by URL, link text and field labels), and \`computer\` for other apps (it works by window, control names and keys). Name controls by their labels as recorded, and give the page address where one was recorded.

Ask a question only for something the evidence cannot settle and a wrong guess would get wrong every run, such as where a value with no source comes from. At most three, short, answerable in a sentence. Do not ask about anything the traced sources already answer.

Also list the final steps: the ones that change something outside the screen and cannot simply be closed away — saving or submitting a form, sending a message, archiving, moving or deleting an item, paying. Name each the way the recording shows it and say what it does: 'Click "Uložiť" in agrisys (saves the delivery date)', 'Press "y" in Fastmail (archives the email)'. At most five, in the order they happen; none if nothing is changed. A practice run of this skill stops before each of them unless the user allows it.

Reply with ONLY a JSON object, no prose and no markdown fences:
{"skill": {"name": "...", "description": "...", "body": "..."}, "variables": [{"name": "<what changes>", "from": "<where the skill finds it>"}], "questions": ["..."], "finalSteps": ["..."]}
or, only when the recording holds no task at all (nothing but window switching, say):
{"skill": null, "reason": "<one short clause>"}`;

/** What one recording's step looks like to the author: one numbered line, plus its source. */
function renderStep(step: RecordedStep, index: number, source: string | null, noSource: boolean): string {
  const where = [step.app, step.window].filter(Boolean).join(' · ') + (step.url ? ` <${step.url}>` : '');
  let what: string;
  switch (step.kind) {
    case 'click': {
      const verb = step.button === 'right' ? 'right-clicked' : (step.count ?? 1) > 1 ? 'double-clicked' : 'clicked';
      what = `${verb} ${step.role ?? 'element'}${step.label ? ` "${step.label}"` : ''}${step.within ? ` in ${step.within}` : ''}`;
      break;
    }
    case 'type':
      what = `typed ${JSON.stringify(step.value ?? '')} into "${step.field ?? step.role ?? 'a field'}"${step.before ? ` (it held ${JSON.stringify(step.before)})` : ''}`;
      break;
    case 'paste':
      what = `pasted ${JSON.stringify(step.text ?? '')}${step.field ? ` into "${step.field}"` : ''}`;
      break;
    case 'copy':
    case 'cut':
      what = `${step.kind === 'cut' ? 'cut' : 'copied'} ${JSON.stringify(step.text ?? '')}`;
      break;
    case 'key':
      // A plain key outside any field is the app's own shortcut (Fastmail's "y" archives).
      what = step.combo && /^.$/u.test(step.combo) ? `pressed "${step.combo}" (a one-key shortcut in this app)` : `pressed ${step.combo ?? 'a key'}`;
      break;
    case 'switch':
      what = 'switched to this window';
      break;
    case 'note':
      return `${index + 1}. NOTE from the user: ${step.text ?? ''}`;
  }
  const lines = [`${index + 1}. [${where}] ${what}`];
  if (source) lines.push(`   ← from: ${source}`);
  else if (noSource) lines.push('   (no source found on screen)');
  return lines.join('\n');
}

export function renderExample(example: RecordingExample): string {
  const sources = new Map<number, string>();
  for (const link of example.links) {
    const at = [link.source.app, link.source.window].filter(Boolean).join(' · ') + (link.source.url ? ` <${link.source.url}>` : '');
    const how = link.via === 'copy' ? 'copied there' : link.form === 'exact' ? 'shown there' : `shown there as a ${link.form} in another format`;
    sources.set(link.step, `${at} (${how}): "${link.source.snippet}"`);
  }
  const unmatched = new Set(example.unmatched.map((u) => u.step));
  return example.steps.map((s, i) => renderStep(s, i, sources.get(i) ?? null, unmatched.has(i))).join('\n');
}

export interface RecordAuthorInput {
  examples: RecordingExample[];
  /** Answers to earlier questions. */
  answers: { question: string; answer: string }[];
  /** The draft so far (as edited by the user, if they did): rewrite it, keep its name. */
  previous: SkillDraft | null;
  /** Where the skill will run (whereSkillsRun()). */
  machine?: string;
}

export function buildRecordPrompt(input: RecordAuthorInput): string {
  const parts = [SKILL_RECORD_INSTRUCTIONS, SKILL_CONTRACT_TEXT, '---'];
  if (input.machine?.trim()) parts.push(`Where the skill will be followed:\n${input.machine.trim()}`);
  input.examples.forEach((ex, i) => {
    const mins = Math.max(1, Math.round(ex.durationMs / 60000));
    parts.push(`--- Recording ${i + 1} of ${input.examples.length} (${new Date(ex.recordedAt).toDateString()}, about ${mins} min) ---`, renderExample(ex));
  });
  if (input.answers.length) {
    parts.push(`The user's answers to your earlier questions:\n${input.answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n')}`);
  }
  if (input.previous) {
    parts.push(
      `Your current draft of this skill (the user may have edited it; keep their edits and keep the name "${input.previous.name}" unless the evidence contradicts them):\nname: ${input.previous.name}\ndescription: ${input.previous.description}\n\n${input.previous.body}`
    );
  }
  return parts.join('\n\n');
}

export interface RecordExtras {
  variables: RecordingVariable[];
  questions: string[];
  finalSteps: string[];
  /** Only from a practice-run rewrite: what it changed, in plain words. */
  changes: string[];
}

export type RecordAuthorOutcome =
  | ({ ok: true; draft: SkillDraft } & RecordExtras)
  | { ok: false; reason: 'declined' | 'invalid' | 'unparseable' | 'error'; detail: string };

function strings(v: unknown, each: number, most: number): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, each)).slice(0, most) : [];
}

/** The variables, questions, final steps and changes beside the skill in the reply; tolerant of junk. */
export function parseRecordExtras(output: string): RecordExtras {
  const text = String(output ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    // quiet: the skill half has its own parse and reports unparseable replies.
  }
  const variables = Array.isArray(parsed.variables)
    ? parsed.variables
        .filter((v): v is { name: string; from: string } => !!v && typeof (v as { name?: unknown }).name === 'string' && typeof (v as { from?: unknown }).from === 'string')
        .map((v) => ({ name: v.name.trim().slice(0, 80), from: v.from.trim().slice(0, 240) }))
        .filter((v) => v.name && v.from)
        .slice(0, 12)
    : [];
  return {
    variables,
    questions: strings(parsed.questions, 300, 3),
    finalSteps: strings(parsed.finalSteps, 200, 5),
    changes: strings(parsed.changes, 240, 8)
  };
}

const MAX_ATTEMPTS = 2;

export async function authorRecording(llm: LlmClient, input: RecordAuthorInput, images: LlmImage[] = []): Promise<RecordAuthorOutcome> {
  const base = buildRecordPrompt(input);
  let prompt = base;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let reply: string;
    try {
      reply = await llm.complete(prompt, images.length ? images : undefined);
    } catch (error) {
      // quiet: the message is the outcome's detail, which the caller logs and shows on the card.
      return { ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) };
    }
    const parsed = parseAuthorReply(reply);
    if (parsed.kind === 'declined') return { ok: false, reason: 'declined', detail: parsed.reason };
    if (parsed.kind === 'skill') {
      const draft = input.previous ? { ...parsed.draft, name: input.previous.name } : parsed.draft;
      const violations = validateSkill(draft);
      if (violations.length === 0) return { ok: true, draft, ...parseRecordExtras(reply) };
      if (attempt === MAX_ATTEMPTS) return { ok: false, reason: 'invalid', detail: formatViolations(violations) };
      prompt = `${base}\n\n---\n\nYour previous answer was rejected. You returned:\nname: ${draft.name}\ndescription: ${draft.description}\n\n${draft.body}\n\nIt broke the contract:\n${formatViolations(violations)}\n\nFix every point and reply again with the same JSON shape.`;
      continue;
    }
    // A target or junk: this author offers no library, so either is a bad reply.
    if (attempt === MAX_ATTEMPTS) return { ok: false, reason: 'unparseable', detail: 'the model did not return the JSON shape' };
    prompt = `${base}\n\n---\n\nYour previous answer was not valid JSON in the required shape. Reply with ONLY the JSON object.`;
  }
  return { ok: false, reason: 'error', detail: 'author loop fell through' };
}

/** A draft's examples with picture references dropped: they were for one authoring pass. */
export function withoutShots(examples: RecordingExample[]): RecordingExample[] {
  return examples.map((ex) => ({ ...ex, unmatched: ex.unmatched.map((u) => ({ ...u, shots: [] })) }));
}

/** The fields of a draft a client may send back (an edited skill). */
export function cleanEdited(edited: unknown): SkillDraft | null {
  if (!edited || typeof edited !== 'object') return null;
  const { name, description, body } = edited as Record<string, unknown>;
  if (typeof name !== 'string' || typeof description !== 'string' || typeof body !== 'string') return null;
  return { name: name.trim(), description: description.trim(), body: body.trim() };
}

export type { RecordingDraft };

const STEP_KINDS = new Set(['click', 'type', 'key', 'copy', 'cut', 'paste', 'switch', 'note']);
const MAX_STEPS = 400;

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

/**
 * A recording as sent by a client, reduced to the shape and sizes the author
 * expects. The desktop already builds it this way; this is what keeps any other
 * authenticated client from handing the prompt something else.
 */
export function cleanExample(raw: unknown): RecordingExample | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.steps) || r.steps.length === 0) return null;
  const steps: RecordedStep[] = [];
  for (const s of r.steps.slice(0, MAX_STEPS)) {
    if (!s || typeof s !== 'object') continue;
    const x = s as Record<string, unknown>;
    if (typeof x.kind !== 'string' || !STEP_KINDS.has(x.kind)) continue;
    const step: RecordedStep = { kind: x.kind as RecordedStep['kind'], t: num(x.t), app: str(x.app, 120) ?? '', window: str(x.window, 200) ?? '' };
    const opt: [keyof RecordedStep, number][] = [
      ['bundleId', 200], ['url', 600], ['role', 60], ['label', 200], ['within', 200], ['field', 200],
      ['value', 4000], ['before', 400], ['text', 2000], ['combo', 60]
    ];
    for (const [k, max] of opt) {
      const v = str(x[k], max);
      if (v !== undefined) (step as unknown as Record<string, unknown>)[k] = v;
    }
    if (x.button === 'right') step.button = 'right';
    if (typeof x.count === 'number') step.count = num(x.count);
    if (x.secure === true) step.secure = true;
    steps.push(step);
  }
  if (steps.length === 0) return null;
  const links = (Array.isArray(r.links) ? r.links : [])
    .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
    .map((l) => {
      const src = (l.source && typeof l.source === 'object' ? l.source : {}) as Record<string, unknown>;
      return {
        step: num(l.step),
        value: str(l.value, 4000) ?? '',
        via: l.via === 'copy' ? ('copy' as const) : ('seen' as const),
        form: (l.form === 'date' || l.form === 'number' ? l.form : 'exact') as RecordingLink['form'],
        source: { app: str(src.app, 120) ?? '', window: str(src.window, 200) ?? '', ...(typeof src.url === 'string' ? { url: src.url.slice(0, 600) } : {}), t: num(src.t), snippet: str(src.snippet, 700) ?? '' }
      };
    })
    .filter((l) => l.step < steps.length)
    .slice(0, MAX_STEPS);
  const unmatched = (Array.isArray(r.unmatched) ? r.unmatched : [])
    .filter((u): u is Record<string, unknown> => !!u && typeof u === 'object')
    .map((u) => ({
      step: num(u.step),
      value: str(u.value, 4000) ?? '',
      shots: (Array.isArray(u.shots) ? u.shots : []).filter((p): p is string => typeof p === 'string').slice(0, 2)
    }))
    .filter((u) => u.step < steps.length)
    .slice(0, MAX_STEPS);
  return {
    id: str(r.id, 80) ?? `ex-${Date.now()}`,
    recordedAt: typeof r.recordedAt === 'string' && !Number.isNaN(Date.parse(r.recordedAt)) ? r.recordedAt : new Date().toISOString(),
    durationMs: num(r.durationMs),
    steps,
    links,
    unmatched
  };
}

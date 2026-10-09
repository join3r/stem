import { randomUUID } from 'node:crypto';
import type { RecordedStep, RecordingExample, RecordingLink } from '../../shared/types';
import { linkValues, type SeenText, type Shot } from './matcher';
import { redactSecrets } from './secrets';

// What one recording sends to the server: the steps, each traced value's
// source snippet, and pictures only for values no text explains. The window
// texts themselves stay here — they are the evidence the matcher read, not
// something the author needs whole (and they are full of unrelated mail).

/** A recording longer than this is cut; the author's prompt has a budget too. */
export const MAX_STEPS = 400;
/** Of a cut recording, this many steps are kept from its start; the rest come from its end, where the save or send is. */
const KEEP_HEAD = 100;

/** The recorder's own Stop shortcut (⌃⌥R) as the helper writes it down; never part of the task. */
export const STOP_COMBO = 'ctrl+alt+r';

export function buildExample(input: {
  steps: RecordedStep[];
  seen: SeenText[];
  shots: Shot[];
  startedAt: Date;
  durationMs: number;
  notes?: string[];
}): RecordingExample {
  const all = tidy(input.steps).map(redactStep);
  let steps = all;
  let cut: RecordingExample['cut'];
  if (all.length > MAX_STEPS) {
    const tail = MAX_STEPS - KEEP_HEAD;
    steps = [...all.slice(0, KEEP_HEAD), ...all.slice(-tail)];
    cut = { at: KEEP_HEAD, steps: all.length - MAX_STEPS };
  }
  const traced = linkValues(steps, input.seen, input.shots, input.startedAt);
  const links = traced.links.map((l) => ({ ...l, source: { ...l.source, snippet: redactSecrets(l.source.snippet) } }));
  const notes = [...(input.notes ?? [])];
  if (cut) notes.push(`The recording was long, so ${cut.steps} steps from its middle were left out.`);
  return {
    id: randomUUID(),
    recordedAt: input.startedAt.toISOString(),
    durationMs: input.durationMs,
    steps,
    links,
    unmatched: traced.unmatched,
    ...(cut ? { cut } : {}),
    ...(notes.length ? { notes } : {})
  };
}

/** The helper redacts by field and app; this catches keys and tokens by their shape in what is left. */
function redactStep(step: RecordedStep): RecordedStep {
  const out = { ...step };
  for (const k of ['label', 'value', 'before', 'text', 'form'] as const) {
    if (out[k]) out[k] = redactSecrets(out[k]);
  }
  return out;
}

const FIELD_ROLES = new Set(['textfield', 'textarea', 'combobox', 'searchfield', 'securetextfield']);

/**
 * Drop what says nothing: a switch straight into another switch (flicking
 * through windows), a switch back to the window the person was already in,
 * the click that only focused a field whose typing follows as its own step
 * (the typing names the field), and the ⌃⌥R that stopped the recording.
 */
export function tidy(steps: RecordedStep[]): RecordedStep[] {
  const out: RecordedStep[] = [];
  for (const step of steps) {
    if (step.kind === 'key' && step.combo === STOP_COMBO) continue;
    const prev = out[out.length - 1];
    if (step.kind === 'switch') {
      if (prev?.kind === 'switch') out.pop();
      const last = out[out.length - 1];
      if (last && last.app === step.app && last.window === step.window) continue;
    }
    if ((step.kind === 'type' || (step.kind === 'paste' && step.field)) && prev?.kind === 'click' && isFocusClick(prev, step)) out.pop();
    out.push(step);
  }
  return out;
}

function isFocusClick(click: RecordedStep, typed: RecordedStep): boolean {
  if (!FIELD_ROLES.has(click.role ?? '') || click.button === 'right' || click.file || click.files) return false;
  return click.app === typed.app && click.window === typed.window;
}

/** One line a person reads for a step (the pill, the logs). */
export function describeStep(step: RecordedStep): string {
  const where = step.app;
  switch (step.kind) {
    case 'click': {
      const what = step.label ? `"${step.label}"` : step.role ?? 'something';
      return `${step.button === 'right' ? 'Right-clicked' : step.count && step.count > 1 ? 'Double-clicked' : 'Clicked'} ${what} in ${where}`;
    }
    case 'type':
      return step.secure ? `Typed a password · not saved` : `Typed ${quote(step.value)} into "${step.field ?? 'a field'}"`;
    case 'paste':
      return step.secure ? 'Pasted a password · not saved' : `Pasted ${quote(step.text)}${step.field ? ` into "${step.field}"` : ''}`;
    case 'copy':
    case 'cut':
      return step.secure ? 'Copied a password · not saved' : `Copied ${quote(step.text)} in ${where}`;
    case 'key':
      return `Pressed ${step.combo ?? 'a key'}`;
    case 'switch':
      return `Switched to ${where}${step.window ? ` · ${step.window}` : ''}`;
    case 'note':
      return `Note: ${step.text ?? ''}`;
  }
}

/** "← Mail" for a traced value. */
export function linkTag(link: RecordingLink | undefined): string | null {
  return link ? `← ${link.source.app}` : null;
}

function quote(s: string | undefined): string {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();
  return `"${v.length > 40 ? `${v.slice(0, 39)}…` : v}"`;
}

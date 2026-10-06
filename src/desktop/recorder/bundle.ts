import { randomUUID } from 'node:crypto';
import type { RecordedStep, RecordingExample, RecordingLink } from '../../shared/types';
import { linkValues, type SeenText, type Shot } from './matcher';

// What one recording sends to the server: the steps, each traced value's
// source snippet, and pictures only for values no text explains. The window
// texts themselves stay here — they are the evidence the matcher read, not
// something the author needs whole (and they are full of unrelated mail).

/** A recording longer than this is cut; the author's prompt has a budget too. */
export const MAX_STEPS = 400;

export function buildExample(input: {
  steps: RecordedStep[];
  seen: SeenText[];
  shots: Shot[];
  startedAt: Date;
  durationMs: number;
}): RecordingExample {
  const steps = tidy(input.steps).slice(0, MAX_STEPS);
  const { links, unmatched } = linkValues(steps, input.seen, input.shots, input.startedAt);
  return {
    id: randomUUID(),
    recordedAt: input.startedAt.toISOString(),
    durationMs: input.durationMs,
    steps,
    links,
    unmatched
  };
}

/**
 * Drop what says nothing: a switch straight into another switch (flicking
 * through windows), a switch back to the window the person was already in,
 * and the click that only focused a field whose typing follows as its own step.
 */
export function tidy(steps: RecordedStep[]): RecordedStep[] {
  const out: RecordedStep[] = [];
  for (const step of steps) {
    const prev = out[out.length - 1];
    if (step.kind === 'switch') {
      if (prev?.kind === 'switch') out.pop();
      const last = out[out.length - 1];
      if (last && last.app === step.app && last.window === step.window) continue;
    }
    out.push(step);
  }
  return out;
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

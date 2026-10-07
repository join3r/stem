// The message a draft card's "Practice run" puts in the composer: which skill
// to try, and — the point of it — which of its steps change something for real,
// so the agent stops and asks before each one unless the person edits the line
// out ("archive at the end") or adds their own ("don't save, just fill it in").
// It is only ever prefilled, never sent: the person picks the input and decides.

export interface PracticeMessage {
  text: string;
  /** Where the caret goes: right after "on: ", for the input to practice on. */
  caret: number;
}

/** Said when a draft predates final steps, or has none it could name. */
const GENERIC_STOP = 'anything that saves, submits, sends, archives, moves or deletes something';

export function practiceMessage(skillName: string, finalSteps: readonly string[] | undefined): PracticeMessage {
  const head = `Practice the "${skillName}" skill on: `;
  const steps = (finalSteps ?? []).map((s) => s.trim()).filter(Boolean);
  const stops = steps.length ? steps.map((s) => `- ${s}`) : [`- ${GENERIC_STOP}`];
  const text = [
    head,
    '',
    'Do every step as the skill says, but stop and ask me before:',
    ...stops,
    '',
    "If something doesn't match the skill (a button with another name, a missing field, an extra step), tell me what and how you got past it."
  ].join('\n');
  return { text, caret: head.length };
}

import type { ChatBackend } from '../backend/types';
import { writeSubject } from '../chats/subject';
import { backgroundRunOf, readSettings } from '../workspace/settings';
import { degrade } from '../degrade';

// Naming a scheduled task. A task's title used to be its prompt's first 57
// characters, and a schedule_task prompt almost always opens by restating the
// schedule: the Tasks tab showed "Every morning at 06:0…", "On the first day of
// each month…", "Every first day of the month at…" — eight rows told apart by
// nothing, each sitting over a second line that already says "Daily at 06:00".
// The small model that writes chat and mail subjects names the task from its
// prompt instead, leaving the schedule to the line beneath.

/** The prompt is the whole input; its opening carries what the task is for. */
const PROMPT_INPUT_CAP = 2_000;
const TITLE_TIMEOUT_MS = 20_000;

export function taskTitlePrompt(prompt: string): string {
  const text = prompt.trim();
  return [
    'Write a short name for the scheduled task below, the way an email subject names a thread.',
    'The name is shown in a list of tasks; the schedule is shown next to it already.',
    '',
    'Rules:',
    '- Two to six words. Never more than 60 characters.',
    '- Name what the task watches, checks or produces: "Bitcoin price watch", "Hacker News AI threads", "Unpaid invoices summary".',
    '- Leave out when it runs: no "every morning", "daily", "on the 1st", "at 09:00", "Monday", "trikrát denne".',
    '- Leave out how it reports: no "send me", "notify", "mail".',
    '- Keep concrete nouns from the task — names, sites, products, places — over generic ones.',
    '- Write it in the same language as the task.',
    '- No quotes, no trailing period, no "Name:" prefix, no explanation.',
    '- Reply with the name alone.',
    '',
    'Task:',
    '"""',
    text.length > PROMPT_INPUT_CAP ? `${text.slice(0, PROMPT_INPUT_CAP - 1).trimEnd()}…` : text,
    '"""'
  ].join('\n');
}

/**
 * A written name for a task prompt, or '' when there is none to be had (subject
 * writing is off, the model failed or answered junk). Never rejects; '' leaves
 * the first-line title standing.
 */
export async function writeTaskTitle(runtime: Pick<ChatBackend, 'complete'>, prompt: string): Promise<string> {
  try {
    const chats = (await readSettings()).chats;
    if (chats.subjects === 'off') return '';
    return await writeSubject(
      (p, opts) => runtime.complete(p, opts),
      taskTitlePrompt(prompt),
      {
        ...(await backgroundRunOf('subject', () => ({ model: chats.subjectModel, effort: chats.subjectEffort }))),
        timeoutMs: TITLE_TIMEOUT_MS
      },
      prompt
    );
  } catch (err) {
    degrade('tasks', "left a task titled by its prompt's first line", err);
    return '';
  }
}

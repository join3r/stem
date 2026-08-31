// Mail subject hygiene, shared main/renderer. A conversation's subject is a
// LINE the Inbox trusts blindly — the list row, the header h1, the activity
// label, the delivery preamble all print it verbatim — but its sources are
// not all a typed subject line: notify_user titles are model-written, task
// titles are a raw 60-char slice of the task's prompt, and either can carry
// protocol fences (<!--stem:mail ...-->) or Markdown that then renders as
// gibberish in a row (the screenshot bug). Everything a subject could enter
// the store through funnels here: markup is stripped, whitespace flattened,
// length capped — and a mail sent with NO subject gets one derived from its
// body's first meaningful line instead of the '(no subject)' shrug.

/** An explicit subject longer than this is cut — it is a subject, not the mail. */
export const MAX_MAIL_SUBJECT = 120;
/** A derived subject stays shorter — same cap as chat titles and task titles. */
const MAX_DERIVED_SUBJECT = 60;
/** The last-resort subject for a conversation nothing can name. */
export const NO_SUBJECT = '(no subject)';

function capped(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  // slice() counts UTF-16 units, so the cut can land inside a surrogate pair
  // (an emoji at the boundary) — never emit the orphaned half.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/**
 * Stem's protocol fences are PAIRED comments whose interior is injected
 * scaffolding, never user text — so the whole block goes, open through the
 * matching closer, or to the end of the string when the closer never made it
 * (a subject sliced out of a longer prompt cuts mid-fence). `sub` is what the
 * removed span becomes: a space for one-line cleaning, a newline when the
 * caller still needs line boundaries.
 */
function stripStemFences(text: string, sub: string): string {
  return text
    .replace(/<!--stem:(\w+)[^>]*-->[\s\S]*?(?:<!--\/stem:\1-->|$)/g, sub)
    .replace(/<!--[\s\S]*?-->/g, sub)
    .replace(/<!--[\s\S]*$/, sub);
}

/**
 * One line of text, stripped of the markup a subject must never wear. No cap
 * here — the exported wrappers cap, because an explicit subject and a derived
 * one earn different lengths.
 */
function stripMarkup(raw: string): string {
  return (
    stripStemFences(raw ?? '', ' ')
      // Code fences with their info string; stray backticks go below.
      .replace(/```+\S*/g, ' ')
      // Images and links keep their text, lose their syntax.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Emphasis/code marks. Underscores are left alone entirely — file_name
      // and __init__ are likelier in a subject than underscore-bold, and
      // mangling an identifier is worse than letting a rare `__` through.
      .replace(/[*`]+|~~+/g, '')
      // Leading heading/blockquote markers and list bullets (the asterisk and
      // dash bullets are already gone or ambiguous; digits stay digits).
      .replace(/^\s*(?:[#>]+\s*)+/, '')
      .replace(/^\s*(?:[-+]|\d+[.)])\s+/, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Reduce whatever arrived in a subject field to a clean subject line, or ''
 * if nothing readable survives (a subject that was pure markup). A clean
 * subject passes through verbatim short of the length cap.
 */
export function cleanMailSubject(raw: string): string {
  return capped(stripMarkup(raw), MAX_MAIL_SUBJECT);
}

/**
 * Name a conversation from its first mail: the body's first line that still
 * says anything once the markup is gone, capped like a chat's auto-title.
 * '' when the body offers nothing (attachments-only mail).
 */
export function deriveMailSubject(body: string): string {
  // Fences are stripped over the WHOLE body first: a block spanning lines
  // would otherwise donate its interior to the first-line contest.
  const text = stripStemFences(body ?? '', '\n');
  for (const rawLine of text.split('\n')) {
    const line = stripMarkup(rawLine);
    if (line) return capped(line, MAX_DERIVED_SUBJECT);
  }
  return '';
}

/**
 * The one policy every subject entering the mail store goes through: the
 * caller's subject if it cleans to something, else a subject derived from the
 * mail's body, else the explicit shrug.
 */
export function resolveMailSubject(subject: unknown, body: string): string {
  // `unknown`: compose input crosses the transport from clients of any age,
  // so the subject field is not trusted to even be a string.
  return cleanMailSubject(typeof subject === 'string' ? subject : '') || deriveMailSubject(body) || NO_SUBJECT;
}

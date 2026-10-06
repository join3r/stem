import type { RecordedStep, RecordingLink } from '../../shared/types';

// Where did a value the person typed come from? The recorder keeps the text
// of every window they looked at (rec-seen); this finds each typed, pasted or
// picked value in what was on screen BEFORE it went in, so the author is told
// "Delivery date 14.10.2026 ← Mail · PO-4411: '…delivery on October 14…'"
// instead of having to guess. Dates and numbers are read as dates and numbers
// on both sides, because people retype them in the form the target wants.
// Pure: the Mac side feeds it, unit tests pin it.

export interface SeenText {
  t: number;
  app: string;
  window: string;
  url?: string;
  text: string;
}

export interface Shot {
  t: number;
  app: string;
  window: string;
  path: string;
}

export interface MatchResult {
  links: RecordingLink[];
  unmatched: { step: number; value: string; shots: string[] }[];
}

const SNIPPET_RADIUS = 240;
/** How far back a picture may be to explain a value. */
const SHOT_WINDOW_MS = 60_000;
const SHOTS_PER_VALUE = 2;
/** Picked from a list or menu: the label is the value. */
const PICK_ROLES = new Set(['menuitem', 'option', 'radiobutton']);

/** The value a step put somewhere, if it put one. */
export function stepValue(step: RecordedStep): string | null {
  let v: string | undefined;
  if (step.kind === 'type') v = step.value;
  else if (step.kind === 'paste') v = step.text;
  else if (step.kind === 'click' && step.role && PICK_ROLES.has(step.role)) v = step.label;
  if (!v || step.secure || v === '[password]') return null;
  v = v.trim();
  return v.length > 0 ? v : null;
}

export function linkValues(steps: RecordedStep[], seen: SeenText[], shots: Shot[], recordedAt: Date): MatchResult {
  const links: RecordingLink[] = [];
  const unmatched: MatchResult['unmatched'] = [];
  const year = recordedAt.getFullYear();
  const byTime = [...seen].sort((a, b) => b.t - a.t);
  steps.forEach((step, i) => {
    const value = stepValue(step);
    if (value === null) return;
    const link = viaCopy(steps, i, value) ?? viaSeen(step, i, value, byTime, year);
    if (link) {
      links.push(link);
      return;
    }
    unmatched.push({ step: i, value, shots: shotsBefore(step, shots) });
  });
  return { links, unmatched };
}

/** A copy (or cut) earlier in the recording whose text is the value. */
function viaCopy(steps: RecordedStep[], i: number, value: string): RecordingLink | null {
  const want = squash(value);
  for (let j = i - 1; j >= 0; j--) {
    const s = steps[j];
    if ((s.kind === 'copy' || s.kind === 'cut') && s.text && squash(s.text) === want) {
      return {
        step: i,
        value,
        via: 'copy',
        form: 'exact',
        source: { app: s.app, window: s.window, ...(s.url ? { url: s.url } : {}), t: s.t, snippet: s.text.slice(0, SNIPPET_RADIUS * 2) }
      };
    }
  }
  return null;
}

/**
 * The nearest earlier window text that shows the value. Other windows first:
 * the window being typed into shows its own old values, which explain nothing.
 */
function viaSeen(step: RecordedStep, i: number, value: string, byTime: SeenText[], year: number): RecordingLink | null {
  const earlier = byTime.filter((s) => s.t <= step.t);
  const other = earlier.filter((s) => !sameWindow(s, step));
  const same = value.length >= 3 ? earlier.filter((s) => sameWindow(s, step)) : [];
  for (const pool of [other, same]) {
    for (const s of pool) {
      const hit = find(value, s.text, year);
      if (hit) {
        return {
          step: i,
          value,
          via: 'seen',
          form: hit.form,
          source: { app: s.app, window: s.window, ...(s.url ? { url: s.url } : {}), t: s.t, snippet: snippet(s.text, hit.index, hit.length) }
        };
      }
    }
  }
  return null;
}

function sameWindow(s: { app: string; window: string }, step: RecordedStep): boolean {
  return s.app === step.app && s.window === step.window;
}

function shotsBefore(step: RecordedStep, shots: Shot[]): string[] {
  const near = shots.filter((s) => s.t <= step.t && step.t - s.t <= SHOT_WINDOW_MS).sort((a, b) => b.t - a.t);
  const ordered = [...near.filter((s) => !sameWindow(s, step)), ...near.filter((s) => sameWindow(s, step))];
  return ordered.slice(0, SHOTS_PER_VALUE).map((s) => s.path);
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Hit {
  index: number;
  length: number;
  form: RecordingLink['form'];
}

/** Find `value` in `text`: as written, else as the same date, else as the same number. */
export function find(value: string, text: string, year: number): Hit | null {
  const exact = findExact(value, text);
  if (exact) return { ...exact, form: 'exact' };
  const date = parseDate(value, year);
  if (date) {
    for (const cand of dateTokens(text, year)) {
      if (cand.ymd === date) return { index: cand.index, length: cand.length, form: 'date' };
    }
  }
  const num = parseNumber(value);
  if (num !== null && !date) {
    for (const cand of numberTokens(text)) {
      if (cand.values.some((v) => Math.abs(v - num) < 1e-9)) return { index: cand.index, length: cand.length, form: 'number' };
    }
  }
  return null;
}

function findExact(value: string, text: string): { index: number; length: number } | null {
  const body = escapeRe(value.trim()).replace(/\s+/g, '\\s+');
  // Words and numbers must stand on their own ("14" is not inside "2014").
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu');
  const m = re.exec(text);
  return m ? { index: m.index, length: m[0].length } : null;
}

function snippet(text: string, index: number, length: number): string {
  const from = Math.max(0, index - SNIPPET_RADIUS);
  const to = Math.min(text.length, index + length + SNIPPET_RADIUS);
  return (from > 0 ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < text.length ? '…' : '');
}

// ---- dates ----

const MONTHS: Record<string, number> = {};
const MONTH_NAMES: [number, string[]][] = [
  [1, ['january', 'jan', 'januar', 'januára', 'január', 'jänner']],
  [2, ['february', 'feb', 'februára', 'február', 'februar']],
  [3, ['march', 'mar', 'marca', 'marec', 'märz', 'marz']],
  [4, ['april', 'apr', 'apríla', 'apríl']],
  [5, ['may', 'mája', 'máj', 'mai']],
  [6, ['june', 'jun', 'júna', 'jún', 'juni']],
  [7, ['july', 'jul', 'júla', 'júl', 'juli']],
  [8, ['august', 'aug', 'augusta']],
  [9, ['september', 'sep', 'sept', 'septembra']],
  [10, ['october', 'oct', 'októbra', 'október', 'oktober', 'okt']],
  [11, ['november', 'nov', 'novembra']],
  [12, ['december', 'dec', 'decembra', 'dezember', 'dez']]
];
for (const [n, names] of MONTH_NAMES) for (const name of names) MONTHS[name] = n;
const MONTH_RE = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .map(escapeRe)
  .join('|');

function ymd(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

interface DateToken {
  index: number;
  length: number;
  ymd: string;
}

/** Every date-looking run in `text`, read every way it can be read. */
export function dateTokens(text: string, year: number): DateToken[] {
  const out: DateToken[] = [];
  const push = (m: RegExpExecArray, y: number, mo: number, d: number) => {
    const v = ymd(y, mo, d);
    if (v) out.push({ index: m.index, length: m[0].length, ymd: v });
  };
  let m: RegExpExecArray | null;
  // 2026-10-14
  const iso = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/g;
  while ((m = iso.exec(text))) push(m, +m[1], +m[2], +m[3]);
  // 14.10.2026 / 14. 10. 2026 / 14/10/2026 / 10/14/2026 / 14.10. (no year)
  const dotted = /(?<![\d.])(\d{1,2})\s?([./-])\s?(\d{1,2})(?:\s?\2\s?(\d{2,4}))?(?![\d])/g;
  while ((m = dotted.exec(text))) {
    const a = +m[1];
    const b = +m[3];
    const y = m[4] ? +m[4] : year;
    if (m[2] === '/' ) {
      push(m, y, a, b); // US month/day
      push(m, y, b, a);
    } else {
      push(m, y, b, a); // day.month
    }
  }
  // 14 October 2026 / 14. októbra / October 14, 2026 / Oct 14
  const dayFirst = new RegExp(`(?<![\\p{L}\\d])(\\d{1,2})\\.?\\s+(${MONTH_RE})\\.?(?:\\s+(\\d{4}))?(?![\\p{L}])`, 'giu');
  while ((m = dayFirst.exec(text))) push(m, m[3] ? +m[3] : year, MONTHS[m[2].toLowerCase()], +m[1]);
  const monthFirst = new RegExp(`(?<![\\p{L}])(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?![\\p{L}\\d])`, 'giu');
  while ((m = monthFirst.exec(text))) push(m, m[3] ? +m[3] : year, MONTHS[m[1].toLowerCase()], +m[2]);
  return out.sort((x, y) => x.index - y.index);
}

/** The value as a date (YYYY-MM-DD), when the whole value is one. */
export function parseDate(value: string, year: number): string | null {
  const v = value.trim();
  const tokens = dateTokens(v, year).filter((t) => t.index === 0 && t.length === v.length);
  // A value that reads as two dates (03/04) is ambiguous; let the text decide via exact match only.
  const unique = [...new Set(tokens.map((t) => t.ymd))];
  return unique.length === 1 ? unique[0] : null;
}

// ---- numbers ----

/** "1 250,50" / "1,250.50" / "1250.5" → 1250.5; null when the value is not one number. */
export function parseNumber(value: string): number | null {
  const v = value.trim().replace(/[\s\u00a0\u202f']/g, '');
  if (!/^[-+]?\d[\d.,]*$/.test(v)) return null;
  const readings = readNumber(v);
  return readings.length > 0 ? readings[0] : null;
}

/** Both readings of a number whose separators could go either way. */
function readNumber(raw: string): number[] {
  const v = raw.replace(/[\s\u00a0\u202f']/g, '');
  const out = new Set<number>();
  const lastDot = v.lastIndexOf('.');
  const lastComma = v.lastIndexOf(',');
  if (lastDot === -1 && lastComma === -1) {
    out.add(Number(v));
  } else if (lastDot > -1 && lastComma > -1) {
    // Whichever comes last is the decimal point.
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    out.add(Number(v.split(thou).join('').replace(dec, '.')));
  } else {
    const sep = lastDot > -1 ? '.' : ',';
    const parts = v.split(sep);
    // 1.250 / 1,250 may be thousands; 12,5 / 1.25 a fraction.
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) out.add(Number(parts.join('')));
    if (parts.length === 2) out.add(Number(`${parts[0]}.${parts[1]}`));
  }
  return [...out].filter((n) => Number.isFinite(n));
}

function numberTokens(text: string): { index: number; length: number; values: number[] }[] {
  const out: { index: number; length: number; values: number[] }[] = [];
  const re = /(?<![\p{L}\d])\d[\d\u00a0\u202f'.,]*(?:\s\d{3})*(?:[.,]\d+)?(?![\p{L}\d])/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[0].replace(/[.,]$/, '');
    out.push({ index: m.index, length: raw.length, values: readNumber(raw) });
  }
  return out;
}

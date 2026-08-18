// A tiny, dependency-free 5-field cron engine. Stem keeps no cron dependency for
// the same reason it uses node:sqlite and a hand-rolled MCP bridge — the surface
// is small and well understood, so a vendored micro-parser beats a dep.
//
// Fields (standard crontab order), all in LOCAL time:
//   minute        0-59
//   hour          0-23
//   day-of-month  1-31
//   month         1-12   (Jan = 1)
//   day-of-week   0-6    (Sun = 0; 7 is also accepted as Sun)
//
// Per-field syntax: `*`, `a`, `a-b`, `a,b,c`, `*/n`, `a-b/n`, and any comma list of
// those. Day-of-month and day-of-week follow the conventional Vixie-cron OR rule:
// when BOTH are restricted (neither is `*`), a date matches if EITHER matches.

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** True when dom/dow OR-matching applies (both restricted). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

interface FieldSpec {
  min: number;
  max: number;
}

const SPECS: Record<keyof Omit<CronFields, 'domRestricted' | 'dowRestricted'>, FieldSpec> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dom: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  // 7 is accepted as an alias for Sunday (0) and normalized in parseCron.
  dow: { min: 0, max: 7 }
};

/** Parse one cron field into the set of integers it matches. Throws on malformed input. */
function parseField(raw: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) throw new Error('empty cron field segment');

    // Optional step: `<range>/<n>`.
    const [rangePart, stepPart, ...rest] = token.split('/');
    if (rest.length) throw new Error(`invalid step in "${token}"`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) throw new Error(`invalid step "${stepPart}"`);
      step = Number(stepPart);
      if (!Number.isSafeInteger(step) || step <= 0) throw new Error(`invalid step "${stepPart}"`);
    }

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = spec.min;
      hi = spec.max;
    } else {
      // Enforce the documented decimal/range grammar before conversion. Number()
      // would otherwise accept `+5`/`1e1`, while a loose split accepted `-1` as
      // 0-1 and silently ignored the tail of `1-2-3`.
      const match = /^(\d+)(?:-(\d+))?$/.exec(rangePart);
      if (!match) throw new Error(`invalid value or range "${rangePart}"`);
      lo = Number(match[1]);
      hi = match[2] === undefined ? lo : Number(match[2]);
      if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) {
        throw new Error(`invalid value or range "${rangePart}"`);
      }
      // A bare value with a step (e.g. `5/15`) means "from 5 to max, every step".
      if (stepPart !== undefined && match[2] === undefined) hi = spec.max;
    }

    if (lo < spec.min || hi > spec.max || lo > hi) {
      throw new Error(`cron field out of range: "${token}" (allowed ${spec.min}-${spec.max})`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (!out.size) throw new Error('cron field matched nothing');
  return out;
}

/** Parse a 5-field cron expression. Throws (with a readable message) when invalid. */
export function parseCron(expr: string): CronFields {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields (got ${fields.length}): "${expr}"`);
  }
  const dowRaw = fields[4];
  const dow = parseField(dowRaw, SPECS.dow);
  // Normalize 7 → Sunday (0); some crontabs use 0-7 with both ends as Sunday.
  if (dow.has(7)) {
    dow.add(0);
    dow.delete(7);
  }
  return {
    minute: parseField(fields[0], SPECS.minute),
    hour: parseField(fields[1], SPECS.hour),
    dom: parseField(fields[2], SPECS.dom),
    month: parseField(fields[3], SPECS.month),
    dow,
    domRestricted: fields[2].trim() !== '*',
    dowRestricted: dowRaw.trim() !== '*'
  };
}

/** True when `expr` is a well-formed 5-field cron expression. */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    // quiet: the throw IS the answer this function exists to convert.
    return false;
  }
}

function matchesCalendarDate(f: CronFields, d: Date): boolean {
  if (!f.month.has(d.getMonth() + 1)) return false;
  const domOk = f.dom.has(d.getDate());
  const dowOk = f.dow.has(d.getDay());
  // Vixie-cron rule: if both day fields are restricted, match on EITHER; if only
  // one is restricted, that one must match; if neither, both `*` match trivially.
  if (f.domRestricted && f.dowRestricted) return domOk || dowOk;
  if (f.domRestricted) return domOk;
  if (f.dowRestricted) return dowOk;
  return true;
}

// Eight years covers the widest valid Gregorian month/day gap: February 29 jumps
// from 2096 to 2104 across the non-leap century year 2100. This still bounds an
// impossible expression at fewer than 3,000 cheap calendar-date checks.
const MAX_DAYS = 8 * 366;

function sameLocalMinute(candidate: Date, day: Date, hour: number, minute: number): boolean {
  return (
    candidate.getFullYear() === day.getFullYear() &&
    candidate.getMonth() === day.getMonth() &&
    candidate.getDate() === day.getDate() &&
    candidate.getHours() === hour &&
    candidate.getMinutes() === minute
  );
}

/**
 * Return every real instant represented by one local wall-clock minute. Most
 * minutes have one; a spring-forward gap has none; a fall-back fold has two.
 * JavaScript's local Date constructor chooses the earlier instant in a fold, so
 * detect the later offset and add the alternate when it maps to the same fields.
 */
function localMinuteInstants(day: Date, hour: number, minute: number): Date[] {
  const first = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0);
  if (!sameLocalMinute(first, day, hour, minute)) return [];
  const out = [first];

  // Any repeated minute is adjacent to a backwards offset transition. Looking
  // 36 hours ahead covers even unusual midnight/large-offset transitions; the
  // exact local-field equality below prevents unrelated future changes from
  // manufacturing an alternate instant.
  const laterOffset = new Date(first.getTime() + 36 * 60 * 60 * 1000).getTimezoneOffset();
  const offsetIncrease = laterOffset - first.getTimezoneOffset();
  if (offsetIncrease > 0) {
    const alternate = new Date(first.getTime() + offsetIncrease * 60_000);
    if (sameLocalMinute(alternate, day, hour, minute)) out.push(alternate);
  }
  return out;
}

/**
 * The next firing time strictly after `from` (local time), or null if the
 * expression can never match within the search horizon. Minute-resolution: seconds
 * and milliseconds of the result are always zero.
 */
export function nextAfter(expr: string, from: Date): Date | null {
  const f = parseCron(expr);
  const hours = [...f.hour].sort((a, b) => a - b);
  const minutes = [...f.minute].sort((a, b) => a - b);
  const startYear = from.getFullYear();
  const startMonth = from.getMonth();
  const startDate = from.getDate();

  for (let offset = 0; offset <= MAX_DAYS; offset++) {
    // Noon avoids the rare timezone transition that moves/skips local midnight;
    // only the calendar fields are used from this probe date.
    const day = new Date(startYear, startMonth, startDate + offset, 12, 0, 0, 0);
    if (!matchesCalendarDate(f, day)) continue;
    const candidates: Date[] = [];
    for (const hour of hours) {
      for (const minute of minutes) {
        candidates.push(...localMinuteInstants(day, hour, minute));
      }
    }
    // Wall-clock ordering differs from instant ordering inside a fall-back fold:
    // the first 01:50 occurs before the repeated 01:30. Sort the day's complete
    // candidate set so nextAfter always returns the truly earliest future instant.
    candidates.sort((a, b) => a.getTime() - b.getTime());
    const next = candidates.find((candidate) => candidate.getTime() > from.getTime());
    if (next) return next;
  }
  return null;
}

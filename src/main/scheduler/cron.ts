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
      step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) throw new Error(`invalid step "${stepPart}"`);
    }

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = spec.min;
      hi = spec.max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = Number(a);
      hi = Number(b);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`invalid range "${rangePart}"`);
    } else {
      lo = Number(rangePart);
      hi = lo;
      if (!Number.isInteger(lo)) throw new Error(`invalid value "${rangePart}"`);
      // A bare value with a step (e.g. `5/15`) means "from 5 to max, every step".
      if (stepPart !== undefined) hi = spec.max;
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
    return false;
  }
}

function matchesDate(f: CronFields, d: Date): boolean {
  if (!f.month.has(d.getMonth() + 1)) return false;
  if (!f.hour.has(d.getHours())) return false;
  if (!f.minute.has(d.getMinutes())) return false;
  const domOk = f.dom.has(d.getDate());
  const dowOk = f.dow.has(d.getDay());
  // Vixie-cron rule: if both day fields are restricted, match on EITHER; if only
  // one is restricted, that one must match; if neither, both `*` match trivially.
  if (f.domRestricted && f.dowRestricted) return domOk || dowOk;
  if (f.domRestricted) return domOk;
  if (f.dowRestricted) return dowOk;
  return true;
}

// Cap the forward search so an impossible expression (e.g. `0 0 30 2 *` — Feb 30)
// terminates instead of looping forever. Five years of minutes is far beyond any
// real schedule's gap.
const MAX_MINUTES = 5 * 366 * 24 * 60;

/**
 * The next firing time strictly after `from` (local time), or null if the
 * expression can never match within the search horizon. Minute-resolution: seconds
 * and milliseconds of the result are always zero.
 */
export function nextAfter(expr: string, from: Date): Date | null {
  const f = parseCron(expr);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after `from`
  for (let i = 0; i < MAX_MINUTES; i++) {
    if (matchesDate(f, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

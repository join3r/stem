// Scales, ticks and number formatting for the hand-rolled charts. Pure
// functions, unit-tested in tests/unit/mdx-chart.test.ts.

/** Round tick values covering [min, max]: steps of 1, 2, 2.5 or 5 × 10^k. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) {
    if (min === 0) return [0, 1];
    const pad = Math.abs(min) * 0.1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Rounded to the step's precision, so 0.1+0.2 doesn't label as 0.30000000000000004.
  const digits = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(digits)));
  return ticks;
}

const PREFIX_UNITS = new Set(['$', '€', '£', '¥', '₹', '₩', 'CHF']);

/** Attach a unit the way people write it: "$12", "12%", "12 km". */
export function withUnit(text: string, unit: string | undefined): string {
  if (!unit) return text;
  if (PREFIX_UNITS.has(unit)) return text.startsWith('-') ? `-${unit}${text.slice(1)}` : `${unit}${text}`;
  if (unit === '%') return `${text}%`;
  return `${text} ${unit}`;
}

/**
 * A value for an axis tick or a tight label: compact past ten thousand
 * (12.5k, 3.2M, 1.1B), otherwise grouped with at most two decimals.
 */
export function formatCompact(v: number, unit?: string): string {
  const abs = Math.abs(v);
  let text: string;
  if (abs >= 1e9) text = `${trim(v / 1e9)}B`;
  else if (abs >= 1e6) text = `${trim(v / 1e6)}M`;
  else if (abs >= 1e4) text = `${trim(v / 1e3)}k`;
  else text = formatFull(v);
  return withUnit(text, unit);
}

/** A value for a tooltip or table: every digit, grouped, at most two decimals. */
export function formatValue(v: number, unit?: string): string {
  return withUnit(formatFull(v), unit);
}

function formatFull(v: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: Math.abs(v) < 1 ? 3 : 2 }).format(v);
}

function trim(v: number): string {
  const text = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  // Only zeros after a decimal point: "150" must stay "150", not "15".
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/** Rough rendered width of a label at the chart's 11px UI font. */
export function textWidth(text: string, px = 11): number {
  return text.length * px * 0.58;
}

/**
 * A bar from the baseline to its value, as a path with the data end rounded
 * (4px, never more than half the bar) and the baseline end square. Works both
 * ways: a negative bar rounds its bottom. `horizontal` swaps the axes.
 */
export function barPath(
  across: number,
  thickness: number,
  base: number,
  end: number,
  horizontal = false,
  radius = 4
): string {
  const len = Math.abs(end - base);
  const r = Math.max(0, Math.min(radius, thickness / 2, len));
  const dir = end < base ? -1 : 1;
  const a0 = across;
  const a1 = across + thickness;
  // Written along a "length" axis l and an "across" axis a, then mapped.
  const pt = (l: number, a: number) => (horizontal ? `${l},${a}` : `${a},${l}`);
  if (r === 0) {
    return `M${pt(base, a0)} L${pt(end, a0)} L${pt(end, a1)} L${pt(base, a1)} Z`;
  }
  const before = end - dir * r;
  // Sweep flag: which way the arcs turn depends on direction and orientation.
  const sweep = (dir === 1) !== horizontal ? 0 : 1;
  return [
    `M${pt(base, a0)}`,
    `L${pt(before, a0)}`,
    `A${r},${r} 0 0 ${sweep} ${pt(end, a0 + r)}`,
    `L${pt(end, a1 - r)}`,
    `A${r},${r} 0 0 ${sweep} ${pt(before, a1)}`,
    `L${pt(base, a1)}`,
    'Z'
  ].join(' ');
}

export interface Slice {
  label: string;
  value: number;
  /** Index into the categorical palette; -1 for the folded "Other" slice. */
  slot: number;
}

/**
 * Donut slices: non-positive values dropped, and past `max` slices the
 * smallest fold into one "Other" — a ninth hue is never generated.
 */
export function donutSlices(labels: string[], values: Array<number | null>, max = 6): Slice[] {
  const items = labels
    .map((label, i) => ({ label, value: values[i] ?? 0, slot: i }))
    .filter((s) => s.value > 0);
  if (items.length <= max) return items.map((s, i) => ({ ...s, slot: i }));
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const kept = new Set(sorted.slice(0, max - 1));
  const out: Slice[] = [];
  let other = 0;
  for (const s of items) {
    if (kept.has(s)) out.push({ ...s, slot: out.length });
    else other += s.value;
  }
  out.push({ label: 'Other', value: other, slot: -1 });
  return out;
}

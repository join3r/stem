// The recorder's value tracing: a value the person typed is linked to the
// window text that showed it before, so the skill author learns "the date
// comes from the email" without anyone writing that down.
import { describe, expect, it } from 'vitest';
import { find, linkValues, parseDate, parseNumber, stepValue } from '../../src/desktop/recorder/matcher';
import type { RecordedStep } from '../../src/shared/types';

const AT = new Date('2026-10-06T10:00:00Z');

const mail = (t: number, text: string) => ({ t, app: 'Mail', window: 'PO-4411 — Agro Supply', text });
const step = (over: Partial<RecordedStep>): RecordedStep => ({ kind: 'type', t: 1000, app: 'Arc', window: 'agrisys · Order 4411', ...over });

describe('find', () => {
  it('finds a value as written, on word boundaries', () => {
    expect(find('4411', 'Re: PO-4411 delivery', 2026)?.form).toBe('exact');
    expect(find('14', 'year 2014', 2026)).toBeNull();
  });

  it('reads dates in other forms', () => {
    const text = 'We can confirm delivery on October 14 at the farm.';
    const hit = find('14.10.2026', text, 2026);
    expect(hit?.form).toBe('date');
    expect(text.slice(hit!.index, hit!.index + hit!.length)).toBe('October 14');
    expect(find('2026-10-14', 'dodanie 14. októbra 2026', 2026)?.form).toBe('date');
    expect(find('10/14/2026', 'termín 14.10.2026', 2026)?.form).toBe('date');
    expect(find('14 Oct', 'on 2026-10-14', 2026)?.form).toBe('date');
  });

  it('does not take another day for the date', () => {
    expect(find('15.10.2026', 'delivery on October 14', 2026)).toBeNull();
  });

  it('reads numbers with either separator', () => {
    expect(find('1250', 'Total: 1 250,00 EUR', 2026)?.form).toBe('number');
    expect(find('1250.5', 'Total 1,250.50', 2026)?.form).toBe('number');
    expect(find('12,5', 'weight 12.5 t', 2026)?.form).toBe('number');
  });
});

describe('parse', () => {
  it('parses whole-value dates and numbers', () => {
    expect(parseDate('14.10.2026', 2026)).toBe('2026-10-14');
    expect(parseDate('October 14', 2026)).toBe('2026-10-14');
    expect(parseDate('03/04/2026', 2026)).toBeNull(); // ambiguous
    expect(parseDate('Agro s.r.o.', 2026)).toBeNull();
    expect(parseNumber('1 250')).toBe(1250);
    expect(parseNumber('abc')).toBeNull();
  });

  it('never treats a password as a value', () => {
    expect(stepValue(step({ value: '[password]', secure: true }))).toBeNull();
    expect(stepValue(step({ kind: 'click', role: 'menuitem', label: 'Agro s.r.o.' }))).toBe('Agro s.r.o.');
    expect(stepValue(step({ kind: 'click', role: 'button', label: 'Save' }))).toBeNull();
  });
});

describe('linkValues', () => {
  it('links the typed date to the email shown before it', () => {
    const steps = [step({ kind: 'switch', t: 100, app: 'Mail', window: 'PO-4411 — Agro Supply' }), step({ field: 'Delivery date', value: '14.10.2026', t: 5000 })];
    const seen = [mail(200, 'Hello,\nwe confirm delivery on October 14.\nRegards'), { t: 4000, app: 'Arc', window: 'agrisys · Order 4411', text: 'Delivery date' }];
    const { links, unmatched } = linkValues(steps, seen, [], AT);
    expect(unmatched).toEqual([]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ step: 1, via: 'seen', form: 'date', source: { app: 'Mail' } });
    expect(links[0].source.snippet).toContain('October 14');
  });

  it('ignores text seen after the value went in', () => {
    const steps = [step({ value: 'ZX-99', t: 1000 })];
    const { links, unmatched } = linkValues(steps, [mail(2000, 'ZX-99')], [], AT);
    expect(links).toEqual([]);
    expect(unmatched[0].value).toBe('ZX-99');
  });

  it('prefers the nearest earlier text', () => {
    const steps = [step({ value: 'ABC-1', t: 9000 })];
    const seen = [mail(1000, 'old ABC-1 here'), { ...mail(8000, 'new ABC-1 there'), window: 'PO-4412' }];
    expect(linkValues(steps, seen, [], AT).links[0].source.window).toBe('PO-4412');
  });

  it('links a paste to its copy', () => {
    const steps = [
      step({ kind: 'copy', t: 100, app: 'Mail', window: 'PO-4411', text: 'PO-4411' }),
      step({ kind: 'paste', t: 900, text: 'PO-4411', field: 'Reference' })
    ];
    expect(linkValues(steps, [], [], AT).links[0]).toMatchObject({ via: 'copy', source: { app: 'Mail' } });
  });

  it('hands unmatched values the pictures from just before, other windows first', () => {
    const steps = [step({ value: 'K-7', t: 70_000 })];
    const shots = [
      { t: 1000, app: 'Preview', window: 'scan.pdf', path: '/old.jpg' },
      { t: 60_000, app: 'Arc', window: 'agrisys · Order 4411', path: '/form.jpg' },
      { t: 65_000, app: 'Preview', window: 'scan.pdf', path: '/scan.jpg' }
    ];
    expect(linkValues(steps, [], shots, AT).unmatched[0].shots).toEqual(['/scan.jpg', '/form.jpg']);
  });
});

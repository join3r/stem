import { describe, expect, it } from 'vitest';
import { isValidCron, nextAfter, parseCron } from '../../src/main/scheduler/cron';

// All times are local — construct Dates with the local constructor so the test is
// timezone-independent (we only assert relative field values, never UTC offsets).
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0);

describe('cron parsing', () => {
  it('accepts the standard shapes', () => {
    expect(isValidCron('* * * * *')).toBe(true);
    expect(isValidCron('0 8 * * 1-5')).toBe(true);
    expect(isValidCron('*/15 * * * *')).toBe(true);
    expect(isValidCron('0 0 1 1 *')).toBe(true);
    expect(isValidCron('30 9,17 * * *')).toBe(true);
    expect(isValidCron('0 0 * * 7')).toBe(true); // 7 = Sunday
  });

  it('rejects malformed expressions', () => {
    expect(isValidCron('')).toBe(false);
    expect(isValidCron('* * * *')).toBe(false); // 4 fields
    expect(isValidCron('* * * * * *')).toBe(false); // 6 fields
    expect(isValidCron('60 * * * *')).toBe(false); // minute out of range
    expect(isValidCron('* 24 * * *')).toBe(false); // hour out of range
    expect(isValidCron('* * 0 * *')).toBe(false); // dom below range
    expect(isValidCron('* * * 13 *')).toBe(false); // month out of range
    expect(isValidCron('a * * * *')).toBe(false);
    expect(isValidCron('*/0 * * * *')).toBe(false);
    expect(isValidCron('5-2 * * * *')).toBe(false); // inverted range
  });

  it('parses 7 as Sunday alongside 0', () => {
    expect(parseCron('* * * * 7').dow.has(0)).toBe(true);
  });
});

describe('nextAfter', () => {
  it('every 15 minutes', () => {
    expect(nextAfter('*/15 * * * *', at(2026, 6, 29, 9, 7))).toEqual(at(2026, 6, 29, 9, 15));
    expect(nextAfter('*/15 * * * *', at(2026, 6, 29, 9, 15))).toEqual(at(2026, 6, 29, 9, 30));
    // Rolls over the hour.
    expect(nextAfter('*/15 * * * *', at(2026, 6, 29, 9, 52))).toEqual(at(2026, 6, 29, 10, 0));
  });

  it('weekday mornings at 08:00', () => {
    // 2026-06-29 is a Monday. 08:05 → next is Tuesday 08:00.
    expect(nextAfter('0 8 * * 1-5', at(2026, 6, 29, 8, 5))).toEqual(at(2026, 6, 30, 8, 0));
    // Friday 2026-07-03 09:00 → skips the weekend to Monday 2026-07-06 08:00.
    expect(nextAfter('0 8 * * 1-5', at(2026, 7, 3, 9, 0))).toEqual(at(2026, 7, 6, 8, 0));
  });

  it('is strictly after the given instant', () => {
    // Exactly on a match → returns the NEXT occurrence, not the same minute.
    expect(nextAfter('0 8 * * *', at(2026, 6, 29, 8, 0))).toEqual(at(2026, 6, 30, 8, 0));
  });

  it('month and day-of-month rollover', () => {
    // First of the month at midnight, from mid-January → February 1.
    expect(nextAfter('0 0 1 * *', at(2026, 1, 15, 12, 0))).toEqual(at(2026, 2, 1, 0, 0));
    // Year rollover.
    expect(nextAfter('0 0 1 1 *', at(2026, 6, 1, 0, 0))).toEqual(at(2027, 1, 1, 0, 0));
  });

  it('day-of-month OR day-of-week when both restricted', () => {
    // "1st of month OR every Monday" — from Wed 2026-07-01 fires same day is excluded
    // (strictly after midnight), next match is Mon 2026-07-06.
    const next = nextAfter('0 0 1 * 1', at(2026, 7, 1, 0, 0));
    expect(next).toEqual(at(2026, 7, 6, 0, 0));
  });

  it('returns null for an impossible expression', () => {
    // Feb 30 never exists.
    expect(nextAfter('0 0 30 2 *', at(2026, 1, 1, 0, 0))).toBeNull();
  });
});

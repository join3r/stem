import { describe, expect, it } from 'vitest';
import { findPhoneNumbers } from '../../src/shared/phone-links';

const hrefs = (text: string) => findPhoneNumbers(text).map((m) => m.href);
const spans = (text: string) => findPhoneNumbers(text).map((m) => text.slice(m.start, m.end));

describe('findPhoneNumbers', () => {
  it('finds international, national and North American numbers', () => {
    expect(hrefs('Call +421 905 123 456 today')).toEqual(['tel:+421905123456']);
    expect(hrefs('Mobil: 0905 123 456.')).toEqual(['tel:0905123456']);
    expect(hrefs('Office (02) 1234 5678')).toEqual(['tel:0212345678']);
    expect(hrefs('+1 (415) 555-2671 or 415-555-2671 or (415) 555-2671')).toEqual([
      'tel:+14155552671',
      'tel:4155552671',
      'tel:4155552671',
    ]);
    expect(hrefs('+14155552671')).toEqual(['tel:+14155552671']);
    expect(spans('Reach us at +44 20 7946 0958, thanks')).toEqual(['+44 20 7946 0958']);
  });

  it('leaves dates, versions, ids, prices and times alone', () => {
    for (const t of [
      '2026-10-09',
      'version 0.6.0 and 1.2.3.4',
      'order 1234567890',
      '192.168.1.10',
      'costs 1 250 000 €',
      '10:30-11:45',
      'ISBN 978-3-16-148410-0',
      'https://example.com/+421905123456',
      'commit 0a48815 and 0905',
      'id=+421905123456',
      '+12 3',
    ]) {
      expect(hrefs(t)).toEqual([]);
    }
  });
});

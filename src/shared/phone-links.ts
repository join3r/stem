// Phone numbers in a reply become tel: links, so a click on the Mac hands the
// call to FaceTime / the paired iPhone and a tap on the phone dials. Detection
// is deliberately narrow: a model reply is full of digit runs (dates, versions,
// order ids, prices) and a false link is worse than a missing one. A number
// counts only in one of these shapes:
//   - international: a leading +, then 8–15 digits in groups (+421 905 123 456)
//   - national with a trunk 0 and separators (0905 123 456, (02) 1234 5678)
//   - North American with separators ((415) 555-2671, 415-555-2671)
// The iOS app mirrors this in ios/Stem/Markdown (PhoneLinks.swift).

const PHONE_RE =
  /(?<![\w/.+=:-])(?:\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,6}|\(?0\d{1,4}\)?(?:[ .-]\d{2,4}){2,4}|\(\d{3}\) ?\d{3}[ .-]\d{4}|\d{3}[.-]\d{3}[.-]\d{4})(?![\w/-]|[.,:]\d)/g;

export interface PhoneMatch {
  start: number;
  end: number;
  /** The tel: URL, digits only (and the leading + when written). */
  href: string;
}

export function findPhoneNumbers(text: string): PhoneMatch[] {
  const out: PhoneMatch[] = [];
  for (const m of text.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) continue;
    out.push({ start: m.index, end: m.index + m[0].length, href: `tel:${m[0].startsWith('+') ? '+' : ''}${digits}` });
  }
  return out;
}

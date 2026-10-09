// Secrets recognised by their shape, wherever they turn up in a recording: an
// API key typed into an ordinary field, a token copied from a dashboard, a JWT
// in a page's text. The helper catches secrets by WHERE they are (password
// fields, password managers, fields named "PIN"); this catches what slips past
// that, before anything leaves the Mac. The helper runs the same patterns
// (Record.swift redactSecrets); this is the second net.

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|rk|pk)-(?:[a-z]+-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bxai-[A-Za-z0-9]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi
];

/** A long run of letters, digits and token punctuation with upper, lower AND digits: a key, not a word or a hash. */
const OPAQUE = /[A-Za-z0-9_+/-]{32,}={0,2}/g;

/**
 * A link's address is left to the named patterns (a shared doc's id looks just
 * like a key and is the point of the link); its query and fragment are not:
 * that is where reset links, magic links and OAuth redirects carry tokens.
 */
const URL_RUN = /\bhttps?:\/\/[^\s?#]+/g;

function looksOpaque(run: string): boolean {
  return /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run);
}

export const SECRET_MARK = '[secret]';

/** The text with every secret-shaped run replaced by "[secret]". */
export function redactSecrets(text: string): string {
  let out = text;
  for (const p of PATTERNS) out = out.replace(p, SECRET_MARK);
  const opaque = (part: string) => part.replace(OPAQUE, (run) => (looksOpaque(run) ? SECRET_MARK : run));
  let result = '';
  let last = 0;
  for (const m of out.matchAll(URL_RUN)) {
    result += opaque(out.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return result + opaque(out.slice(last));
}

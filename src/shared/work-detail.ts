/** Bounded, credential-redacted display data. Never pass reasoning blocks here. */
export function workDetail(value: unknown, limit = 24_000): string {
  const seen = new WeakSet<object>();
  let changed = false;
  const redactText = (text: string): string => text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/(?<![\w.-])((?:"|')?(?:api[_-]?key|(?:access|refresh|auth)[_-]?token|token|password|passwd|secret|client[_-]?secret|(?:[a-z][a-z0-9]*[_-])+(?:token|password|secret|(?:access|api|private)[_-]?key))(?:"|')?\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;"']+)/gi,
      (_match, prefix: string, content: string) => `${prefix}${content.startsWith('"') ? '"[redacted]"' : content.startsWith("'") ? "'[redacted]'" : '[redacted]'}`);
  const clean = (v: unknown, depth = 0): unknown => {
    if (depth > 12) return '[depth limit]';
    if (typeof v === 'string') {
      const redacted = redactText(v);
      changed ||= redacted !== v;
      return redacted;
    }
    if (!v || typeof v !== 'object') return v;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([key, x]) => {
      if (/token|secret|password|passwd|api.?key|authorization|credential|cookie|bearer|^env$|^headers$/i.test(key)) {
        changed ||= x !== '[redacted]';
        return [key, '[redacted]'];
      }
      return [key, clean(x, depth + 1)];
    }));
  };
  let text: string;
  if (typeof value === 'string') {
    // Tool results usually arrive as text, including serialized JSON. Scrub
    // their structured fields too, while preserving untouched text verbatim.
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { /* Plain tool output is expected. */ }
    if (parsed && typeof parsed === 'object') {
      const cleaned = clean(parsed);
      text = changed ? JSON.stringify(cleaned, null, 2) : value;
    } else text = redactText(value);
  } else text = JSON.stringify(clean(value), null, 2) ?? '';
  return text.length > limit ? text.slice(0, limit) + '\n[Output truncated]' : text;
}

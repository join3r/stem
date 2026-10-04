// The one or two lines under an Inbox row. The text comes out of a transcript,
// so it is Markdown (and sometimes MDX) — but the row renders it as plain text in
// a clamped span, so every marker in it is noise at best and a lie at worst:
// `**done**` would read as literal asterisks, and a table would arrive as a hedge
// of pipes. This reduces a message to the words a person would have read.
//
// It is deliberately one-way and lossy: nothing here has to round-trip, so where
// a construct has no plain-text reading (rules, fence markers, tags) it simply
// goes away, and where it has one (link text, image alt, code contents) that is
// what is kept.

/** Max length of a preview — two clamped lines can't show more than this anyway. */
export const MAX_PREVIEW = 200;

/**
 * Components whose body is data (JSON, Mermaid) or suggestions, not prose: the
 * preview keeps only their title or caption. Without this a reply that opens
 * with a chart previewed as `[{"label":"Q1","value":12}…`.
 */
const DATA_COMPONENT = /^\s*<(Chart|DataTable|Stats|Compare|Diagram|Replies)\b([^>]*)>/;
/** The words a component's own attributes carry (a Quiz topic, a Form prompt). */
const LABEL_ATTR = /\b(?:title|caption|topic|prompt)="([^"]*)"/;

/** Line-level constructs, stripped before the text is flattened into one line. */
function stripBlocks(input: string): string {
  const out: string[] = [];
  let skipping: string | null = null;
  for (let line of input.split('\n')) {
    if (skipping) {
      if (line.includes(`</${skipping}>`)) skipping = null;
      continue;
    }
    const data = DATA_COMPONENT.exec(line);
    if (data) {
      const label = LABEL_ATTR.exec(data[2])?.[1];
      if (label) out.push(label);
      if (!line.includes(`</${data[1]}>`) && !/\/>\s*$/.test(line)) skipping = data[1];
      continue;
    }
    const labelled = /^\s*<(?:Quiz|Form|Collapsible)\b([^>]*)>/.exec(line);
    if (labelled) {
      const label = LABEL_ATTR.exec(labelled[1])?.[1];
      if (label) out.push(label);
    }
    // Fence markers go; whatever is inside them stays, so a reply that is mostly
    // code still previews as something rather than as nothing.
    if (/^\s*(```|~~~)/.test(line)) continue;
    // Thematic breaks and setext underlines are pure decoration.
    if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) continue;
    if (/^\s{0,3}(=+|-+)\s*$/.test(line)) continue;
    // A table's delimiter row (|---|:--:|) has no words in it at all.
    if (/^\s*\|?[\s:|-]*\|[\s:|-]*$/.test(line) && line.includes('-')) continue;

    line = line.replace(/^\s{0,3}#{1,6}\s+/, '');
    line = line.replace(/^(\s{0,3}>\s?)+/, '');
    line = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '');
    // Checklist boxes read as brackets, not as state.
    line = line.replace(/^\[[ xX]\]\s*/, '');
    // Table cells: the bars are structure, the cells are words.
    if (line.includes('|')) line = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\s*\|\s*/g, ' · ');
    out.push(line);
  }
  return out.join('\n');
}

/** Inline constructs, unwrapped down to the text they were decorating. */
function stripInline(text: string): string {
  return (
    text
      // Autolinks first — the tag sweep below would otherwise eat <https://…>.
      .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
      // HTML and MDX tags: the tag is markup, its children are content.
      .replace(/<\/?[A-Za-z][^>]*>/g, '')
      // Images keep their alt text; links keep their label, never their URL.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      .replace(/\[\^[^\]]+\]/g, '')
      .replace(/``([^`]+)``/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      // Single-marker emphasis only between non-word characters, so file_name_x
      // and 3 * 4 survive intact.
      .replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1')
      .replace(/(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, '$1')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
  );
}

// A backslash escape exists for the parser, not the reader — but the marker it
// protects must not be mistaken for a live one on the way past. So an escaped
// character is parked in a private-use code point, outside the alphabet the
// strippers look at, and put back once they have all run.
const ESCAPED = /\\([\\`*_{}[\]()#+\-.!>~|])/g;
const PARKED = /\uE000(\d+)\uE000/g;

/**
 * Flatten one message to the plain, single-line text an Inbox row shows.
 * Returns '' when nothing readable is left — the row then shows no preview,
 * which is better than showing punctuation.
 */
export function previewText(raw: string, cap = MAX_PREVIEW): string {
  const parked = (raw ?? '').replace(ESCAPED, (_m, c: string) => `\uE000${c.charCodeAt(0)}\uE000`);
  const text = stripInline(stripBlocks(parked))
    .replace(PARKED, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= cap) return text;
  return `${text.slice(0, cap - 1).trimEnd()}…`;
}

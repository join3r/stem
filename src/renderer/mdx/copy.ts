import { closeDataComponents } from './render';
import { toComponentTree, type TreeBlock } from './tree';
import { parseTable, toNumber, type Row } from './data';
import { formatCompact } from './chart/scale';

// What "Copy message" puts on the clipboard: the reply as plain Markdown, with
// every MDX component turned into the Markdown a person would have written for
// it. A Callout becomes a quote, Steps a numbered list, a Chart or DataTable a
// table of its numbers, a Diagram its Mermaid fence. Suggested replies are UI
// and go. Pasted into Slack, Notion or a text file it reads right, where the
// raw reply was a page of <Callout> tags and JSON.
//
// It walks the same component tree the phone parses (tree.ts), and the phone
// carries a port of it (ios/Stem/Markdown/MdxCopy.swift): both are checked
// against the *.copy.md files beside the shared fixtures in tests/fixtures/mdx.

const CALLOUT_LABELS: Record<string, string> = {
  info: 'Note',
  warn: 'Warning',
  success: 'Done',
  danger: 'Caution',
};

/** The reply as Markdown with no component tags left in it. */
export function mdxToMarkdown(text: string): string {
  const tree = toComponentTree(closeDataComponents(text));
  return tidy(blocksToMarkdown(tree.blocks));
}

function blocksToMarkdown(blocks: TreeBlock[]): string {
  return blocks.map(blockToMarkdown).filter((s) => s.trim()).join('\n\n');
}

function blockToMarkdown(b: TreeBlock): string {
  if (b.kind === 'md') return stripTags(b.text);
  const inner = () => blocksToMarkdown(b.children);
  const a = b.attrs;
  switch (b.name) {
    case 'Callout': {
      const label = CALLOUT_LABELS[a.type ?? ''] ?? 'Note';
      const body = inner();
      // A callout that opens with prose takes its label inline; one that opens
      // with a list, heading or code puts the label on its own line.
      const opensWithProse = !/^(\s*([-*+]|\d+[.)])\s|#|>|```|~~~|\|)/.test(body);
      return quote(body && opensWithProse ? `**${label}:** ${body}` : `**${label}**\n\n${body}`.trim());
    }
    case 'Steps':
      return numbered(b.children.filter((c) => c.kind === 'component' && c.name === 'Step').map(childrenMd));
    case 'Collapsible':
    case 'Tab':
      return titled(a.title ?? a.label, inner());
    case 'Tabs':
      return blocksToMarkdown(b.children);
    case 'DataTable': {
      const table = parseTable(b.data?.value);
      return titled(a.caption, table ? mdTable(table.columns, table.rows) : '');
    }
    case 'Chart': {
      const table = parseTable(b.data?.value);
      const title = a.title && a.unit ? `${a.title} (${a.unit})` : a.title;
      return titled(title, table ? mdTable(table.columns, table.rows) : '');
    }
    case 'Stats':
      return stats(b.data?.value);
    case 'Compare':
      return compare(b.data?.value, a.recommend);
    case 'Diagram': {
      const source = b.data?.value.trim();
      return titled(a.title, source ? `\`\`\`${b.data?.lang || 'mermaid'}\n${source}\n\`\`\`` : '');
    }
    case 'Quiz': {
      const questions = b.children.filter((c) => c.kind === 'component' && c.name === 'Question');
      return titled(a.topic, numbered(questions.map(question)));
    }
    case 'Question':
      return question(b);
    case 'Form': {
      const fields = b.children.filter((c) => c.kind === 'component' && c.name === 'Field');
      return titled(a.prompt, fields.map(field).join('\n'));
    }
    case 'Field':
      return field(b);
    case 'FactChange': {
      const label = a.label && !a.label.endsWith('?') ? a.label : a.kind === 'save' ? 'Saved' : 'Retired';
      const line = `- **${label}:** ${a.text ?? ''}`.trimEnd();
      return a.reason ? `${line} (${a.reason})` : line;
    }
    case 'Replies':
    case 'Reply':
      return '';
    default:
      // Step, Choice, Option and unknown tags: their content, without the tag.
      return inner();
  }
}

type Component = Extract<TreeBlock, { kind: 'component' }>;

const childrenMd = (b: TreeBlock): string => (b.kind === 'component' ? blocksToMarkdown(b.children) : '');

function question(q: TreeBlock): string {
  if (q.kind !== 'component') return '';
  const choices = q.children.filter((c) => c.kind === 'component' && c.name === 'Choice').map(childrenMd);
  const lines = [q.attrs.prompt ?? '', ...choices.map((c) => `- ${c}`)];
  if (q.attrs.answer) lines.push('', `Answer: ${q.attrs.answer}`);
  return lines.filter((l, i) => l || i > 0).join('\n');
}

function field(f: TreeBlock): string {
  if (f.kind !== 'component') return '';
  const label = f.attrs.label ?? f.attrs.name ?? '';
  const options = (f as Component).children
    .filter((c) => c.kind === 'component' && c.name === 'Option')
    .map(childrenMd);
  return [`- ${label}`, ...options.map((o) => `  - ${o}`)].join('\n');
}

function stats(raw: string | undefined): string {
  const table = parseTable(raw);
  if (!table) return '';
  return table.rows
    .map((r) => {
      const unit = typeof r.unit === 'string' ? r.unit : undefined;
      const value = typeof r.value === 'number' ? formatCompact(r.value, unit) : cell(r.value);
      const previous = toNumber(r.previous);
      const delta = r.delta !== undefined && r.delta !== null ? cell(r.delta).trim() : '';
      const change = delta ? ` (${delta})` : previous !== null ? ` (was ${formatCompact(previous, unit)})` : '';
      return `- **${cell(r.label)}:** ${value}${change}`;
    })
    .join('\n');
}

function compare(raw: string | undefined, recommend: string | undefined): string {
  const table = parseTable(raw);
  if (!table) return '';
  const pick = recommend?.trim().toLowerCase();
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(cell).filter(Boolean) : typeof v === 'string' && v ? [v] : [];
  return table.rows
    .slice(0, 4)
    .map((r) => {
      const name = cell(r.name ?? r.option);
      const summary = cell(r.summary ?? r.bestFor ?? r.best_for);
      const picked = !!pick && name.trim().toLowerCase() === pick;
      const head = `**${name}**${picked ? ' (recommended)' : ''}${summary ? `: ${summary}` : ''}`;
      const items = [...list(r.pros).map((p) => `- Pro: ${p}`), ...list(r.cons).map((c) => `- Con: ${c}`)];
      return [head, ...items].join('\n');
    })
    .join('\n\n');
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(cell).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function mdTable(columns: string[], rows: Row[]): string {
  if (!columns.length) return '';
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const line = (cells: string[]) => `| ${cells.map(esc).join(' | ')} |`;
  return [line(columns), line(columns.map(() => '---')), ...rows.map((r) => line(columns.map((c) => cell(r[c]))))].join(
    '\n'
  );
}

function titled(title: string | undefined, body: string): string {
  const head = title?.trim() ? `**${title.trim()}**` : '';
  return [head, body].filter(Boolean).join('\n\n');
}

function numbered(items: string[]): string {
  return items
    .filter((s) => s.trim())
    .map((s, i) => {
      const marker = `${i + 1}. `;
      return marker + s.split('\n').map((l, j) => (j && l ? ' '.repeat(marker.length) + l : l)).join('\n');
    })
    .join('\n');
}

function quote(body: string): string {
  return body
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
}

/**
 * Component tags left inside a Markdown run: an inline <Kbd>Cmd</Kbd>, or a
 * reply that would not parse as MDX at all. The tags go, their words stay.
 * Code (fenced or inline) is left exactly as written.
 */
function stripTags(md: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of md.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) fence = null;
      out.push(line);
      continue;
    }
    if (marker) {
      fence = marker;
      out.push(line);
      continue;
    }
    if (/^\s*<\/?[A-Z][\w.]*(?:\s[^>]*)?\/?>\s*$/.test(line)) continue; // a tag alone on its line
    out.push(
      line
        .split(/(`+[^`]*`+)/)
        .map((part, i) => (i % 2 ? part : part.replace(/<\/?[A-Z][\w.]*(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?\/?>/g, '')))
        .join('')
    );
  }
  return out.join('\n');
}

function tidy(md: string): string {
  return md.replace(/\n{3,}/g, '\n\n').trim();
}

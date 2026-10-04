import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import { stripCiteMarkers } from '../../shared/citations';

// The component tree of a reply: runs of plain Markdown (kept as their raw
// source) and the MDX components between them, nested. It is the contract
// between this renderer's parse and the phone's own line parser
// (ios/Stem/Markdown/MdxTree.swift): both must produce the same tree for every
// fixture in tests/fixtures/mdx. The phone draws Markdown runs with its own
// Markdown renderer, so only the component structure has to agree.

export type TreeBlock =
  | { kind: 'md'; text: string }
  | {
      kind: 'component';
      name: string;
      attrs: Record<string, string>;
      data?: { lang: string; value: string };
      children: TreeBlock[];
    };

export interface ComponentTree {
  blocks: TreeBlock[];
}

/**
 * Components whose first fenced code child is their data (JSON rows, Mermaid
 * source) rather than prose. In every other component a code fence is content
 * and stays in the children.
 */
export const DATA_COMPONENTS: ReadonlySet<string> = new Set(['Chart', 'DataTable', 'Stats', 'Compare', 'Diagram']);

interface Pos {
  start: { offset?: number };
  end: { offset?: number };
}

interface Node {
  type: string;
  name?: string | null;
  value?: string;
  lang?: string | null;
  attributes?: Array<{ type: string; name?: string; value?: unknown }>;
  children?: Node[];
  position?: Pos;
}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);

const isComponent = (n: Node) =>
  (n.type === 'mdxJsxFlowElement' || n.type === 'mdxJsxTextElement') &&
  typeof n.name === 'string' &&
  /^[A-Z]/.test(n.name);

const isBlank = (n: Node) => n.type === 'text' && !(n.value ?? '').trim();

/** A paragraph that is only one-line components (`<Step>…</Step>`, `<Reply>…</Reply>`). */
function inlineComponents(n: Node): Node[] | null {
  if (n.type !== 'paragraph') return null;
  const kids = (n.children ?? []).filter((c) => !isBlank(c));
  return kids.length && kids.every(isComponent) ? kids : null;
}

function attrsOf(n: Node): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of n.attributes ?? []) {
    if (a.type === 'mdxJsxAttribute' && typeof a.name === 'string' && typeof a.value === 'string') out[a.name] = a.value;
  }
  return out;
}

function blocksOf(nodes: Node[], src: string): TreeBlock[] {
  const out: TreeBlock[] = [];
  let run: Node[] = [];
  const flush = () => {
    if (!run.length) return;
    const start = run[0].position?.start.offset ?? 0;
    const end = run[run.length - 1].position?.end.offset ?? src.length;
    const text = src.slice(start, end).trim();
    if (text) out.push({ kind: 'md', text });
    run = [];
  };
  for (const n of nodes) {
    const inline = inlineComponents(n);
    if (isComponent(n) || inline) {
      flush();
      for (const c of inline ?? [n]) out.push(componentOf(c, src));
    } else if (!isBlank(n)) {
      run.push(n);
    }
  }
  flush();
  return out;
}

function componentOf(n: Node, src: string): TreeBlock {
  const name = n.name as string;
  let kids = n.children ?? [];
  let data: { lang: string; value: string } | undefined;
  if (DATA_COMPONENTS.has(name)) {
    const code = kids.find((c) => c.type === 'code');
    if (code) {
      data = { lang: code.lang ?? '', value: code.value ?? '' };
      // The fence is gone from the children, and Markdown on either side of it
      // stays two runs, as it is on the phone.
      const at = kids.indexOf(code);
      const before = blocksOf(kids.slice(0, at), src);
      const after = blocksOf(kids.slice(at + 1), src);
      return { kind: 'component', name, attrs: attrsOf(n), data, children: [...before, ...after] };
    }
  }
  kids = kids.filter((c) => !isBlank(c));
  return { kind: 'component', name, attrs: attrsOf(n), children: blocksOf(kids, src) };
}

/**
 * The reply as Markdown runs and components. A reply that is not valid MDX
 * (the renderer falls back to plain Markdown for it) is one Markdown run.
 */
export function toComponentTree(text: string): ComponentTree {
  const src = stripCiteMarkers(text).replace(/\r\n/g, '\n');
  let root: Node;
  try {
    root = processor.parse(src) as unknown as Node;
  } catch {
    const t = src.trim();
    return { blocks: t ? [{ kind: 'md', text: t }] : [] };
  }
  return { blocks: blocksOf(root.children ?? [], src) };
}

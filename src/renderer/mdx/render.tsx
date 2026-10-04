import type { ReactNode } from 'react';
import { Fragment, createElement } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import { stripCiteMarkers } from '../../shared/citations';
import { CodeBlock, TaskItem, componentMap } from './components';

// A minimal structural type for the mdast/mdx nodes we walk.
interface MdNode {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  checked?: boolean | null;
  url?: string;
  alt?: string;
  lang?: string;
  name?: string | null;
  attributes?: Array<{ type: string; name?: string; value?: unknown }>;
  children?: MdNode[];
}

const mdxProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);
const plainProcessor = unified().use(remarkParse).use(remarkGfm);

/**
 * Only allow safe URL schemes; everything else (e.g. javascript:) is dropped.
 * file: links are allowed for links only, never images: the main process
 * opens them on this machine (src/desktop/open-link.ts).
 */
function safeUrl(url: string | undefined, allowFile = false): string | undefined {
  if (!url) return undefined;
  if (/^(https?:|mailto:|tel:|#|\/)/i.test(url)) return url;
  if (allowFile && /^file:/i.test(url)) return url;
  if (/^data:image\//i.test(url)) return url;
  return undefined;
}

/** Extract plain string-valued JSX attributes; expression-valued attrs are ignored. */
function stringAttributes(node: MdNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of node.attributes ?? []) {
    if (attr.type === 'mdxJsxAttribute' && typeof attr.name === 'string' && typeof attr.value === 'string') {
      out[attr.name] = attr.value;
    }
  }
  return out;
}

function renderChildren(node: MdNode, keyPrefix: string): ReactNode[] {
  return (node.children ?? []).map((child, i) => renderNode(child, `${keyPrefix}-${i}`));
}

function renderNode(node: MdNode, key: string): ReactNode {
  switch (node.type) {
    case 'root':
      return <Fragment key={key}>{renderChildren(node, key)}</Fragment>;
    case 'paragraph':
      return <p key={key}>{renderChildren(node, key)}</p>;
    case 'text':
      return node.value ?? '';
    case 'heading': {
      const tag = `h${Math.min(Math.max(node.depth ?? 1, 1), 6)}`;
      return createElement(tag, { key }, renderChildren(node, key));
    }
    case 'strong':
      return <strong key={key}>{renderChildren(node, key)}</strong>;
    case 'emphasis':
      return <em key={key}>{renderChildren(node, key)}</em>;
    case 'delete':
      return <del key={key}>{renderChildren(node, key)}</del>;
    case 'inlineCode':
      return <code key={key} className="inline-code">{node.value}</code>;
    case 'code':
      return <CodeBlock key={key} lang={node.lang ?? undefined} value={node.value ?? ''} />;
    case 'list': {
      // GFM task lists mark items with `checked`; the list itself drops its
      // bullets so the checkboxes become the markers.
      const task = (node.children ?? []).some((c) => typeof c.checked === 'boolean');
      const className = task ? 'task-list' : undefined;
      return node.ordered
        ? <ol key={key} className={className}>{renderChildren(node, key)}</ol>
        : <ul key={key} className={className}>{renderChildren(node, key)}</ul>;
    }
    case 'listItem':
      return typeof node.checked === 'boolean'
        ? <TaskItem key={key} checked={node.checked}>{renderChildren(node, key)}</TaskItem>
        : <li key={key}>{renderChildren(node, key)}</li>;
    case 'link': {
      const href = safeUrl(node.url, true);
      if (href && /^file:/i.test(href)) {
        const open = (e: { preventDefault(): void }) => {
          e.preventDefault();
          void window.stem.openLink(href);
        };
        return <a key={key} href={href} title={href} onClick={open}>{renderChildren(node, key)}</a>;
      }
      return href
        ? <a key={key} href={href} target="_blank" rel="noreferrer">{renderChildren(node, key)}</a>
        : <Fragment key={key}>{renderChildren(node, key)}</Fragment>;
    }
    case 'image': {
      const src = safeUrl(node.url);
      return src ? <img key={key} src={src} alt={node.alt ?? ''} /> : <Fragment key={key}>{node.alt ?? ''}</Fragment>;
    }
    case 'blockquote':
      return <blockquote key={key}>{renderChildren(node, key)}</blockquote>;
    case 'thematicBreak':
      return <hr key={key} />;
    case 'break':
      return <br key={key} />;
    case 'table':
      return <table key={key}><tbody>{renderChildren(node, key)}</tbody></table>;
    case 'tableRow':
      return <tr key={key}>{renderChildren(node, key)}</tr>;
    case 'tableCell':
      return <td key={key}>{renderChildren(node, key)}</td>;

    // MDX components: only render allow-listed ones; others become inert text.
    case 'mdxJsxFlowElement':
    case 'mdxJsxTextElement': {
      const name = typeof node.name === 'string' ? node.name : '';
      const entry = componentMap[name];
      const children = <Fragment key={`${key}-c`}>{renderChildren(node, key)}</Fragment>;
      if (entry) {
        // Data-heavy components (Chart/DataTable) read their payload from a fenced
        // code child (e.g. ```json …```). We surface its RAW text so the component
        // can JSON.parse it — this never executes model code, it's just data.
        const dataChild = (node.children ?? []).find((c) => c.type === 'code');
        const data = dataChild
          ? { lang: dataChild.lang ?? undefined, value: dataChild.value ?? '' }
          : undefined;
        return <Fragment key={key}>{entry(stringAttributes(node), children, data)}</Fragment>;
      }
      // Unknown component (e.g. <script>): drop the tag, keep children as text.
      return children;
    }

    // Security: never execute model JS or imports.
    case 'mdxFlowExpression':
    case 'mdxTextExpression':
    case 'mdxjsEsm':
      return null;

    // Raw HTML is rendered inert (as escaped text), never as live markup.
    case 'html':
      return <span key={key}>{node.value ?? ''}</span>;

    default:
      return node.children ? <Fragment key={key}>{renderChildren(node, key)}</Fragment> : (node.value ?? null);
  }
}

/** Every tag the renderer instantiates; the stream splitter tracks only these. */
export const COMPONENT_NAMES: ReadonlySet<string> = new Set(Object.keys(componentMap));

/** One top-level block of a reply, and the component still being written in it, if any. */
export interface StreamBlock {
  text: string;
  /**
   * The outermost component the block opened and hasn't closed yet (or the
   * name typed so far of a tag still being written). Only ever set on the last
   * block: everything before it closed before the split.
   */
  open: string | null;
  /** Every component open at the end of the block, outermost first. */
  stack: string[];
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/;
// A complete opening, closing or self-closing tag. Attribute values are plain
// strings, so a `>` inside quotes is the one case worth skipping over.
const TAG = /<(\/?)([A-Z][A-Za-z0-9]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g;
// A tag cut off at the end of the text: `<Cha`, `<Chart type="li`, `</Ste`.
const PARTIAL_TAG = /<\/?([A-Z][A-Za-z0-9]*)?(?:\s(?:[^>"']|"[^"]*"|'[^']*')*(?:"[^"]*|'[^']*)?)?$/;

/**
 * Split a (possibly still streaming) reply into top-level blocks. A boundary
 * is a blank line outside a fenced code block AND outside any component: a
 * `<Steps>` or `<Chart>` spanning blank lines stays one block, so each block
 * parses on its own. A component starting at the top level also starts a new
 * block, and one closing back to the top level ends its block.
 *
 * In an append-only stream every block but the last is final, which is what
 * lets StreamingMdxView parse each exactly once; the last block reports the
 * component it is still inside, so the view can show a placeholder instead
 * of half a tag. Approximate on purpose (a loose list split by blank lines
 * renders as separate blocks until completion); the settled message
 * re-renders via the exact full parse.
 */
export function splitStreamBlocks(text: string): StreamBlock[] {
  const blocks: StreamBlock[] = [];
  let current: string[] = [];
  let fence: string | null = null; // the opening fence marker (``` or ~~~, possibly longer)
  const stack: string[] = [];
  const flush = () => {
    if (current.length) blocks.push({ text: current.join('\n'), open: null, stack: [] });
    current = [];
  };
  for (const line of text.split('\n')) {
    if (fence) {
      current.push(line);
      // Closing fence: same char, at least as long, nothing else on the line.
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = open[1];
      current.push(line);
      continue;
    }
    if (!line.trim()) {
      if (stack.length === 0) flush();
      else current.push(line);
      continue;
    }
    const depthBefore = stack.length;
    let opensAtTop = false;
    for (const m of line.matchAll(TAG)) {
      const [, closing, name, selfClosing] = m;
      if (!COMPONENT_NAMES.has(name)) continue;
      if (closing) {
        const at = stack.lastIndexOf(name);
        if (at !== -1) stack.length = at;
      } else if (!selfClosing) {
        if (stack.length === 0 && m.index === line.search(/\S/)) opensAtTop = true;
        stack.push(name);
      }
    }
    if (depthBefore === 0 && opensAtTop) flush();
    current.push(line);
    if (depthBefore > 0 && stack.length === 0) flush();
  }
  flush();
  const last = blocks[blocks.length - 1];
  if (last) {
    if (stack.length) {
      last.open = stack[0];
      last.stack = [...stack];
    } else if (!fence) {
      // A tag still being typed at the very end is "open" too: rendering it now
      // would flash `<Cha` as text.
      const tail = last.text.split('\n').pop() ?? '';
      const partial = PARTIAL_TAG.exec(tail);
      if (partial && (!partial[1] || [...COMPONENT_NAMES].some((n) => n.startsWith(partial[1])))) {
        last.open = partial[1] && COMPONENT_NAMES.has(partial[1]) ? partial[1] : '';
      }
    }
  }
  return blocks;
}

/**
 * Containers whose content is prose the user can start reading before the
 * closing tag arrives. A streaming tail open only on these is closed
 * provisionally and rendered live; anything else (a Chart's data, a Quiz's
 * answers) shows a placeholder until it is complete.
 */
const LIVE_CONTAINERS: ReadonlySet<string> = new Set(['Callout', 'Steps', 'Step', 'Tabs', 'Tab', 'Collapsible']);

/**
 * The streaming tail as something renderable now: `live` text with its open
 * prose containers closed provisionally, and the component still being
 * written that should show as a placeholder after it (null when none).
 */
export function provisionalTail(block: StreamBlock): { live: string; pending: string | null } {
  if (block.open === null) return { live: block.text, pending: null };
  // Drop a tag cut off mid-way; it is re-read whole on the next delta.
  const lines = block.text.split('\n');
  const lastLine = lines.pop() ?? '';
  const cut = PARTIAL_TAG.exec(lastLine);
  const text = [...lines, cut ? lastLine.slice(0, cut.index) : lastLine].join('\n').trimEnd();
  if (block.stack.length === 0) return { live: text, pending: block.open };
  if (!block.stack.every((name) => LIVE_CONTAINERS.has(name))) {
    // Show what came before the component; the component itself waits.
    return { live: '', pending: block.open };
  }
  const closers = [...block.stack].reverse().map((name) => `</${name}>`);
  return { live: `${text}\n\n${closers.join('\n')}`, pending: null };
}

/**
 * Split markdown into top-level blocks (see {@link splitStreamBlocks}), text only.
 */
export function splitMdBlocks(text: string): string[] {
  return splitStreamBlocks(text).map((b) => b.text);
}

/**
 * Parse the safe MDX subset and render it to React. Tries MDX parsing first
 * (to recognize component tags); if the model emitted malformed JSX, falls back
 * to plain Markdown so the answer still renders. Never executes model code.
 * Leaked web-search citation markers are stripped here rather than per delta —
 * a marker can split across delta boundaries, but the accumulated text passed
 * in always contains it whole (or as a strippable unterminated tail).
 */
/**
 * Render a block only if it parses as MDX; null otherwise. The streaming view
 * uses it on a provisionally closed tail, where the plain-Markdown fallback
 * would show the component's tags as text for a moment.
 */
export function tryRenderMdx(text: string): ReactNode | null {
  try {
    return renderNode(mdxProcessor.parse(stripCiteMarkers(text)) as unknown as MdNode, 'mdx');
  } catch {
    return null;
  }
}

export function renderMdx(text: string): ReactNode {
  text = stripCiteMarkers(text);
  let tree: MdNode;
  try {
    tree = mdxProcessor.parse(text) as unknown as MdNode;
  } catch {
    try {
      tree = plainProcessor.parse(text) as unknown as MdNode;
    } catch {
      return <p>{text}</p>;
    }
  }
  return renderNode(tree, 'mdx');
}

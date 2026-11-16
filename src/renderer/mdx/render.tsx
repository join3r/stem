import type { ReactNode } from 'react';
import { Fragment, createElement } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import { stripCiteMarkers } from '../../shared/citations';
import { filePathHref, findFilePaths } from '../../shared/file-paths';
import { filesPlaceRel, scratchRel } from '../../shared/files-links';
import { useMdxStatic, useMdxThread } from './ActionContext';
import { findPhoneNumbers } from '../../shared/phone-links';
import { openStemLink, parseStemLink } from '../stemLinks';
import { CodeBlock, TaskItem, componentMap } from './components';
import { RemoteImage } from './RemoteImage';

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

/**
 * How deep the rendered tree may go. Real replies nest a handful of levels
 * (a list in a Tab in Tabs); model output nested thousands deep would overflow
 * the stack while rendering and, with no error boundary, blank the window.
 * Past the cap the rest of the branch renders as its plain text.
 */
const MAX_RENDER_DEPTH = 48;
let renderDepth = 0;

function plainText(node: MdNode): string {
  if (node.value !== undefined) return node.value;
  let out = '';
  // An explicit stack, so flattening a deep branch can't recurse either.
  const pending: MdNode[] = [...(node.children ?? [])].reverse();
  while (pending.length) {
    const n = pending.pop()!;
    if (n.value !== undefined) out += n.value;
    else pending.push(...[...(n.children ?? [])].reverse());
  }
  return out;
}

/** Inside a link, text stays text: an <a> must not nest another. */
let linkDepth = 0;

function linkChildren(node: MdNode, key: string): ReactNode[] {
  linkDepth += 1;
  try {
    return renderChildren(node, key);
  } finally {
    linkDepth -= 1;
  }
}

/** A file:// link: the main process opens or reveals it on this computer. On a share page, its text. */
function FileLink({ href, children }: { href: string; children: ReactNode }) {
  if (useMdxStatic()) return <>{children}</>;
  const open = (e: { preventDefault(): void }) => {
    e.preventDefault();
    void window.stem.openLink(href);
  };
  return <a href={href} title={decodeFileHref(href)} className="file-link" onClick={open}>{children}</a>;
}

/** A file in the user's Files place (shared/files-links.ts): fetched to this computer and opened. On a share page, its text. */
function FilesPlaceLink({ rel, children }: { rel: string; children: ReactNode }) {
  if (useMdxStatic()) return <>{children}</>;
  const open = (e: { preventDefault(): void }) => {
    e.preventDefault();
    // quiet: a file that is gone or will not fetch leaves the click without effect, like a dead file: link.
    void window.stem.openFilesItem?.(rel).catch(() => undefined);
  };
  return <a href={`files/${rel}`} title={`Files › ${rel}`} className="file-link" onClick={open}>{children}</a>;
}

/**
 * A file in this chat's scratch folder (shared/files-links.ts), where the
 * assistant keeps its own work. Outside a chat (mail, facts, a share page)
 * there is no scratch folder to name, so the link is plain text.
 */
function ScratchLink({ rel, children }: { rel: string; children: ReactNode }) {
  const threadId = useMdxThread();
  const shared = useMdxStatic();
  if (shared || !threadId || !window.stem?.openScratchItem) return <>{children}</>;
  const open = (e: { preventDefault(): void }) => {
    e.preventDefault();
    // quiet: a file swept with old scratch, or one that will not fetch, leaves the click without effect.
    void window.stem.openScratchItem!(threadId, rel).catch(() => undefined);
  };
  // data-thread: the right-click menu (desktop/context-menu.ts) reads the chat from it.
  return (
    <a href={`scratch/${rel}`} data-thread={threadId} title={`This chat's scratch › ${rel}`} className="file-link" onClick={open}>
      {children}
    </a>
  );
}

function decodeFileHref(href: string): string {
  try {
    return decodeURI(href.replace(/^file:\/\/\/~\//i, '~/'));
  } catch {
    return href;
  }
}

/**
 * Plain text with phone numbers as tel: links (shared/phone-links.ts) and
 * file paths as file:// links (shared/file-paths.ts).
 */
function renderText(value: string, key: string): ReactNode {
  if (linkDepth) return value;
  const matches = [
    ...findPhoneNumbers(value).map((m) => ({ ...m, file: false })),
    ...findFilePaths(value).map((m) => ({ ...m, file: true })),
  ].sort((a, b) => a.start - b.start);
  if (!matches.length) return value;
  const out: ReactNode[] = [];
  let at = 0;
  matches.forEach((m, i) => {
    if (m.start < at) return; // overlapping (a digit run inside a path)
    if (m.start > at) out.push(value.slice(at, m.start));
    const text = value.slice(m.start, m.end);
    out.push(m.file
      ? <FileLink key={`${key}-file${i}`} href={m.href}>{text}</FileLink>
      : <a key={`${key}-tel${i}`} href={m.href}>{text}</a>);
    at = m.end;
  });
  if (at < value.length) out.push(value.slice(at));
  return <Fragment key={key}>{out}</Fragment>;
}

function renderChildren(node: MdNode, keyPrefix: string): ReactNode[] {
  if (renderDepth >= MAX_RENDER_DEPTH) return [plainText(node)];
  renderDepth += 1;
  try {
    return (node.children ?? []).map((child, i) => renderNode(child, `${keyPrefix}-${i}`));
  } finally {
    renderDepth -= 1;
  }
}

function renderNode(node: MdNode, key: string): ReactNode {
  switch (node.type) {
    case 'root':
      return <Fragment key={key}>{renderChildren(node, key)}</Fragment>;
    case 'paragraph': {
      // A component written on one line (`<Step>…</Step>`, `<Reply>…</Reply>`)
      // parses as inline JSX inside a paragraph. Its block markup (an <li>, a
      // <div>) must not land inside a <p>, so such a paragraph renders bare.
      const kids = (node.children ?? []).filter((c) => !(c.type === 'text' && !(c.value ?? '').trim()));
      if (kids.length && kids.every((c) => c.type === 'mdxJsxTextElement' && !!c.name && c.name in componentMap)) {
        return <Fragment key={key}>{kids.map((c, i) => renderNode(c, `${key}-${i}`))}</Fragment>;
      }
      return <p key={key}>{renderChildren(node, key)}</p>;
    }
    case 'text':
      return renderText(node.value ?? '', key);
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
    case 'inlineCode': {
      const code = <code key={key} className="inline-code">{node.value}</code>;
      const fileHref = linkDepth ? undefined : filePathHref(node.value ?? '');
      return fileHref ? <FileLink key={key} href={fileHref}>{code}</FileLink> : code;
    }
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
      const stemLink = parseStemLink(node.url ?? '');
      if (stemLink) {
        const open = (e: { preventDefault(): void }) => {
          e.preventDefault();
          openStemLink(stemLink);
        };
        return <a key={key} href={node.url} className="stem-link" onClick={open}>{linkChildren(node, key)}</a>;
      }
      const filesRel = filesPlaceRel(node.url);
      if (filesRel) return <FilesPlaceLink key={key} rel={filesRel}>{linkChildren(node, key)}</FilesPlaceLink>;
      const scratch = scratchRel(node.url);
      if (scratch) return <ScratchLink key={key} rel={scratch}>{linkChildren(node, key)}</ScratchLink>;
      const href = safeUrl(node.url, true);
      if (href && /^file:/i.test(href)) return <FileLink key={key} href={href}>{linkChildren(node, key)}</FileLink>;
      return href
        ? <a key={key} href={href} target="_blank" rel="noreferrer">{linkChildren(node, key)}</a>
        : <Fragment key={key}>{renderChildren(node, key)}</Fragment>;
    }
    case 'image': {
      const src = safeUrl(node.url);
      if (src && /^https?:/i.test(src)) return <RemoteImage key={key} src={src} alt={node.alt ?? ''} />;
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

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/;

// Data components: their content is one fenced block and nothing else (any
// children are ignored). A streaming reply draws these while their data is
// still arriving.
const LIVE_DATA: ReadonlySet<string> = new Set(['Diagram', 'Chart', 'DataTable', 'Stats', 'Compare']);
const DATA_OPEN = /^\s{0,3}<(Diagram|Chart|DataTable|Stats|Compare)\b(?:[^>"']|"[^"]*"|'[^']*')*>\s*$/;

/**
 * Close data components the model forgot to close. Models sometimes write
 * `<DataTable>` + its fence and carry straight on with prose, never writing
 * `</DataTable>`: the MDX parse of the whole reply then fails and every
 * component in it falls back to plain text. A data component holds nothing
 * after its fence, so a non-blank line other than its closing tag there means
 * the closer is missing: it is inserted right after the fence, and a later
 * orphaned closer of the same name is dropped. A line that may still grow into
 * the closer (`</Data` mid-stream) is left alone.
 */
export function closeDataComponents(text: string): string {
  if (!text.includes('<')) return text;
  const out: string[] = [];
  let fence: string | null = null;
  let open: string | null = null; // data component whose fence hasn't started yet
  let inData: string | null = null; // data component whose fence is being read
  let awaiting: { name: string; at: number } | null = null; // fence done, closer due
  const orphans = new Map<string, number>();
  let changed = false;
  for (const line of text.split('\n')) {
    if (fence) {
      out.push(line);
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        fence = null;
        if (inData) awaiting = { name: inData, at: out.length };
        inData = null;
      }
      continue;
    }
    const trimmed = line.trim();
    if (awaiting) {
      const closer = `</${awaiting.name}>`;
      if (!trimmed || closer.startsWith(trimmed.replace(/\s+(?=>)/, ''))) {
        if (trimmed && new RegExp(`^</${awaiting.name}\\s*>$`).test(trimmed)) awaiting = null;
        out.push(line);
        continue;
      }
      out.splice(awaiting.at, 0, closer);
      orphans.set(awaiting.name, (orphans.get(awaiting.name) ?? 0) + 1);
      awaiting = null;
      changed = true;
    }
    const orphan = /^<\/([A-Z][A-Za-z0-9]*)\s*>$/.exec(trimmed);
    if (orphan && (orphans.get(orphan[1]) ?? 0) > 0) {
      orphans.set(orphan[1], orphans.get(orphan[1])! - 1);
      changed = true;
      continue;
    }
    const fenceOpen = FENCE_OPEN.exec(line);
    if (fenceOpen) {
      fence = fenceOpen[1];
      inData = open;
      open = null;
      out.push(line);
      continue;
    }
    const dataOpen = DATA_OPEN.exec(line);
    // A new component of the same name owns the next closer.
    if (dataOpen) orphans.delete((open = dataOpen[1]));
    else if (trimmed) open = null;
    out.push(line);
  }
  return changed ? out.join('\n') : text;
}

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
  text = closeDataComponents(text);
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
  // A tag opened mid-line (`<Step>**One.** Fir`) is inline JSX: its closer
  // has to land on the same line, or the parse fails. The rest close on lines
  // of their own.
  const closers = [...block.stack].reverse().map((name) => `</${name}>`);
  const inner = block.stack[block.stack.length - 1];
  const tailLine = text.split('\n').pop() ?? '';
  const inline = new RegExp(`<${inner}\\b[^>]*>.*\\S`).test(tailLine);
  const live = inline
    ? `${text}${closers[0]}${closers.length > 1 ? `\n${closers.slice(1).join('\n')}` : ''}`
    : `${text}\n\n${closers.join('\n')}`;
  return { live, pending: null };
}

const ATTR = /\b([A-Za-z][A-Za-z0-9]*)=(?:"([^"]*)"|'([^']*)')/g;

/**
 * A top-level data component still being written (Diagram, Chart, DataTable,
 * Stats, Compare): its name, its attributes, and its data fence so far. Null
 * for anything else. `closed` says the fence itself has ended, so its last
 * line is complete. The streaming view draws these live instead of showing a
 * placeholder.
 */
export function streamingData(
  block: StreamBlock
): { name: string; props: Record<string, string>; value: string; closed: boolean } | null {
  if (block.open === null || !LIVE_DATA.has(block.open) || block.stack.length !== 1) return null;
  const name = block.open;
  const lines = block.text.split('\n');
  const open = new RegExp(`^\\s{0,3}<${name}\\b((?:[^>"']|"[^"]*"|'[^']*')*)>\\s*$`).exec(lines[0]);
  if (!open) return null;
  const props: Record<string, string> = {};
  for (const m of open[1].matchAll(ATTR)) props[m[1]] = m[2] ?? m[3];
  const fenceAt = lines.findIndex((line, i) => i > 0 && FENCE_OPEN.test(line));
  if (fenceAt === -1) return { name, props, value: '', closed: false };
  const marker = FENCE_OPEN.exec(lines[fenceAt])![1];
  const body: string[] = [];
  for (const line of lines.slice(fenceAt + 1)) {
    const close = FENCE_CLOSE.exec(line);
    if (close && close[1][0] === marker[0] && close[1].length >= marker.length) {
      return { name, props, value: body.join('\n'), closed: true };
    }
    body.push(line);
  }
  return { name, props, value: body.join('\n'), closed: false };
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
    return renderNode(mdxProcessor.parse(closeDataComponents(stripCiteMarkers(text))) as unknown as MdNode, 'mdx');
  } catch {
    return null;
  }
}

export function renderMdx(text: string): ReactNode {
  text = closeDataComponents(stripCiteMarkers(text));
  try {
    return renderNode(mdxProcessor.parse(text) as unknown as MdNode, 'mdx');
  } catch {
    // One malformed component shouldn't strip every other one: fall back block
    // by block, so only the blocks that don't parse render as plain Markdown.
    const blocks = splitMdBlocks(text);
    if (blocks.length > 1) {
      return blocks.map((block, i) => (
        <Fragment key={`fb-${i}`}>{tryRenderMdx(block) ?? renderPlain(block, `fb-${i}`)}</Fragment>
      ));
    }
    return renderPlain(text, 'mdx');
  }
}

function renderPlain(text: string, key: string): ReactNode {
  try {
    return renderNode(plainProcessor.parse(text) as unknown as MdNode, key);
  } catch {
    return <p>{text}</p>;
  }
}

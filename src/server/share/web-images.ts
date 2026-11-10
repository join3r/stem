// The web pictures a reply shows, found the way the app's renderer finds them
// (src/renderer/mdx/render.tsx renderMdx): citation markers stripped, an MDX
// parse, plain Markdown when the MDX parse fails, and every `image` node with
// an http(s) URL. A share snapshot carries the bytes of exactly these, so the
// share page shows the pictures the app shows, and no others.
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import { stripCiteMarkers } from '../../shared/citations';

interface Node {
  type: string;
  url?: unknown;
  children?: Node[];
}

const mdxProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);
const plainProcessor = unified().use(remarkParse).use(remarkGfm);

/** The http(s) picture URLs in a reply, in order, each once. */
export function webImageUrls(text: string): string[] {
  const source = stripCiteMarkers(text);
  let tree: Node;
  try {
    tree = mdxProcessor.parse(source) as unknown as Node;
  } catch {
    try {
      tree = plainProcessor.parse(source) as unknown as Node;
    } catch {
      // quiet: the renderer shows such text as one plain paragraph, with no pictures.
      return [];
    }
  }
  const out = new Set<string>();
  // An explicit stack: model output can nest deep enough to overflow recursion.
  const pending: Node[] = [tree];
  while (pending.length) {
    const n = pending.pop()!;
    if (n.type === 'image' && typeof n.url === 'string' && /^https?:/i.test(n.url)) out.add(n.url);
    if (n.children) for (let i = n.children.length - 1; i >= 0; i--) pending.push(n.children[i]!);
  }
  return [...out];
}

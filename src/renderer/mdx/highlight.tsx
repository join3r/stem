import type { ReactNode } from 'react';
import { createLowlight, common } from 'lowlight';

// Syntax coloring for fenced code blocks. lowlight runs highlight.js grammars
// but answers with a tree instead of an HTML string, so the result renders as
// React elements — no innerHTML anywhere near model output. Colors come from the
// --syn-* tokens (styles.css), which a theme may set like any other color.
//
// Only a fence that names a language highlight.js knows is colored: guessing a
// language for an unlabeled block is slow on long blocks and wrong often enough
// to look worse than plain text.

const lowlight = createLowlight(common);

/** Past this size a block renders plain: a pasted log is not worth a parse per streamed token. */
const MAX_CHARS = 60_000;

interface HastText { type: 'text'; value: string }
interface HastElement { type: 'element'; properties?: { className?: string[] }; children: HastNode[] }
type HastNode = HastText | HastElement | { type: string };

function toReact(nodes: HastNode[], key: string): ReactNode[] {
  return nodes.map((node, i) => {
    if (node.type === 'text') return (node as HastText).value;
    if (node.type !== 'element') return null;
    const el = node as HastElement;
    return (
      <span key={`${key}.${i}`} className={el.properties?.className?.join(' ')}>
        {toReact(el.children, `${key}.${i}`)}
      </span>
    );
  });
}

/** The code as colored spans, or null when the language is unknown or the block too big. */
export function highlightCode(lang: string | undefined, value: string): ReactNode[] | null {
  const name = lang?.trim().toLowerCase();
  if (!name || value.length > MAX_CHARS || !lowlight.registered(name)) return null;
  try {
    return toReact(lowlight.highlight(name, value).children as HastNode[], 'h');
  } catch {
    return null; // a grammar that throws on odd input still leaves readable plain text
  }
}

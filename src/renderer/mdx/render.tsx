import type { ReactNode } from 'react';
import { Fragment, createElement } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import { CodeBlock, componentMap } from './components';

// A minimal structural type for the mdast/mdx nodes we walk.
interface MdNode {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  url?: string;
  alt?: string;
  lang?: string;
  name?: string | null;
  attributes?: Array<{ type: string; name?: string; value?: unknown }>;
  children?: MdNode[];
}

const mdxProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);
const plainProcessor = unified().use(remarkParse).use(remarkGfm);

/** Only allow safe URL schemes; everything else (e.g. javascript:) is dropped. */
function safeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (/^(https?:|mailto:|#|\/)/i.test(url)) return url;
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
    case 'list':
      return node.ordered
        ? <ol key={key}>{renderChildren(node, key)}</ol>
        : <ul key={key}>{renderChildren(node, key)}</ul>;
    case 'listItem':
      return <li key={key}>{renderChildren(node, key)}</li>;
    case 'link': {
      const href = safeUrl(node.url);
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
        return <Fragment key={key}>{entry(stringAttributes(node), children)}</Fragment>;
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

/**
 * Parse the safe MDX subset and render it to React. Tries MDX parsing first
 * (to recognize component tags); if the model emitted malformed JSX, falls back
 * to plain Markdown so the answer still renders. Never executes model code.
 */
export function renderMdx(text: string): ReactNode {
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

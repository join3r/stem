import { mdxToMarkdown } from './copy';
import { renderMdx } from './render';
import { MdxStaticContext, type MdxStatic } from './ActionContext';

// "Copy message" for a reply: Markdown as the plain text (Slack, Notion, a
// text editor), and the same Markdown drawn as HTML for apps that paste
// formatting (Mail, Pages, Google Docs). Both come from mdxToMarkdown, so no
// component tags reach either.

/** Links into this computer or Stem open nothing once pasted: they copy as their text. */
const STATIC: MdxStatic = { webImage: () => undefined };

export async function replyHtml(markdown: string): Promise<string> {
  // Loaded on the first copy, never with the app.
  const { renderToStaticMarkup } = await import('react-dom/server');
  const html = renderToStaticMarkup(
    <MdxStaticContext.Provider value={STATIC}>{renderMdx(markdown)}</MdxStaticContext.Provider>
  );
  // Copy buttons on code blocks and the checkboxes of task lists are controls,
  // not content. The markup is React's own (model text in it is escaped), so a
  // tag match is exact here.
  return html.replace(/<button\b[^>]*>[\s\S]*?<\/button>/g, '').replace(/<input\b[^>]*>/g, '');
}

export async function copyReply(text: string): Promise<void> {
  const markdown = mdxToMarkdown(text);
  try {
    const html = await replyHtml(markdown);
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([markdown], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ]);
  } catch {
    // No rich clipboard here (or the HTML would not draw): the Markdown alone.
    await navigator.clipboard.writeText(markdown);
  }
}

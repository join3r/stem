// The 0.6.0 components, rendered the way the chat renders them: through
// renderMdx, inside (or outside) the action and message contexts.
import { describe, expect, it } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMdx } from '../../src/renderer/mdx/render';
import {
  EARLIER_MESSAGE,
  LATEST_MESSAGE,
  MdxActionContext,
  MdxMessageContext,
  type MdxMessage
} from '../../src/renderer/mdx/ActionContext';

const actions = { submit: () => undefined, running: false };
function html(text: string, opts: { actions?: boolean; message?: MdxMessage } = {}): string {
  let tree: ReactNode = renderMdx(text);
  if (opts.message) tree = createElement(MdxMessageContext.Provider, { value: opts.message }, tree);
  if (opts.actions) tree = createElement(MdxActionContext.Provider, { value: actions }, tree);
  return renderToStaticMarkup(createElement('div', null, tree));
}
const json = (v: unknown) => '```json\n' + JSON.stringify(v) + '\n```';

describe('Replies', () => {
  const doc = 'Answer.\n\n<Replies>\n<Reply>Compare with last year</Reply>\n<Reply>Why?</Reply>\n</Replies>';

  it('shows chips only on the newest reply, where something can be sent', () => {
    expect(html(doc, { actions: true, message: LATEST_MESSAGE })).toContain('Compare with last year</button>');
    expect(html(doc, { actions: true, message: EARLIER_MESSAGE })).not.toContain('mdx-replies');
    // The Inbox and other read-only views have no action provider.
    expect(html(doc, { message: LATEST_MESSAGE })).not.toContain('mdx-replies');
  });
});

describe('Stats', () => {
  it('computes the change from previous, colors it by whether it is good, and keeps text values as written', () => {
    const out = html(
      `<Stats>\n${json([
        { label: 'Users', value: 12400, previous: 10900 },
        { label: 'Churn', value: 3.1, previous: 3.8, unit: '%', good: 'down' },
        { label: 'Uptime', value: '99.98%' }
      ])}\n</Stats>`
    );
    expect(out).toContain('12.4k');
    expect(out).toContain('+13.8%');
    expect(out).toMatch(/stat-change good[^>]*>.*−0\.7 pp/);
    expect(out).toContain('99.98%');
  });
});

describe('Compare', () => {
  it('marks the recommended option', () => {
    const out = html(
      `<Compare recommend="sqlite">\n${json([
        { name: 'PostgreSQL', pros: ['Concurrent writers'], cons: ['A server'] },
        { name: 'SQLite', summary: 'A file', pros: 'Zero ops' }
      ])}\n</Compare>`
    );
    expect(out.match(/compare-card picked/g)).toHaveLength(1);
    expect(out).toContain('Recommended');
    expect(out).toContain('Zero ops');
  });
});

describe('Diagram', () => {
  it('waits for mermaid behind a placeholder and never renders the source as HTML', () => {
    const out = html('<Diagram title="Flow">\n```mermaid\nflowchart LR\n  A --> B\n```\n</Diagram>');
    expect(out).toContain('Drawing diagram…');
    expect(out).toContain('Flow');
  });
});

describe('one-line components', () => {
  it('does not wrap a one-line Step in a paragraph', () => {
    const out = html('<Steps>\n<Step>**One.** First.</Step>\n<Step>**Two.** Second.</Step>\n</Steps>');
    expect(out).not.toContain('<p><li');
    expect(out.match(/<li class="step">/g)).toHaveLength(2);
  });
});

describe('Form outside a chat', () => {
  it('lists what it asks for instead of showing inputs that go nowhere', () => {
    const doc = '<Form prompt="Details">\n<Field name="dates" label="Travel dates" />\n</Form>';
    expect(html(doc)).toContain('Reply with these to answer.');
    expect(html(doc)).not.toContain('<input');
    expect(html(doc, { actions: true })).toContain('<input');
  });
});

describe('hostile nesting', () => {
  it('renders absurdly deep nesting as text instead of overflowing the stack', () => {
    const deep = '<Callout>\n'.repeat(3000) + 'bottom' + '\n</Callout>'.repeat(3000);
    expect(() => html(deep)).not.toThrow();
    expect(html(deep)).toContain('bottom');
    const quotes = '>'.repeat(5000) + ' deep quote';
    expect(() => html(quotes)).not.toThrow();
  });
});

describe('phone numbers', () => {
  it('render as tel: links, but never inside an existing link or code', () => {
    expect(html('Call **+421 905 123 456** now')).toContain('<a href="tel:+421905123456">+421 905 123 456</a>');
    expect(html('[+421 905 123 456](https://example.com)')).not.toContain('tel:');
    expect(html('`+421 905 123 456`')).not.toContain('tel:');
  });
});

// The 0.6.0 components, rendered the way the chat renders them: through
// renderMdx, inside (or outside) the action and message contexts.
import { describe, expect, it } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMdx } from '../../src/renderer/mdx/render';
import { FormHostContext, MdxSourceContext, createFormHost } from '../../src/renderer/mdx/FormHost';
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
  it('waits for the renderer behind a placeholder and never renders the source as HTML', () => {
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

describe('Form choice fields', () => {
  const doc = [
    '<Form prompt="Memory check">',
    '<Field type="choice" name="q1" label="Which launcher?" hint="Two facts disagree." other="true">',
    '<Option>Raycast</Option>',
    '<Option>Alfred</Option>',
    '</Field>',
    '</Form>'
  ].join('\n');
  const hosted = (text: string) =>
    renderToStaticMarkup(
      createElement(
        MdxActionContext.Provider,
        { value: actions },
        createElement(
          FormHostContext.Provider,
          { value: createFormHost('above', () => undefined) },
          createElement(MdxSourceContext.Provider, { value: 'mail:test' }, createElement('div', null, renderMdx(text)))
        )
      )
    );

  it('shows each option as a chip, plus Other…, with its own submit outside a host', () => {
    const out = html(doc, { actions: true });
    expect(out).toContain('>Raycast</button>');
    expect(out).toContain('>Alfred</button>');
    expect(out).toContain('>Other…</button>');
    expect(out).toContain('Two facts disagree.');
    expect(out).toContain('mdx-form-submit');
  });

  it('in a host, leaves sending to the answer bar and offers Ask on each question', () => {
    const out = hosted(doc);
    expect(out).not.toContain('mdx-form-submit');
    expect(out).toContain('0 of 1 answered');
    expect(out).toContain('send from the bar above');
    expect(out).toContain('mdx-field-ask');
  });

  it('lists the options where nothing can be sent', () => {
    expect(html(doc)).toContain('(Raycast / Alfred)');
  });
});

describe('FactChange', () => {
  it('shows the fact, why, and the action its status allows', () => {
    const applied = html('<FactChange check="k" change="c1" fact="2833" text="The user is a cloud engineer." reason="From a course intro." status="applied" />');
    expect(applied).toContain('#2833');
    expect(applied).toContain('fact-change-text gone');
    expect(applied).toContain('>Undo</button>');
    const proposed = html('<FactChange check="k" change="c2" fact="2744" text="Favourite VR games." reason="Only a list." status="proposed" />');
    expect(proposed).toContain('Retire?');
    expect(proposed).toContain('>Keep</button>');
    expect(proposed).toContain('>Retire</button>');
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

describe('ordered list start', () => {
  const html = (md: string) => renderToStaticMarkup(createElement('div', null, renderMdx(md)));
  it('keeps the first number of a list that does not start at 1', () => {
    // A date range at the start of a bullet parses as a nested ordered list.
    const out = html('- 4. – 9. septembra 2026\n- 25. septembra 2026');
    expect(out).toContain('<ol start="4">');
    expect(out).toContain('<ol start="25">');
    expect(html('1. a\n2. b')).toContain('<ol>');
  });
});

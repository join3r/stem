// Inbox previews. The row is a plain-text span, so everything Markdown uses to
// mean something has to come off before it gets there — and the words it was
// decorating have to survive.
import { describe, expect, it } from 'vitest';
import { MAX_PREVIEW, previewText } from '../../src/server/chats/preview';

describe('previewText', () => {
  it('leaves plain prose alone, flattened to one line', () => {
    expect(previewText('The build is green\nagain.')).toBe('The build is green again.');
  });

  it('unwraps emphasis, code spans and strikethrough', () => {
    expect(previewText('**Done** — the *retry* path is `fixed`, ~~again~~')).toBe(
      'Done — the retry path is fixed, again'
    );
    expect(previewText('___all three___ and ``double ticks``')).toBe('all three and double ticks');
  });

  it('does not mistake snake_case or arithmetic for emphasis', () => {
    expect(previewText('set file_name_here to 3 * 4 * 5')).toBe('set file_name_here to 3 * 4 * 5');
  });

  it('keeps a link’s text and drops its URL', () => {
    expect(previewText('See [the run](https://ci.example.com/42) for details')).toBe(
      'See the run for details'
    );
    expect(previewText('![a chart](chart.png) shows the dip')).toBe('a chart shows the dip');
    expect(previewText('as [noted][ref] earlier')).toBe('as noted earlier');
  });

  it('keeps a bare autolink readable instead of eating it as a tag', () => {
    expect(previewText('grab it from <https://example.com/x>')).toBe('grab it from https://example.com/x');
  });

  it('drops heading, quote, bullet and checklist markers', () => {
    expect(previewText('## Findings\n\n- one\n- two\n\n> and a caveat')).toBe(
      'Findings one two and a caveat'
    );
    expect(previewText('1. first\n2) second')).toBe('first second');
    expect(previewText('- [ ] ship it\n- [x] tested')).toBe('ship it tested');
  });

  it('keeps the contents of a code block but not its fence', () => {
    expect(previewText('Try this:\n\n```ts\nconst x = 1;\n```')).toBe('Try this: const x = 1;');
  });

  it('reads a table as cells, not as a hedge of pipes', () => {
    const table = '| Region | Q3 |\n| --- | ---: |\n| EMEA | 12 |';
    expect(previewText(table)).toBe('Region · Q3 EMEA · 12');
  });

  it('drops horizontal rules and setext underlines', () => {
    expect(previewText('Findings\n========\n\nall clear\n\n---\n\nnext')).toBe('Findings all clear next');
  });

  it('strips HTML and MDX tags while keeping what they wrap', () => {
    expect(previewText('<Tabs><Tab label="one">the first</Tab></Tabs>')).toBe('the first');
    expect(previewText('a <strong>bold</strong> claim')).toBe('a bold claim');
  });

  it('unescapes backslash escapes, which existed only for the parser', () => {
    expect(previewText('the literal \\*asterisks\\* case')).toBe('the literal *asterisks* case');
    // An escaped marker is not a live one: this line is prose, not a bullet.
    expect(previewText('\\- not a list item')).toBe('- not a list item');
  });

  it('caps long text with an ellipsis', () => {
    const out = previewText('word '.repeat(200));
    expect(out.length).toBe(MAX_PREVIEW);
    expect(out.endsWith('…')).toBe(true);
  });

  it('is empty when nothing readable is left', () => {
    expect(previewText('---\n\n***\n')).toBe('');
    expect(previewText('')).toBe('');
  });

  // A component's body can be data: JSON, Mermaid, suggested replies. The row
  // shows the component's own title instead, then the prose around it.
  it('keeps a data component’s title and drops its body', () => {
    const reply = [
      'Bills are falling.',
      '',
      '<Chart type="line" title="Monthly bill" unit="€">',
      '```json',
      '[{"label":"Jan","value":92},{"label":"Feb","value":88}]',
      '```',
      '</Chart>',
      '',
      '<Stats>',
      '```json',
      '[{"label":"Users","value":12400}]',
      '```',
      '</Stats>',
      '',
      'Want the yearly view?',
      '',
      '<Replies>',
      '<Reply>Show the year</Reply>',
      '</Replies>'
    ].join('\n');
    expect(previewText(reply)).toBe('Bills are falling. Monthly bill Want the yearly view?');
  });

  it('keeps a Quiz topic or Form prompt beside their content', () => {
    expect(previewText('<Form prompt="A few details first">\n<Field name="d" label="Dates" />\n</Form>')).toBe(
      'A few details first'
    );
  });
});

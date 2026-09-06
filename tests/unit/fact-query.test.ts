import { describe, expect, it } from 'vitest';
import { formatFactQuery, previousFactUserMessages } from '../../src/server/recall/fact-query';

function user(id: string, parentId: string | null, content: unknown) {
  return { id, parentId, type: 'message', message: { role: 'user', content } };
}

function prior(content: unknown): string[] {
  return previousFactUserMessages({ entries: [user('u', null, content)], leafId: 'u' });
}

describe('fact query context', () => {
  it('follows the selected branch through compaction and ignores later sibling entries', () => {
    const entries = [
      user('u0', null, 'too old'),
      user('u1', 'u0', 'selected first'),
      { id: 'a', parentId: 'u1', type: 'message', message: { role: 'assistant', content: 'assistant text' } },
      { id: 'c', parentId: 'a', type: 'compaction', summary: 'summary text' },
      user('u2', 'c', 'selected second'),
      user('sibling', 'u0', 'other branch'),
      user('future', 'u2', 'future turn')
    ];
    expect(previousFactUserMessages({ entries, leafId: 'u2' })).toEqual(['selected first', 'selected second']);
  });

  it('validates ancestry past the last two eligible messages', () => {
    const entries = [user('first', 'missing', 'first'), user('second', 'first', 'second')];
    expect(previousFactUserMessages({ entries, leafId: 'second' })).toEqual([]);
    entries[0].parentId = 'second';
    expect(previousFactUserMessages({ entries, leafId: 'second' })).toEqual([]);
  });

  it.each([
    null,
    {},
    { entries: [], leafId: 'missing' },
    { entries: [user('u', null, 'text'), user('u', null, 'duplicate')], leafId: 'u' },
    { entries: [{ id: 'u', type: 'message' }], leafId: 'u' },
    { entries: [user('u', null, 'text')], leafId: 1 }
  ])('rejects malformed snapshots without a flat-history fallback: %j', (snapshot) => {
    expect(previousFactUserMessages(snapshot)).toEqual([]);
  });

  it('strips a complete leading context block but preserves in-message markers', () => {
    const raw = 'A question\n<!--stem:context-->literal example<!--/stem:context-->';
    expect(prior(`<!--stem:context-->Recall and instructions<!--/stem:context-->\n\n${raw}`)).toEqual([raw]);
    expect(prior(raw)).toEqual([raw]);
    expect(prior('<!--stem:context-->missing closing fence')).toEqual([]);
    expect(prior('<!--stem:context-->hidden<!--/stem:context-->no separator')).toEqual([]);
    expect(prior('<!--stem:context broken prefix')).toEqual([]);
  });

  it.each([
    '<!--stem:scheduled at="2026-01-01"-->hidden<!--/stem:scheduled-->\n\nRun task',
    '<!--stem:mail from=someone-->hidden<!--/stem:mail-->\n\nMail body',
    'This is an automated scheduled run — execute it.',
    'Question\n\nAttached file: notes.txt\n```\nDocument bytes\n```',
    'Question\n\n(Skipped unsupported attachment: notes.bin)',
    [{ type: 'text', text: 'Question' }, { type: 'image', data: 'synthetic', mimeType: 'image/png' }],
    [{ type: 'text', text: 'Question' }, { type: 'file', path: 'synthetic.txt' }]
  ])('omits automated or attachment-bearing messages: %j', (content) => {
    expect(prior(content)).toEqual([]);
  });

  it('skips non-user and ineligible turns while retaining older clean user text', () => {
    const entries: unknown[] = [user('u', null, [{ type: 'text', text: 'Ahoj ' }, { type: 'text', text: 'svet' }])];
    let parent = 'u';
    for (const role of ['assistant', 'toolResult', 'system', 'custom']) {
      entries.push({ id: role, parentId: parent, type: 'message', message: { role, content: 'not user text' } });
      parent = role;
    }
    entries.push(user('empty', parent, '  '), user('attached', 'empty', 'Attached file: notes.txt'));
    expect(previousFactUserMessages({ entries, leafId: 'attached' })).toEqual(['Ahoj svet']);
  });

  it('retains legitimate repetitions and never adds the current message as prior context', () => {
    const context = previousFactUserMessages({
      entries: [user('a', null, 'Again'), user('b', 'a', 'Again')], leafId: 'b'
    });
    expect(context).toEqual(['Again', 'Again']);
    expect(formatFactQuery('Current only', context)).toBe(
      'Earlier messages from the user in this conversation:\n- Again\n- Again\n\nCurrent message: Current only'
    );
  });

  it('bounds prior context, preserves Unicode, and leaves the current input unchanged', () => {
    const long = '😀'.repeat(401);
    const current = 'Čo teraz?\n' + 'x'.repeat(500);
    expect(prior(long)).toEqual(['😀'.repeat(400)]);
    expect(formatFactQuery(current, ['discard', 'První otázka', '', long, ' '])).toBe(
      `Earlier messages from the user in this conversation:\n- První otázka\n- ${'😀'.repeat(400)}\n\nCurrent message: ${current}`
    );
    expect(formatFactQuery(current, ['', ' '])).toBe(current);
    expect(previousFactUserMessages({ entries: [], leafId: null })).toEqual([]);
  });
});

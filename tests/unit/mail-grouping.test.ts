// The conversation fold: persona↔persona runs collapse into 'exchange' groups
// between the mails the user actually sent or received.
import { describe, expect, it } from 'vitest';
import { groupMailTimeline } from '../../src/renderer/mail/grouping';
import type { MailItem } from '../../src/shared/types';

let n = 0;
function mail(from: string, to: string[], body = ''): MailItem {
  n += 1;
  return { id: `m${n}`, conversationId: 'c', from, to, body, at: n };
}

describe('groupMailTimeline', () => {
  it('folds persona↔persona runs between user-visible mails', () => {
    const groups = groupMailTimeline([
      mail('user', ['verifier', 'orchestrator']),
      mail('verifier', ['orchestrator']),
      mail('orchestrator', ['verifier']),
      mail('verifier', ['user']),
      mail('user', ['verifier', 'orchestrator']),
      mail('verifier', ['orchestrator']),
      mail('verifier', ['user'])
    ]);
    expect(groups.map((g) => (g.kind === 'mail' ? g.item.from : `x${g.items.length}`))).toEqual([
      'user',
      'x2',
      'verifier',
      'user',
      'x1',
      'verifier'
    ]);
  });

  it('a persona mail that CCs the user stands alone (the user received it)', () => {
    const groups = groupMailTimeline([
      mail('user', ['verifier']),
      mail('verifier', ['orchestrator', 'user']),
      mail('orchestrator', ['verifier'])
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['mail', 'mail', 'exchange']);
  });

  it('an all-visible conversation folds nothing', () => {
    const groups = groupMailTimeline([mail('user', ['normal']), mail('normal', ['user'])]);
    expect(groups.every((g) => g.kind === 'mail')).toBe(true);
  });
});

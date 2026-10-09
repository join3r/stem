// The conversation's reading layout: newest on top, consulting folded onto the
// reply it produced, work on the mail it made, running work kept for the live card.
import { describe, expect, it } from 'vitest';
import { exchangeLabel, layoutThread } from '../../src/renderer/mail/thread';
import type { MailItem, MailWorkGroup } from '../../src/shared/types';

let n = 0;
function mail(from: string, to: string[], extra: Partial<MailItem> = {}): MailItem {
  n += 1;
  return { id: `m${n}`, conversationId: 'c', from, to, body: `body ${n}`, at: n, ...extra };
}

function work(anchor: string | undefined, status: 'ok' | 'running' = 'ok'): MailWorkGroup {
  return {
    id: `w-${anchor}-${status}`,
    conversationId: 'c',
    ...(anchor ? { sourceItemId: anchor } : {}),
    runs: [{ id: 'r', personaId: 'normal', startedAt: 1, status, activities: [] }]
  };
}

describe('layoutThread', () => {
  it('reads newest first and folds consulting onto the reply it produced', () => {
    const ask = mail('user', ['normal', 'verifier']);
    const consult = mail('normal', ['verifier']);
    const answer = mail('verifier', ['normal']);
    const reply = mail('normal', ['user']);
    const layout = layoutThread([reply, ask, consult, answer], []);
    expect(layout.entries.map((e) => e.item.id)).toEqual([reply.id, ask.id]);
    expect(layout.entries[0].exchange.map((m) => m.id)).toEqual([consult.id, answer.id]);
    expect(layout.trailingExchange).toEqual([]);
  });

  it('consulting after the newest mail is still under way', () => {
    const ask = mail('user', ['normal']);
    const consult = mail('normal', ['verifier']);
    const layout = layoutThread([ask, consult], []);
    expect(layout.trailingExchange.map((m) => m.id)).toEqual([consult.id]);
  });

  it('puts work on the reply it produced, keeps running and orphan work apart', () => {
    const ask = mail('user', ['normal']);
    const reply = mail('normal', ['user']);
    const again = mail('user', ['normal']);
    const done = work(ask.id);
    const noReplyYet = work(again.id);
    const live = work(again.id, 'running');
    const orphan = work('missing');
    const layout = layoutThread([ask, reply, again], [done, noReplyYet, live, orphan]);
    const byId = Object.fromEntries(layout.entries.map((e) => [e.item.id, e.work.map((w) => w.id)]));
    expect(byId[reply.id]).toEqual([done.id]);
    expect(byId[again.id]).toEqual([noReplyYet.id]);
    expect(byId[ask.id]).toEqual([]);
    expect(layout.liveWork.map((w) => w.id)).toEqual([live.id]);
    expect(layout.unlinkedWork.map((w) => w.id)).toEqual([orphan.id]);
  });

  it('opens the newest mail, the latest reply to you, and pending approvals', () => {
    const ask = mail('user', ['normal']);
    const park = mail('normal', ['user'], {
      approval: {
        id: 'a',
        kind: 'exec',
        command: 'ls',
        status: 'pending',
        resume: { personaId: 'normal', threadId: 't', from: 'user', epoch: 1, sourceItemId: ask.id }
      }
    });
    const reply = mail('normal', ['user']);
    const followUp = mail('user', ['normal']);
    const layout = layoutThread([ask, park, reply, followUp], []);
    expect([...layout.defaultOpen].sort()).toEqual([followUp.id, park.id, reply.id].sort());
  });
});

describe('exchangeLabel', () => {
  it('names who the author consulted', () => {
    const x = [mail('normal', ['verifier']), mail('verifier', ['normal'])];
    expect(exchangeLabel(x, 'normal', (id) => id[0].toUpperCase() + id.slice(1))).toBe('Consulted Verifier · 2 mails');
  });
});

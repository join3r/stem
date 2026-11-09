import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage, MailConversation, MailItem } from '../../src/shared/types';
import { plainExcerpt, suggestCard, type ShareSnapshot } from '../../src/shared/share';
import {
  buildSnapshot,
  chatMessages,
  cleanAssistantText,
  mailMessages,
  pickMessages,
  ShareInputError
} from '../../src/server/share/snapshot';
import { keyFragment, openShare, sealShare } from '../../src/server/share/seal';
import { openShare as browserOpenShare } from '../../src/share/decrypt';
import { cleanRecipients, ShareService } from '../../src/server/share/service';
import { shareOpenedText } from '../../src/server/share/notice';
import { ShareStore } from '../../src/server/share/store';
import { RelayError } from '../../src/server/interstem/relay-client';
import type { ChatBackend } from '../../src/server/backend';
import type { InterStemService } from '../../src/server/interstem/service';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const chat: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'First question', turnId: 't1', createdAt: '2026-10-19T10:00:00Z' },
  {
    id: 'a1',
    role: 'assistant',
    content: 'First answer <FactChange check="c" change="x" fact="1" label="l" kind="k" text="secret" reason="r" status="open" />',
    turnId: 't1',
    meta: { model: 'openai-codex/gpt-6.1-sol' },
    activity: [{ id: 'x', kind: 'tool', type: 'commandExecution', detail: 'cat ~/secrets.txt', status: 'ok' }]
  },
  { id: 'system-t2', role: 'system', content: 'Turn failed', turnId: 't2' },
  {
    id: 'u2',
    role: 'user',
    content: 'Look at this [chat](stem://chat/abc)',
    turnId: 't3',
    attachments: [{ kind: 'image', name: 'me.png', dataUrl: `data:image/png;base64,${PNG}` }]
  },
  {
    id: 'a2',
    role: 'assistant',
    content: 'See [the file](file:///Users/v/notes.md) and stem://mail/xyz.\n\n<Replies>\n<Reply>More</Reply>\n</Replies>',
    turnId: 't3',
    images: [{ id: 'img_0123456789', threadId: 'th', mime: 'image/png', prompt: 'a cat' }],
    sources: [{ url: 'https://example.com', title: 'Ex' }, { url: 'javascript:alert(1)' }]
  },
  { id: 'u3', role: 'user', content: 'never sent', sendFailed: true }
];

const source = (messages = chat) => ({
  title: 'My chat',
  messages: chatMessages(messages),
  image: async (id: string) => (id === 'img_0123456789' ? { mimeType: 'image/png', data: PNG } : null)
});

describe('share snapshot', () => {
  it('drops system notices, failed sends, tool rows, memory cards and in-app links', async () => {
    const { snapshot, omittedAttachments } = await buildSnapshot(source(), {}, 1);
    expect(snapshot.kind).toBe('thread');
    expect(snapshot.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain('secret');
    expect(json).not.toContain('Turn failed');
    expect(json).not.toContain('never sent');
    expect(json).not.toContain('stem://');
    expect(json).not.toContain('file:');
    expect(json).not.toContain('cat ~/');
    expect(json).not.toContain('Replies');
    expect(json).not.toContain('javascript:');
    expect(snapshot.messages[2]!.text).toBe('Look at this chat');
    expect(snapshot.messages[3]!.text).toContain('See the file and');
    expect(snapshot.messages[1]!.model).toBe('gpt-6.1-sol');
    // The generated picture rides along; the user's own one doesn't by default.
    expect(snapshot.messages[3]!.images?.[0]?.alt).toBe('a cat');
    expect(snapshot.messages[2]!.images).toBeUndefined();
    expect(omittedAttachments).toBe(1);
  });

  it('includes the user’s pictures and hides the model on request', async () => {
    const { snapshot, omittedAttachments } = await buildSnapshot(source(), { includeAttachments: true, includeModel: false });
    expect(snapshot.messages[2]!.images).toHaveLength(1);
    expect(omittedAttachments).toBe(0);
    expect(snapshot.messages.some((m) => m.model)).toBe(false);
  });

  it('shares the question and answer, or the answer alone', async () => {
    const pair = (await buildSnapshot(source(), { scope: 'pair', anchorId: 't3' })).snapshot;
    expect(pair.kind).toBe('answer');
    expect(pair.messages.map((m) => m.text.slice(0, 4))).toEqual(['Look', 'See ']);
    const only = (await buildSnapshot(source(), { scope: 'answer', anchorId: 't3' })).snapshot;
    expect(only.messages.map((m) => m.role)).toEqual(['assistant']);
  });

  it('finds the question in an earlier turn when the answer’s turn has none', () => {
    const msgs = chatMessages([
      { id: 'u', role: 'user', content: 'q', turnId: 'a' },
      { id: 'x', role: 'assistant', content: 'r', turnId: 'b' }
    ]);
    expect(pickMessages(msgs, 'pair', 'b').map((m) => m.text)).toEqual(['q', 'r']);
    expect(() => pickMessages(msgs, 'pair', 'zzz')).toThrow(ShareInputError);
    expect(() => pickMessages(msgs, 'answer')).toThrow(ShareInputError);
  });

  it('finds an answer by its live turn id too', () => {
    // Just streamed: the bubble names its turn by the runtime id until the
    // chat is reloaded, while history keys it by the session entry id.
    const msgs = chatMessages([
      { id: 'u', role: 'user', content: 'q', turnId: 'entry-1', runtimeTurnId: 'live-1' },
      { id: 'x', role: 'assistant', content: 'r', turnId: 'entry-1', runtimeTurnId: 'live-1' }
    ]);
    expect(pickMessages(msgs, 'pair', 'live-1').map((m) => m.text)).toEqual(['q', 'r']);
    expect(pickMessages(msgs, 'answer', 'live-1').map((m) => m.text)).toEqual(['r']);
  });

  it('reads a mail thread as the user sees it', async () => {
    const at = 1_760_000_000_000;
    const items: MailItem[] = [
      { id: 'm1', conversationId: 'c', from: 'user', to: ['p1'], body: 'Plan my week', at },
      { id: 'm2', conversationId: 'c', from: 'p1', to: ['p2'], body: 'internal consult', at: at + 1 },
      { id: 'm3', conversationId: 'c', from: 'p1', to: ['user'], body: 'Here is the plan', at: at + 2,
        images: [{ id: 'img_0123456789', threadId: 'hidden', mime: 'image/png' }] },
      { id: 'm4', conversationId: 'c', from: 'p1', to: ['user'], body: 'approve?', at: at + 3,
        approval: { id: 'a', kind: 'exec', command: 'rm', status: 'pending', resume: {} as never } },
      { id: 'm5', conversationId: 'c', from: 'user', to: ['p1'], body: 'thanks', at: at + 4 }
    ];
    const messages = mailMessages(items, (id) => (id === 'p1' ? 'Secretary' : id));
    expect(messages.map((m) => m.text)).toEqual(['Plan my week', 'Here is the plan', 'thanks']);
    const { snapshot } = await buildSnapshot(
      { title: 'Week', messages, image: async () => ({ mimeType: 'image/png', data: PNG }) },
      { scope: 'pair', anchorId: 'm3' }
    );
    expect(snapshot.messages.map((m) => [m.role, m.author ?? null])).toEqual([
      ['user', null],
      ['assistant', 'Secretary']
    ]);
    expect(snapshot.messages[1]!.images).toHaveLength(1);
  });

  it('refuses a chat with no answer', async () => {
    await expect(buildSnapshot(source([chat[0]!]), {})).rejects.toThrow(ShareInputError);
  });

  it('keeps ordinary links and MDX', () => {
    expect(cleanAssistantText('[site](https://a.b) <Callout>hi</Callout>')).toBe('[site](https://a.b) <Callout>hi</Callout>');
  });
});

describe('link preview card', () => {
  it('suggests the title and a plain start of the first answer', () => {
    const snap: ShareSnapshot = {
      v: 1,
      kind: 'answer',
      title: '  Ako  natrieť terasu ',
      sharedAt: 1,
      messages: [
        { role: 'user', text: 'otázka' },
        {
          role: 'assistant',
          text: '## Krátko\n\nNa smrekovec stačia **dve** vrstvy, viď [návod](https://x.y).\n\n<Callout type="tip">Druhú po 12 h.</Callout>\n\n```bash\nrm -rf /\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'
        }
      ]
    };
    const card = suggestCard(snap);
    expect(card.title).toBe('Ako natrieť terasu');
    expect(card.description).toBe('Krátko Na smrekovec stačia dve vrstvy, viď návod. Druhú po 12 h. a b 1 2');
  });

  it('clips at a word with an ellipsis', () => {
    const out = plainExcerpt('slovo '.repeat(100), 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('slovo…')).toBe(true);
  });
});

describe('share encryption', () => {
  const snap: ShareSnapshot = { v: 1, kind: 'thread', title: 'Ž', sharedAt: 1, messages: [{ role: 'user', text: 'ahoj 👋' }] };

  it('round-trips in Node', () => {
    const { blob, key } = sealShare(JSON.stringify(snap));
    expect(blob[0]).toBe(1);
    expect(JSON.parse(openShare(blob, key))).toEqual(snap);
  });

  it('opens in the browser viewer’s WebCrypto code', async () => {
    const { blob, key } = sealShare(JSON.stringify(snap));
    expect(await browserOpenShare(new Uint8Array(blob), keyFragment(key))).toEqual(snap);
  });

  it('fails with the wrong key', async () => {
    const { blob } = sealShare(JSON.stringify(snap));
    await expect(browserOpenShare(new Uint8Array(blob), keyFragment(Buffer.alloc(32, 7)))).rejects.toThrow();
  });
});

describe('ShareService', () => {
  const runtime = {
    readThread: async () => ({ title: 'My chat', messages: chat }),
    findThreadImage: async () => ({ mimeType: 'image/png', data: PNG })
  } as unknown as ChatBackend;
  const identity = { seed: Buffer.alloc(32, 1), cert: {} as never };
  const interStem = (address: string | null, closed = false) =>
    ({
      status: async () => ({}),
      defaultSelf: async () => address,
      closedDomain: async () => closed,
      shareIdentity: async () => {
        if (!address) throw new Error('no address');
        return { relay: 'https://relay.test', address, identity };
      }
    }) as unknown as InterStemService;
  const store = () => {
    const path = join(mkdtempSync(join(tmpdir(), 'stem-shares-')), 'shares.json');
    return new ShareStore(() => path);
  };

  it('uploads a blob only the link’s key opens, and remembers the link', async () => {
    let uploaded: Uint8Array | null = null;
    const svc = new ShareService({
      runtime: () => runtime,
      interStem: () => interStem('a@b.test'),
      store: store(),
      upload: async (_relay, _id, blob, ttl) => {
        uploaded = blob;
        expect(ttl).toBe(30);
        return { id: 'AAAAAAAAAAAAAAAAAAAAAA', url: 'https://share.test/s/AAAAAAAAAAAAAAAAAAAAAA', expires: 99 };
      },
      now: () => 5
    });
    const link = await svc.create({ kind: 'chat', threadId: 'th' }, { scope: 'pair', anchorId: 't1', ttlDays: 30 });
    expect(link.url).toMatch(/^https:\/\/share\.test\/s\/A{22}#[A-Za-z0-9_-]{43}$/);
    const snap = await browserOpenShare(uploaded!, link.url.split('#')[1]!);
    expect(snap.kind).toBe('answer');
    expect(snap.messages[0]!.text).toBe('First question');
    expect(await svc.list()).toEqual([link]);
  });

  it('revokes on the relay, then forgets the link (an already-gone link too)', async () => {
    const removed: string[] = [];
    const svc = new ShareService({
      runtime: () => runtime,
      interStem: () => interStem('a@b.test'),
      store: store(),
      upload: async () => ({ id: 'BBBBBBBBBBBBBBBBBBBBBB', url: 'https://share.test/s/BBBBBBBBBBBBBBBBBBBBBB', expires: 0 }),
      remove: async (_r, _i, id) => {
        removed.push(id);
        throw new RelayError(404, 'not_found');
      }
    });
    const link = await svc.create({ kind: 'chat', threadId: 'th' });
    expect(await svc.revoke(link.id)).toEqual([]);
    expect(removed).toEqual([link.id]);
  });

  it('says why it can’t share, in plain words', async () => {
    const svc = new ShareService({ runtime: () => runtime, interStem: () => interStem(null), store: store() });
    expect(await svc.status()).toMatchObject({ available: false, code: 'no_address' });
    const closed = new ShareService({ runtime: () => runtime, interStem: () => interStem('a@acme.test', true), store: store() });
    expect(await closed.status()).toMatchObject({ available: false, code: 'policy' });
    const limited = new ShareService({
      runtime: () => runtime,
      interStem: () => interStem('a@b.test'),
      store: store(),
      upload: async () => {
        throw new RelayError(429, 'rate_limited');
      }
    });
    await expect(limited.create({ kind: 'chat', threadId: 'th' })).rejects.toThrow(/shared a lot today/);
  });

  it('sends the edited card, one line each, or none', async () => {
    const cards: unknown[] = [];
    const svc = new ShareService({
      runtime: () => runtime,
      interStem: () => interStem('a@b.test'),
      store: store(),
      upload: async (_r, _i, _b, _t, card) => {
        cards.push(card);
        return { id: 'DDDDDDDDDDDDDDDDDDDDDD', url: 'https://share.test/s/DDDDDDDDDDDDDDDDDDDDDD', expires: 1 };
      }
    });
    const src = { kind: 'chat' as const, threadId: 'th' };
    await svc.create(src, { card: { title: ' Môj\nnadpis ', description: 'x'.repeat(400) } });
    await svc.create(src, { card: { title: ' ', description: '' } });
    await svc.create(src, { card: null });
    expect(cards[0]).toEqual({ title: 'Môj nadpis', description: 'x'.repeat(300) });
    expect(cards.slice(1)).toEqual([null, null]);
  });

  it('defaults to 30 days and never asks for more', async () => {
    const asked: (number | undefined)[] = [];
    const svc = new ShareService({
      runtime: () => runtime,
      interStem: () => interStem('a@b.test'),
      store: store(),
      upload: async (_r, _i, _b, ttl) => {
        asked.push(ttl);
        return { id: 'CCCCCCCCCCCCCCCCCCCCCC', url: 'https://share.test/s/CCCCCCCCCCCCCCCCCCCCCC', expires: 1 };
      }
    });
    await svc.create({ kind: 'chat', threadId: 'th' });
    await svc.create({ kind: 'chat', threadId: 'th' }, { ttlDays: 365 });
    expect(asked).toEqual([30, 30]);
  });

  it('explains the 100-link cap', async () => {
    const svc = new ShareService({
      runtime: () => runtime,
      interStem: () => interStem('a@b.test'),
      store: store(),
      upload: async () => {
        throw new RelayError(507, 'too_many_links');
      }
    });
    await expect(svc.create({ kind: 'chat', threadId: 'th' })).rejects.toThrow(/100 working links/);
  });

  it('refuses another person’s mail and the memory check', async () => {
    const conv = (extra: Partial<MailConversation>) =>
      ({ id: 'c', subject: 's', participants: [], sessions: {}, ...extra }) as MailConversation;
    for (const conversation of [conv({ external: { address: 'x@y.z' } as never }), conv({ owner: 'memory-check' })]) {
      const svc = new ShareService({
        runtime: () => runtime,
        interStem: () => interStem('a@b.test'),
        store: store(),
        readMail: async () => ({ conversation, items: [], sys: {} as never }),
        personas: async () => []
      });
      await expect(svc.preview({ kind: 'mail', conversationId: 'c' })).rejects.toThrow(ShareInputError);
    }
  });
  it('locks a link to people: cleans the list and sends it to the relay', async () => {
    let sent: string[] | undefined;
    const svc = new ShareService({
      runtime: () => runtime,
      interStem: () => interStem('a@b.test'),
      store: store(),
      upload: async (_r, _i, _b, _t, _c, to) => {
        sent = to;
        return { id: 'CCCCCCCCCCCCCCCCCCCCCC', url: 'https://share.test/s/CCCCCCCCCCCCCCCCCCCCCC', expires: 0, recipients: to };
      }
    });
    const link = await svc.create({ kind: 'chat', threadId: 'th' }, { recipients: [' Martin@Gmail.com ', 'martin@gmail.com', '', 'eva@x.sk'] });
    expect(sent).toEqual(['martin@gmail.com', 'eva@x.sk']);
    expect(link.recipients).toEqual(['martin@gmail.com', 'eva@x.sk']);
    expect((await svc.list())[0]!.recipients).toEqual(['martin@gmail.com', 'eva@x.sk']);
    expect(() => cleanRecipients(['not-an-address'])).toThrow(/not an email address/);
    expect(() => cleanRecipients(Array.from({ length: 21 }, (_, i) => `p${i}@x.sk`))).toThrow(/at most 20/);
  });

  it('takes the link down when the relay did not lock it', async () => {
    const removed: string[] = [];
    const svc = new ShareService({
      runtime: () => runtime,
      interStem: () => interStem('a@b.test'),
      store: store(),
      // An old relay: ignores ?to= and answers without recipients.
      upload: async () => ({ id: 'DDDDDDDDDDDDDDDDDDDDDD', url: 'https://share.test/s/DDDDDDDDDDDDDDDDDDDDDD', expires: 0 }),
      remove: async (_r, _i, id) => {
        removed.push(id);
      }
    });
    await expect(svc.create({ kind: 'chat', threadId: 'th' }, { recipients: ['m@x.sk'] })).rejects.toThrow(/Nothing was shared/);
    expect(removed).toEqual(['DDDDDDDDDDDDDDDDDDDDDD']);
    expect(await svc.list()).toEqual([]);
  });

  it('stores who opened a locked link and announces each first opening once', async () => {
    let opens: { address: string; first: number; last: number; count: number }[] = [];
    const notices: string[][] = [];
    const svc = new ShareService({
      runtime: () => runtime,
      interStem: () => interStem('a@b.test'),
      store: store(),
      upload: async (_r, _i, _b, _t, _c, to) => ({ id: 'EEEEEEEEEEEEEEEEEEEEEE', url: 'https://share.test/s/EEEEEEEEEEEEEEEEEEEEEE', expires: 0, recipients: to }),
      relayList: async () => [{ id: 'EEEEEEEEEEEEEEEEEEEEEE', url: '', expires: 0, recipients: ['m@x.sk', 'e@x.sk'], opens }],
      onOpened: async (_link, fresh) => {
        notices.push(fresh.map((o) => o.address));
      }
    });
    await svc.create({ kind: 'chat', threadId: 'th' }, { recipients: ['m@x.sk', 'e@x.sk'] });
    await svc.syncOpens();
    expect(notices).toEqual([]);
    opens = [{ address: 'm@x.sk', first: 10, last: 10, count: 1 }];
    await svc.syncOpens();
    opens = [{ address: 'm@x.sk', first: 10, last: 20, count: 2 }];
    await svc.syncOpens();
    expect(notices).toEqual([['m@x.sk']]);
    expect((await svc.list())[0]!.opens).toEqual([{ address: 'm@x.sk', firstAt: 10, lastAt: 20, count: 2 }]);
    const text = shareOpenedText((await svc.list())[0]!, [
      { address: 'm@x.sk', firstAt: 1, lastAt: 1, count: 1 },
      { address: 'e@x.sk', firstAt: 1, lastAt: 1, count: 1 }
    ]);
    expect(text.body).toContain('m@x.sk and e@x.sk opened the link you shared');
  });
});

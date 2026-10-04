import { afterAll, describe, expect, it } from 'vitest';
import { closeForTest, getIndexedWatermark, reindexThread, searchChatDocs } from '../../src/server/chatsearch/store';
import { reindexChatThread } from '../../src/server/chatsearch/index-sync';
import { searchChatsLexical } from '../../src/server/chatsearch/search';

afterAll(() => closeForTest());

describe('chat search store', () => {
  it('limits distinct threads rather than raw rows from one noisy thread', () => {
    reindexThread(
      'noisy',
      'Noisy chat',
      Array.from({ length: 250 }, (_, i) => ({ role: 'user', text: `needle repeated ${i}`, ts: i + 1 })),
      300
    );
    reindexThread('other', 'Other chat', [{ role: 'assistant', text: 'one useful needle', ts: 500 }], 500);

    expect(searchChatDocs('"needle"', 10).map((hit) => hit.threadId).sort()).toEqual(['noisy', 'other']);
  });

  it('stores live reindex watermarks in backend milliseconds', async () => {
    await reindexChatThread(
      {
        listThreads: async () => [],
        readThread: async () => ({
          title: 'Live thread',
          messages: [{ role: 'user', content: 'live indexed content' }]
        })
      },
      'live'
    );
    expect(getIndexedWatermark('live')).toBeGreaterThan(1_000_000_000_000);
  });

  it('does not let a deleted high-ranking thread consume the live result limit', async () => {
    const term = 'zebracobalt';
    reindexThread(
      'deleted-high-rank',
      'Deleted chat',
      [{ role: 'user', text: Array.from({ length: 40 }, () => term).join(' '), ts: 600 }],
      600
    );
    reindexThread(
      'live-lower-rank',
      'Live chat',
      [{ role: 'user', text: `${term} ${'filler '.repeat(100)}`, ts: 700 }],
      700
    );

    expect(searchChatDocs(`"${term}"`, 1)[0]?.threadId).toBe('deleted-high-rank');

    const hits = await searchChatsLexical(
      term,
      {
        llm: null,
        listChats: async () => [{ threadId: 'live-lower-rank', title: 'Current title' }]
      },
      1
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ threadId: 'live-lower-rank', title: 'Current title' });
  });
});

describe('chat search and the pinboard', () => {
  it("finds a chat by what was pinned in it — a note's text, or a pin's label", async () => {
    const { addPin, updatePin } = await import('../../src/server/pins/store');
    const rt = {
      listThreads: async () => [],
      readThread: async () => ({ title: 'Table finishing', messages: [{ role: 'user', content: 'what oil?' }] })
    };
    addPin('pinned-search', { kind: 'note', text: 'bought quartzwhite accelerator' });
    const labelled = addPin('pinned-search', { kind: 'note', text: 'three to one' });
    updatePin('pinned-search', labelled.id, { label: 'Ochrecobalt ratio' });
    await reindexChatThread(rt, 'pinned-search');
    expect(searchChatDocs('"quartzwhite"').map((h) => h.threadId)).toEqual(['pinned-search']);
    expect(searchChatDocs('"ochrecobalt"').map((h) => h.threadId)).toEqual(['pinned-search']);
  });
});

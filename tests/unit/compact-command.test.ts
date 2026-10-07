import { beforeEach, describe, expect, it } from 'vitest';
import { detectCompactCommand } from '../../src/renderer/chat/Composer';
import { compactErrorText, compactedText, readCompact, resetCompact, startCompact } from '../../src/renderer/chat/compact-store';

describe('detectCompactCommand', () => {
  it('matches a bare /compact and takes the rest as the focus', () => {
    expect(detectCompactCommand('/compact')).toEqual({ instructions: '' });
    expect(detectCompactCommand('/compact  keep the numbers ')).toEqual({ instructions: 'keep the numbers' });
  });

  it('never matches mid-message or on longer slash words', () => {
    expect(detectCompactCommand('what does /compact do')).toBeNull();
    expect(detectCompactCommand('/compacted')).toBeNull();
  });
});

describe('compact store', () => {
  beforeEach(() => resetCompact());

  it('phrases the outcome', () => {
    expect(compactedText({ tokensBefore: 142_318, tokensAfter: 9_400 })).toBe('Condensed this chat: 142k → 9.4k tokens');
    expect(compactedText({ tokensBefore: null, tokensAfter: null })).toBe('Condensed this chat');
    expect(compactErrorText(new Error("Error invoking remote method 'chats:compact': Error: Nothing to compact (session too small)"))).toBe(
      'This chat is too short to condense yet'
    );
    expect(compactErrorText(new Error('Wait for the reply to finish, then compact.'))).toBe(
      'Couldn’t condense this chat: Wait for the reply to finish, then compact.'
    );
  });

  it('holds one condense per chat and keeps its outcome', async () => {
    let finish!: () => void;
    let runs = 0;
    const run = () => {
      runs += 1;
      return new Promise<{ tokensBefore: number; tokensAfter: number }>((resolve) => {
        finish = () => resolve({ tokensBefore: 2000, tokensAfter: 500 });
      });
    };
    const first = startCompact('chat', run);
    void startCompact('chat', run);
    expect(readCompact('chat').compacting).toBe(true);
    finish();
    await first;
    expect(runs).toBe(1);
    expect(readCompact('chat')).toEqual({ compacting: false, notice: { ok: true, text: 'Condensed this chat: 2.0k → 500 tokens' } });
  });
});

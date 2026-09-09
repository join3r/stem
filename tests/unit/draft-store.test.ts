import { beforeEach, describe, expect, it } from 'vitest';
import { clearDraft, readDraft, resetDrafts, writeDraft } from '../../src/renderer/chat/draft-store';

// Unsent composer text parked per chat across the remount a chat switch causes
// (issue #13). The Composer reads on mount, writes on every change, and clears on
// send.
describe('draft store', () => {
  beforeEach(() => resetDrafts());

  it('hands back what was written under the same key', () => {
    writeDraft('t1', { text: 'half a thought', attachments: [{ name: 'a.png', path: '/a.png' }] });
    expect(readDraft('t1')).toEqual({ text: 'half a thought', attachments: [{ name: 'a.png', path: '/a.png' }] });
  });

  it('keeps chats apart', () => {
    writeDraft('t1', { text: 'for one', attachments: [] });
    writeDraft('__draft__', { text: 'for the new chat', attachments: [] });
    expect(readDraft('t1').text).toBe('for one');
    expect(readDraft('__draft__').text).toBe('for the new chat');
    expect(readDraft('t2')).toEqual({ text: '', attachments: [] });
  });

  it('forgets a key once the field is emptied or the draft is sent', () => {
    writeDraft('t1', { text: 'typed', attachments: [] });
    writeDraft('t1', { text: '', attachments: [] });
    expect(readDraft('t1').text).toBe('');
    writeDraft('t1', { text: 'typed again', attachments: [] });
    clearDraft('t1');
    expect(readDraft('t1').text).toBe('');
  });
});

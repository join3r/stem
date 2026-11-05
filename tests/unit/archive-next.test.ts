import { describe, expect, it } from 'vitest';
import { chatAfterArchive } from '../../src/renderer/chats/archive-next';

describe('chatAfterArchive', () => {
  const order = ['a', 'b', 'c', 'd'];
  it('opens the row below', () => expect(chatAfterArchive(order, 'b', ['b'])).toBe('c'));
  it('opens the row above when the last goes', () => expect(chatAfterArchive(order, 'd', ['d'])).toBe('c'));
  it('skips the other chats archived with it', () => expect(chatAfterArchive(order, 'b', ['b', 'c'])).toBe('d'));
  it('falls back above past a removed tail', () => expect(chatAfterArchive(order, 'c', ['c', 'd'])).toBe('b'));
  it('is null when nothing is left', () => expect(chatAfterArchive(['a'], 'a', ['a'])).toBeNull());
  it('is null when the open chat is not on screen', () => expect(chatAfterArchive(order, 'x', ['x'])).toBeNull());
});

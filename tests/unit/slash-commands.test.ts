import { describe, expect, it } from 'vitest';
import { slashMatches, type SlashCommandName } from '../../src/renderer/chat/slashCommands';

const all = new Set<SlashCommandName>(['pin', 'note', 'learn', 'compact']);
const names = (draft: string, available = all) => slashMatches(draft, available)?.map((c) => c.name) ?? null;

describe('slash menu', () => {
  it('lists every command on a bare slash', () => {
    expect(names('/')).toEqual(['pin', 'note', 'learn', 'compact']);
  });

  it('narrows as the name is typed, ignoring case', () => {
    expect(names('/p')).toEqual(['pin']);
    expect(names('/N')).toEqual(['note']);
    expect(names('/learn')).toEqual(['learn']);
    expect(names('/c')).toEqual(['compact']);
  });

  it('closes once the name is done, or nothing matches', () => {
    expect(names('/pin ')).toBeNull();
    expect(names('/pin oak')).toBeNull();
    expect(names('/x')).toBeNull();
    expect(names('/p\nmore')).toBeNull();
  });

  it('never opens for ordinary text or the // note shortcut', () => {
    expect(names('')).toBeNull();
    expect(names('hello /pin')).toBeNull();
    expect(names('//')).toBeNull();
  });

  it('offers only what this composer can run', () => {
    expect(names('/', new Set(['note']))).toEqual(['note']);
    expect(names('/p', new Set(['note', 'learn']))).toBeNull();
  });
});

// Ambient context goes out once per thread: a block already in front of the
// model (per pi's projection — active branch, after the last compaction's
// kept entry) is named in one line instead of repeated.
import { describe, expect, it } from 'vitest';
import { AmbientBlocks, liveUserTexts } from '../../src/server/pi/context-dedupe';

function user(id: string, parentId: string | null, text: string) {
  return { type: 'message', id, parentId, message: { role: 'user', content: [{ type: 'text', text }] } };
}
function assistant(id: string, parentId: string | null) {
  return { type: 'message', id, parentId, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
}

describe('liveUserTexts', () => {
  it('follows the active branch only', () => {
    const snapshot = {
      leafId: 'a2',
      entries: [user('u1', null, 'first'), assistant('a1', 'u1'), user('dead', 'a1', 'abandoned'), user('u2', 'a1', 'second'), assistant('a2', 'u2')]
    };
    expect(liveUserTexts(snapshot)).toEqual(['second', 'first']);
  });

  it('stops at the newest compaction’s first kept entry', () => {
    const snapshot = {
      leafId: 'a3',
      entries: [
        user('u1', null, 'summarised away'),
        assistant('a1', 'u1'),
        user('u2', 'a1', 'kept'),
        assistant('a2', 'u2'),
        { type: 'compaction', id: 'c1', parentId: 'a2', firstKeptEntryId: 'u2' },
        user('u3', 'c1', 'after'),
        assistant('a3', 'u3')
      ]
    };
    expect(liveUserTexts(snapshot)).toEqual(['after', 'kept']);
  });

  it('answers nothing for a snapshot it cannot trust', () => {
    expect(liveUserTexts(undefined)).toEqual([]);
    expect(liveUserTexts({ leafId: 'missing', entries: [user('u1', null, 'x')] })).toEqual([]);
  });
});

describe('AmbientBlocks', () => {
  it('drops a block the live context already holds verbatim and names it', () => {
    const ambient = new AmbientBlocks(['<context>\nCATALOG v1\n</context>\n\nhello']);
    ambient.add('CATALOG v1', 'the catalogue');
    ambient.add('WEB TOOLS', 'the web tools');
    expect(ambient.blocks()).toEqual([
      'WEB TOOLS',
      'Unchanged from earlier in this chat and still in force (not repeated here): the catalogue.'
    ]);
  });

  it('sends a changed block in full', () => {
    const ambient = new AmbientBlocks(['CATALOG v1']);
    ambient.add('CATALOG v2', 'the catalogue');
    expect(ambient.blocks()).toEqual(['CATALOG v2']);
  });

  it('adds no line when nothing was dropped', () => {
    const ambient = new AmbientBlocks([]);
    ambient.add('A', 'a');
    expect(ambient.blocks()).toEqual(['A']);
  });
});

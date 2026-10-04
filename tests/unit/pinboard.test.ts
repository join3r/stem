import { describe, expect, it } from 'vitest';
import { detectPinCommand } from '../../src/renderer/chat/Composer';
import { locatePassage, messageAnchor, pinLabel, pinSource, pinSummary } from '../../src/renderer/chat/pins';
import type { ChatMessage, ChatPin } from '../../src/shared/types';

const pin = (over: Partial<ChatPin>): ChatPin => ({
  id: 'p',
  threadId: 't',
  kind: 'note',
  anchor: null,
  role: null,
  text: 'text',
  label: null,
  labelSource: null,
  createdAt: 0,
  updatedAt: 0,
  ...over
});

describe('pinboard summary', () => {
  it('names a pin by its label, or its first words until one is written', () => {
    expect(pinLabel(pin({ label: 'Rubio mix', text: 'anything' }))).toBe('Rubio mix');
    expect(pinLabel(pin({ text: '  12–24 h\nschnutie, 5 dní vytvrdnutie, bez vody' }))).toBe('12–24 h schnutie, 5…');
    expect(pinLabel(pin({ text: 'cure five days' }))).toBe('cure five days');
  });

  it('joins the names in board order for the collapsed strip', () => {
    expect(pinSummary([pin({ label: 'Rubio mix' }), pin({ label: 'Curing' }), pin({ text: '2nd coat' })])).toBe(
      'Rubio mix · Curing · 2nd coat'
    );
  });
});

describe('pin sources', () => {
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'ratio?', turnId: 'e1', runtimeTurnId: 'r1' },
    { id: 'a1', role: 'assistant', content: 'Mix 3 parts oil : 1 part accelerator.', turnId: 'e1', runtimeTurnId: 'r1' },
    { id: 'a2a', role: 'assistant', content: 'Let me check.', turnId: 'e2' },
    { id: 'a2b', role: 'assistant', content: 'Cure for 5 days.', turnId: 'e2' }
  ];

  it('anchors on the runtime turn id when a message has one', () => {
    expect(messageAnchor(messages[1])).toBe('r1');
    expect(messageAnchor(messages[2])).toBe('e2');
    expect(messageAnchor({ id: 'x', role: 'user', content: '' })).toBeNull();
  });

  it('finds the message on either turn id, and by role', () => {
    expect(pinSource(pin({ kind: 'message', anchor: 'r1', role: 'assistant', text: 'x' }), messages)?.id).toBe('a1');
    expect(pinSource(pin({ kind: 'message', anchor: 'e1', role: 'user', text: 'x' }), messages)?.id).toBe('u1');
  });

  it('narrows a turn of several bubbles by the pinned text', () => {
    expect(pinSource(pin({ kind: 'passage', anchor: 'e2', role: 'assistant', text: 'Let me' }), messages)?.id).toBe('a2a');
    // Text no longer there (edited elsewhere): the turn's last bubble of that role.
    expect(pinSource(pin({ kind: 'passage', anchor: 'e2', role: 'assistant', text: 'gone' }), messages)?.id).toBe('a2b');
  });

  it('prefers the bubble that is exactly the pinned message over one containing it', () => {
    const turn: ChatMessage[] = [
      { id: 'b1', role: 'assistant', content: 'Done. Next, sand it.', turnId: 'e3' },
      { id: 'b2', role: 'assistant', content: 'Done.', turnId: 'e3' }
    ];
    expect(pinSource(pin({ kind: 'message', anchor: 'e3', role: 'assistant', text: 'Done.' }), turn)?.id).toBe('b2');
  });

  it('has no source for a note, or once the turn left the chat', () => {
    expect(pinSource(pin({ kind: 'note' }), messages)).toBeNull();
    expect(pinSource(pin({ kind: 'message', anchor: 'r9', role: 'assistant' }), messages)).toBeNull();
  });
});

describe('locatePassage', () => {
  it('finds a passage that spans text nodes', () => {
    expect(locatePassage(['Mix 3 parts ', 'oil', ' : 1 part accelerator.'], 'parts oil : 1')).toEqual({
      startPiece: 0,
      startOffset: 6,
      endPiece: 2,
      endOffset: 4
    });
  });

  it('ignores whitespace, which a selection and the rendered text disagree on', () => {
    // A selection across two list items reads "dry 24 h\ncure 5 days"; the DOM has no newline.
    expect(locatePassage(['dry 24 h', 'cure   5 days'], 'h\ncure 5')).toEqual({
      startPiece: 0,
      startOffset: 7,
      endPiece: 1,
      endOffset: 8
    });
  });

  it('is null when the passage is gone or empty', () => {
    expect(locatePassage(['something else'], 'Mix 3 : 1')).toBeNull();
    expect(locatePassage(['x'], '   ')).toBeNull();
  });
});

describe('detectPinCommand', () => {
  it('reads /pin <text> as a note, and a bare /pin as nothing to pin', () => {
    expect(detectPinCommand('/pin buy accelerator')).toEqual({ note: 'buy accelerator' });
    expect(detectPinCommand('/pin    padded  ')).toEqual({ note: 'padded' });
    expect(detectPinCommand('/pin')).toEqual({ note: '' });
  });

  it('leaves everything else to the normal send path', () => {
    expect(detectPinCommand('/pinned it')).toBeNull();
    expect(detectPinCommand('please /pin this')).toBeNull();
    expect(detectPinCommand('/learn')).toBeNull();
  });
});

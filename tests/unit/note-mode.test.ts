import { describe, expect, it } from 'vitest';
import { detectNoteTrigger, isImageAttachment, noteBodyValid, pasteLandsInCommand } from '../../src/renderer/noteMode';

describe('detectNoteTrigger', () => {
  it('triggers on "/note " at the start and strips the prefix', () => {
    expect(detectNoteTrigger('/note buy milk')).toEqual({ body: 'buy milk' });
  });

  it('triggers on "//" at the start and strips the prefix', () => {
    expect(detectNoteTrigger('//buy milk')).toEqual({ body: 'buy milk' });
  });

  it('never triggers mid-message', () => {
    expect(detectNoteTrigger('see /note docs')).toBeNull();
    expect(detectNoteTrigger('a // b')).toBeNull();
  });

  it('does not trigger on longer slash words like /notes', () => {
    expect(detectNoteTrigger('/notes x')).toBeNull();
    expect(detectNoteTrigger('/notebook')).toBeNull();
  });

  it('bare prefixes trigger with an empty (not yet saveable) body', () => {
    expect(detectNoteTrigger('//')).toEqual({ body: '' });
    expect(detectNoteTrigger('/note ')).toEqual({ body: '' });
  });

  it('does not trigger on "/note" until the space lands (keeps it out of the body)', () => {
    expect(detectNoteTrigger('/note')).toBeNull();
  });

  it('plain messages pass through untouched', () => {
    expect(detectNoteTrigger('what is the weather?')).toBeNull();
    expect(detectNoteTrigger('/ note spaced out')).toBeNull();
  });
});

describe('noteBodyValid', () => {
  it('requires non-whitespace content', () => {
    expect(noteBodyValid('')).toBe(false);
    expect(noteBodyValid('   ')).toBe(false);
    expect(noteBodyValid('prefers tabs')).toBe(true);
  });

  it('accepts an empty body when an image is attached', () => {
    expect(noteBodyValid('', 1)).toBe(true);
    expect(noteBodyValid('   ', 0)).toBe(false);
  });
});

describe('isImageAttachment', () => {
  it('judges by mime when present, else by extension', () => {
    expect(isImageAttachment({ name: 'x', mime: 'image/png', dataBase64: '' })).toBe(true);
    expect(isImageAttachment({ name: 'x.png', mime: 'application/octet-stream' })).toBe(false);
    expect(isImageAttachment({ name: 'IMG_1.HEIC', path: '/p/IMG_1.HEIC' })).toBe(true);
    expect(isImageAttachment({ name: 'doc.pdf', path: '/p/doc.pdf' })).toBe(false);
  });
});

describe('pasteLandsInCommand', () => {
  it('treats a paste at the start of the draft as literal', () => {
    expect(pasteLandsInCommand('', 0)).toBe(true);
    expect(pasteLandsInCommand('hello', 0)).toBe(true);
  });
  it('treats a paste inside a half-typed command name as literal', () => {
    expect(pasteLandsInCommand('/', 1)).toBe(true);
    expect(pasteLandsInCommand('/no', 3)).toBe(true);
  });
  it('lets a paste after a typed command and space be its argument', () => {
    expect(pasteLandsInCommand('/pin ', 5)).toBe(false);
    expect(pasteLandsInCommand('/note ', 6)).toBe(false);
  });
  it('ignores pastes later in ordinary text', () => {
    expect(pasteLandsInCommand('hello ', 6)).toBe(false);
    expect(pasteLandsInCommand('hello', 5)).toBe(false);
  });
});

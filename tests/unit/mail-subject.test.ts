// Mail subject hygiene (shared/mail-subject): protocol fences and Markdown
// never survive into a subject line, a clean subject passes through verbatim,
// and a mail sent without one gets a subject derived from its body.
import { describe, expect, it } from 'vitest';
import {
  cleanMailSubject,
  deriveMailSubject,
  MAX_MAIL_SUBJECT,
  NO_SUBJECT,
  resolveMailSubject
} from '../../src/shared/mail-subject';

describe('cleanMailSubject', () => {
  it('passes a clean subject through verbatim', () => {
    expect(cleanMailSubject('Q3 revenue breakdown')).toBe('Q3 revenue breakdown');
    expect(cleanMailSubject('  padded  ')).toBe('padded');
  });

  it('strips a Stem mail envelope WITH its interior, the screenshot case', () => {
    // The fence pair's interior is injected scaffolding, not user text — a
    // subject sliced from a delivery prompt cleans to '' (and the caller then
    // falls back to deriving one), never to preamble prose.
    expect(
      cleanMailSubject('<!--stem:mail from=user-->\nThis is a mail delivery in the conversation "x"')
    ).toBe('');
    expect(cleanMailSubject('<!--stem:mail from=user-->\nscaffolding\n<!--/stem:mail-->')).toBe('');
    expect(cleanMailSubject('Weekly digest <!--stem:mail from=user-->scaffolding<!--/stem:mail-->')).toBe(
      'Weekly digest'
    );
  });

  it('strips an UNCLOSED comment — what a truncated title slice leaves behind', () => {
    expect(cleanMailSubject('Check the feed <!--stem:scheduled at="2026-08-')).toBe('Check the feed');
    expect(cleanMailSubject('<!--stem:mail from=us…')).toBe('');
  });

  it('strips Markdown markup but keeps its text', () => {
    expect(cleanMailSubject('## **Deploy** `pipeline` update')).toBe('Deploy pipeline update');
    expect(cleanMailSubject('- [Release notes](https://example.com) shipped')).toBe(
      'Release notes shipped'
    );
    expect(cleanMailSubject('> quoted ~~loudly~~')).toBe('quoted loudly');
    // Underscores are likelier identifiers than emphasis — left alone, even in
    // runs: __init__.py must survive where __bold__ may slip through.
    expect(cleanMailSubject('fix applyLiveTurns in pending_sends.ts')).toBe(
      'fix applyLiveTurns in pending_sends.ts'
    );
    expect(cleanMailSubject('refactor __init__.py imports')).toBe('refactor __init__.py imports');
  });

  it('never splits a surrogate pair at the cap — the orphaned half is dropped, not emitted', () => {
    // A lone surrogate (what a code-unit slice leaves of a boundary emoji)
    // renders as U+FFFD mojibake. With the /u flag, this class matches only
    // UNPAIRED surrogates — a well-formed emoji does not hit it.
    const loneSurrogate = /[\uD800-\uDFFF]/u;

    // Explicit cap (120): the emoji's two UTF-16 units sit at indices 118–119,
    // so the old slice(0, 119) cut straight through it.
    const explicit = cleanMailSubject(`${'a'.repeat(118)}😀 and more trailing text`);
    expect(loneSurrogate.test(explicit)).toBe(false);
    expect(explicit).toBe(`${'a'.repeat(118)}…`);
    expect(explicit.length).toBeLessThanOrEqual(MAX_MAIL_SUBJECT);

    // Derived cap (60): same crossing at indices 58–59, via slice(0, 59).
    const derived = deriveMailSubject(`${'b'.repeat(58)}😀 tail that forces the cap\nsecond line`);
    expect(loneSurrogate.test(derived)).toBe(false);
    expect(derived).toBe(`${'b'.repeat(58)}…`);
    expect(derived.length).toBeLessThanOrEqual(60);

    // An emoji fully INSIDE the cap survives intact.
    expect(cleanMailSubject('Launch 🚀 checklist')).toBe('Launch 🚀 checklist');
  });

  it('flattens whitespace and caps the length with an ellipsis', () => {
    expect(cleanMailSubject('one\n\ttwo   three')).toBe('one two three');
    const long = 'word '.repeat(60);
    const cleaned = cleanMailSubject(long);
    expect(cleaned.length).toBeLessThanOrEqual(MAX_MAIL_SUBJECT);
    expect(cleaned.endsWith('…')).toBe(true);
  });
});

describe('deriveMailSubject', () => {
  it('takes the first meaningful line of the body, capped short', () => {
    expect(deriveMailSubject('Summarize the meeting notes\n\nDetails follow…')).toBe(
      'Summarize the meeting notes'
    );
    const derived = deriveMailSubject(`${'x'.repeat(200)}\nrest`);
    expect(derived.length).toBeLessThanOrEqual(60);
    expect(derived.endsWith('…')).toBe(true);
  });

  it('skips envelope fences and markup-only lines to reach real text', () => {
    const body = [
      '<!--stem:mail from=user-->',
      'This is a mail delivery. Nobody is reading live.',
      '<!--/stem:mail-->',
      '```',
      'Investigate the failing deploy'
    ].join('\n');
    expect(deriveMailSubject(body)).toBe('Investigate the failing deploy');
    // A fence spanning lines must not donate its interior as the subject.
    expect(deriveMailSubject('<!--stem:context-->\nsecret scaffolding\n<!--/stem:context-->\nreal ask')).toBe(
      'real ask'
    );
  });

  it('answers "" for a body with nothing to say (attachments-only mail)', () => {
    expect(deriveMailSubject('')).toBe('');
    expect(deriveMailSubject('```\n\n<!--x-->')).toBe('');
  });
});

describe('resolveMailSubject', () => {
  it('prefers the supplied subject, cleaned', () => {
    expect(resolveMailSubject('Check this', 'body text')).toBe('Check this');
    expect(resolveMailSubject('**Check** this', 'body text')).toBe('Check this');
  });

  it('derives from the body when the subject is blank or pure markup', () => {
    expect(resolveMailSubject('', 'Book the flights\nfor June')).toBe('Book the flights');
    expect(resolveMailSubject(undefined, 'Book the flights')).toBe('Book the flights');
    expect(resolveMailSubject('<!--stem:mail from=user-->', 'Book the flights')).toBe('Book the flights');
  });

  it('falls back to the explicit shrug when neither side offers text', () => {
    expect(resolveMailSubject('', '')).toBe(NO_SUBJECT);
    // Non-string subjects (an older or hostile client) are treated as absent.
    expect(resolveMailSubject(42, '')).toBe(NO_SUBJECT);
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { recallStore as store } from '../../src/server/recall/store';
import { LONG_NOTE_THRESHOLD, describeNoteImages, extractNoteFacts, normalizeExplicitNote, processExplicitNote } from '../../src/server/recall/note';
import { MAX_NOTE_IMAGES, addMemoryNote, imageNotePlaceholder, setMemoryEnabled } from '../../src/server/workspace/memory';
import type { LlmImage } from '../../src/server/recall/llm';

afterAll(() => store.close());
beforeEach(async () => {
  store.resetFacts();
  await setMemoryEnabled(true);
});

const llmReturning = (reply: string) => ({ complete: async () => reply });
const rewriteReply = (text: string) => JSON.stringify({ text });
/** Answers the note-rewrite prompt with `text`; any other prompt (reconcile,
 *  contradiction) gets an empty relation reply. */
const rewriteOnlyLlm = (text: string) => ({
  complete: async (prompt: string) =>
    /Rewrite it as ONE short/.test(prompt)
      ? rewriteReply(text)
      : JSON.stringify({ supersedeIds: [], conflictIds: [] })
});

describe('updateFactText', () => {
  it('rewrites text + norm in place and invalidates the cached vector', () => {
    const id = store.upsertFact('radsej taby ako medzery', { source: 'explicit', confidence: 1 })!;
    store.upsertFactVector(id, 'test-model', new Float32Array([1, 0]));
    expect(store.getFactVectors('test-model').has(id)).toBe(true);

    const survivor = store.updateFactText(id, 'The user prefers tabs over spaces.');
    expect(survivor).toBe(id);
    const fact = store.getFactDetails(id)!;
    expect(fact.text).toBe('The user prefers tabs over spaces.');
    expect(fact.status).toBe('active');
    // The stale embedding must not survive a text change.
    expect(store.getFactVectors('test-model').has(id)).toBe(false);
    // The FTS trigger followed the update: the new wording is searchable.
    expect(store.factTermSearch('"tabs" AND "spaces"', 10).some((f) => f.id === id)).toBe(true);
  });

  it('merges into an existing fact on a norm collision instead of violating UNIQUE', () => {
    const existing = store.upsertFact('The user prefers tabs over spaces.', 'distilled')!;
    const note = store.upsertFact('taby > medzery', { source: 'explicit', confidence: 1 })!;

    const survivor = store.updateFactText(note, 'The user prefers tabs over spaces.');
    expect(survivor).toBe(existing);
    // The user just re-asserted the claim: the survivor ratchets to explicit…
    const kept = store.getFactDetails(existing)!;
    expect(kept.source).toBe('explicit');
    expect(kept.confidence).toBe(1);
    // …and the duplicate note is retired, pointing at the survivor.
    const retired = store.getFactDetails(note)!;
    expect(retired.status).toBe('superseded');
    expect(retired.supersededBy).toBe(existing);
  });

  it('returns null for empty text, a missing fact, or a superseded fact', () => {
    const id = store.upsertFact('The user lives in Bratislava.', 'explicit')!;
    expect(store.updateFactText(id, '   ')).toBeNull();
    expect(store.updateFactText(999_999, 'The user is nobody.')).toBeNull();
    store.supersedeFact(id);
    expect(store.updateFactText(id, 'The user lives in Košice.')).toBeNull();
  });

  it('is a no-op survivor when the text is unchanged', () => {
    const id = store.upsertFact('The user prefers dark mode.', 'explicit')!;
    expect(store.updateFactText(id, 'The user prefers dark mode.')).toBe(id);
    expect(store.getFactDetails(id)!.text).toBe('The user prefers dark mode.');
  });
});

describe('addMemoryNote', () => {
  it('saves an explicit, confidence-1, unpinned fact with explicit_user evidence', async () => {
    const result = await addMemoryNote('prefers tabs over spaces');
    expect(result.saved).toBe(true);
    const fact = store.getFactDetails(result.factId!)!;
    expect(fact.source).toBe('explicit');
    expect(fact.confidence).toBe(1);
    expect(fact.pinned).toBe(false);
    expect(fact.status).toBe('active');
    expect(fact.evidence).toHaveLength(1);
    expect(fact.evidence[0].origin).toBe('explicit_user');
  });

  it('rejects empty / whitespace-only notes', async () => {
    expect(await addMemoryNote('   ')).toEqual({ saved: false, reason: 'empty' });
  });

  it('refuses when memory is disabled', async () => {
    await setMemoryEnabled(false);
    expect(await addMemoryNote('prefers tabs')).toEqual({ saved: false, reason: 'disabled' });
  });

  it('never stores credential-looking notes', async () => {
    expect(await addMemoryNote('my password is hunter2')).toEqual({ saved: false, reason: 'secret' });
    expect(store.getAllFacts()).toHaveLength(0);
  });

  it('keeps long pastes (fact-extraction input) and only truncates runaway ones', async () => {
    const wall = await addMemoryNote(`insurance details: ${'x'.repeat(5000)}`);
    expect(wall.saved).toBe(true);
    expect(store.getFactDetails(wall.factId!)!.text.length).toBeGreaterThan(5000);

    const runaway = await addMemoryNote(`log dump ${'y'.repeat(30_000)}`);
    expect(runaway.saved).toBe(true);
    expect(store.getFactDetails(runaway.factId!)!.text.length).toBeLessThanOrEqual(20_000);
  });
});

// A 1×1 PNG — enough for the image path, which never decodes pixels.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAACAAFVwtTvAAAAAElFTkSuQmCC';
const pngAttachment = (name = 'label.png') => ({ name, mime: 'image/png', dataBase64: PNG_1PX });
const describeReply = (description: string) => JSON.stringify({ description });
/** Answers the describe prompt with `description`, the rewrite prompt with
 *  `rewritten` (or the note unchanged), and everything else with no relations.
 *  Records the images each call received. */
function imageNoteLlm(description: string, rewritten?: string) {
  const seen: Array<LlmImage[] | undefined> = [];
  return {
    seen,
    complete: async (prompt: string, images?: LlmImage[]) => {
      seen.push(images);
      if (/attached an image|attached \d+ images/.test(prompt)) return describeReply(description);
      if (/Rewrite it as ONE short/.test(prompt)) {
        const note = /Note: (.*)\nToday's date/s.exec(prompt)?.[1] ?? '';
        return rewriteReply(rewritten ?? note);
      }
      return JSON.stringify({ supersedeIds: [], conflictIds: [] });
    }
  };
}

describe('addMemoryNote with images', () => {
  it('stores the pictures with the fact and counts them for the list view', async () => {
    const result = await addMemoryNote('router label', [pngAttachment('router.png'), pngAttachment('back.png')]);
    expect(result.saved).toBe(true);
    const fact = store.getFactDetails(result.factId!)!;
    expect(fact.text).toBe('router label');
    expect(fact.images.map((i) => i.name)).toEqual(['router.png', 'back.png']);
    expect(fact.images[0].mime).toBe('image/png');
    expect(fact.images[0].size).toBe(Buffer.from(PNG_1PX, 'base64').length);
    expect(fact.images[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(store.getFactImageCounts().get(result.factId!)).toBe(2);
  });

  it('accepts an image-only note under a stamped placeholder, so two never merge', async () => {
    const a = await addMemoryNote('', [pngAttachment('Screenshot.png')]);
    const b = await addMemoryNote('  ', [pngAttachment('Screenshot.png')]);
    expect(a.saved && b.saved).toBe(true);
    expect(a.factId).not.toBe(b.factId);
    const fact = store.getFactDetails(a.factId!)!;
    expect(fact.text).toMatch(/^Image note \(Screenshot\.png\) saved /);
    expect(fact.evidence[0].excerpt).toBe('[image: Screenshot.png]');
    expect(imageNotePlaceholder(['a.png'], new Date(0))).toBe('Image note (a.png) saved 1970-01-01T00:00:00.000Z');
  });

  it('refuses non-image attachments, too many images, and stores nothing', async () => {
    const pdf = { name: 'doc.pdf', mime: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4').toString('base64') };
    expect(await addMemoryNote('see attached', [pdf])).toEqual({ saved: false, reason: 'image' });
    expect(await addMemoryNote('see attached', [pngAttachment(), pdf])).toEqual({ saved: false, reason: 'image' });
    const many = Array.from({ length: MAX_NOTE_IMAGES + 1 }, (_, i) => pngAttachment(`p${i}.png`));
    expect(await addMemoryNote('album', many)).toEqual({ saved: false, reason: 'image' });
    expect(store.getAllFacts()).toHaveLength(0);
    expect(store.getFactImageCounts().size).toBe(0);
  });

  it('still refuses credential-looking text even with an image attached', async () => {
    expect(await addMemoryNote('wifi password is on the sticker', [pngAttachment()])).toEqual({ saved: false, reason: 'secret' });
  });

  it('forgetting or resetting removes the images too', async () => {
    const a = await addMemoryNote('one', [pngAttachment()]);
    const b = await addMemoryNote('two', [pngAttachment()]);
    store.deleteFact(a.factId!);
    expect(store.getFactImages(a.factId!)).toEqual([]);
    expect(store.getFactImages(b.factId!)).toHaveLength(1);
    store.resetFacts();
    expect(store.getFactImages(b.factId!)).toEqual([]);
  });
});

describe('describeNoteImages', () => {
  it('hands the pictures to the model and merges the description into the text', async () => {
    const { factId } = await addMemoryNote('home router', [pngAttachment('router.png')]);
    const llm = imageNoteLlm('A TP-Link Archer AX55 label, serial 2237X1.');
    const survivor = await describeNoteImages(factId!, llm, 'home router');
    expect(survivor).toBe(factId);
    expect(llm.seen[0]).toHaveLength(1);
    expect(llm.seen[0]![0]).toEqual({ data: PNG_1PX, mimeType: 'image/png' });
    expect(store.getFactDetails(factId!)!.text).toBe('home router\n\nAttached image: A TP-Link Archer AX55 label, serial 2237X1.');
  });

  it('replaces the placeholder outright for an image-only note', async () => {
    const { factId } = await addMemoryNote('', [pngAttachment('menu.jpg')]);
    await describeNoteImages(factId!, imageNoteLlm('The lunch menu of Bistro Kolo: soup 3.50 €, daily 8.90 €.'), '');
    expect(store.getFactDetails(factId!)!.text).toBe('The lunch menu of Bistro Kolo: soup 3.50 €, daily 8.90 €.');
  });

  it('keeps the note as-is when the model fails, answers garbage, or transcribes a credential', async () => {
    const { factId } = await addMemoryNote('', [pngAttachment()]);
    const before = store.getFactDetails(factId!)!.text;
    await describeNoteImages(factId!, { complete: async () => { throw new Error('down'); } }, '');
    await describeNoteImages(factId!, { complete: async () => 'not json' }, '');
    await describeNoteImages(factId!, { complete: async () => describeReply('') }, '');
    await describeNoteImages(factId!, { complete: async () => describeReply('The wifi password is hunter2.') }, '');
    expect(store.getFactDetails(factId!)!.text).toBe(before);
    expect(store.getFactImages(factId!)).toHaveLength(1);
  });

  it('is a no-op for a fact without images', async () => {
    const { factId } = await addMemoryNote('plain note');
    const llm = imageNoteLlm('never asked');
    await describeNoteImages(factId!, llm, 'plain note');
    expect(llm.seen).toEqual([]);
  });

  it('does not write when the text changed while the model was thinking', async () => {
    const { factId } = await addMemoryNote('draft', [pngAttachment()]);
    const llm = {
      complete: async () => {
        store.updateFactText(factId!, 'edited meanwhile');
        return describeReply('a picture');
      }
    };
    await describeNoteImages(factId!, llm, 'draft');
    expect(store.getFactDetails(factId!)!.text).toBe('edited meanwhile');
  });
});

describe('processExplicitNote with images', () => {
  it('describes, then canonicalizes, with the picture staying on the surviving fact', async () => {
    const { factId } = await addMemoryNote('', [pngAttachment('router.png')]);
    const llm = imageNoteLlm(
      'A TP-Link Archer AX55 router label.',
      "The user's home router is a TP-Link Archer AX55."
    );
    await processExplicitNote(factId!, llm, '');
    const fact = store.getFactDetails(factId!)!;
    expect(fact.text).toBe("The user's home router is a TP-Link Archer AX55.");
    expect(fact.images).toHaveLength(1);
    // Describe, rewrite, reconcile — the rewrite saw the description, not the placeholder.
    expect(llm.seen[0]).toHaveLength(1);
    expect(llm.seen[1]).toBeUndefined();
  });

  it('moves the picture when the canonical text lands on an existing claim', async () => {
    const existing = store.upsertFact("The user's home router is a TP-Link Archer AX55.", 'distilled')!;
    const { factId } = await addMemoryNote('router', [pngAttachment()]);
    await processExplicitNote(factId!, imageNoteLlm('An Archer AX55 label.', "The user's home router is a TP-Link Archer AX55."), 'router');
    expect(store.getFactDetails(factId!)!.status).toBe('superseded');
    expect(store.getFactImages(factId!)).toEqual([]);
    expect(store.getFactImages(existing)).toHaveLength(1);
  });

  it('moves the picture to the first extracted fact when a long note is split', async () => {
    const long = 'Trip notes. '.repeat(50);
    const { factId } = await addMemoryNote(long, [pngAttachment('itinerary.png')]);
    expect(long.length).toBeGreaterThan(LONG_NOTE_THRESHOLD);
    const llm = {
      complete: async (prompt: string) => {
        if (/attached an image/.test(prompt)) return describeReply('Flight LH1234 on 2026-10-02.');
        if (/Break it into separate DURABLE facts/.test(prompt)) {
          return JSON.stringify({ claims: [
            { text: 'The user flies LH1234 on 2026-10-02.', category: 'schedule', sensitivity: 'standard', validUntil: null },
            { text: 'The user is planning a trip.', category: 'other', sensitivity: 'standard', validUntil: null }
          ] });
        }
        return JSON.stringify({ supersedeIds: [], conflictIds: [] });
      }
    };
    await processExplicitNote(factId!, llm, long);
    const raw = store.getFactDetails(factId!)!;
    expect(raw.status).toBe('superseded');
    expect(store.getFactImages(factId!)).toEqual([]);
    expect(store.getFactImages(raw.supersededBy!)).toHaveLength(1);
  });
});

describe('normalizeExplicitNote / processExplicitNote', () => {
  it('rewrites the note to the canonical form in place', async () => {
    const { factId } = await addMemoryNote('radsej taby ako medzery');
    const survivor = await normalizeExplicitNote(factId!, llmReturning(rewriteReply('The user prefers tabs over spaces.')));
    expect(survivor).toBe(factId);
    expect(store.getFactDetails(factId!)!.text).toBe('The user prefers tabs over spaces.');
  });

  it('leaves the raw note intact when the model is unreachable', async () => {
    const { factId } = await addMemoryNote('radsej taby ako medzery');
    const dead = { complete: async (): Promise<string> => { throw new Error('backend down'); } };
    await expect(processExplicitNote(factId!, dead)).resolves.toBeUndefined();
    expect(store.getFactDetails(factId!)!.text).toBe('radsej taby ako medzery');
  });

  it('rejects garbage, empty, and oversized rewrites', async () => {
    const { factId } = await addMemoryNote('prefers tabs');
    for (const reply of ['not json at all', rewriteReply(''), rewriteReply(`The user ${'x'.repeat(600)}`)]) {
      expect(await normalizeExplicitNote(factId!, llmReturning(reply))).toBe(factId);
      expect(store.getFactDetails(factId!)!.text).toBe('prefers tabs');
    }
  });

  it('does not write when the facts store is reset mid-flight', async () => {
    const { factId } = await addMemoryNote('prefers tabs');
    const resettingLlm = {
      complete: async () => {
        store.resetFacts();
        return rewriteReply('The user prefers tabs over spaces.');
      }
    };
    expect(await normalizeExplicitNote(factId!, resettingLlm)).toBe(factId);
    expect(store.getAllFacts()).toHaveLength(0);
  });

  it('does not write when the fact text changed while the model was thinking', async () => {
    const { factId } = await addMemoryNote('prefers tabs');
    const racingLlm = {
      complete: async () => {
        store.updateFactText(factId!, 'The user prefers spaces, actually.');
        return rewriteReply('The user prefers tabs over spaces.');
      }
    };
    expect(await normalizeExplicitNote(factId!, racingLlm)).toBe(factId);
    expect(store.getFactDetails(factId!)!.text).toBe('The user prefers spaces, actually.');
  });

  it('merges onto an existing claim and reconciles with the surviving id', async () => {
    const existing = store.upsertFact('The user prefers tabs over spaces.', 'distilled')!;
    const { factId } = await addMemoryNote('taby > medzery');
    await processExplicitNote(factId!, rewriteOnlyLlm('The user prefers tabs over spaces.'));
    expect(store.getFactDetails(factId!)!.status).toBe('superseded');
    const kept = store.getFactDetails(existing)!;
    expect(kept.source).toBe('explicit');
    expect(kept.status).toBe('active');
  });
});

describe('long notes: extractNoteFacts', () => {
  // A wall of text long enough to cross the split threshold.
  const wall = `Trip notes. ${'Flight details and packing thoughts. '.repeat(20)}We fly to Ghent on 17 July, staying at Hotel Harmony, booking ref GH-4411. Miriam is vegetarian.`;
  // validUntil must lie in the future: expireFacts() retires past-dated facts on
  // every store read. (A hardcoded date here once turned into a time bomb — the
  // suite started failing the day the fixture's trip dates passed.)
  const tripDay = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const claimsReply = JSON.stringify({
    claims: [
      { text: `The user flies to Ghent on ${tripDay}.`, category: 'schedule', sensitivity: 'sensitive', validUntil: tripDay },
      { text: 'The user is staying at Hotel Harmony in Ghent, booking ref GH-4411.', category: 'schedule', sensitivity: 'sensitive', validUntil: tripDay },
      { text: "The user's companion Miriam is vegetarian.", category: 'relationship', sensitivity: 'standard', validUntil: null }
    ]
  });
  /** Answers the extraction prompt with `reply`; reconcile prompts get empty relations. */
  const extractLlm = (reply: string) => ({
    complete: async (prompt: string) =>
      /Break it into separate DURABLE facts/.test(prompt)
        ? reply
        : JSON.stringify({ supersedeIds: [], conflictIds: [] })
  });

  it('splits a pasted wall of text into individual explicit facts and retires the blob', async () => {
    expect(wall.length).toBeGreaterThan(LONG_NOTE_THRESHOLD);
    const { factId } = await addMemoryNote(wall);
    await processExplicitNote(factId!, extractLlm(claimsReply));

    const active = store.getAllFacts().filter((f) => f.status === 'active');
    expect(active).toHaveLength(3);
    for (const f of active) {
      expect(f.source).toBe('explicit');
      expect(f.confidence).toBe(1);
      // Provenance: each piece carries the original note as evidence.
      expect(store.getFactEvidence(f.id)[0]?.origin).toBe('explicit_user');
    }
    // The raw blob no longer competes at inject time, but points at its pieces.
    const blob = store.getFactDetails(factId!)!;
    expect(blob.status).toBe('superseded');
    expect(blob.supersededBy).toBe(active[0].id);
  });

  it('keeps the raw blob active when the model is unreachable or finds nothing', async () => {
    const { factId } = await addMemoryNote(wall);
    const dead = { complete: async (): Promise<string> => { throw new Error('backend down'); } };
    await expect(processExplicitNote(factId!, dead)).resolves.toBeUndefined();
    expect(store.getFactDetails(factId!)!.status).toBe('active');

    expect(await extractNoteFacts(factId!, extractLlm(JSON.stringify({ claims: [] })))).toEqual([]);
    expect(store.getFactDetails(factId!)!.status).toBe('active');
  });

  it('does not write when the store is reset while the model was thinking', async () => {
    const { factId } = await addMemoryNote(wall);
    const resettingLlm = {
      complete: async () => {
        store.resetFacts();
        return claimsReply;
      }
    };
    expect(await extractNoteFacts(factId!, resettingLlm)).toEqual([]);
    expect(store.getAllFacts()).toHaveLength(0);
  });

  it('accepts a list kept together as one fact even past the distill length cap', async () => {
    // A coherent list fact between distill's 300-char cap and the note ceiling.
    const listFact = `The user still wants to visit these Bratislava restaurants: ${Array.from({ length: 25 }, (_, i) => `Restaurant ${i + 1}`).join(', ')}.`;
    expect(listFact.length).toBeGreaterThan(300);
    expect(listFact.length).toBeLessThanOrEqual(500);
    const { factId } = await addMemoryNote(wall);
    const ids = await extractNoteFacts(factId!, extractLlm(JSON.stringify({
      claims: [{ text: listFact, category: 'preference', sensitivity: 'standard', validUntil: null }]
    })));
    expect(ids).toHaveLength(1);
    expect(store.getFactDetails(ids[0])!.text).toBe(listFact);
  });

  it('dedups extracted claims onto existing facts instead of duplicating them', async () => {
    const existing = store.upsertFact("The user's companion Miriam is vegetarian.", 'distilled')!;
    const { factId } = await addMemoryNote(wall);
    const ids = await extractNoteFacts(factId!, extractLlm(claimsReply));
    expect(ids).toContain(existing);
    // The re-asserted fact ratchets to explicit; no duplicate row appears.
    const kept = store.getFactDetails(existing)!;
    expect(kept.source).toBe('explicit');
    expect(store.getAllFacts().filter((f) => f.status === 'active')).toHaveLength(3);
  });
});

describe('long-note extraction failure fallback', () => {
  it('reconciles the raw note when extraction returns nothing', async () => {
    const existing = store.upsertFact('The user rents a flat in Bratislava.', 'distilled')!;
    const noteText = `I bought an apartment in Nitra. ${'More context about the purchase and the mortgage details. '.repeat(20)}`;
    expect(noteText.length).toBeGreaterThan(LONG_NOTE_THRESHOLD);
    const factId = store.upsertFact(noteText, { source: 'explicit', confidence: 1 })!;
    const llm = {
      complete: async (prompt: string) =>
        prompt.includes('Return ONLY JSON {"supersedeIds":[],"conflictIds":[]}')
          ? JSON.stringify({ supersedeIds: [existing], conflictIds: [] })
          : 'garbled nonsense the extractor cannot parse'
    };
    // Extraction fails (unparseable reply) -> before the fix the raw blob was
    // never reconciled and silently coexisted with the facts it contradicts.
    await processExplicitNote(factId, llm);
    expect(store.getFactDetails(existing)?.status).toBe('superseded');
    expect(store.getFactDetails(existing)?.supersededBy).toBe(factId);
  });
});

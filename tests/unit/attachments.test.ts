// Attachment classification, at the one boundary the user can feel: whether the
// thing they attached actually reaches the model. The PDF branch earns the
// tests — a PDF used to be silently dropped as "unsupported", and the regression
// mode (extraction quietly failing and falling back to the skip note) produces
// a turn that reads as though the feature never existed.
import { afterEach, describe, expect, it } from 'vitest';
import { imagePreviewFromBytes, resolveAttachments } from '../../src/server/pi/attachments';
import { setHeicDecoderForTests } from '../../src/server/pi/heic';
import { makePdf } from './make-pdf';

const MINI_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function fakeHeic(): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeUInt32BE(16, 0);
  buf.write('ftyp', 4);
  buf.write('heic', 8);
  buf.write('mif1', 12);
  return buf;
}

afterEach(() => {
  setHeicDecoderForTests(null);
});

describe('resolveAttachments and PDFs', () => {
  it('inlines a PDF text layer as a fenced block', async () => {
    const pdf = makePdf([
      ['Prodigy ISA overview', 'Chapter 1: registers'],
      ['Chapter 2: instruction encoding']
    ]);
    const resolved = await resolveAttachments([
      { name: 'isa-manual.pdf', dataBase64: pdf.toString('base64') }
    ]);
    expect(resolved.rejected).toHaveLength(0);
    expect(resolved.images).toHaveLength(0);
    expect(resolved.textBlocks).toHaveLength(1);
    expect(resolved.textBlocks[0]).toContain('Attached file: isa-manual.pdf');
    expect(resolved.textBlocks[0]).toContain('Prodigy ISA overview');
    expect(resolved.textBlocks[0]).toContain('instruction encoding');
    expect(resolved.textBlocks[0]).not.toContain('truncated');
  });

  it('classifies by the mime type when the name has no extension', async () => {
    const pdf = makePdf([['Untitled but still a PDF']]);
    const resolved = await resolveAttachments([
      { name: 'scan-2026', mime: 'application/pdf', dataBase64: pdf.toString('base64') }
    ]);
    expect(resolved.textBlocks[0]).toContain('Untitled but still a PDF');
  });

  it('rejects a PDF that cannot be parsed', async () => {
    // The bytes a .pdf name most often lies about: something that is not a PDF
    // at all. Must land in `rejected` (the user is told), not throw a turn.
    const resolved = await resolveAttachments([
      { name: 'broken.pdf', dataBase64: Buffer.from('not really a pdf\0').toString('base64') }
    ]);
    expect(resolved.rejected).toEqual(['broken.pdf']);
    expect(resolved.textBlocks).toHaveLength(0);
  });

  it('rejects a well-formed PDF with no text layer', async () => {
    // An image-only scan parses fine and extracts nothing; with no OCR there is
    // nothing to inline, and pretending otherwise would attach an empty block.
    const resolved = await resolveAttachments([
      { name: 'scan.pdf', dataBase64: makePdf([[]]).toString('base64') }
    ]);
    expect(resolved.rejected).toEqual(['scan.pdf']);
    expect(resolved.textBlocks).toHaveLength(0);
  });
});

describe('resolveAttachments and HEIC', () => {
  it('converts a HEIC attachment to a JPEG image block', async () => {
    setHeicDecoderForTests(async () => MINI_JPEG);
    const resolved = await resolveAttachments([
      { name: 'IMG_1.HEIC', dataBase64: fakeHeic().toString('base64') }
    ]);
    expect(resolved.rejected).toHaveLength(0);
    expect(resolved.images).toEqual([
      { type: 'image', data: MINI_JPEG.toString('base64'), mimeType: 'image/jpeg' }
    ]);
  });

  it('rejects a HEIC this machine cannot decode, naming the file', async () => {
    setHeicDecoderForTests(async () => null);
    const resolved = await resolveAttachments([
      { name: 'broken.heic', dataBase64: Buffer.from('not really heic\0').toString('base64') }
    ]);
    expect(resolved.rejected).toEqual(['broken.heic (could not decode HEIC)']);
    expect(resolved.images).toHaveLength(0);
  });

  it('does not re-decode a HEIC that is already JPEG (client conversion)', async () => {
    let called = 0;
    setHeicDecoderForTests(async () => {
      called += 1;
      return MINI_JPEG;
    });
    const resolved = await resolveAttachments([
      { name: 'IMG_1.HEIC', mime: 'image/jpeg', dataBase64: MINI_JPEG.toString('base64') }
    ]);
    expect(called).toBe(0);
    expect(resolved.images).toEqual([
      { type: 'image', data: MINI_JPEG.toString('base64'), mimeType: 'image/jpeg' }
    ]);
  });

  it('builds a JPEG data URL for a pasted HEIC thumbnail', async () => {
    setHeicDecoderForTests(async () => MINI_JPEG);
    const url = await imagePreviewFromBytes(fakeHeic().toString('base64'), 'image/heic', 'paste.heic');
    expect(url).toBe(`data:image/jpeg;base64,${MINI_JPEG.toString('base64')}`);
  });
});

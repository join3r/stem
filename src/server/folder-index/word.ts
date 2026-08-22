// Word text extraction for the folder index, via word-extractor — one pure-JS
// package covering both formats: legacy .doc (OLE compound documents, parsed
// directly) and .docx (OOXML zip, via yauzl + saxes). No native binary. Loaded
// lazily on the first Word file so folders without any never pay the module
// cost; kept external in the main-process bundle and resolved from
// node_modules at runtime (see electron.vite.config.ts).

type WordExtractorClass = typeof import('word-extractor');

let modPromise: Promise<WordExtractorClass> | null = null;
function wordExtractor(): Promise<WordExtractorClass> {
  modPromise ??= import('word-extractor').then((m) => m.default);
  return modPromise;
}

export interface WordText {
  /** Extracted text: body plus any footnotes/endnotes/textboxes that carry text. */
  text: string;
  /**
   * Always null — word-extractor exposes no document metadata, so the caller
   * falls back to the filename. Present so PDF and Word extraction results
   * share a shape.
   */
  title: null;
}

/**
 * Extract a Word document's text (.doc or .docx — word-extractor sniffs the
 * container from the lead bytes, not the extension). Returns null when the
 * file can't be parsed (corrupt, encrypted, mislabeled); an empty `text` means
 * a well-formed document with nothing to index (e.g. images only). Unlike the
 * PDF path there is no early stop — the whole document is parsed, then the
 * text is truncated to `maxChars`.
 */
export async function extractWordText(data: Buffer, maxChars: number): Promise<WordText | null> {
  try {
    const Extractor = await wordExtractor();
    const doc = await new Extractor().extract(data);
    // Body first (it dominates relevance under truncation), then the side
    // channels — a flyer whose only text lives in textboxes still indexes.
    const parts = [doc.getBody(), doc.getFootnotes(), doc.getEndnotes(), doc.getTextboxes()]
      .map((s) => s.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim())
      .filter(Boolean);
    return { text: parts.join('\n\n').slice(0, maxChars).trim(), title: null };
  } catch {
    // quiet: null is the answer. The caller counts it as an unreadable Word
    // file in the skip stats the Folders tab shows.
    return null;
  }
}

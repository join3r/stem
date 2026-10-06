import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { extractPdfText } from '../folder-index/pdf';

// The main-process half of `read` on a PDF. pi's read tool decodes every
// non-image file as UTF-8, so a PDF reaches the model as raw object syntax; the
// bridge's tool_result hook swaps that for the text layer it asks for here —
// the same pdf.js extractor the folder index and chat attachments use, which
// lives in main (pdfjs-dist is resolved from main's node_modules, not pi's).
//
// The bridge only asks after pi's own read succeeded on the path, so the
// filesystem gate has already passed it; this side just refuses anything that
// is not an absolute .pdf path.

/** Same cap as a folder-index document: past this the model pages, never floods. */
const MAX_TEXT_CHARS = 2 * 1024 * 1024;
/** A larger file is not worth parsing for a reply (mirrors already skip files over 25 MB). */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const CACHE_SIZE = 4;

export type PdfReadResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; error: string };

/** Paging through one PDF is a run of reads of the same file; parse it once. */
const cache = new Map<string, { key: string; result: PdfReadResult }>();

export async function readPdfText(path: string): Promise<PdfReadResult> {
  if (!isAbsolute(path) || !/\.pdf$/i.test(path)) return { ok: false, error: 'Not a PDF path.' };
  let info;
  try {
    info = await stat(path);
  } catch {
    // quiet: the answer is the signal — it becomes the read's result for the assistant.
    return { ok: false, error: 'The PDF could not be opened.' };
  }
  if (info.size > MAX_FILE_BYTES) {
    return { ok: false, error: `The PDF is ${Math.round(info.size / 1024 / 1024)} MB — too large to extract text from here.` };
  }
  const key = `${info.size}:${info.mtimeMs}`;
  const hit = cache.get(path);
  if (hit?.key === key) return hit.result;

  const pdf = await extractPdfText(await readFile(path), MAX_TEXT_CHARS + 1);
  const result: PdfReadResult = !pdf
    ? { ok: false, error: 'Stem could not extract text from this PDF (it may be corrupt or encrypted).' }
    : {
        ok: true,
        text: pdf.text.length > MAX_TEXT_CHARS ? pdf.text.slice(0, MAX_TEXT_CHARS) : pdf.text,
        truncated: pdf.text.length > MAX_TEXT_CHARS
      };
  cache.delete(path);
  cache.set(path, { key, result });
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return result;
}

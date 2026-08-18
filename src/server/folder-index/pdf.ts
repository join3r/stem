// PDF text extraction for the folder index, via pdf.js (pdfjs-dist). The
// legacy build is the Node-compatible one — the modern build assumes DOM
// globals (DOMMatrix) at import time. Loaded lazily on the first .pdf so
// text-only folders never pay the module cost; kept external in the
// main-process bundle and resolved from node_modules at runtime (pure JS,
// no native binary — see electron.vite.config.ts).

type PdfjsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

let modPromise: Promise<PdfjsModule> | null = null;
function pdfjs(): Promise<PdfjsModule> {
  // pdf.js constructs a DOMMatrix at module scope and would otherwise polyfill
  // it from the optional native @napi-rs/canvas (~25MB of skia we don't ship —
  // excluded in electron-builder.yml). Text extraction never touches rendering
  // math, so inert stubs are enough; defining them up front also stops pdf.js
  // from probing for the canvas package at all.
  const g = globalThis as Record<string, unknown>;
  g.DOMMatrix ??= class DOMMatrixStub {
    a = 1;
    b = 0;
    c = 0;
    d = 1;
    e = 0;
    f = 0;
    scale(): this {
      return this;
    }
    translate(): this {
      return this;
    }
    multiply(): this {
      return this;
    }
    invertSelf(): this {
      return this;
    }
    transformPoint<T>(p: T): T {
      return p;
    }
  };
  g.Path2D ??= class Path2DStub {
    addPath(): void {}
    moveTo(): void {}
    lineTo(): void {}
    closePath(): void {}
  };
  modPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return modPromise;
}

export interface PdfText {
  /** Extracted text layer; empty string for image-only scans (no OCR). */
  text: string;
  /** Document metadata title, when present and non-empty. */
  title: string | null;
}

/**
 * Extract a PDF's text layer. Returns null when the file can't be parsed at
 * all (corrupt, encrypted); an empty `text` means a well-formed but image-only
 * document. Stops reading pages once `maxChars` is reached so a thousand-page
 * scan can't flood the index.
 */
export async function extractPdfText(data: Buffer, maxChars: number): Promise<PdfText | null> {
  const { getDocument } = await pdfjs();
  let task: ReturnType<typeof getDocument> | null = null;
  try {
    task = getDocument({
      // Copy: pdf.js transfers the buffer to its (fake) worker and detaches it.
      data: new Uint8Array(data),
      disableFontFace: true,
      verbosity: 0
    });
    const doc = await task.promise;
    const parts: string[] = [];
    let total = 0;
    for (let i = 1; i <= doc.numPages && total < maxChars; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let pageText = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        pageText += item.str;
        if (item.hasEOL) pageText += '\n';
      }
      pageText = pageText.replace(/[ \t]+\n/g, '\n').trim();
      if (pageText) {
        parts.push(pageText);
        total += pageText.length;
      }
    }
    // quiet: the metadata title is a nicety on top of the text, and plenty of
    // PDFs carry none at all — the caller falls back to the filename either way.
    const meta = await doc.getMetadata().catch(() => null);
    const rawTitle = (meta?.info as { Title?: unknown } | undefined)?.Title;
    const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim().slice(0, 200) : null;
    return { text: parts.join('\n\n').slice(0, maxChars).trim(), title };
  } catch {
    // quiet: null is the answer. The caller counts it as an unreadable PDF in the
    // skip stats the Folders tab shows.
    return null;
  } finally {
    // quiet: this only releases pdf.js's own buffers on a document nothing will
    // read again. Letting it through would be worse than dropping it: a throw in
    // `finally` replaces the extracted text with the destroy's error.
    await task?.destroy().catch(() => {});
  }
}

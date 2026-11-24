import { readFile, rm } from 'node:fs/promises';
import { heicToJpeg, looksLikeHeicBytes } from '../pi/heic';
import { resolveUploadSources, type BrowserSourceDeps } from './browser-sources';

// generate_image references that are files rather than pictures in the chat:
// a sprite in a connected project, a photo in Files, something a script left
// in scratch. Without this the model had to ask the user to attach a file it
// could already read ("First-Person Sword Hand Sprite Fix", 2026-11-03).
//
// The files it may name are exactly the ones a browser upload or save_file may
// name (browser-sources.ts): `img_…` ids, `files/…`, scratch, connected
// folders. Nothing on the user's computer that Stem does not already mirror.

/** The image service takes pictures up to about this size; bigger is refused here, not there. */
export const MAX_IMAGE_REF_BYTES = 20 * 1024 * 1024;

export interface ImageRef {
  ref: string;
  mimeType: string;
  /** Base64. */
  data: string;
}

/** PNG, JPEG, WebP or GIF by its first bytes; null for anything else. */
export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  return null;
}

/** Read each named picture, in order. All or nothing, like an upload. */
export async function resolveImageRefs(
  threadId: string,
  refs: string[],
  deps: BrowserSourceDeps
): Promise<{ ok: true; images: ImageRef[] } | { ok: false; error: string }> {
  const src = await resolveUploadSources(threadId, refs, deps);
  if (!src.ok) return { ok: false, error: src.error.replace(/\bupload(ed)?\b/g, (_m, ed) => (ed ? 'used as a reference' : 'reference')) };
  try {
    const images: ImageRef[] = [];
    for (let i = 0; i < src.files.length; i++) {
      const ref = refs[i]!.trim();
      let bytes: Buffer = await readFile(src.files[i]!.path);
      if (looksLikeHeicBytes(bytes)) {
        const jpeg = await heicToJpeg(bytes);
        if (!jpeg) return { ok: false, error: `“${ref}” is a HEIC photo this server cannot decode; save it as JPEG or PNG first.` };
        bytes = jpeg;
      }
      const mimeType = sniffImageMime(bytes);
      if (!mimeType) return { ok: false, error: `“${ref}” is not a PNG, JPEG, WebP or GIF picture.` };
      if (bytes.length > MAX_IMAGE_REF_BYTES) {
        return { ok: false, error: `“${ref}” is larger than ${MAX_IMAGE_REF_BYTES / 1024 / 1024} MB; make a smaller copy first.` };
      }
      images.push({ ref, mimeType, data: bytes.toString('base64') });
    }
    return { ok: true, images };
  } finally {
    // quiet: a copy that will not delete is swept with the outbox folder on the next start.
    for (const f of src.files) await rm(f.path, { force: true }).catch(() => undefined);
  }
}

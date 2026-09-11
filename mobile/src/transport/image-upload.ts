import { File } from 'expo-file-system';
import type { DraftAttachment } from '../drafts/store';
import { MAX_ATTACHMENT_BYTES } from '../drafts/store';

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const heifExtension = /\.(heic|heif|hif)$/i;
const isJpeg = (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/** Convert at upload time so Photos, Files, and previously saved drafts all work. */
export async function prepareImageUpload(attachment: DraftAttachment, bytes: Uint8Array<ArrayBuffer>) {
  const { name, mime } = attachment;
  // Picker metadata is not always reliable. Inspect the actual container too.
  const heifBytes = bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp' &&
    HEIF_BRANDS.has(String.fromCharCode(...bytes.subarray(8, 12)));
  const heifMetadata = heifExtension.test(name) || heifExtension.test(attachment.uri) ||
    /^image\/hei[cf](?:-sequence)?$/i.test(mime?.split(';')[0].trim() ?? '');
  if (!heifBytes && !heifMetadata) return { name, mime, bytes };

  const jpegName = `${name.replace(/\.[^.]+$/, '') || 'photo'}.jpg`;
  // Some picker versions already transcode but retain the original HEIC name.
  if (isJpeg(bytes)) return { name: jpegName, mime: 'image/jpeg', bytes };

  let converted: File | undefined;
  try {
    const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
    const context = ImageManipulator.manipulate(attachment.uri);
    try {
      const image = await context.renderAsync();
      try {
        const result = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.95 });
        converted = new File(result.uri);
      } finally {
        image.release();
      }
    } finally {
      context.release();
    }
    if (converted.size > MAX_ATTACHMENT_BYTES)
      throw new Error('The converted photo is larger than 100 MiB. Your draft is saved.');
    const jpeg = await converted.bytes();
    if (!isJpeg(jpeg)) throw new Error('The image converter did not produce a JPEG.');
    return { name: jpegName, mime: 'image/jpeg', bytes: jpeg };
  } catch (error) {
    throw new Error(`Could not prepare ${name} as JPEG. Your draft is saved. ${error instanceof Error ? error.message : ''}`.trim());
  } finally {
    // Only remove the converter's cache file; keep the original for safe retries.
    try { if (converted?.exists) converted.delete(); } catch { /* Best effort cache cleanup. */ }
  }
}

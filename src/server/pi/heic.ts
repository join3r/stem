// Decode HEIC/HEIF to JPEG using a decoder the OS (or the user) already has.
//
// Stem never ships HEVC. iPhone photos are HEVC inside a HEIF container, and
// distributing a software decoder (libheif, libde265, WASM ports) is a patent
// problem Chromium itself refuses. Instead:
//
//   macOS  — `/usr/bin/sips` (ImageIO; Apple licensed HEVC in the OS)
//   others — `heif-convert` or `magick` if the user put one on PATH
//
// Failure is null, never a throw: a missing decoder or a corrupt file is the
// same as any other unsupported attachment. The caller names it in `rejected`.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { TurnAttachment } from '../../shared/types';

const CONVERT_TIMEOUT_MS = 30_000;

const HEIC_EXT = new Set(['.heic', '.heif', '.hif']);

const HEIC_MIME = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence'
]);

// ISO BMFF major-brand at byte 8. `mif1`/`msf1` are generic HEIF; the rest are
// the HEVC-in-HEIF brands iPhones actually write.
const HEIC_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1'
]);

/** True when the name or MIME already says HEIC, before we look at bytes. */
export function isHeicNameOrMime(att: Pick<TurnAttachment, 'name' | 'path' | 'mime'>): boolean {
  const mime = att.mime?.toLowerCase();
  // Already converted (client-side sips left the .heic name but set jpeg mime).
  if (mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/gif' || mime === 'image/webp') {
    return false;
  }
  if (mime && HEIC_MIME.has(mime)) return true;
  const ext = extname(att.name || att.path || '').toLowerCase();
  return HEIC_EXT.has(ext);
}

/** True when the file's `ftyp` box is a HEIF brand. */
export function looksLikeHeicBytes(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  if (bytes.toString('ascii', 4, 8) !== 'ftyp') return false;
  return HEIC_BRANDS.has(bytes.toString('ascii', 8, 12));
}

export function isHeicAttachment(
  att: Pick<TurnAttachment, 'name' | 'path' | 'mime'>,
  bytes?: Buffer | null
): boolean {
  if (isHeicNameOrMime(att)) return true;
  return bytes ? looksLikeHeicBytes(bytes) : false;
}

function looksLikeJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

type Decoder = (bytes: Buffer) => Promise<Buffer | null>;

let decoderOverride: Decoder | null = null;

/** Swap the decoder in unit tests. Pass `null` to restore the system decoder. */
export function setHeicDecoderForTests(decoder: Decoder | null): void {
  decoderOverride = decoder;
}

/**
 * JPEG bytes, or null if this machine has no decoder or the file will not decode.
 * Never throws.
 */
export async function heicToJpeg(bytes: Buffer): Promise<Buffer | null> {
  try {
    const out = await (decoderOverride ?? convertHeicWithSystem)(bytes);
    if (!out || !looksLikeJpeg(out)) return null;
    return out;
  } catch {
    // quiet: the caller treats null like any other unreadable attachment.
    return null;
  }
}

/**
 * If this attachment is HEIC and this machine can decode it, return JPEG bytes
 * as `dataBase64` (path dropped — the original file stays on disk). Otherwise
 * return the attachment unchanged so a later stage can try, or reject it.
 */
export async function convertHeicAttachment(att: TurnAttachment): Promise<TurnAttachment> {
  if (!isHeicNameOrMime(att)) return att;
  let bytes: Buffer | null = null;
  if (att.dataBase64) {
    bytes = Buffer.from(att.dataBase64, 'base64');
  } else if (att.path) {
    try {
      bytes = await readFile(att.path);
    } catch {
      return att;
    }
  }
  if (!bytes) return att;
  const jpeg = await heicToJpeg(bytes);
  if (!jpeg) return att;
  return { name: att.name, mime: 'image/jpeg', dataBase64: jpeg.toString('base64') };
}

export async function convertHeicAttachments(atts: TurnAttachment[]): Promise<TurnAttachment[]> {
  return Promise.all(atts.map(convertHeicAttachment));
}

function runTool(command: string, args: readonly string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: CONVERT_TIMEOUT_MS, windowsHide: true }, (error) => {
        resolve(!error);
      });
    } catch {
      resolve(false);
    }
  });
}

async function convertHeicWithSystem(bytes: Buffer): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), 'stem-heic-'));
  const input = join(dir, 'in.heic');
  const output = join(dir, 'out.jpg');
  try {
    await writeFile(input, bytes);
    if (process.platform === 'darwin') {
      const ok = await runTool('/usr/bin/sips', ['-s', 'format', 'jpeg', input, '--out', output]);
      if (ok) return await readJpeg(output);
    }
    // User-supplied tools only. Never ship these; never `apt install` them into
    // the official image. `convert` is skipped: on Windows it is a filesystem
    // utility, not ImageMagick.
    for (const [command, args] of [
      ['heif-convert', [input, output]],
      ['magick', [input, output]]
    ] as const) {
      const ok = await runTool(command, args);
      if (ok) return await readJpeg(output);
    }
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // quiet: temp cleanup is best-effort; the next boot's OS temp sweep gets it.
    });
  }
}

async function readJpeg(path: string): Promise<Buffer | null> {
  try {
    const bytes = await readFile(path);
    return looksLikeJpeg(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

// Resolve user turn attachments into pi-ingestible inputs.
//
// pi's `prompt` RPC accepts images natively (`images: [{type:'image', data, mimeType}]`).
// It has no slot for arbitrary files, so text-like files are inlined into the message as
// fenced blocks and binary files are rejected. This module is the single place that reads
// attachment bytes (from `dataBase64` or an on-disk `path`) and classifies them.

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { TurnAttachment } from '../../shared/types';

/** pi `ImageContent` — the shape of each entry in the prompt's `images` array. */
export interface PiImageContent {
  type: 'image';
  data: string; // base64
  mimeType: string;
}

export interface ResolvedAttachments {
  /** → `prompt.images` */
  images: PiImageContent[];
  /** Fenced file contents appended to the message text. */
  textBlocks: string[];
  /** Basenames of attachments skipped because they're unsupported binaries. */
  rejected: string[];
}

// Image types pi accepts. SVG is intentionally excluded — it's markup, handled as text.
const IMAGE_EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

// Extensions we treat as text even when the OS reports no/!text mime.
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.mdx', '.rst', '.log',
  '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.env', '.csv', '.tsv',
  '.xml', '.html', '.htm', '.svg', '.css', '.scss',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp',
  '.cs', '.php', '.sh', '.bash', '.zsh', '.sql', '.graphql', '.lua', '.pl', '.r',
  '.gitignore', '.dockerfile', '.makefile', '.gradle'
]);

// Map a few extensions to a fenced-code language hint.
const LANG_BY_EXT: Record<string, string> = {
  '.js': 'js', '.jsx': 'jsx', '.ts': 'ts', '.tsx': 'tsx', '.mjs': 'js', '.cjs': 'js',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp', '.php': 'php',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.sql': 'sql', '.css': 'css',
  '.scss': 'scss', '.html': 'html', '.htm': 'html', '.xml': 'xml', '.json': 'json',
  '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.md': 'markdown'
};

// Inlined text files larger than this are truncated (with a notice) so a stray large
// file can't blow up the prompt.
const MAX_INLINE_BYTES = 100 * 1024;

function imageMimeFor(att: TurnAttachment, ext: string): string | null {
  const mime = att.mime?.toLowerCase();
  if (mime?.startsWith('image/')) {
    // Normalise to a type pi accepts; drop unknown image subtypes to the ext map.
    if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif' || mime === 'image/webp') {
      return mime;
    }
  }
  return IMAGE_EXT_MIME[ext] ?? null;
}

function looksTextual(att: TurnAttachment, ext: string, bytes: Buffer): boolean {
  if (att.mime?.toLowerCase().startsWith('text/')) return true;
  if (TEXT_EXT.has(ext)) return true;
  // Heuristic for unknown types: no NUL byte and decodes as UTF-8 cleanly.
  if (bytes.includes(0)) return false;
  return Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes);
}

async function bytesOf(att: TurnAttachment): Promise<Buffer | null> {
  if (att.dataBase64) return Buffer.from(att.dataBase64, 'base64');
  if (att.path) {
    try {
      return await readFile(att.path);
    } catch {
      return null;
    }
  }
  return null;
}

function fenceText(name: string, lang: string, body: string, truncated: boolean): string {
  const note = truncated ? '\n… (truncated)' : '';
  return `Attached file: ${name}\n\`\`\`${lang}\n${body}${note}\n\`\`\``;
}

/**
 * Read an on-disk image and return a `data:` URL for an inline thumbnail, or null if the
 * file isn't a supported image or can't be read. Used to preview dialog/drop-picked
 * images in the live bubble, where the renderer never holds the bytes.
 */
export async function imagePreviewDataUrl(path: string): Promise<string | null> {
  const ext = extname(path).toLowerCase();
  const mime = IMAGE_EXT_MIME[ext];
  if (!mime) return null;
  try {
    const bytes = await readFile(path);
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

export async function resolveAttachments(atts: TurnAttachment[]): Promise<ResolvedAttachments> {
  const out: ResolvedAttachments = { images: [], textBlocks: [], rejected: [] };
  for (const att of atts) {
    const ext = extname(att.name || att.path || '').toLowerCase();
    const imageMime = imageMimeFor(att, ext);

    // Fast path for pasted images: bytes are already base64, no decode round-trip needed.
    if (imageMime && att.dataBase64 && !att.path) {
      out.images.push({ type: 'image', data: att.dataBase64, mimeType: imageMime });
      continue;
    }

    const bytes = await bytesOf(att);
    if (!bytes) {
      out.rejected.push(att.name);
      continue;
    }

    if (imageMime) {
      out.images.push({ type: 'image', data: bytes.toString('base64'), mimeType: imageMime });
      continue;
    }

    if (looksTextual(att, ext, bytes)) {
      const truncated = bytes.length > MAX_INLINE_BYTES;
      const body = (truncated ? bytes.subarray(0, MAX_INLINE_BYTES) : bytes).toString('utf8');
      out.textBlocks.push(fenceText(att.name, LANG_BY_EXT[ext] ?? '', body, truncated));
      continue;
    }

    out.rejected.push(att.name);
  }
  return out;
}

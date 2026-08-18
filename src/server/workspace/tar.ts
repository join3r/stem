import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, utimes } from 'node:fs/promises';
import { dirname, posix, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { degrade } from '../degrade';

// A tar reader and writer, written here rather than installed.
//
// Two constraints decide this. The import side runs as `stem-server import`,
// which is booted by scripts/server-boot.mjs on a filesystem with NO node_modules
// at all — a runtime dependency under src/server does not merely add weight, it
// fails to resolve. And shelling out to the system `tar` would make extraction
// safety a property of whichever tar happens to be installed (bsdtar on the Mac,
// GNU tar on the VPS, neither on Windows), when extraction safety is the one part
// of this file that has to be exactly right.
//
// The format is POSIX ustar with PAX extended headers for paths over 100 bytes,
// which is what every modern tar writes and reads. That matters: the archive is a
// backup, so `tar tf` and `tar xf` must work on it years from now with no Stem
// anywhere in sight. It is deliberately a small subset — regular files and
// directories, nothing else — because that is all a state root contains and every
// other member type is a way for an archive to write somewhere it shouldn't.
//
// EXTRACTION IS THE DANGEROUS HALF. A tarball is the classic path-traversal
// vector: `../../.ssh/authorized_keys` as a member name, an absolute path, or a
// symlink placed early that a later member then writes through. So {@link extractTar}
// resolves every member against the destination and refuses anything that lands
// outside it, refuses absolute paths and `..` before it even resolves, and refuses
// symlinks, hardlinks and device nodes outright rather than skipping them — an
// archive containing one was not written by us, and the interesting question is
// not which members are safe but why it is here at all.

const BLOCK = 512;

/** Where a member's bytes come from: a file on disk, or bytes we computed. */
export type TarSource = { file: string } | { data: Buffer };

/** One member to write. `size` must match what `source` yields (see writeTar). */
export interface TarInput {
  /** POSIX-separated path inside the archive, always relative. */
  path: string;
  type: 'file' | 'directory';
  /** Permission bits only; the type bits are supplied from `type`. */
  mode: number;
  /** Modification time in whole seconds since the epoch. */
  mtime: number;
  size: number;
  source?: TarSource;
}

/** One member read back out. */
export interface TarMemberInfo {
  path: string;
  type: 'file' | 'directory';
  mode: number;
  /** Whole seconds since the epoch, 0 when the archive did not say. */
  mtime: number;
  size: number;
}

function octal(value: number, width: number): string {
  // width includes the trailing NUL, which is what every tar writes for these
  // fields even though the spec also allows a space.
  return Math.max(0, Math.trunc(value)).toString(8).padStart(width - 1, '0') + '\0';
}

function writeAscii(block: Buffer, offset: number, text: string, width: number): void {
  block.write(text.slice(0, width), offset, width, 'ascii');
}

/**
 * The ustar header checksum: the sum of every byte of the header with the
 * checksum field itself read as eight spaces. Written as six octal digits, a NUL
 * and a space — the one field whose padding is not uniform.
 */
function applyChecksum(block: Buffer): void {
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  writeAscii(block, 148, `${sum.toString(8).padStart(6, '0')}\0 `, 8);
}

function header(fields: {
  name: string;
  prefix: string;
  mode: number;
  size: number;
  mtime: number;
  typeflag: string;
}): Buffer {
  const block = Buffer.alloc(BLOCK);
  writeAscii(block, 0, fields.name, 100);
  writeAscii(block, 100, octal(fields.mode & 0o7777, 8), 8);
  // uid/gid 0 and no uname/gname: the archive crosses machines and users, and a
  // numeric owner from the Mac means nothing in a container. Extraction never
  // restores ownership anyway.
  writeAscii(block, 108, octal(0, 8), 8);
  writeAscii(block, 116, octal(0, 8), 8);
  writeAscii(block, 124, octal(fields.size, 12), 12);
  writeAscii(block, 136, octal(fields.mtime, 12), 12);
  writeAscii(block, 156, fields.typeflag, 1);
  writeAscii(block, 257, 'ustar\0', 6);
  writeAscii(block, 263, '00', 2);
  writeAscii(block, 345, fields.prefix, 155);
  applyChecksum(block);
  return block;
}

/** Zero bytes rounding `size` up to the next 512-byte boundary. */
function padding(size: number): Buffer {
  const over = size % BLOCK;
  return over === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - over);
}

/**
 * Split a path into ustar's name/prefix pair, or return null when it does not
 * fit — in which case the caller emits a PAX header instead. The split has to
 * fall on a `/` and leave at most 100 bytes of name and 155 of prefix.
 */
function ustarSplit(path: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let i = path.indexOf('/'); i !== -1 && i < path.length - 1; i = path.indexOf('/', i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  return null;
}

/** One PAX record: `<total length> <key>=<value>\n`, the length counting itself. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  // The digits are part of the length they state, so adding one can push it over
  // a power of ten. Two iterations always settle it.
  while (Buffer.byteLength(String(length)) + Buffer.byteLength(body) !== length) {
    length = Buffer.byteLength(String(length)) + Buffer.byteLength(body);
  }
  return Buffer.from(`${length}${body}`, 'utf8');
}

/** The header blocks for one member, PAX-prefixed when its path is too long. */
function headerBlocks(input: TarInput, index: number): Buffer[] {
  const path = input.type === 'directory' && !input.path.endsWith('/') ? `${input.path}/` : input.path;
  const typeflag = input.type === 'directory' ? '5' : '0';
  const split = ustarSplit(path);
  if (split) {
    return [header({ ...split, mode: input.mode, size: input.size, mtime: input.mtime, typeflag })];
  }
  const records = paxRecord('path', path);
  // The truncated name in the ustar header is what a tar that ignores PAX would
  // use. Keeping the tail rather than the head makes that fallback readable.
  const fallback = path.slice(-99);
  return [
    header({
      name: `PaxHeaders/${index}`,
      prefix: '',
      mode: 0o644,
      size: records.length,
      mtime: input.mtime,
      typeflag: 'x'
    }),
    records,
    padding(records.length),
    header({
      name: fallback,
      prefix: '',
      mode: input.mode,
      size: input.size,
      mtime: input.mtime,
      typeflag
    })
  ];
}

/**
 * Write `entries` as a tar archive at `out`, created 0600.
 *
 * A member's declared size is fixed when the header goes out, so a file that
 * grows or shrinks between the stat that produced `size` and the read that
 * follows would corrupt the archive for everything after it. Exactly `size`
 * bytes are therefore written whatever the file now says: short reads are padded
 * with zeros, long ones truncated. A live state root is the normal case here, so
 * this is the expected path and not a paranoid one.
 */
export async function writeTar(out: string, entries: TarInput[]): Promise<void> {
  async function* blocks(): AsyncGenerator<Buffer> {
    let index = 0;
    for (const entry of entries) {
      yield* headerBlocks(entry, index++);
      if (entry.type === 'directory' || !entry.source) continue;
      let written = 0;
      if ('data' in entry.source) {
        const slice = entry.source.data.subarray(0, entry.size);
        written = slice.length;
        if (slice.length) yield slice;
      } else {
        for await (const chunk of createReadStream(entry.source.file)) {
          const buf = chunk as Buffer;
          const room = entry.size - written;
          if (room <= 0) break;
          const slice = buf.length > room ? buf.subarray(0, room) : buf;
          written += slice.length;
          yield slice;
        }
      }
      if (written < entry.size) yield Buffer.alloc(entry.size - written);
      const pad = padding(entry.size);
      if (pad.length) yield pad;
    }
    // Two zero blocks mark the end of the archive.
    yield Buffer.alloc(BLOCK * 2);
  }

  // quiet: if the directory really is not there, the write stream on the next
  // line cannot open it and the pipeline rejects to the caller.
  await mkdir(dirname(out), { recursive: true }).catch(() => undefined);
  await pipeline(blocks(), createWriteStream(out, { mode: 0o600 }));
}


// ---- reading ----

/** How much of a member is held in memory at once while it is being unpacked. */
const CHUNK = 4 * 1024 * 1024;

/** Pulls exact byte counts out of a byte stream. */
class BlockSource {
  private buffer: Buffer = Buffer.alloc(0);
  private done = false;

  constructor(private readonly iterator: AsyncIterator<Buffer>) {}

  /** Exactly `n` bytes, or null at a clean end of stream. Throws on a short tail. */
  async read(n: number): Promise<Buffer | null> {
    while (this.buffer.length < n && !this.done) {
      const next = await this.iterator.next();
      if (next.done) this.done = true;
      else this.buffer = Buffer.concat([this.buffer, next.value as Buffer]);
    }
    if (this.buffer.length === 0) return null;
    if (this.buffer.length < n) throw new Error('the archive ends in the middle of a record');
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }
}

function readAscii(block: Buffer, offset: number, width: number): string {
  const raw = block.subarray(offset, offset + width);
  const end = raw.indexOf(0);
  return raw
    .subarray(0, end === -1 ? raw.length : end)
    .toString('ascii')
    .trim();
}

function readOctal(block: Buffer, offset: number, width: number): number {
  const text = readAscii(block, offset, width).replace(/[^0-7]/g, '');
  return text ? parseInt(text, 8) : 0;
}

/** True for a block of nothing but zeros — the archive's end marker. */
function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

/** A member's bytes, offered two ways so a caller never holds more than it needs. */
export interface TarBody {
  /** Hand every chunk to `sink`, in order. */
  pipe(sink: (chunk: Buffer) => Promise<void> | void): Promise<void>;
  /** The whole member in memory. Only for members known to be small. */
  buffer(): Promise<Buffer>;
}

/**
 * Walk an archive, calling `visit` once per ordinary member with its bytes.
 * Whatever `visit` leaves unread is skipped, so a caller that only wants the
 * headers never pays for the payloads. Returning 'stop' ends the walk.
 *
 * PAX extended headers, GNU long names and global headers are consumed here and
 * never surface: `path` is taken from them when present, and everything else they
 * can carry — atime, ownership, vendor keys — is deliberately dropped.
 *
 * Member types other than file and directory are refused rather than skipped.
 * Symlinks and hardlinks are how a tarball writes outside the directory it was
 * unpacked into; Stem never writes one, so an archive that has one is not a Stem
 * export, and the useful answer is to stop.
 */
async function scanTar(
  archive: string,
  visit: (member: TarMemberInfo, body: TarBody) => Promise<'stop' | void> | 'stop' | void
): Promise<void> {
  const stream = createReadStream(archive);
  const source = new BlockSource(stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>);
  /** A `path=` from a PAX header, which applies to the NEXT member only. */
  let pendingPath: string | null = null;

  try {
    for (;;) {
      const block = await source.read(BLOCK);
      if (!block || isZeroBlock(block)) break;

      const size = readOctal(block, 124, 12);
      const typeflag = String.fromCharCode(block[156] || 0x30);
      const prefix = readAscii(block, 345, 155);
      const name = readAscii(block, 0, 100);
      const declared = pendingPath ?? (prefix ? `${prefix}/${name}` : name);

      let unread = size;
      const drain = async (): Promise<void> => {
        while (unread > 0) {
          const chunk = await source.read(Math.min(unread, CHUNK));
          if (!chunk) throw new Error('the archive ends in the middle of a file');
          unread -= chunk.length;
        }
        const pad = padding(size).length;
        if (pad > 0) await source.read(pad);
      };
      const body: TarBody = {
        async pipe(sink) {
          while (unread > 0) {
            const chunk = await source.read(Math.min(unread, CHUNK));
            if (!chunk) throw new Error('the archive ends in the middle of a file');
            unread -= chunk.length;
            await sink(chunk);
          }
        },
        async buffer() {
          const parts: Buffer[] = [];
          await this.pipe((chunk) => {
            parts.push(Buffer.from(chunk));
          });
          return Buffer.concat(parts);
        }
      };

      if (typeflag === 'x' || typeflag === 'X' || typeflag === 'L') {
        const text = (await body.buffer()).toString('utf8');
        await drain();
        pendingPath =
          typeflag === 'L' ? text.replace(/\0+$/, '') : (/^\d+ path=(.*)$/m.exec(text)?.[1] ?? null);
        continue;
      }
      pendingPath = null;
      if (typeflag === 'g') {
        await drain();
        continue;
      }
      if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '5') {
        throw new Error(
          `the archive contains a ${typeflag === '1' || typeflag === '2' ? 'link' : 'special file'} ` +
            `(${declared}); a Stem export holds only ordinary files and folders`
        );
      }

      const member: TarMemberInfo = {
        path: declared,
        type: typeflag === '5' || declared.endsWith('/') ? 'directory' : 'file',
        mode: readOctal(block, 100, 8) & 0o7777,
        mtime: readOctal(block, 136, 12),
        size
      };
      const outcome = await visit(member, body);
      await drain();
      if (outcome === 'stop') return;
    }
  } finally {
    stream.destroy();
  }
}

/**
 * Reject a member path that could write outside `root`, BEFORE anything is
 * created. Three checks, each catching what the others cannot: the textual ones
 * refuse absolute paths, drive letters and any `..` segment; the resolve()
 * comparison catches whatever is left, including the platform-specific ways a
 * path can be absolute that a string check would miss.
 */
function safeJoin(root: string, member: string): string {
  if (member.includes('\0')) throw new Error('the archive names a member with a NUL byte in it');
  const normalized = member.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`the archive names an absolute path (${member}); refusing to unpack it`);
  }
  if (normalized.split('/').some((part) => part === '..')) {
    throw new Error(`the archive names a path that climbs out of the folder (${member}); refusing to unpack it`);
  }
  const target = resolve(root, ...normalized.split('/').filter((p) => p && p !== '.'));
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`the archive names a path outside the destination (${member}); refusing to unpack it`);
  }
  return target;
}

/**
 * Unpack `archive` into `root`, returning what landed. Existing files are
 * overwritten; the caller decides whether that is allowed (see importState,
 * which refuses a state root that has been used).
 *
 * Modes are restored from the archive, so the 0600 files land 0600 — on POSIX.
 * Windows has no such bits and chmod there is close to a no-op, which is the
 * documented limit of this and of every other 0600 in Stem.
 *
 * `onTimesUnrestored` fires once if any member's timestamps could not be put
 * back. The caller needs to know because mtime is not decoration here: it is what
 * the Inbox reads as "when something last happened in this chat", so files left
 * at unpack time arrive as a wall of activity nobody caused.
 */
export async function extractTar(
  archive: string,
  root: string,
  opts: { onTimesUnrestored?: () => void } = {}
): Promise<TarMemberInfo[]> {
  const landed: TarMemberInfo[] = [];
  // Said once rather than once per member: a destination that cannot set times
  // cannot set them for any of the thousands of files in a state root.
  let timesReported = false;
  await scanTar(archive, async (member, body) => {
    const target = safeJoin(root, member.path);
    if (member.type === 'directory') {
      await mkdir(target, { recursive: true, mode: member.mode || 0o755 });
      landed.push(member);
      return;
    }
    await mkdir(dirname(target), { recursive: true });
    const handle = await open(target, 'w', member.mode || 0o644);
    try {
      await body.pipe((chunk) => handle.write(chunk).then(() => undefined));
      // `open` honours the mode only when it creates the file; re-assert it so an
      // overwrite of an existing, looser file still ends up 0600.
      // quiet: which is the only case a failure here can matter in — a file this
      // created is already at that mode or tighter — and the one caller refuses
      // to unpack into a state root that has anything in it.
      await handle.chmod(member.mode || 0o644).catch(() => undefined);
    } finally {
      await handle.close();
    }
    if (member.mtime > 0) {
      await utimes(target, member.mtime, member.mtime).catch((error) => {
        // A session file's mtime is the only record Stem has of when something
        // last happened in that chat: the Inbox places rows by it and bolds them
        // by it. Left at the unpack time, every chat in the archive arrives as
        // activity from a minute ago — unread, top of the list, back out of the
        // archived state it was in — for turns nobody took. That is the 0.4.x
        // Inbox bug, over every chat at once.
        if (timesReported) return;
        timesReported = true;
        degrade('import', 'left every restored chat looking like it just happened', error);
        opts.onTimesUnrestored?.();
      });
    }
    landed.push(member);
  });
  return landed;
}

/** The archive's members, without writing anything or reading a payload. */
export async function listTar(archive: string): Promise<TarMemberInfo[]> {
  const members: TarMemberInfo[] = [];
  await scanTar(archive, (member) => {
    members.push(member);
  });
  return members;
}

/** One named member's bytes, or null if the archive has no such member. */
export async function readTarMember(archive: string, path: string): Promise<Buffer | null> {
  let found: Buffer | null = null;
  await scanTar(archive, async (member, body) => {
    if (member.path !== path) return;
    found = await body.buffer();
    return 'stop';
  });
  return found;
}

/** Join archive path segments — always POSIX, whatever machine wrote them. */
export function archivePath(...parts: string[]): string {
  return posix.join(...parts);
}

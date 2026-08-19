import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { host } from '../host';
import { resolveLoginPath } from '../exec/executor';
import { passphraseKeyWrapper, passphraseProblem } from '../host/passphrase-key';
import { degrade } from '../degrade';
import { log } from '../log';
import { RECALL_MCP_NAME } from '../recall/register-mcp';
import { SECRET_ENVELOPE_KEY, SECRET_VALUE_PREFIX } from '../pi/protocol';
import { restampInboxBaseline } from './inbox';
import { adoptSessionCwds } from '../pi/session-cwd';
import { archivePath, extractTar, readTarMember, writeTar, type TarInput } from './tar';
import type { SecretsState, StateExportReport, TransferGroup } from '../../shared/types';
import {
  chatSearchDbPath,
  chatStorePath,
  connectedFoldersStorePath,
  folderIndexDir,
  inboxStorePath,
  piHome,
  recallDbPath,
  secretKeyPath,
  settingsStorePath,
  tasksStorePath,
  userDataRoot,
  workspaceRoot
} from './paths';

// Taking your Stem with you: everything it knows, in one file, openable on
// another machine — and, because they are the same act, the backup.
//
// WHY THIS IS NOT `tar czf ~/Library/Application\ Support/Stem`.
//
// The state root is Electron's userData directory, which means Stem's own stores
// share it with several hundred megabytes of Chromium: Cache, Code Cache,
// GPUCache, Cookies, Local Storage, Service Worker, DIPS, and a dozen more, all
// of which are this install's browser scratch and none of which mean anything on
// another machine. It also holds three kinds of file that must NOT travel — the
// device registry, this client's own credential, and a key wrapped by a keychain
// that exists on exactly one Mac. So the archive is built from an ALLOW-list at
// the top level (below), and a deny-list inside the folders Stem owns outright.
// The two directions are deliberate: a new Chromium directory appearing must not
// silently join the archive, and a new file appearing under pi-home is almost
// certainly state the user would miss.
//
// WHAT MAKES IT OPEN ON THE OTHER SIDE. MCP credentials — bearer headers in
// mcp.json, the whole OAuth token map — are AES-256-GCM ciphertexts under one
// data key, and that key lives in `pi-home/secret.key` wrapped by the platform:
// the macOS Keychain, here. A container has no keychain, so the export unwraps
// the data key through whatever wrapper THIS machine has and re-wraps it under a
// passphrase (see host/passphrase-key.ts). The data key itself does not change,
// which is the whole trick: every ciphertext in the archive stays valid verbatim,
// and nothing has to be decrypted and re-encrypted field by field.
//
// The passphrase is the one the destination will hold as its key file — the same
// bytes that become /run/secrets/stem_key. It is never written into the archive,
// never passed as an argument (so it cannot land in shell history), and never
// logged.

/** Bumped only if the layout changes in a way an older import cannot read. */
const FORMAT_VERSION = 1;

/** Provenance, written into the archive and left in the state root on import. */
export const MANIFEST_NAME = 'stem-export.json';

interface ExportManifest {
  format: number;
  /** The Stem that wrote it, for a report that can say "from 0.4.0 on darwin". */
  app: string;
  platform: string;
  exportedAt: string;
  /** How MCP credentials travelled — see {@link StateExportReport.secrets}. */
  secrets: SecretsState;
}

export interface StateImportReport {
  stateRoot: string;
  files: number;
  bytes: number;
  landed: TransferGroup[];
  /**
   * What became of the data key that opens saved tool credentials:
   * `opened` — the passphrase unwrapped it, so everything stays connected;
   * `wrong-passphrase` — it is here but this passphrase does not open it;
   * `lost` — the machine that exported could no longer open it either;
   * `none` — this Stem was not encrypting them in the first place.
   */
  secrets: 'opened' | 'wrong-passphrase' | 'lost' | 'none';
  /** Things that will ask to be connected again, and why. */
  reauthorize: string[];
  /** Things that came over but point at this machine's world and may not resolve. */
  attention: string[];
  /** The Stem that wrote the archive. */
  from: { app: string; platform: string; exportedAt: string };
}

// ---- what travels ----

/**
 * The top-level members of the state root that are packed, and where they come
 * from. `kind` decides how: a folder is walked, a plain file is copied, and a
 * `sqlite` file is snapshotted rather than copied, because the app is running
 * while the export is taken and a database with a hot write-ahead log copied
 * byte-for-byte is a database that may not open.
 */
function members(): Array<{ archive: string; source: string; kind: 'dir' | 'file' | 'sqlite' }> {
  return [
    // The pi backend's home: sessions (the chats themselves), skills, provider
    // credentials, MCP config and tokens, the assistant's scratch folder.
    { archive: 'pi-home', source: piHome(), kind: 'dir' },
    // The backend's working directory: the user's Files place and its attachments.
    { archive: 'workspace', source: workspaceRoot(), kind: 'dir' },
    // Search indexes over connected folders. See the note in OMITTED about why
    // these travel and the model weights do not. Copied as files rather than
    // snapshotted like the two below: they are WAL databases, so the main file
    // is always internally consistent, and the most a copy taken mid-index can
    // be is one checkpoint stale — which the next indexing pass corrects. The
    // two hot ones are worth the snapshot; twenty folder indexes are not.
    { archive: 'folder-index', source: folderIndexDir(), kind: 'dir' },
    { archive: 'folders.json', source: chatStorePath(), kind: 'file' },
    { archive: 'inbox.json', source: inboxStorePath(), kind: 'file' },
    { archive: 'connected-folders.json', source: connectedFoldersStorePath(), kind: 'file' },
    { archive: 'tasks.json', source: tasksStorePath(), kind: 'file' },
    { archive: 'settings.json', source: settingsStorePath(), kind: 'file' },
    { archive: 'recall.sqlite', source: recallDbPath(), kind: 'sqlite' },
    { archive: 'chat_search.sqlite', source: chatSearchDbPath(), kind: 'sqlite' }
  ];
}

/**
 * Everything Stem owns that is deliberately left behind, with the reason a person
 * would want. Reported verbatim by the export so the decisions are visible at the
 * moment they are made rather than discovered afterwards.
 */
const OMITTED: Array<{ name: string; reason: string }> = [
  {
    name: 'Paired devices and pairing codes',
    reason:
      'The devices that could reach the old server are not the ones that will reach the new one, and Stem keeps only hashes of their keys — nothing that could be re-used. Pair each device again on the other side.'
  },
  {
    name: "This computer's own settings and offline copy of your chats",
    reason:
      'The Quick Chat shortcut, the window geometry and the cached chats belong to the machine you are sitting at, not to Stem. They stay here.'
  },
  {
    name: 'Downloaded embedding models',
    reason:
      'Around a gigabyte of model weights that are the same for everybody and download again on first use. Your indexes DO travel — those are made out of your own files and nothing else could rebuild them.'
  },
  {
    name: 'Uploads waiting to be used, logs and lock files',
    reason: 'Scratch. Stem clears them on a timer anyway.'
  },
  {
    name: 'Working files from your chats',
    reason:
      'Downloads, scripts and build output the assistant made while running commands, kept per chat and cleared on a timer. Your Files place travels; the throwaways around it do not, and they are the one thing that could turn a small export into a very large one.'
  },
  {
    name: "The address the old server was listening on",
    reason: 'A port number from another machine, rewritten every time a server starts.'
  }
];

/** Names that never travel, wherever they turn up inside a folder that does. */
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', '.skills-rev', MANIFEST_NAME]);

/** Suffixes that never travel: locks, half-written temporaries, database sidecars. */
const SKIP_SUFFIXES = ['.lock', '.lock.reaper', '.tmp', '.corrupt', '-wal', '-shm', '.sock'];

/**
 * Paths inside `pi-home` that are rebuilt rather than carried. The two json files
 * are written by the MCP bridge when it connects, and both describe servers that
 * are not running on the other machine yet — carrying them would mean the first
 * turn after an import advertises tools that aren't there. `exec-workspace` is
 * the per-chat scratch space: throwaway by definition, and the one member that
 * could turn a small export into a multi-gigabyte one.
 */
const SKIP_IN_PI_HOME = new Set(['mcp-catalog.json', 'mcp-status.json', 'exec-workspace']);

// ---- export ----

/**
 * Walk `dir`, collecting every ordinary file and folder under it as archive
 * members rooted at `prefix`. Anything that is not a file or a directory —
 * a symlink, the recall socket, a device node — is left out: the archive format
 * this writes cannot express one, and a state root has no legitimate need of it.
 */
async function walk(dir: string, prefix: string, into: TarInput[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    // Absent is normal: a fresh install has no folder-index at all. A directory
    // that is there and will not read is a hole in an archive that then reports
    // the files it did write and calls itself a backup.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('export', 'left a folder out of the archive', error);
    }
    return;
  }
  // quiet: readdir has just succeeded on this directory, so a stat that fails is
  // one racing a delete — and the loop below then finds nothing in it either. The
  // member only carries the folder's own mode and mtime; extract recreates a
  // parent it was not given.
  const dirStat = await stat(dir).catch(() => null);
  if (dirStat) {
    into.push({ path: prefix, type: 'directory', mode: dirStat.mode & 0o7777, mtime: Math.floor(dirStat.mtimeMs / 1000), size: 0 });
  }
  for (const name of entries.sort()) {
    if (SKIP_NAMES.has(name) || SKIP_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
    if (prefix === 'pi-home' && SKIP_IN_PI_HOME.has(name)) continue;
    const child = archivePath(prefix, name);
    const full = join(dir, name);
    const info = await lstat(full).catch((error) => {
      // Gone between the readdir and here is a lock or a temporary, and the skip
      // is right. A file that is there and will not stat is a hole in an archive
      // that then reports the files it did write and calls itself a backup — the
      // same loss as the unreadable directory above.
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        degrade('export', 'left a file out of the archive', error);
      }
      return null;
    });
    if (!info) continue;
    if (info.isDirectory()) {
      await walk(full, child, into);
    } else if (info.isFile()) {
      into.push({
        path: child,
        type: 'file',
        mode: info.mode & 0o7777,
        mtime: Math.floor(info.mtimeMs / 1000),
        size: info.size,
        source: { file: full }
      });
    }
  }
}

/**
 * A consistent copy of a SQLite database, taken while something else may be
 * writing to it. `VACUUM INTO` is SQLite's own answer to exactly this: it reads
 * the source inside one transaction and writes a fresh, fully checkpointed file,
 * so the archive holds a single database file with no -wal beside it and no
 * chance of a half-applied transaction.
 *
 * Returns null when the database is missing (nothing to carry) or refuses to open
 * — in which case the caller falls back to copying the bytes and says so.
 */
async function snapshotDatabase(source: string, name: string, scratch: string): Promise<string | null> {
  if (!existsSync(source)) return null;
  const out = join(scratch, name);
  await rm(out, { force: true });
  let db: DatabaseSync | null = null;
  try {
    // Read-only: the export must not be able to modify, checkpoint or create the
    // live database it is copying out of.
    db = new DatabaseSync(source, { readOnly: true });
    db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    return out;
  } catch (e) {
    log('export', 'could not snapshot a database; copying it as it is', {
      database: name,
      error: String((e as Error)?.message ?? e)
    });
    return null;
  } finally {
    db?.close();
  }
}

/**
 * The data key that opens MCP credentials, re-wrapped for the destination.
 *
 * Reads `pi-home/secret.key` through THIS machine's wrapper (the Keychain) and
 * writes it back out under the passphrase. The plaintext in between is a 64-char
 * hex string that exists only in this function's local and never touches disk.
 */
function rewrapSecretKey(passphrase: string): { data: Buffer; state: SecretsState } {
  const wrapper = host().keyWrapper();
  const path = secretKeyPath();
  if (!wrapper || !existsSync(path)) {
    // No keyring here, or no key was ever minted: MCP secrets are 0600 plaintext
    // on this disk already, so there is nothing to re-wrap and they travel as
    // they are. The destination's own wrapper encrypts them on its next write.
    return { data: Buffer.alloc(0), state: 'none' };
  }
  try {
    const hex = wrapper.unwrap(readFileSync(path));
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('not a data key');
    return { data: passphraseKeyWrapper(passphrase).wrap(hex), state: 'rewrapped' };
  } catch {
    // quiet: the keychain no longer opens it (a reset, a restored machine). The
    // ciphertexts in this archive are unreadable by anybody, including this Mac —
    // so they travel as 'unreadable', which the manifest carries and the import
    // turns into the paragraph naming what will ask to be connected again.
    return { data: Buffer.alloc(0), state: 'unreadable' };
  }
}

/**
 * mcp.json with the reserved stem-recall entry removed. That entry is rewritten
 * from scratch at every boot (see ensureMcpConfig) and every field in it is a
 * path on THIS machine — the Electron binary, the bundled server script, the
 * recall database. Carrying it would put an /Applications path in a Linux
 * container's config until the first boot overwrote it. The user's own servers,
 * including their encrypted fields, are copied through untouched.
 */
function mcpConfigWithoutLocalPaths(source: string): Buffer | null {
  try {
    const parsed = JSON.parse(readFileSync(source, 'utf8')) as { servers?: Record<string, unknown> };
    if (!parsed?.servers || !(RECALL_MCP_NAME in parsed.servers)) return null;
    delete parsed.servers[RECALL_MCP_NAME];
    return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  } catch {
    // quiet: unparseable, so the bytes travel as they are, corrupt and all — and
    // the entry this would have stripped is rewritten at the first boot anyway.
    return null;
  }
}

/**
 * Write the whole of this Stem to `out` as a tar archive, with MCP credentials
 * re-wrapped so `passphrase` opens them on the other side.
 *
 * The archive is written 0600 and is NOT itself encrypted: it is a tarball, so
 * `tar tf` works on it and a restore needs nothing but tar. That means it holds
 * your chats, your memory and your provider credentials in a file — treat it the
 * way you would treat a password manager's export, and move it over ssh.
 */
export async function exportState(options: { out: string; passphrase: string }): Promise<StateExportReport> {
  const problem = passphraseProblem(options.passphrase);
  if (problem) throw new Error(problem);

  const scratch = await mkdtemp(join(tmpdir(), 'stem-export-'));
  try {
    const entries: TarInput[] = [];
    const secrets = rewrapSecretKey(options.passphrase);
    const now = Math.floor(Date.now() / 1000);

    for (const member of members()) {
      if (member.kind === 'dir') {
        await walk(member.source, member.archive, entries);
        continue;
      }
      if (member.kind === 'file') {
        const info = await stat(member.source).catch((error) => {
          // Absent is ordinary: nothing has been scheduled, no chat folder made.
          // Present and unreadable loses a whole top-level member — the chat
          // folders, the inbox, the scheduled tasks — out of an archive that goes
          // on to report how many files it wrote.
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            degrade('export', `left ${member.archive} out of the archive`, error);
          }
          return null;
        });
        if (!info?.isFile()) continue;
        entries.push({
          path: member.archive,
          type: 'file',
          mode: info.mode & 0o7777,
          mtime: Math.floor(info.mtimeMs / 1000),
          size: info.size,
          source: { file: member.source }
        });
        continue;
      }
      const snapshot = await snapshotDatabase(member.source, member.archive, scratch);
      const from = snapshot ?? member.source;
      const info = await stat(from).catch((error) => {
        // No recall.sqlite is a Stem nobody has talked to yet. One that is there
        // and will not stat takes the entire memory database out of the archive,
        // silently, on the one copy the user is about to migrate from.
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          degrade('export', `left ${member.archive} out of the archive`, error);
        }
        return null;
      });
      if (!info?.isFile()) continue;
      entries.push({
        path: member.archive,
        type: 'file',
        mode: 0o600,
        mtime: Math.floor(info.mtimeMs / 1000),
        size: info.size,
        source: { file: from }
      });
    }

    // Two members whose bytes are computed rather than copied. Both replace a
    // file the walk already collected, so they are substituted in place.
    const keyMember = archivePath('pi-home', 'secret.key');
    const keyIndex = entries.findIndex((e) => e.path === keyMember);
    if (secrets.state === 'rewrapped') {
      const replacement: TarInput = {
        path: keyMember,
        type: 'file',
        mode: 0o600,
        mtime: now,
        size: secrets.data.length,
        source: { data: secrets.data }
      };
      if (keyIndex === -1) entries.push(replacement);
      else entries[keyIndex] = replacement;
    } else if (keyIndex !== -1) {
      // A key nobody can unwrap is worse than no key: the destination would find
      // it, fail to open it, and mint a fresh one anyway. Leave it out.
      entries.splice(keyIndex, 1);
    }

    const mcpMember = archivePath('pi-home', 'mcp.json');
    const mcpIndex = entries.findIndex((e) => e.path === mcpMember);
    if (mcpIndex !== -1) {
      const rewritten = mcpConfigWithoutLocalPaths(join(piHome(), 'mcp.json'));
      if (rewritten) {
        entries[mcpIndex] = { ...entries[mcpIndex], size: rewritten.length, mtime: now, source: { data: rewritten } };
      }
    }

    const manifest: ExportManifest = {
      format: FORMAT_VERSION,
      app: host().appVersion(),
      platform: process.platform,
      exportedAt: new Date().toISOString(),
      secrets: secrets.state
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    entries.unshift({
      path: MANIFEST_NAME,
      type: 'file',
      mode: 0o600,
      mtime: now,
      size: manifestBytes.length,
      source: { data: manifestBytes }
    });

    await writeTar(options.out, entries);
    const written = await stat(options.out);

    return {
      path: options.out,
      bytes: written.size,
      files: entries.filter((e) => e.type === 'file').length,
      included: groupsOf(entries.filter((e) => e.type === 'file').map((e) => ({ path: e.path, size: e.size }))).filter(
        (g) => g.name !== MANIFEST_NAME
      ),
      omitted: OMITTED,
      secrets: secrets.state
    };
  } finally {
    // quiet: everything in here is a copy of something still on disk, and a temp
    // directory that will not delete must not fail an export that already wrote
    // its archive — the OS reaps it.
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Roll per-file sizes up to the top-level member they belong to. */
function groupsOf(files: Array<{ path: string; size: number }>): TransferGroup[] {
  const groups = new Map<string, TransferGroup>();
  for (const file of files) {
    const name = file.path.split('/')[0];
    const group = groups.get(name) ?? { name, files: 0, bytes: 0 };
    group.files += 1;
    group.bytes += file.size;
    groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes);
}

// ---- import ----

/**
 * Whether this state root has been USED, and what says so — the check `import`
 * refuses on.
 *
 * "Empty" cannot mean "no files": a first boot writes a pi home, a workspace, an
 * empty recall database, a device registry and a settings file before anybody has
 * done anything at all, and refusing that would make the normal case impossible.
 * So the question asked is whether anything is here that a person put here. Each
 * signal below is something only use produces, and the answer names the one it
 * found — a refusal that says "not empty" and stops is a refusal nobody can act on.
 *
 * There is deliberately no --force. Unpacking over a used state root would merge
 * two Stems file by file: some chats from one and some from the other, a memory
 * database from one and the folder assignments from the other. Moving the old
 * directory aside is one command, keeps the rollback the migration wants anyway,
 * and cannot half-succeed.
 */
export async function stateRootObstruction(root: string = userDataRoot()): Promise<string | null> {
  /** Null when the directory is genuinely empty; otherwise the phrase to refuse with. */
  const entriesIn = async (dir: string, used: string): Promise<string | null> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      // Not there is the ordinary answer — a fresh state root has no sessions
      // folder. There and unreadable is NOT empty: answering that clears the
      // import to unpack a second Stem on top of what it could not list, and
      // there is deliberately no way back from that (see the note above). "I
      // cannot tell" has to refuse, because being wrong here is unrecoverable.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      degrade('import', 'refused an import into a state root folder it could not read', error);
      return `${dir} is there and would not open, so it cannot be told apart from a Stem that has been used`;
    }
    return names.some((name) => !SKIP_NAMES.has(name)) ? used : null;
  };

  for (const [dir, used] of [
    [join(root, 'pi-home', 'sessions'), 'it already has chats in it'],
    [join(root, 'pi-home', 'skills'), 'it already has skills in it'],
    [join(root, 'workspace', 'files'), 'it already has files in it']
  ] as const) {
    const obstruction = await entriesIn(dir, used);
    if (obstruction) return obstruction;
  }

  for (const [file, what] of [
    ['folders.json', 'chat folders'],
    ['inbox.json', 'an inbox'],
    ['tasks.json', 'scheduled tasks'],
    ['connected-folders.json', 'connected folders']
  ] as const) {
    let raw: string | null;
    try {
      raw = await readFile(join(root, file), 'utf8');
    } catch (error) {
      // As above: absent is what a fresh root looks like; unreadable is a store
      // this cannot vouch for, and vouching for it anyway is what clears the
      // import to unpack over it.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      degrade('import', `refused an import into a root whose ${file} would not open`, error);
      return `${file} is there and would not open, so it cannot be told apart from a Stem that has been used`;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && Object.values(parsed).some((v) => Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' && Object.keys(v).length > 0)) {
        return `it already has ${what} in it`;
      }
    } catch {
      // quiet: unparseable is still somebody's data, and the refusal returned
      // here is the loudest thing this function can say.
      return `it already has ${what} in it`;
    }
  }

  const recall = join(root, 'recall.sqlite');
  if (existsSync(recall)) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(recall, { readOnly: true });
      for (const table of ['messages', 'facts']) {
        const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n?: number } | undefined;
        if ((row?.n ?? 0) > 0) return 'it already has memory in it';
      }
    } catch (error) {
      // A database with no tables in it yet is a boot nobody used, and the signals
      // above are the ones that matter. A database that is there and will not open
      // is the other case: "not evidence of use" is then a guess, and an import
      // cleared on a guess unpacks a second Stem on top of memory it never read.
      if (!/no such table/i.test(String(error))) {
        degrade('import', 'refused an import into a root whose memory database would not open', error);
        return 'recall.sqlite is there and would not open, so it cannot be told apart from a Stem that has been used';
      }
    } finally {
      db?.close();
    }
  }
  return null;
}

/**
 * The manifest, read out of the archive before anything is unpacked — which is
 * also the check that this IS an archive Stem wrote. It is the first member, so
 * this costs one header and one small read whatever the archive weighs.
 */
async function readManifest(archive: string): Promise<ExportManifest> {
  let bytes: Buffer | null;
  try {
    bytes = await readTarMember(archive, MANIFEST_NAME);
  } catch (e) {
    throw new Error(`${archive} is not readable as a tar archive: ${String((e as Error)?.message ?? e)}`);
  }
  if (!bytes) {
    throw new Error(
      `${archive} does not look like a Stem export — there is no ${MANIFEST_NAME} in it. ` +
        'Use the file Settings → Server → "Move or back up this Stem" wrote.'
    );
  }
  let parsed: ExportManifest;
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as ExportManifest;
  } catch {
    throw new Error(`${archive} has a ${MANIFEST_NAME} that is not readable; the archive is damaged.`);
  }
  if (!(parsed.format <= FORMAT_VERSION)) {
    throw new Error(
      `${archive} was written by a newer Stem (archive format ${parsed.format}, this one reads ${FORMAT_VERSION}). Update Stem here first.`
    );
  }
  return parsed;
}

/**
 * What in the imported state will ask to be connected again, and what points at a
 * world this machine does not have. Worked out by reading what actually landed,
 * because the answer is not the same for every credential:
 *
 *  - Provider sign-ins (Claude, ChatGPT, an API key) live in auth.json as bearer
 *    and refresh tokens. Nothing in them names a machine, so they keep working.
 *  - MCP OAuth tokens are the same shape — but the bridge only attaches one when
 *    the server's identity hash still matches, and that hash is taken over the
 *    server's URL *and its secret header/env values*. Values that no longer
 *    decrypt are dropped, the hash changes, and every remote server comes up
 *    signed-out. So whether these survive is decided entirely by whether the key
 *    file opened, which is what makes the passphrase load-bearing rather than
 *    ceremonial.
 *  - An MCP server can be device-shaped in two ways, and both survive the move as
 *    an entry that cannot work: a command by absolute path (a path from a Mac is
 *    not a path on a Linux server) and a URL on the old machine's own network (a
 *    VPS has no route to 192.168.x.x and never will). Both have an answer now —
 *    pin the entry to that computer once it is paired, see
 *    docs/mcp-device-pinning.md — and neither is applied here. Decision ⑩ is that
 *    they stay server-located and are flagged: at import time no device is paired
 *    yet, so re-pointing one would mean guessing which machine was meant, in the
 *    one moment nobody is watching to correct the guess.
 *  - Connected folders are absolute paths to folders that live outside Stem.
 *    Their indexes travelled; the folders themselves could not.
 */
async function assess(root: string, secrets: StateImportReport['secrets']): Promise<Pick<StateImportReport, 'reauthorize' | 'attention'>> {
  const reauthorize: string[] = [];
  const attention: string[] = [];

  let config: { servers?: Record<string, Record<string, unknown>> } = {};
  try {
    config = JSON.parse(await readFile(join(root, 'pi-home', 'mcp.json'), 'utf8')) as typeof config;
  } catch (error) {
    // No MCP config is the common case and there is nothing to say about it. One
    // that will not parse takes the whole tools half of the report with it — no
    // command that is missing here, no URL only the old LAN could reach — off the
    // one screen the user reads to find out what the move broke.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('import', 'said nothing about MCP servers in the report', error);
    }
  }
  const servers = Object.entries(config.servers ?? {});
  const remote = servers.filter(([, s]) => typeof s.url === 'string');

  // quiet: no token map is the common case, and one that will not read costs the
  // report a reassuring sentence rather than an instruction — whether connected
  // tools come up signed in is decided by `secrets`, settled before this runs.
  const oauthRaw = await readFile(join(root, 'pi-home', 'mcp-oauth.json'), 'utf8').catch(() => null);
  const signedIn: string[] = [];
  if (oauthRaw) {
    try {
      const parsed = JSON.parse(oauthRaw) as Record<string, unknown>;
      signedIn.push(...Object.keys(parsed).filter((k) => k !== SECRET_ENVELOPE_KEY));
      // An encrypted envelope hides the names; the count is what matters anyway.
      if (signedIn.length === 0 && typeof parsed[SECRET_ENVELOPE_KEY] === 'string') {
        signedIn.push(...remote.map(([name]) => name));
      }
    } catch {
      // quiet: a corrupt token map is reported the loud way — every remote server
      // is listed as signed out, which is the safe direction to be wrong in.
      signedIn.push(...remote.map(([name]) => name));
    }
  }

  const encrypted = signedIn.length > 0 || remote.some(([, s]) => hasCiphertext(s));
  if (secrets === 'opened' && signedIn.length > 0) {
    reauthorize.push(
      `${signedIn.length} connected tool${signedIn.length === 1 ? '' : 's'} came over still signed in (${signedIn.join(', ')}). ` +
        'If one asks you to sign in again, its access had simply expired — nothing was lost in the move.'
    );
  } else if (secrets === 'wrong-passphrase') {
    reauthorize.push(
      'The key that opens saved tool credentials would not unlock with this passphrase, so every connected tool comes up ' +
        'signed out. Sign each one in again in Settings → Tools, or move this state root aside and import again with the ' +
        'right passphrase.'
    );
  } else if (secrets === 'lost') {
    reauthorize.push(
      'The computer this came from could no longer open its own credential key, so the saved tool credentials in this ' +
        'archive are unreadable by anyone. Sign each connected tool in again in Settings → Tools.'
    );
  } else if (secrets === 'none' && encrypted) {
    reauthorize.push(
      'This Stem was keeping tool credentials unencrypted, so they came over as they were and nothing needs re-connecting.'
    );
  }

  // quiet: the only line this feeds says the model sign-ins should keep working,
  // so losing it asks nothing of anybody — and a sign-in that did not survive the
  // move asks for itself on the first turn.
  const authRaw = await readFile(join(root, 'pi-home', 'auth.json'), 'utf8').catch(() => null);
  if (authRaw) {
    let providers: string[] = [];
    try {
      providers = Object.keys(JSON.parse(authRaw) as Record<string, unknown>);
    } catch {
      // quiet: an auth.json this cannot read is one there is nothing true to say
      // about, and a sign-in that did not survive asks for itself on the first turn.
    }
    if (providers.length > 0) {
      reauthorize.push(
        `Your model sign-in${providers.length === 1 ? '' : 's'} (${providers.join(', ')}) came over and should keep working — ` +
          'those keys are not tied to a machine. Settings → Models will say if one needs signing in again.'
      );
    }
  }

  const runnable = await commandProbe();
  for (const [name, server] of servers) {
    const command = server.command;
    if (typeof command === 'string' && command.trim() && !runnable(command)) {
      attention.push(
        `The tool "${name}" runs ${command}, which is not on this machine. Pair the computer it came from, then ` +
          `open Settings → Tools → MCP servers, select "${name}" and choose "Move to" that computer — Stem will run ` +
          'it there and its tools work from anywhere, including your phone. Or point it at a command that exists ' +
          'here, or remove it.'
      );
      continue;
    }
    const url = typeof server.url === 'string' ? server.url : '';
    if (url && isPrivateAddress(url)) {
      attention.push(
        `The tool "${name}" is at ${url}, which is an address on the network the old computer was on — this machine ` +
          `has no route to it. Pair a computer that can reach it, then select "${name}" in Settings → Tools → MCP ` +
          'servers and choose "Move to" that computer; Stem will open the URL from there.'
      );
    }
  }

  const foldersRaw = await readFile(join(root, 'connected-folders.json'), 'utf8').catch((error) => {
    // No registry means nothing was ever connected. One that is there and will
    // not read leaves the report silent about every folder that came over as a
    // path this machine does not have — the same loss the parse below degrades on.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('import', 'said nothing about connected folders in the report', error);
    }
    return null;
  });
  if (foldersRaw) {
    try {
      const parsed = JSON.parse(foldersRaw) as {
        folders?: Array<{ path?: string; name?: string; label?: string; origin?: { clientPath?: string } }>;
      };
      for (const folder of parsed.folders ?? []) {
        // A client folder's mirror bytes deliberately do not travel, and pairing
        // does not either — the device that owns it will re-pair under a NEW
        // identity, so the entry cannot self-heal. Say exactly what to do.
        if (folder.origin) {
          attention.push(
            `The connected folder "${folder.label ?? folder.origin.clientPath}" lives on another computer ` +
              `(${folder.origin.clientPath}), and mirrors do not travel in an export. Pair that computer with ` +
              'this Stem again, then reconnect the folder from it: Folders tab → + → On this computer.'
          );
          continue;
        }
        if (typeof folder.path !== 'string' || existsSync(folder.path)) continue;
        attention.push(
          `The connected folder "${folder.name ?? folder.path}" is ${folder.path}, which does not exist here. ` +
            'Its search index came over; the folder itself has to be somewhere this Stem can read.'
        );
      }
    } catch (error) {
      // The registry came over and will not read, so every connected folder lands
      // as nothing — and the report whose job is naming what did not survive the
      // move says nothing about any of them.
      degrade('import', 'said nothing about connected folders in the report', error);
    }
  }

  attention.push('No device is paired with this Stem yet. Run `stem-server pair` and enter the code in Settings → Server on each machine.');
  return { reauthorize, attention };
}

/**
 * `command => whether this machine could actually run it`, with the directories
 * resolved once.
 *
 * An absolute path is the easy half and was the only half for a while, which
 * made the report quietest about the entries most likely to be broken: real
 * configs say `npx`, `uvx`, `docker`, `bunx` — a bare name, resolved against
 * PATH — and those are exactly the ones that do not exist inside a container.
 * Unflagged, the first turn on the new machine fails with a bare ENOENT that
 * nobody connects back to the move they made yesterday.
 *
 * Two PATHs, unioned, because two different ones are real here: the process's
 * own (what the MCP child actually inherits) and the user's login shell (what
 * they see in a terminal). A command present in the second but not the first is
 * a configuration problem, not a missing program, and saying "not on this
 * machine" about a binary they can see would be wrong in the way that teaches
 * people to ignore the report.
 */
async function commandProbe(): Promise<(command: string) => boolean> {
  // quiet: resolveLoginPath answers with the process PATH on every failure of its
  // own and degrades there (exec.loginPath); it has no rejection to report.
  const loginPath = await resolveLoginPath().catch(() => '');
  const dirs = [...new Set([loginPath, process.env.PATH ?? ''].flatMap((p) => p.split(delimiter)))].filter(Boolean);
  // Windows resolves a bare name through PATHEXT; elsewhere the name is the file.
  const suffixes =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : [''];
  return (command: string): boolean => {
    const trimmed = command.trim();
    if (isAbsolute(trimmed)) return existsSync(trimmed);
    // A relative path (`./server.js`, `bin/x`) is resolved against a working
    // directory this has no way to know, so it is left alone rather than
    // guessed at — the same rule the URL check follows.
    if (trimmed.includes('/') || trimmed.includes('\\')) return true;
    return dirs.some((dir) => suffixes.some((ext) => existsSync(join(dir, trimmed + ext))));
  };
}

/**
 * Whether a URL names a machine only the computer this archive came from could
 * reach: its own loopback, an mDNS name, a bare hostname that only one LAN
 * resolves, or a private address. Home Assistant, a NAS, a router, a dev server.
 *
 * A server in a datacentre has no route to any of these, so an entry like this
 * is device-shaped in exactly the way a missing command is, and the report says
 * so rather than letting it fail on the first turn with a connection timeout
 * nobody connects back to the move.
 *
 * Anything unparseable is left alone: a URL this cannot read is one it has
 * nothing true to say about.
 */
function isPrivateAddress(raw: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    // quiet: a URL this cannot read is one it has nothing true to say about, per
    // the note above.
    return false;
  }
  if (hostname === 'localhost' || hostname === '::1') return true;
  if (hostname.endsWith('.local') || hostname.endsWith('.localhost') || hostname.endsWith('.home.arpa')) return true;
  // A single label — `nas`, `raspberrypi` — resolves on one network's DNS and
  // nowhere else. (An IPv6 literal has colons and is handled below by not
  // matching the v4 shape.)
  if (!hostname.includes('.') && !hostname.includes(':')) return true;
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!parts) return false;
  const [first, second] = [Number(parts[1]), Number(parts[2])];
  if (first === 127 || first === 10) return true; // loopback, RFC1918 /8
  if (first === 192 && second === 168) return true; // RFC1918 /16
  if (first === 172 && second >= 16 && second <= 31) return true; // RFC1918 /12
  if (first === 169 && second === 254) return true; // link-local
  return false;
}

/** Whether any field of an MCP server entry is one of our ciphertexts. */
function hasCiphertext(server: Record<string, unknown>): boolean {
  const values = [
    ...Object.values((server.headers as Record<string, string>) ?? {}),
    ...Object.values((server.env as Record<string, string>) ?? {}),
    server.oauthClientSecret
  ];
  return values.some((v) => typeof v === 'string' && v.startsWith(SECRET_VALUE_PREFIX));
}

/**
 * Unpack `archive` into this server's state root, refusing one that has been
 * used. Reports what landed and what will need a person.
 */
export async function importState(options: { archive: string; passphrase: string }): Promise<StateImportReport> {
  const root = userDataRoot();
  const manifest = await readManifest(options.archive);

  const obstruction = await stateRootObstruction(root);
  if (obstruction) {
    throw new Error(
      `${root} cannot be imported into — ${obstruction}.\n` +
        'Importing on top of it would mix the two together. Move it aside first:\n' +
        `  mv "${root}" "${root}.before-import"\n` +
        'and run this again. Keeping the old directory is the rollback.'
    );
  }

  // Members are checked and written one at a time (see extractTar). A crafted
  // archive can therefore land its legitimate members before the one that gets it
  // refused — but never a byte outside this root, which is the property that
  // matters, and the half-populated root it leaves is one the refusal above will
  // decline to import into a second time. Validating the whole archive first
  // would mean reading every byte of it twice for a case that only arises when
  // somebody hands you a hostile file.
  // Timestamps are not decoration in a state root: the Inbox reads a chat's mtime
  // as when something last happened in it. If they could not be restored, every
  // restored chat would arrive at unpack time — after the baseline that travelled
  // inside the archive — and the Inbox would open on thousands of unread threads
  // for turns nobody took. Re-stamping the baseline is the same clean slate a
  // first launch gets.
  let timesLost = false;
  const landedMembers = await extractTar(options.archive, root, {
    onTimesUnrestored: () => {
      timesLost = true;
    }
  });
  const files = landedMembers.filter((m) => m.type === 'file');

  // Whether the data key opened is the single fact the credential half of the
  // report turns on, so it is established before anything is said about it.
  let secrets: StateImportReport['secrets'] = manifest.secrets === 'unreadable' ? 'lost' : 'none';
  const keyPath = join(root, 'pi-home', 'secret.key');
  if (manifest.secrets === 'rewrapped' && existsSync(keyPath)) {
    try {
      const hex = passphraseKeyWrapper(options.passphrase).unwrap(readFileSync(keyPath));
      secrets = /^[0-9a-f]{64}$/.test(hex) ? 'opened' : 'wrong-passphrase';
    } catch {
      // quiet: 'wrong-passphrase' goes into the report, where assess() turns it
      // into the paragraph saying every connected tool comes up signed out.
      secrets = 'wrong-passphrase';
    }
  }

  // Every chat in the archive still records the folder it ran in on the machine
  // that wrote it, and pi refuses to resume a chat whose folder is not there. On
  // this machine that folder is ours and it is here, so point them at it now,
  // while the move is the thing happening — otherwise the first thing to open an
  // old chat fails, and the first thing to open one is usually a scheduled run
  // with nobody watching. (PiRuntime repairs a stray one on resume as well, for
  // state that came over before this pass existed.)
  await adoptSessionCwds(join(root, 'pi-home', 'sessions'), join(root, 'workspace'));

  if (timesLost) {
    await restampInboxBaseline().catch((error) =>
      // The import still succeeded; what is left is an Inbox that opens on every
      // restored chat marked unread. Worth a line, because from the user's side
      // that looks like the import having done something to their chats.
      degrade('import', 'left the restored chats looking unread in the Inbox', error)
    );
  }

  const assessment = await assess(root, secrets);

  // Provenance, left where the next person to wonder will look.
  const provenance = `${JSON.stringify({ ...manifest, importedAt: new Date().toISOString() }, null, 2)}\n`;
  // quiet: written for a person reading the state root afterwards; nothing in
  // Stem reads it back, and the same three facts are in the report this returns.
  await writeFile(join(root, MANIFEST_NAME), provenance, { encoding: 'utf8', mode: 0o600 }).catch(() => undefined);

  return {
    stateRoot: root,
    files: files.length,
    bytes: files.reduce((sum, m) => sum + m.size, 0),
    landed: groupsOf(files.map((m) => ({ path: m.path, size: m.size }))).filter((g) => g.name !== MANIFEST_NAME),
    secrets,
    ...assessment,
    from: { app: manifest.app, platform: manifest.platform, exportedAt: manifest.exportedAt }
  };
}

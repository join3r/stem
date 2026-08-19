// Taking your Stem with you, and bringing it back.
//
// The property that decides whether this feature works is not "the tarball has
// files in it". It is that the data key which encrypts every MCP credential
// leaves this machine wrapped by the platform keychain and arrives wrapped by a
// passphrase — the SAME key, so every ciphertext already on disk stays readable
// without anything being decrypted and re-encrypted on the way. That is the first
// test below, and the reason it decrypts by hand rather than through
// pi/secrets.ts is that pi/secrets.ts caches its key for the life of the process:
// asking it twice would only ever tell us what it already believed.
//
// The rest is what must NOT travel (the device registry, this client's own
// credential, a gigabyte of re-downloadable model weights, Chromium's scratch)
// and what "an empty state root" means, which is the whole difference between an
// import that refuses safely and one that mixes two Stems together.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setHost } from '../../src/server/host';
import { passphraseKeyWrapper } from '../../src/server/host/passphrase-key';
import { SECRET_VALUE_PREFIX } from '../../src/server/pi/protocol';
import { exportState, importState, stateRootObstruction } from '../../src/server/workspace/state-transfer';
import { listTar } from '../../src/server/workspace/tar';

const PASSPHRASE = 'a passphrase for the container';

/** The stand-in for the macOS Keychain that tests/setup-unit.ts installs. */
const KEYCHAIN = {
  wrap: (plain: string) => Buffer.from(`stub-wrapped:${plain}`, 'utf8'),
  unwrap: (wrapped: Buffer) => {
    const text = wrapped.toString('utf8');
    if (!text.startsWith('stub-wrapped:')) throw new Error('not stub-wrapped ciphertext');
    return text.slice('stub-wrapped:'.length);
  }
};

const scratches: string[] = [];
const savedEnv = { ...process.env };

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stem-transfer-'));
  scratches.push(dir);
  return dir;
}

/**
 * Point every store at `root` and make it the host's state root. The path helpers
 * read some of these from the environment (the seam the unit suite already uses),
 * so a state root is only really a state root once both are set.
 */
function useStateRoot(root: string): void {
  setHost({ stateRoot: () => root, keyWrapper: () => KEYCHAIN });
  process.env.STEM_RECALL_DB = join(root, 'recall.sqlite');
  process.env.STEM_CHAT_SEARCH_DB = join(root, 'chat_search.sqlite');
  process.env.STEM_CONNECTED_FOLDERS_STORE = join(root, 'connected-folders.json');
  process.env.STEM_FOLDER_INDEX_DIR = join(root, 'folder-index');
  process.env.STEM_SECRET_KEY_FILE = join(root, 'pi-home', 'secret.key');
  delete process.env.STEM_FILES_DIR;
}

/** A state root shaped like a Stem somebody has actually used. */
function populate(root: string): void {
  mkdirSync(join(root, 'pi-home', 'sessions', 'thread-1'), { recursive: true });
  mkdirSync(join(root, 'pi-home', 'skills', 'invoice-run'), { recursive: true });
  mkdirSync(join(root, 'workspace', 'files', 'Recipes'), { recursive: true });
  mkdirSync(join(root, 'folder-index'), { recursive: true });
  mkdirSync(join(root, 'embed-models', 'Xenova'), { recursive: true });
  mkdirSync(join(root, 'uploads', 'abc'), { recursive: true });
  mkdirSync(join(root, 'Code Cache', 'js'), { recursive: true });
  mkdirSync(join(root, 'pi-home', 'exec-workspace', 'thread-1'), { recursive: true });

  writeFileSync(join(root, 'pi-home', 'sessions', 'thread-1', 'turns.jsonl'), '{"role":"user"}\n');
  writeFileSync(join(root, 'pi-home', 'skills', 'invoice-run', 'SKILL.md'), '# invoice run\n');
  writeFileSync(join(root, 'pi-home', 'auth.json'), JSON.stringify({ anthropic: { access: 'tok' } }), { mode: 0o600 });
  writeFileSync(join(root, 'pi-home', 'mcp-status.json'), '{"servers":[]}');
  writeFileSync(join(root, 'pi-home', 'mcp.json.lock'), 'held');
  writeFileSync(join(root, 'workspace', 'files', 'Recipes', 'cake.pdf'), 'PDF');
  writeFileSync(join(root, 'folder-index', 'f1.sqlite'), 'not really a database');
  writeFileSync(join(root, 'embed-models', 'Xenova', 'model.onnx'), 'weights');
  writeFileSync(join(root, 'uploads', 'abc', 'dropped.txt'), 'staged');
  writeFileSync(join(root, 'Code Cache', 'js', 'blob'), 'chromium');
  writeFileSync(join(root, 'pi-home', 'exec-workspace', 'thread-1', 'build.log'), 'x'.repeat(4096));
  writeFileSync(join(root, 'folders.json'), JSON.stringify({ version: 1, folders: [{ id: 'f', name: 'Work' }] }));
  writeFileSync(join(root, 'inbox.json'), JSON.stringify({ version: 1, entries: {} }));
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ quickChat: { shortcut: 'Alt+Space' } }));
  writeFileSync(join(root, 'devices.json'), JSON.stringify({ devices: [{ id: 'd1', tokenHash: 'x' }] }), { mode: 0o600 });
  writeFileSync(join(root, 'pairing.json'), JSON.stringify({ pending: [] }), { mode: 0o600 });
  writeFileSync(join(root, 'client.json'), JSON.stringify({ version: 1, deviceId: 'd1', tokenEnc: 'zzz' }), { mode: 0o600 });
  writeFileSync(join(root, 'chat-cache.sqlite'), 'offline copy');
  writeFileSync(join(root, 'server.json'), JSON.stringify({ url: 'http://127.0.0.1:51234' }));
  writeFileSync(join(root, 'stem.log'), 'boot\n');
  writeFileSync(join(root, '.DS_Store'), 'finder');
}

beforeEach(() => {
  Object.assign(process.env, savedEnv);
});

afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('STEM_') && !(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  setHost({ stateRoot: () => savedEnv.STEM_STATE_DIR!, keyWrapper: () => KEYCHAIN });
});

/** Decrypt one `stemenc:1:` value with a raw data key, the way the bridge does. */
function decryptWith(keyHex: string, value: string): string {
  const raw = Buffer.from(value.slice(SECRET_VALUE_PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

describe('the credential key that has to open on the other side', () => {
  it('leaves wrapped by the keychain and arrives wrapped by the passphrase, unchanged', async () => {
    const from = scratch();
    useStateRoot(from);
    populate(from);

    // A data key exactly as pi/secrets.ts writes one: 32 random bytes as hex,
    // wrapped by the platform. And one credential encrypted under it, standing in
    // for every bearer header and OAuth token in the archive.
    const dataKey = 'ab'.repeat(32);
    writeFileSync(join(from, 'pi-home', 'secret.key'), KEYCHAIN.wrap(dataKey), { mode: 0o600 });
    const ciphertext = `${SECRET_VALUE_PREFIX}${encryptedSample(dataKey)}`;
    writeFileSync(
      join(from, 'pi-home', 'mcp.json'),
      JSON.stringify({ servers: { fastmail: { url: 'https://api.fastmail.com/mcp', headers: { Authorization: ciphertext } } } })
    );

    const archive = join(scratch(), 'move.tar');
    const report = await exportState({ out: archive, passphrase: PASSPHRASE });
    expect(report.secrets).toBe('rewrapped');

    // The wrapped key in the archive must NOT be the one on this disk.
    const packed = readFileSync(join(from, 'pi-home', 'secret.key'));
    const to = scratch();
    useStateRoot(to);
    await importState({ archive, passphrase: PASSPHRASE });
    const arrived = readFileSync(join(to, 'pi-home', 'secret.key'));
    expect(arrived.equals(packed)).toBe(false);

    // …but it must unwrap to the same data key, which is what keeps every
    // ciphertext that travelled with it readable.
    const recovered = passphraseKeyWrapper(PASSPHRASE).unwrap(arrived);
    expect(recovered).toBe(dataKey);
    const config = JSON.parse(readFileSync(join(to, 'pi-home', 'mcp.json'), 'utf8')) as {
      servers: Record<string, { headers: Record<string, string> }>;
    };
    expect(decryptWith(recovered, config.servers.fastmail.headers.Authorization)).toBe('Bearer real-token');
    expect(statSync(join(to, 'pi-home', 'secret.key')).mode & 0o777).toBe(0o600);
  });

  it('reports a wrong passphrase as every tool needing a sign-in, rather than failing silently', async () => {
    const from = scratch();
    useStateRoot(from);
    populate(from);
    writeFileSync(join(from, 'pi-home', 'secret.key'), KEYCHAIN.wrap('cd'.repeat(32)), { mode: 0o600 });
    writeFileSync(
      join(from, 'pi-home', 'mcp-oauth.json'),
      JSON.stringify({ __stemenc__: `${SECRET_VALUE_PREFIX}whatever` })
    );
    writeFileSync(join(from, 'pi-home', 'mcp.json'), JSON.stringify({ servers: { fastmail: { url: 'https://x/mcp' } } }));

    const archive = join(scratch(), 'move.tar');
    await exportState({ out: archive, passphrase: PASSPHRASE });

    const to = scratch();
    useStateRoot(to);
    const report = await importState({ archive, passphrase: 'not the right passphrase' });
    expect(report.secrets).toBe('wrong-passphrase');
    expect(report.reauthorize.join(' ')).toMatch(/would not unlock/);
  });

  it('leaves out a key nobody can open rather than shipping one that misleads', async () => {
    const from = scratch();
    useStateRoot(from);
    populate(from);
    // A key file the keychain no longer opens — a reset Mac, a restored machine.
    writeFileSync(join(from, 'pi-home', 'secret.key'), Buffer.from('not-stub-wrapped'), { mode: 0o600 });

    const archive = join(scratch(), 'move.tar');
    const report = await exportState({ out: archive, passphrase: PASSPHRASE });
    expect(report.secrets).toBe('unreadable');
    expect((await listTar(archive)).map((m) => m.path)).not.toContain('pi-home/secret.key');

    const to = scratch();
    useStateRoot(to);
    const imported = await importState({ archive, passphrase: PASSPHRASE });
    expect(imported.secrets).toBe('lost');
    expect(imported.reauthorize.join(' ')).toMatch(/sign each connected tool in again/i);
  });

  it('refuses to export under a passphrase too short to be worth deriving from', async () => {
    const from = scratch();
    useStateRoot(from);
    populate(from);
    await expect(exportState({ out: join(scratch(), 'x.tar'), passphrase: 'short' })).rejects.toThrow(/at least 12/);
  });
});

describe('what travels and what stays', () => {
  it('carries what only you have and leaves everything replaceable behind', async () => {
    const from = scratch();
    useStateRoot(from);
    populate(from);
    const archive = join(scratch(), 'move.tar');
    await exportState({ out: archive, passphrase: PASSPHRASE });
    const packed = (await listTar(archive)).map((m) => m.path);

    // Yours: the chats, the skills, the files, the indexes made out of them, and
    // the Stem-owned organization around all of it.
    expect(packed).toContain('pi-home/sessions/thread-1/turns.jsonl');
    expect(packed).toContain('pi-home/skills/invoice-run/SKILL.md');
    expect(packed).toContain('pi-home/auth.json');
    expect(packed).toContain('workspace/files/Recipes/cake.pdf');
    expect(packed).toContain('folder-index/f1.sqlite');
    expect(packed).toContain('folders.json');
    expect(packed).toContain('inbox.json');
    expect(packed).toContain('settings.json');

    // Not yours to carry: credentials for a machine that will re-pair, this
    // client's own identity and its offline copy, a live server's address, logs.
    for (const nope of [
      'devices.json',
      'pairing.json',
      'client.json',
      'chat-cache.sqlite',
      'server.json',
      'stem.log',
      '.DS_Store'
    ]) {
      expect(packed).not.toContain(nope);
    }
    // Replaceable: a gigabyte of model weights anyone can download, staged
    // uploads on a TTL, Chromium's own scratch, a held lock, a status file the
    // MCP bridge rewrites the moment it connects.
    expect(packed.some((p) => p.startsWith('embed-models'))).toBe(false);
    expect(packed.some((p) => p.startsWith('uploads'))).toBe(false);
    expect(packed.some((p) => p.startsWith('Code Cache'))).toBe(false);
    expect(packed).not.toContain('pi-home/mcp.json.lock');
    expect(packed).not.toContain('pi-home/mcp-status.json');
    // Per-chat scratch: throwaway by definition, and the one member that could
    // turn a small export into a multi-gigabyte one.
    expect(packed.some((p) => p.startsWith('pi-home/exec-workspace'))).toBe(false);
  });

  it('drops the recall server entry, whose every field is a path on this machine', async () => {
    const from = scratch();
    useStateRoot(from);
    populate(from);
    writeFileSync(
      join(from, 'pi-home', 'mcp.json'),
      JSON.stringify({
        servers: {
          'stem-recall': { command: '/Applications/Stem.app/Contents/MacOS/Stem', args: ['/Applications/Stem.app/x.js'] },
          weather: { command: '/opt/homebrew/bin/uvx', args: ['weather-mcp'] }
        }
      })
    );
    const archive = join(scratch(), 'move.tar');
    await exportState({ out: archive, passphrase: PASSPHRASE });

    const to = scratch();
    useStateRoot(to);
    await importState({ archive, passphrase: PASSPHRASE });
    const config = JSON.parse(readFileSync(join(to, 'pi-home', 'mcp.json'), 'utf8')) as { servers: Record<string, unknown> };
    // Rewritten from scratch on the next boot, so carrying an /Applications path
    // into a Linux container buys nothing and reads as a mistake.
    expect(config.servers['stem-recall']).toBeUndefined();
    // The user's own server survives untouched, absolute path and all — that one
    // is a decision only a person can make, and the import says so.
    expect(config.servers.weather).toBeTruthy();
  });

  it('leaves the archive readable only by its owner', async () => {
    const from = scratch();
    useStateRoot(from);
    populate(from);
    const archive = join(scratch(), 'move.tar');
    await exportState({ out: archive, passphrase: PASSPHRASE });
    expect(statSync(archive).mode & 0o777).toBe(0o600);
  });
});

describe('importing into a state root that is not empty', () => {
  it('accepts one a first boot made', async () => {
    const from = scratch();
    useStateRoot(from);
    populate(from);
    const archive = join(scratch(), 'move.tar');
    await exportState({ out: archive, passphrase: PASSPHRASE });

    // Exactly what ensureWorkspace() creates, plus the files a boot writes.
    const to = scratch();
    mkdirSync(join(to, 'pi-home', 'skills'), { recursive: true });
    mkdirSync(join(to, 'workspace', 'files'), { recursive: true });
    mkdirSync(join(to, 'workspace', '.stem-internal'), { recursive: true });
    writeFileSync(join(to, 'devices.json'), JSON.stringify({ devices: [] }));
    writeFileSync(join(to, 'server.json'), '{}');
    writeFileSync(join(to, 'stem.log'), '');
    useStateRoot(to);

    expect(await stateRootObstruction(to)).toBeNull();
    const report = await importState({ archive, passphrase: PASSPHRASE });
    expect(report.files).toBeGreaterThan(5);
    expect(readFileSync(join(to, 'pi-home', 'sessions', 'thread-1', 'turns.jsonl'), 'utf8')).toContain('user');
  });

  it('refuses one with chats in it, and says which chats', async () => {
    const from = scratch();
    useStateRoot(from);
    populate(from);
    const archive = join(scratch(), 'move.tar');
    await exportState({ out: archive, passphrase: PASSPHRASE });

    const to = scratch();
    mkdirSync(join(to, 'pi-home', 'sessions', 'other'), { recursive: true });
    writeFileSync(join(to, 'pi-home', 'sessions', 'other', 'turns.jsonl'), '{}');
    useStateRoot(to);

    expect(await stateRootObstruction(to)).toBe('it already has chats in it');
    await expect(importState({ archive, passphrase: PASSPHRASE })).rejects.toThrow(/already has chats/);
    // And nothing was written on the way to refusing.
    expect(existsSync(join(to, 'folders.json'))).toBe(false);
  });

  it('refuses one that only has folders or skills, which a first boot never has', async () => {
    const withSkills = scratch();
    mkdirSync(join(withSkills, 'pi-home', 'skills', 'mine'), { recursive: true });
    expect(await stateRootObstruction(withSkills)).toBe('it already has skills in it');

    const withFolders = scratch();
    writeFileSync(join(withFolders, 'folders.json'), JSON.stringify({ version: 1, folders: [{ id: 'a' }] }));
    expect(await stateRootObstruction(withFolders)).toBe('it already has chat folders in it');

    // An empty store is not use: Stem writes one the first time anything is saved.
    const empty = scratch();
    writeFileSync(join(empty, 'folders.json'), JSON.stringify({ version: 1, folders: [], assignments: {} }));
    expect(await stateRootObstruction(empty)).toBeNull();
  });

  it('refuses an archive that is not a Stem export', async () => {
    const to = scratch();
    useStateRoot(to);
    const notOurs = join(scratch(), 'random.tar');
    const { writeTar } = await import('../../src/server/workspace/tar');
    await writeTar(notOurs, [
      { path: 'readme.txt', type: 'file', mode: 0o644, mtime: 1, size: 2, source: { data: Buffer.from('hi') } }
    ]);
    await expect(importState({ archive: notOurs, passphrase: PASSPHRASE })).rejects.toThrow(/does not look like a Stem export/);
  });
});

describe('what the import tells you to go and fix', () => {
  it('names the tools and folders that point at a machine this is not', async () => {
    const from = scratch();
    useStateRoot(from);
    populate(from);
    writeFileSync(
      join(from, 'pi-home', 'mcp.json'),
      JSON.stringify({
        servers: {
          weather: { command: '/opt/somewhere-else/bin/uvx', args: ['weather-mcp'] },
          // The other device-shaped kind: a URL only the old machine's network
          // resolves. A datacentre has no route to it and never will.
          'home-assistant': { url: 'http://homeassistant.local:8123/mcp' },
          // And one that is nobody's problem: a public endpoint works from here.
          fastmail: { url: 'https://api.fastmail.com/mcp' }
        }
      })
    );
    writeFileSync(
      join(from, 'connected-folders.json'),
      JSON.stringify({
        folders: [
          { id: 'v', name: 'Personal Obsidian', path: '/Users/someone/Obsidian' },
          // A client folder: its path is a mirror that deliberately does not
          // travel, and its device will re-pair under a new identity — the
          // report has to say "reconnect it from that computer", not "missing".
          {
            id: 'c',
            label: 'work-notes',
            path: '/old/mirrors/c',
            origin: { deviceId: 'mac-1', clientPath: '/Users/someone/work-notes' }
          }
        ]
      })
    );
    const archive = join(scratch(), 'move.tar');
    await exportState({ out: archive, passphrase: PASSPHRASE });

    const to = scratch();
    useStateRoot(to);
    const report = await importState({ archive, passphrase: PASSPHRASE });
    const attention = report.attention.join('\n');
    expect(attention).toContain('/opt/somewhere-else/bin/uvx');
    expect(attention).toContain('homeassistant.local');
    expect(attention).toContain('Personal Obsidian');
    // The client folder gets its own instruction, naming where it really lives.
    expect(attention).toContain('work-notes');
    expect(attention).toContain('On this computer');
    expect(attention).not.toContain('/old/mirrors/c');
    // A public URL is not device-shaped and must not be flagged: a report that
    // lists everything is one nobody reads to the end.
    expect(attention).not.toContain('fastmail');
    // Both MCP entries now have an answer rather than only a diagnosis — pin
    // them to the computer they came from once it is paired (decision ⑩). And
    // neither was repointed here: at import time there is no device to name.
    expect(attention).toMatch(/Move to/);
    expect(report.attention.filter((line) => /Move to/.test(line))).toHaveLength(2);
    // Pairing is always the next step: nothing can reach this server yet.
    expect(attention).toMatch(/stem-server pair/);
    // Provider sign-ins are not machine-bound, so they are reported as carried
    // rather than as something to redo.
    expect(report.reauthorize.join('\n')).toMatch(/anthropic/);
  });

  it('names a bare command this machine cannot resolve, not only an absolute one', async () => {
    const from = scratch();
    useStateRoot(from);
    populate(from);
    writeFileSync(
      join(from, 'pi-home', 'mcp.json'),
      JSON.stringify({
        servers: {
          // What real configs actually say. Checking only absolute paths left
          // the report silent about exactly the entries most likely to die in a
          // container — they fail at the first turn with a bare ENOENT nobody
          // connects back to the move.
          notes: { command: 'definitely-not-installed-anywhere', args: ['--stdio'] },
          // A command every machine running this test has, since it is the one
          // running it: present, so silent.
          runner: { command: process.execPath, args: ['server.js'] }
        }
      })
    );
    const archive = join(scratch(), 'bare.tar');
    await exportState({ out: archive, passphrase: PASSPHRASE });

    const to = scratch();
    useStateRoot(to);
    const attention = (await importState({ archive, passphrase: PASSPHRASE })).attention.join('\n');
    expect(attention).toContain('definitely-not-installed-anywhere');
    expect(attention).not.toContain('"runner"');
  });
});

describe('chats that came from another machine', () => {
  // The bug this pins cost every scheduled run on the server, silently, for
  // days: pi stores the folder a chat ran in and REFUSES to resume one whose
  // folder is gone, so every chat that moved over was listable and unopenable.
  // Nothing caught it because nothing had ever resumed an imported chat.
  it('are pointed at this machine\'s workspace, so they can be opened at all', async () => {
    const from = scratch();
    useStateRoot(from);
    populate(from);
    const oldWorkspace = '/Users/someone/Library/Application Support/Stem/workspace';
    writeFileSync(
      join(from, 'pi-home', 'sessions', 'thread-1', 'turns.jsonl'),
      `${JSON.stringify({ type: 'session', version: 3, id: 'thread-1', cwd: oldWorkspace })}\n` +
        `${JSON.stringify({ type: 'message', message: { role: 'user' } })}\n`
    );
    const archive = join(scratch(), 'move.tar');
    await exportState({ out: archive, passphrase: PASSPHRASE });

    const to = scratch();
    useStateRoot(to);
    await importState({ archive, passphrase: PASSPHRASE });

    const lines = readFileSync(join(to, 'pi-home', 'sessions', 'thread-1', 'turns.jsonl'), 'utf8').split('\n');
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'session', id: 'thread-1', cwd: join(to, 'workspace') });
    // The header is corrected; the conversation under it is untouched.
    expect(JSON.parse(lines[1]!)).toMatchObject({ type: 'message', message: { role: 'user' } });
  });
});

/** One AES-256-GCM value under `keyHex`, in the on-disk format, for the test above. */
function encryptedSample(keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ct = Buffer.concat([cipher.update('Bearer real-token', 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

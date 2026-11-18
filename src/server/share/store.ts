// shares.json: the public links this Stem published, so the user can copy one
// again or revoke it. The link's key is stored encrypted with the same data
// key as MCP credentials (pi/secrets.ts); the relay only ever has the blob.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { degrade } from '../degrade';
import { decryptSecretValue, encryptSecretValue } from '../pi/secrets';
import { replaceFile } from '../replace-file';
import { sharesStorePath } from '../workspace/paths';
import type { ShareOpen, SharedLink } from '../../shared/share';

interface StoredShare extends Omit<SharedLink, 'url'> {
  /** Viewer URL without the fragment. */
  base: string;
  /** Encrypted base64url key. */
  key: string;
  /**
   * A locked link: the recipients whose first opening the user was told
   * about. Kept apart from `opens` so a notice that failed is sent again.
   * Absent on links stored before this: their stored opens count as told.
   */
  notified?: string[];
}

interface FileShape {
  version: 1;
  shares: StoredShare[];
}

function unreadable(err: unknown): Error {
  degrade('share', 'shares.json is unreadable; leaving it as it is', err);
  return new Error('Stem could not read your list of shared links, so it changed nothing. Your links still work.');
}

export class ShareStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: () => string = sharesStorePath) {}

  /**
   * Only a missing file is an empty list. Anything else (unreadable, broken
   * JSON) throws, so no write replaces the file: those links still work on the
   * relay, and this list is the only place they can be revoked from.
   */
  private async readFile(): Promise<FileShape> {
    let raw: string;
    try {
      raw = await readFile(this.path(), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, shares: [] };
      throw unreadable(err);
    }
    let f: Partial<FileShape>;
    try {
      f = JSON.parse(raw) as Partial<FileShape>;
    } catch (err) {
      throw unreadable(err);
    }
    if (!f || !Array.isArray(f.shares)) throw unreadable(new Error('no shares list'));
    return { version: 1, shares: f.shares };
  }

  private async writeFile(f: FileShape): Promise<void> {
    const path = this.path();
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await replaceFile(tmp, path);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    // quiet: the caller awaits `next` and sees the error; the chain only orders writes.
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Live links, newest first; expired ones are dropped on read. */
  async list(now = Date.now()): Promise<SharedLink[]> {
    const f = await this.readFile();
    const out: SharedLink[] = [];
    for (const s of f.shares) {
      if (s.expiresAt && s.expiresAt <= now) continue;
      const key = decryptSecretValue(s.key);
      if (!key) continue;
      out.push({
        id: s.id,
        url: `${s.base}#${key}`,
        source: s.source,
        scope: s.scope,
        kind: s.kind,
        title: s.title,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        size: s.size,
        ...(s.recipients?.length ? { recipients: s.recipients, opens: s.opens ?? [] } : {})
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  add(link: SharedLink): Promise<void> {
    return this.serial(async () => {
      const f = await this.readFile();
      const hash = link.url.indexOf('#');
      const { url, ...rest } = link;
      f.shares.push({ ...rest, base: url.slice(0, hash), key: encryptSecretValue(url.slice(hash + 1)) });
      await this.writeFile(f);
    });
  }

  /** Store the openings the relay reported for a locked link. */
  setOpens(id: string, opens: ShareOpen[]): Promise<void> {
    return this.serial(async () => {
      const f = await this.readFile();
      const s = f.shares.find((x) => x.id === id);
      if (!s) return;
      s.notified ??= (s.opens ?? []).map((o) => o.address);
      s.opens = opens;
      await this.writeFile(f);
    });
  }

  /** The recipients whose first opening was announced (see StoredShare.notified). */
  async notified(id: string): Promise<string[]> {
    const s = (await this.readFile()).shares.find((x) => x.id === id);
    return s ? (s.notified ?? (s.opens ?? []).map((o) => o.address)) : [];
  }

  /** Record that these recipients' first openings were announced. */
  markNotified(id: string, addresses: string[]): Promise<void> {
    return this.serial(async () => {
      const f = await this.readFile();
      const s = f.shares.find((x) => x.id === id);
      if (!s) return;
      const told = s.notified ?? (s.opens ?? []).map((o) => o.address);
      s.notified = [...told, ...addresses.filter((a) => !told.includes(a))];
      await this.writeFile(f);
    });
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const f = await this.readFile();
      const n = f.shares.length;
      f.shares = f.shares.filter((s) => s.id !== id);
      if (f.shares.length !== n) await this.writeFile(f);
    });
  }
}

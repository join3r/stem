// Repairing a chat must not look like using it.
//
// pi refuses to resume a session whose recorded working directory is gone, which
// is every chat carried over by `stem-server import`. Stem rewrites the path so
// the chat opens — and that rewrite is a WRITE, which moves the file's mtime.
// That timestamp is the only record Stem has of when something last happened in
// a chat: the Inbox places rows by it and bolds them by it. So a repair that
// leaves the mtime moved puts an untouched chat back at the top of the Inbox,
// unread, out of the archive, for a turn nobody took — the 0.4.x bug where
// opening an old chat from search made it announce itself as new.
//
// Nothing else pins that, and it is invisible in every assertion about the
// chat's contents, which are exactly right either way.
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptSessionCwds, repairMissingSessionCwd } from '../../src/server/pi/session-cwd';

const root = join(tmpdir(), `stem-session-cwd-${process.pid}`);
const workspace = join(root, 'workspace');
const sessions = join(root, 'sessions');

/** Last touched a fortnight ago — old enough that "now" is unmistakable. */
const OLD = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

function writeSession(name: string, cwd: string): string {
  const file = join(sessions, name);
  writeFileSync(
    file,
    `${JSON.stringify({ type: 'session', cwd })}\n` +
      `${JSON.stringify({ type: 'message', message: { role: 'user', content: 'hello' } })}\n`,
    'utf8'
  );
  utimesSync(file, OLD, OLD);
  return file;
}

const headerOf = (file: string) => JSON.parse(readFileSync(file, 'utf8').split('\n')[0]) as { cwd?: string };
const mtimeOf = (file: string) => statSync(file).mtime.getTime();

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(sessions, { recursive: true });
  mkdirSync(workspace, { recursive: true });
});

describe('repairMissingSessionCwd', () => {
  it('points a carried-over chat at this workspace without touching its timestamp', async () => {
    const file = writeSession('carried-over.jsonl', join(tmpdir(), 'a-mac-that-is-not-here', 'workspace'));

    expect(await repairMissingSessionCwd(file, workspace)).toBe(true);
    expect(headerOf(file).cwd).toBe(workspace);
    // The whole point: the chat opens, and the Inbox still says it last had
    // something happen in it a fortnight ago.
    expect(mtimeOf(file)).toBe(OLD.getTime());
    // And the rest of the file survived the rewrite.
    expect(readFileSync(file, 'utf8')).toContain('"hello"');
  });

  it('leaves a chat whose folder is here alone, timestamp included', async () => {
    const file = writeSession('local.jsonl', workspace);
    expect(await repairMissingSessionCwd(file, workspace)).toBe(false);
    expect(mtimeOf(file)).toBe(OLD.getTime());
  });
});

describe('adoptSessionCwds', () => {
  it('adopts every chat in a moved state root and keeps all their timestamps', async () => {
    const elsewhere = join(tmpdir(), 'a-mac-that-is-not-here', 'workspace');
    const files = ['one.jsonl', 'two.jsonl', 'three.jsonl'].map((n) => writeSession(n, elsewhere));

    expect(await adoptSessionCwds(sessions, workspace)).toBe(3);
    for (const file of files) {
      expect(headerOf(file).cwd).toBe(workspace);
      // An import unpacks thousands of these. Bumping them is the same Inbox bug
      // over every chat at once, which is how it would actually be met.
      expect(mtimeOf(file)).toBe(OLD.getTime());
    }
  });
});

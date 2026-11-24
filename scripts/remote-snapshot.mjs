// Copies the working tree to a test machine with git instead of a full copy,
// for scripts/linux-pc.mjs and scripts/windows-vm.mjs. The machine fetches
// the public `main` from GitHub itself, so only what this checkout adds on top
// (unreleased commits plus uncommitted work) travels over SSH. That matters on
// a slow route, such as through a jump host over a Tailscale relay.
//
// The snapshot is a commit of the working tree (tracked files and untracked
// files that are not ignored), with HEAD as its parent, made through a
// temporary index so the real index and worktree are untouched. Nothing is
// pushed to GitHub: the snapshot goes only to the machine's own bare repo,
// `stem.git` in its home directory, as the branch `snapshot`.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PUBLIC_REPO = 'https://github.com/join3r/stem.git';
export const BARE = 'stem.git';

function git(repo, args, env = {}) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) {
    process.stderr.write(r.stderr);
    process.exit(r.status ?? 1);
  }
  return r.stdout.trim();
}

// Same tree and HEAD give the same commit, so an unchanged checkout pushes
// nothing.
export function snapshot(repo) {
  const tmp = mkdtempSync(join(tmpdir(), 'stem-snap-'));
  const index = { GIT_INDEX_FILE: join(tmp, 'index') };
  try {
    git(repo, ['read-tree', 'HEAD'], index);
    git(repo, ['add', '-A'], index);
    const tree = git(repo, ['write-tree'], index);
    const when = git(repo, ['log', '-1', '--format=%cI', 'HEAD']);
    const who = { GIT_AUTHOR_NAME: 'stem-snapshot', GIT_AUTHOR_EMAIL: 'snapshot@localhost', GIT_COMMITTER_NAME: 'stem-snapshot', GIT_COMMITTER_EMAIL: 'snapshot@localhost', GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
    const sha = git(repo, ['commit-tree', tree, '-p', 'HEAD', '-m', 'working tree snapshot'], who);
    // Keeps the pushed objects alive locally, so the next push can send only
    // the difference from it.
    git(repo, ['update-ref', 'refs/worktree/stem-snapshot', sha]);
    return sha;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// `sshCommand` is a shell string for GIT_SSH_COMMAND; `remote` is an
// ssh://… URL. Windows' OpenSSH runs commands in PowerShell, where
// git-receive-pack is not on PATH, hence `git receive-pack`.
export function push(repo, sha, { sshCommand, remote }) {
  const r = spawnSync('git', ['push', '-q', '--force', '--receive-pack=git receive-pack', remote, `${sha}:refs/heads/snapshot`], {
    cwd: repo, stdio: 'inherit', env: { ...process.env, GIT_SSH_COMMAND: sshCommand }
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

export const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

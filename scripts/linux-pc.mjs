#!/usr/bin/env node
// Run Stem on a real Linux PC over SSH: the working tree is copied over with
// git (scripts/remote-snapshot.mjs), so uncommitted work is what gets tested,
// the way scripts/linux-test.mjs does it with a container. The PC needs Node 24, git and GNOME (mutter); the host
// comes from STEM_LINUX_HOST, e.g. `STEM_LINUX_HOST=join3r@192.168.1.164`, and
// STEM_LINUX_JUMP=infra reaches it through a jump host when away from home.
//
//   node scripts/linux-pc.mjs test [vitest args]        unit tests
//   node scripts/linux-pc.mjs e2e [playwright args]     the E2E suite on a headless Wayland desktop
//   node scripts/linux-pc.mjs desktop                   Stem on that headless desktop, a fresh profile;
//                                                       its DevTools port is forwarded to localhost:9333
//   node scripts/linux-pc.mjs screen                    Stem on the PC's own screen, DevTools on localhost:9334
//   node scripts/linux-pc.mjs gnome-e2e [playwright args] E2E specs inside a private headless GNOME Shell with
//                                                       Stem's extension loaded (computer control, e.g.
//                                                       STEM_E2E_COMPUTER_APP=zenity tests/e2e/computer-live.spec.ts)
//   node scripts/linux-pc.mjs gnome-sh '<command>'       one command in that GNOME session
//   node scripts/linux-pc.mjs shell                     a shell in the copy
//   node scripts/linux-pc.mjs sh '<command>'            one command in the copy
//   node scripts/linux-pc.mjs sync                      only copy and install
//
// The headless desktop is a private mutter with its own D-Bus session, so
// nothing appears on the PC's screen and the person at it is not disturbed. It
// is real Wayland on the real GPU, unlike the container's Xvfb.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BARE, PUBLIC_REPO, push, shQuote, snapshot } from './remote-snapshot.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.STEM_LINUX_HOST;
if (!host) {
  console.error('linux-pc: set STEM_LINUX_HOST, e.g. STEM_LINUX_HOST=join3r@192.168.1.164');
  process.exit(2);
}
const DIR = 'stem';
// STEM_LINUX_JUMP: optional jump host(s) for ssh -J, e.g. `infra` when away
// from the PC's network (comma-separate a chain).
const jump = process.env.STEM_LINUX_JUMP;
const SSH = ['-o', 'BatchMode=yes', '-o', 'VisualHostKey=no', ...(jump ? ['-J', jump] : [])];
const [mode = 'test', ...rest] = process.argv.slice(2);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The PC fetches the public main from GitHub; only this checkout's own
// commits and uncommitted work go over SSH (scripts/remote-snapshot.mjs).
// node_modules, dist and out are ignored by git, so they stay the PC's own
// (Linux native modules), never the Mac's.
run('ssh', [...SSH, host, `bash -c ${quote(`test -d ~/${BARE} || git init -q --bare ~/${BARE}
git -C ~/${BARE} fetch -q ${PUBLIC_REPO} +refs/heads/main:refs/heads/main || echo "linux-pc: could not fetch main from GitHub; sending everything"`)}`]);
push(repo, snapshot(repo), { sshCommand: ['ssh', ...SSH].map(shQuote).join(' '), remote: `${host}:${BARE}` });

// Runs on the PC. `headless` starts a private mutter on a virtual monitor and
// points Wayland apps at it; the trap takes it down with the session.
const prelude = `
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH" XDG_RUNTIME_DIR=/run/user/$(id -u)
mkdir -p ~/${DIR}
cd ~/${DIR}
[ -d .git ] || git init -q
git fetch -q ~/${BARE} snapshot
git reset -q --hard FETCH_HEAD
git clean -fdq
want=$(sha256sum package-lock.json | cut -d' ' -f1)
if [ "$(cat node_modules/.stem-lock 2>/dev/null)" != "$want" ]; then
  echo "linux-pc: npm ci (lockfile changed)"
  npm ci --no-audit --no-fund
  echo "$want" > node_modules/.stem-lock
fi
headless() {
  local name=stem-pc-$$
  mutter --headless --wayland --no-x11 --virtual-monitor 1440x900 --wayland-display=$name >/tmp/$name.log 2>&1 &
  local pid=$!
  trap "kill $pid 2>/dev/null" EXIT
  for _ in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/$name" ] && break; sleep 0.1; done
  export WAYLAND_DISPLAY=$name XDG_SESSION_TYPE=wayland
  unset DISPLAY
}
export -f headless
# The private D-Bus session chatters on stderr; it goes to a log and the
# command's own stderr comes back through fd 3.
exec 3>&2
`;
const args = rest.map(quote).join(' ');
const body = {
  sync: 'true',
  test: `exec npx vitest run ${args}`,
  e2e: `exec dbus-run-session -- bash -c ${quote(`exec 2>&3; headless; npx playwright test ${args}`)} 2>/tmp/stem-pc-dbus.log`,
  desktop: `npx electron-vite build >/tmp/stem-pc-build.log
echo "linux-pc: Stem on a headless Wayland desktop; DevTools at localhost:9333"
exec dbus-run-session -- bash -c ${quote('exec 2>&3; headless; npx electron . --fresh --remote-debugging-port=9333')} 2>/tmp/stem-pc-dbus.log`,
  screen: `npx electron-vite build >/tmp/stem-pc-build.log
export WAYLAND_DISPLAY=wayland-0 XDG_SESSION_TYPE=wayland DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
echo "linux-pc: Stem on the PC's screen; DevTools at localhost:9334"
exec npx electron . --fresh --remote-debugging-port=9334`,
  // A private GNOME Shell (scripts/gnome-headless.sh), never the person's session.
  'gnome-e2e': `exec ./scripts/gnome-headless.sh bash -c ${quote(`exec 2>&3; ${process.env.STEM_E2E_COMPUTER_APP ? `export STEM_E2E_COMPUTER_APP=${quote(process.env.STEM_E2E_COMPUTER_APP)};` : ''} npx playwright test ${args}`)} 2>/tmp/stem-pc-gnome.log`,
  'gnome-sh': `exec ./scripts/gnome-headless.sh bash -c ${quote(rest.join(' '))}`,
  shell: 'exec bash -l',
  sh: rest.join(' ')
}[mode];
if (!body) {
  console.error('usage: linux-pc.mjs test|e2e|desktop|screen|gnome-e2e|gnome-sh|shell|sync|sh [args]');
  process.exit(2);
}

const forward = { desktop: ['-L', '9333:localhost:9333'], screen: ['-L', '9334:localhost:9334'] }[mode] ?? [];
const tty = mode === 'shell' && process.stdin.isTTY ? ['-t'] : [];
run('ssh', [...SSH, ...tty, ...forward, host, `bash -c ${quote(prelude + body)}`]);

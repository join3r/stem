// Drives a built stem-computer helper in record mode, by hand, from a terminal
// that has Accessibility, Input Monitoring and (for pictures) Screen Recording:
// prints every step, every changed window text (first lines) and every picture
// as you click and type around the Mac. Ctrl+C (or the duration) stops it.
//
//   node scripts/build-mac-helper.mjs --host-arch --output /tmp/stem-computer
//   node scripts/smoke-recorder.mjs /tmp/stem-computer [seconds]
//
// Things to try: a click in Mail's message list, typing into a web form in
// Arc (the step should carry the page URL), a password field (value must read
// [password]), ⌘C in one app and ⌘V in another.
//
// Nothing here runs in CI: it needs the grants and a screen.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [helperPath, seconds = '60'] = process.argv.slice(2);
if (!helperPath) {
  console.error('usage: node scripts/smoke-recorder.mjs <path-to-stem-computer> [seconds]');
  process.exit(1);
}

const shotsDir = mkdtempSync(join(tmpdir(), 'stem-rec-'));
const helper = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, STEM_COMPUTER_TRACE: '1' } });
const waiting = new Map();
let nextId = 1;
createInterface({ input: helper.stdout }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.event === 'rec-step') {
    const { kind, t, app, window: win, url, ...rest } = msg.step;
    console.log(`${String(t).padStart(6)}ms  ${kind.padEnd(6)} ${app} · ${win || '—'}${url ? ` · ${url}` : ''}\n          ${JSON.stringify(rest)}`);
  } else if (msg.event === 'rec-seen') {
    const lines = msg.seen.text.split('\n');
    console.log(`${String(msg.seen.t).padStart(6)}ms  seen   ${msg.seen.app} · ${msg.seen.window} (${msg.seen.text.length} chars)\n          ${lines.slice(0, 4).join(' | ')}`);
  } else if (msg.event === 'rec-shot') {
    console.log(`${String(msg.shot.t).padStart(6)}ms  shot   ${msg.shot.path}`);
  } else if (msg.event) {
    console.log('event', msg);
  } else {
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  }
});

function call(cmd, fields = {}) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    helper.stdin.write(JSON.stringify({ ...fields, id, cmd }) + '\n');
  });
}

console.log('status', (await call('status')).status);
const started = await call('record-start', { shotsDir });
if (!started.ok) {
  console.error('could not start:', started.error);
  process.exit(1);
}
console.log(`recording for ${seconds}s — pictures in ${shotsDir}`);

const finish = async () => {
  await call('record-stop');
  await call('stop').catch(() => {});
  process.exit(0);
};
process.on('SIGINT', finish);
setTimeout(finish, Number(seconds) * 1000);

// Throwaway probe: confirm the thread persistence RPCs (thread/list, thread/read,
// thread/resume) on this Codex version, against the dev app's real CODEX_HOME so
// we see actually-persisted threads and can check the cwd filter behavior.
//
// Usage: node scripts/probe-threads.mjs
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';

// Dev build userData = ~/Library/Application Support/stem (see memory notes).
const userData = process.env.STEM_USERDATA || join(homedir(), 'Library', 'Application Support', 'stem');
const codexHome = join(userData, 'codex-home');
const workspaceRoot = join(userData, 'workspace');
let workspaceReal = workspaceRoot;
try { workspaceReal = realpathSync(workspaceRoot); } catch {}

console.log('CODEX_HOME      =', codexHome);
console.log('workspaceRoot   =', workspaceRoot);
console.log('workspace(real) =', workspaceReal);

const codex = process.env.CODEX_BIN || 'codex';
const env = { ...process.env, CODEX_HOME: codexHome };
delete env.OPENAI_API_KEY;
delete env.OPENAI_BASE_URL;
const proc = spawn(codex, ['app-server'], { cwd: workspaceRoot, stdio: ['pipe', 'pipe', 'pipe'], env });

let nextId = 1;
const pending = new Map();
function request(method, params) {
  const id = nextId++;
  pending.set(id, method);
  proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  return id;
}
function notify(method, params) {
  proc.stdin.write(JSON.stringify({ method, params }) + '\n');
}

let step = 'list';
let firstThreadId = null;

const rl = createInterface({ input: proc.stdout });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (typeof msg.id !== 'number' || (!msg.result && !msg.error)) return;
  const method = pending.get(msg.id);
  pending.delete(msg.id);

  if (msg.error) { console.log(`ERROR from ${method}:`, JSON.stringify(msg.error)); }

  if (method === 'thread/list') {
    const r = msg.result ?? {};
    const data = r.data ?? r.threads ?? [];
    console.log(`\n=== thread/list (${step}) -> ${data.length} threads; keys:`, Object.keys(r), '===');
    for (const t of data.slice(0, 5)) {
      console.log('  -', JSON.stringify({ id: t.id, name: t.name, preview: (t.preview || '').slice(0, 40), cwd: t.cwd, createdAt: t.createdAt, updatedAt: t.updatedAt, source: t.source }));
    }
    if (step === 'list') {
      // Now try an UNFILTERED list to compare counts (detects cwd-filter misses).
      step = 'list-all';
      firstThreadId = data[0]?.id ?? firstThreadId;
      request('thread/list', { limit: 10, sortKey: 'updated_at', sortDirection: 'desc' });
    } else if (step === 'list-all') {
      firstThreadId = firstThreadId ?? data[0]?.id;
      if (firstThreadId) {
        step = 'read';
        request('thread/read', { threadId: firstThreadId, includeTurns: true });
      } else {
        console.log('\nNo threads to read/resume. Done.');
        proc.kill(); process.exit(0);
      }
    }
    return;
  }

  if (method === 'thread/read') {
    const t = msg.result?.thread ?? {};
    const turns = t.turns ?? [];
    console.log(`\n=== thread/read -> ${turns.length} turns ===`);
    const turn = turns[0] ?? {};
    console.log('  turn keys:', Object.keys(turn));
    const items = turn.items ?? turn.thread?.items ?? [];
    console.log('  turn[0].items count:', items.length);
    for (const it of items.slice(0, 6)) {
      console.log('    item:', JSON.stringify({ type: it.type, id: it.id, text: typeof it.text === 'string' ? it.text.slice(0, 40) : undefined, content: it.content }).slice(0, 200));
    }
    step = 'resume';
    request('thread/resume', { threadId: firstThreadId, cwd: workspaceRoot });
    return;
  }

  if (method === 'thread/resume') {
    console.log('\n=== thread/resume ->', msg.error ? 'ERROR' : 'OK', '; result keys:', Object.keys(msg.result ?? {}), '===');
    console.log('\nProbe complete.');
    proc.kill(); process.exit(0);
  }
});

proc.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));
proc.on('exit', (c) => { console.log('app-server exited', c); process.exit(0); });

request('initialize', { clientInfo: { name: 'stem_probe', title: 'Stem Probe', version: '0.0.0' }, capabilities: { experimentalApi: true } });
notify('initialized', {});
setTimeout(() => {
  // Filtered by cwd ONLY (source=vscode means sourceKinds:['appServer'] excludes them).
  request('thread/list', { cwd: workspaceRoot, sortKey: 'updated_at', sortDirection: 'desc', limit: 10 });
}, 400);
setTimeout(() => { console.log('\n[timeout]'); proc.kill(); process.exit(1); }, 30000);

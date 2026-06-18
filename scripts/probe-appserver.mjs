// Throwaway probe: spawn `codex app-server`, run a full handshake + one turn,
// and log every raw JSON-RPC line to confirm method/event names on this Codex version.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const codex = process.env.CODEX_BIN || 'codex';
const proc = spawn(codex, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });

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

const seenMethods = new Set();
let threadId = null;
let turnSent = false;

const rl = createInterface({ input: proc.stdout });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { console.log('NON-JSON:', line); return; }

  if (typeof msg.id === 'number' && (msg.result || msg.error)) {
    const method = pending.get(msg.id);
    pending.delete(msg.id);
    console.log(`RESPONSE to ${method}:`, JSON.stringify(msg.result ?? msg.error).slice(0, 400));
    if (method === 'thread/start') {
      threadId = msg.result?.thread?.id ?? msg.result?.threadId ?? msg.result?.id;
      console.log('  -> threadId =', threadId);
      if (threadId && !turnSent) {
        turnSent = true;
        request('turn/start', { threadId, cwd: process.cwd(), input: [{ type: 'text', text: 'Say hi in 3 words.' }] });
      }
    }
    return;
  }

  if (msg.method) {
    if (!seenMethods.has(msg.method)) {
      seenMethods.add(msg.method);
      console.log(`EVENT(first) ${msg.method}:`, JSON.stringify(msg.params).slice(0, 300));
    }
    if (msg.method.includes('completed') && msg.method.includes('turn')) {
      console.log('\n=== ALL EVENT METHODS SEEN ===');
      for (const m of seenMethods) console.log(' ', m);
      proc.kill();
      process.exit(0);
    }
  }
});

proc.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));
proc.on('exit', (c) => { console.log('app-server exited', c); process.exit(0); });

request('initialize', { clientInfo: { name: 'stem_probe', title: 'Stem Probe', version: '0.0.0' }, capabilities: { experimentalApi: true } });
notify('initialized', {});
setTimeout(() => { request('thread/start', { cwd: process.cwd() }); }, 300);
setTimeout(() => { console.log('\n[timeout] methods seen so far:', [...seenMethods]); proc.kill(); process.exit(0); }, 30000);

// Dump the FULL structure of item/* events for an agentMessage turn, so we know
// exactly where the final assistant text lives.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const proc = spawn(process.env.CODEX_BIN || 'codex', ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
let nextId = 1;
const pending = new Map();
const req = (method, params) => { const id = nextId++; pending.set(id, method); proc.stdin.write(JSON.stringify({ id, method, params }) + '\n'); };
const notify = (method, params) => proc.stdin.write(JSON.stringify({ method, params }) + '\n');

let threadId = null, turnSent = false;
const rl = createInterface({ input: proc.stdout });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (typeof m.id === 'number' && (m.result || m.error)) {
    const method = pending.get(m.id); pending.delete(m.id);
    if (method === 'thread/start') {
      threadId = m.result?.thread?.id;
      if (threadId && !turnSent) { turnSent = true; req('turn/start', { threadId, cwd: process.cwd(), input: [{ type: 'text', text: 'Say hi in exactly 3 words.' }] }); }
    }
    return;
  }
  if (m.method && m.method.startsWith('item/')) {
    console.log(`\n### ${m.method}`);
    console.log(JSON.stringify(m.params, null, 2));
  }
  if (m.method === 'turn/completed') { console.log('\n[turn/completed]'); proc.kill(); process.exit(0); }
});
proc.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));
req('initialize', { clientInfo: { name: 'probe', title: 'probe', version: '0' }, capabilities: { experimentalApi: true } });
notify('initialized', {});
setTimeout(() => req('thread/start', { cwd: process.cwd() }), 300);
setTimeout(() => { proc.kill(); process.exit(0); }, 30000);

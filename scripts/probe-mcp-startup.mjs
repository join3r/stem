// Throwaway probe: spawn `codex app-server` against Stem's real CODEX_HOME and
// watch MCP startup-status notifications to see which servers actually connect
// (and why fastmail might expose no tools). Prints startupStatus events + the
// list-tools result, then exits.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const codex = process.env.CODEX_BIN || 'codex';
const CH = process.env.CODEX_HOME;
const proc = spawn(codex, ['app-server'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CODEX_HOME: CH }
});

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

const rl = createInterface({ input: proc.stdout });
let threadId = null;

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // server->client request: auto-accept any elicitation so nothing blocks
  if (typeof msg.id !== 'undefined' && msg.method) {
    if (msg.method.includes('elicitation') || msg.method.includes('Approval') || msg.method.includes('approval')) {
      proc.stdin.write(JSON.stringify({ id: msg.id, result: { action: 'accept', decision: 'approved' } }) + '\n');
    }
    return;
  }

  if (typeof msg.id === 'number' && (msg.result || msg.error)) {
    const method = pending.get(msg.id);
    pending.delete(msg.id);
    if (method === 'initialize') {
      notify('initialized', {});
      request('thread/start', { cwd: process.env.WS || process.cwd() });
    } else if (method === 'thread/start') {
      threadId = msg.result?.thread?.id ?? msg.result?.threadId ?? msg.result?.id;
      console.log('thread:', threadId);
    } else {
      console.log(`RESP ${method}:`, JSON.stringify(msg.result ?? msg.error).slice(0, 1200));
    }
    return;
  }

  // notifications
  if (msg.method && msg.method.toLowerCase().includes('mcp')) {
    console.log('EVENT', msg.method, JSON.stringify(msg.params).slice(0, 600));
  }
});

proc.stderr.on('data', (d) => {
  const s = d.toString();
  if (/mcp|fastmail|oauth|token|tool/i.test(s)) process.stdout.write('STDERR ' + s);
});

request('initialize', { clientInfo: { name: 'probe', version: '0' }, capabilities: {} });

// Startup-status notifications fire shortly after thread/start; give them time
// to settle (a failed remote OAuth server reports within a few seconds), then exit.
setTimeout(() => { console.log('--- done ---'); proc.kill(); process.exit(0); }, 10000);

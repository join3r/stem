// Probe: does codex app-server actually inject `additionalContext` into the
// model's prompt, and under which `kind`? We inject a unique passphrase per kind
// and ask the model to echo it. If the reply contains the passphrase, that kind
// is delivered to the model. Runs against an ISOLATED copy of codex-home so it
// can't disturb the running app. Plain node (codex is an external binary).
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const CODEX = process.env.CODEX_BIN || '/Users/join3r/.local/bin/codex';
const CODEX_HOME = process.env.PROBE_CODEX_HOME || '/tmp/probe-codex-home';
const CWD = process.env.PROBE_CWD || '/tmp/probe-workspace';

const env = { ...process.env, CODEX_HOME };
delete env.OPENAI_API_KEY;
delete env.OPENAI_BASE_URL;

const proc = spawn(CODEX, ['app-server'], { cwd: CWD, env, stdio: ['pipe', 'pipe', 'pipe'] });
proc.stderr.on('data', (b) => {
  const s = b.toString();
  if (/error|panic|warn/i.test(s)) process.stderr.write(`[stderr] ${s}`);
});

let nextId = 1;
const pending = new Map();
const listeners = new Set();
const rl = createInterface({ input: proc.stdout });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  // server->client request (approvals etc.): auto-decline so nothing blocks
  if (typeof m.id !== 'undefined' && typeof m.method === 'string') {
    const r = { jsonrpc: '2.0', id: m.id };
    if (/requestApproval|Approval/.test(m.method)) r.result = { decision: 'decline' };
    else if (m.method === 'item/tool/call') r.result = { success: false, contentItems: [] };
    else r.result = {};
    proc.stdin.write(JSON.stringify(r) + '\n');
    return;
  }
  if (typeof m.id === 'number' && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message || 'rpc error'));
    else p.resolve(m.result);
    return;
  }
  if (typeof m.method === 'string') for (const fn of listeners) fn(m);
});

function request(method, params) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, 180000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
  });
}
function notify(method, params) { proc.stdin.write(JSON.stringify({ method, params }) + '\n'); }

function agentMessageText(item) {
  if (!item) return '';
  if (typeof item.text === 'string') return item.text;
  if (Array.isArray(item.content)) return item.content.map((c) => c.text || '').join('');
  return '';
}

// Run one turn injecting `value` under `kind`, with a question. Returns reply text.
function runTurn(threadId, value, kind, question) {
  let text = '';
  return new Promise(async (resolve, reject) => {
    const onEvent = (m) => {
      const p = m.params || {};
      if (p.threadId !== threadId) return;
      if (m.method === 'item/completed' && p.item?.type === 'agentMessage') text = agentMessageText(p.item) || text;
      else if (m.method === 'turn/completed') { listeners.delete(onEvent); resolve(text); }
      else if (m.method === 'turn/failed' || m.method === 'turn/aborted') { listeners.delete(onEvent); reject(new Error(m.method)); }
    };
    listeners.add(onEvent);
    const params = {
      threadId,
      cwd: CWD,
      input: [{ type: 'text', text: question }],
      effort: 'low'
    };
    if (kind !== null) params.additionalContext = { 'stem-recall': { value, kind } };
    else {
      // control: put the secret directly in the user message instead
      params.input = [{ type: 'text', text: `${value}\n\n${question}` }];
    }
    try { await request('turn/start', params); } catch (e) { listeners.delete(onEvent); reject(e); }
  });
}

async function newThread() {
  const r = await request('thread/start', { cwd: CWD });
  return r?.thread?.id;
}

const QUESTION = 'What is the user secret passphrase? Reply with ONLY the passphrase, nothing else.';
const CASES = [
  { kind: 'application', pass: 'ALPHA-APP-7731' },
  { kind: 'developer', pass: 'BETA-DEV-4412' },
  { kind: null, pass: 'GAMMA-CONTROL-9920' } // control: secret in user message
];

(async () => {
  await request('initialize', { clientInfo: { name: 'probe', title: 'probe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  notify('initialized', {});
  for (const c of CASES) {
    const tid = await newThread();
    const value = `The user secret passphrase is ${c.pass}.`;
    let reply = '';
    try {
      reply = await runTurn(tid, value, c.kind, QUESTION);
    } catch (e) { reply = `<error: ${e.message}>`; }
    const hit = reply.includes(c.pass);
    const label = c.kind === null ? 'control(user-msg)' : `kind='${c.kind}'`;
    console.log(`\n### ${label}  -> ${hit ? 'DELIVERED ✅' : 'NOT delivered ❌'}`);
    console.log(`   expected: ${c.pass}`);
    console.log(`   reply: ${reply.slice(0, 200).replace(/\n/g, ' ')}`);
    await request('thread/delete', { threadId: tid }).catch(() => {});
  }
  proc.kill('SIGTERM');
  process.exit(0);
})().catch((e) => { console.error('PROBE FAILED:', e.message); proc.kill('SIGTERM'); process.exit(1); });

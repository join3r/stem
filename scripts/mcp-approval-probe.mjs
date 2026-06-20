// Probe: why is the stem-recall MCP tool call rejected, and how to approve it?
// Registers the real stem-recall MCP server (pointed at a copy of the live DB
// that HAS the health data), forces the model to call search_past_chats, logs the
// EXACT server->client approval request codex sends, and tries to approve it.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';

const CODEX = '/Users/join3r/.local/bin/codex';
const HOME = '/tmp/mcp-approval-home';
const CWD = '/tmp/mcp-approval-ws';
const DB = '/tmp/recall_copy.sqlite';
const ELECTRON = '/Users/join3r/local/vibe/stem2/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';
const MCP = '/Users/join3r/local/vibe/stem2/src/main/recall/mcp-server.mjs';
const APPROVE_DECISION = process.env.APPROVE || 'approved'; // try different values

rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(CWD, { recursive: true });
copyFileSync('/Users/join3r/Library/Application Support/stem/codex-home/auth.json', `${HOME}/auth.json`);
writeFileSync(`${HOME}/config.toml`, `forced_login_method = "chatgpt"

[features]
memories = false

[mcp_servers.stem-recall]
command = "${ELECTRON}"
args = ["${MCP}"]
  [mcp_servers.stem-recall.env]
  ELECTRON_RUN_AS_NODE = "1"
  STEM_RECALL_DB = "${DB}"
`);

const env = { ...process.env, CODEX_HOME: HOME };
delete env.OPENAI_API_KEY; delete env.OPENAI_BASE_URL;
const proc = spawn(CODEX, ['app-server'], { cwd: CWD, env, stdio: ['pipe', 'pipe', 'pipe'] });
proc.stderr.on('data', (b) => { const s = b.toString(); if (/error|panic/i.test(s)) process.stderr.write(`[stderr] ${s}`); });

let nextId = 1; const pending = new Map(); const listeners = new Set();
createInterface({ input: proc.stdout }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (typeof m.id !== 'undefined' && typeof m.method === 'string') {
    // SERVER -> CLIENT request: log it verbatim, then respond
    console.log(`\n>>> SERVER REQUEST: ${m.method}`);
    console.log(`    params: ${JSON.stringify(m.params)?.slice(0, 400)}`);
    let result;
    if (m.method === 'mcpServer/elicitation/request') { result = { action: APPROVE_DECISION, content: null, _meta: null }; console.log(`    -> responding action='${APPROVE_DECISION}'`); }
    else if (/[Aa]pproval/.test(m.method)) { result = { decision: APPROVE_DECISION }; console.log(`    -> responding decision='${APPROVE_DECISION}'`); }
    else if (m.method === 'item/tool/call') result = { success: false, contentItems: [] };
    else result = {};
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
    return;
  }
  if (typeof m.id === 'number' && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
  if (typeof m.method === 'string') for (const fn of listeners) fn(m);
});
function request(method, params) { const id = nextId++; proc.stdin.write(JSON.stringify({ id, method, params }) + '\n'); return new Promise((res, rej) => { const t = setTimeout(() => { pending.delete(id); rej(new Error(`timeout ${method}`)); }, 180000); pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } }); }); }
function notify(method, params) { proc.stdin.write(JSON.stringify({ method, params }) + '\n'); }

(async () => {
  await request('initialize', { clientInfo: { name: 'probe', title: 'probe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  notify('initialized', {});
  const t = await request('thread/start', { cwd: CWD });
  const tid = t?.thread?.id;
  let toolOutput = null, agent = '';
  const onEvent = (m) => {
    const p = m.params || {};
    if (p.threadId && p.threadId !== tid) return;
    if (m.method === 'item/completed' && p.item?.type === 'agentMessage') agent = p.item.text || agent;
    if (m.params?.type === 'mcp_tool_call_end' || /mcp/i.test(JSON.stringify(p)) && p.output) {}
    if (m.method === 'item/completed' && p.item?.type === 'mcpToolCall') {
      toolOutput = JSON.stringify(p.item).slice(0, 300);
      console.log(`\n=== mcpToolCall completed: ${toolOutput}`);
    }
  };
  const done = new Promise((resolve, reject) => {
    const w = (m) => {
      const p = m.params || {};
      if (p.threadId && p.threadId !== tid) return;
      if (m.method === 'turn/completed') { listeners.delete(w); resolve(); }
      else if (m.method === 'turn/failed' || m.method === 'turn/aborted') { listeners.delete(w); reject(new Error(m.method)); }
    };
    listeners.add(w);
    setTimeout(() => { listeners.delete(w); reject(new Error('turn timeout')); }, 170000);
  });
  listeners.add(onEvent);
  console.log(`\n--- starting turn (APPROVE='${APPROVE_DECISION}') ---`);
  await request('turn/start', {
    threadId: tid, cwd: CWD, effort: 'low',
    input: [{ type: 'text', text: 'Call the search_past_chats tool with query "zdravotny stav spina bifida" and tell me what it returns. You MUST call the tool.' }]
  });
  try { await done; } catch (e) { console.log(`(turn ended: ${e.message})`); }
  console.log(`\n=== FINAL agent message ===\n${agent.slice(0, 500)}`);
  proc.kill('SIGTERM'); process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); proc.kill('SIGTERM'); process.exit(1); });

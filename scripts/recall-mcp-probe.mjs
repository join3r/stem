// Drives the Stem Recall MCP server over stdio to verify the protocol handshake
// and a real search_past_chats call. Seeds a throwaway DB via the compiled store,
// then spawns the server exactly as codex would (Electron-as-node).
//
// Run (after compiling modules into .recall-build — see recall-verify.mjs header):
//   STEM_RECALL_DB="$PWD/.recall-build/mcp.sqlite" ELECTRON_RUN_AS_NODE=1 \
//     ./node_modules/.bin/electron scripts/recall-mcp-probe.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { rmSync } from 'node:fs';

const require = createRequire(import.meta.url);
const store = require(fileURLToPath(new URL('../.recall-build/main/recall/store.js', import.meta.url)));
const serverPath = fileURLToPath(new URL('../src/main/recall/mcp-server.mjs', import.meta.url));

const dbPath = process.env.STEM_RECALL_DB;
if (!dbPath) {
  console.log('FAIL: set STEM_RECALL_DB');
  process.exit(1);
}
for (const suffix of ['', '-wal', '-shm']) {
  try {
    rmSync(`${dbPath}${suffix}`, { force: true });
  } catch {}
}

store.recordMessage({
  threadId: 'A',
  turnId: 't1',
  role: 'assistant',
  text: 'Your UZ Gent cardiology appointment is on June 30; Dr. Janssens flagged elevated cholesterol.'
});
store.recordMessage({ threadId: 'B', role: 'user', text: 'unrelated chat about pizza recipes' });
store.closeForTest();

const electron = process.execPath;
const child = spawn(electron, [serverPath], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', STEM_RECALL_DB: dbPath },
  stdio: ['pipe', 'pipe', 'pipe']
});

let failures = 0;
const responses = new Map();
const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  if (msg.id !== undefined) responses.set(msg.id, msg);
});

function send(obj) {
  child.stdin.write(`${JSON.stringify(obj)}\n`);
}

function waitFor(id, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (responses.has(id)) return resolve(responses.get(id));
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for id ${id}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

function check(name, cond) {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!cond) failures += 1;
}

try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  const init = await waitFor(1);
  check('initialize returns serverInfo', init.result?.serverInfo?.name === 'stem-recall');
  check('initialize advertises tools capability', !!init.result?.capabilities?.tools);

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = await waitFor(2);
  check('tools/list includes search_past_chats', list.result?.tools?.some((t) => t.name === 'search_past_chats'));

  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'search_past_chats', arguments: { query: 'UZ Gent cardiology appointment', limit: 5 } }
  });
  const call = await waitFor(3);
  const text = call.result?.content?.[0]?.text ?? '';
  check('tools/call returns the health snippet', /UZ Gent/.test(text));
  check('tools/call excludes unrelated content', !/pizza/.test(text));
} catch (e) {
  console.log('FAIL:', e.message);
  failures += 1;
} finally {
  child.kill();
}

console.log(failures === 0 ? '\nALL_PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

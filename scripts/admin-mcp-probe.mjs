// Drives the Stem Admin MCP server over stdio to verify the protocol handshake
// and the self-management tools (list/add/remove) against a throwaway config.toml.
// Spawns the server exactly as codex would (Electron-as-node).
//
// Run:
//   STEM_CODEX_CONFIG="$(mktemp -d)/config.toml" ELECTRON_RUN_AS_NODE=1 \
//     ./node_modules/.bin/electron scripts/admin-mcp-probe.mjs
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const serverPath = fileURLToPath(new URL('../src/main/admin/mcp-server.mjs', import.meta.url));
const configPath = process.env.STEM_CODEX_CONFIG;
if (!configPath) {
  console.log('FAIL: set STEM_CODEX_CONFIG');
  process.exit(1);
}
// Seed a config that already has a reserved server, to prove it's hidden from list.
try {
  rmSync(configPath, { force: true });
} catch {}
writeFileSync(
  configPath,
  'forced_login_method = "chatgpt"\n\n[mcp_servers.stem-recall]\ncommand = "node"\nargs = ["x.mjs"]\n',
  'utf8'
);

const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', STEM_CODEX_CONFIG: configPath },
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
function textOf(msg) {
  return msg.result?.content?.[0]?.text ?? '';
}

try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  const init = await waitFor(1);
  check('initialize returns serverInfo', init.result?.serverInfo?.name === 'stem-admin');

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = await waitFor(2);
  const toolNames = (list.result?.tools ?? []).map((t) => t.name);
  check('tools/list has all three tools', ['list_mcp_servers', 'add_mcp_server', 'remove_mcp_server'].every((n) => toolNames.includes(n)));

  // Add a stdio server with env.
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'add_mcp_server',
      arguments: {
        name: 'homeassistant',
        transport: 'stdio',
        command: 'uvx',
        args: ['ha-mcp@latest'],
        env: { HOMEASSISTANT_URL: 'http://homeassistant.local:8123/', HOMEASSISTANT_TOKEN: 'secret' }
      }
    }
  });
  check('add_mcp_server succeeds', /Added MCP server/.test(textOf(await waitFor(3))));

  // Confirm it was written to config.toml with command/args/env.
  const written = readFileSync(configPath, 'utf8');
  check('config has [mcp_servers.homeassistant]', /\[mcp_servers\.homeassistant\]/.test(written));
  check('config has the command', /command = "uvx"/.test(written));
  check('config has the env token', /HOMEASSISTANT_TOKEN/.test(written));

  // List should include it and exclude the reserved stem-recall.
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_mcp_servers', arguments: {} } });
  const listed = textOf(await waitFor(4));
  check('list includes homeassistant', /homeassistant/.test(listed));
  check('list excludes reserved stem-recall', !/stem-recall/.test(listed));

  // Reserved servers can't be removed.
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'remove_mcp_server', arguments: { name: 'stem-recall' } } });
  check('remove refuses reserved server', (await waitFor(5)).result?.isError === true);

  // Remove the one we added.
  send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'remove_mcp_server', arguments: { name: 'homeassistant' } } });
  check('remove_mcp_server succeeds', /Removed MCP server/.test(textOf(await waitFor(6))));
  check('config no longer has homeassistant', !/mcp_servers\.homeassistant/.test(readFileSync(configPath, 'utf8')));

  // Name validation: a leading-dash name is rejected (argv injection guard).
  send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'add_mcp_server', arguments: { name: '-evil', transport: 'stdio', command: 'x' } } });
  check('rejects leading-dash name', (await waitFor(7)).result?.isError === true);
} catch (e) {
  console.log('FAIL:', e.message);
  failures += 1;
} finally {
  child.kill();
}

console.log(failures === 0 ? '\nALL_PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

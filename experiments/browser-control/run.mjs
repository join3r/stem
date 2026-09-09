// Launches only a NEW, isolated browser profile; never touches a real profile.
// No remote-debugging-port or remote-debugging-pipe: the native host drives tests.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = dirname(fileURLToPath(import.meta.url));
const kind = process.argv[2] ?? 'chromium';
if (!['chromium', 'chrome', 'arc'].includes(kind)) throw new Error('Usage: node experiments/browser-control/run.mjs [chromium|chrome|arc]');
const binaries = {
  chromium: chromium.executablePath(),
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  arc: '/Applications/Arc.app/Contents/MacOS/Arc'
};
const runDir = await mkdtemp(join(tmpdir(), `stem-browser-${kind}-`));
const profile = join(runDir, 'profile');
const extensionPath = join(runDir, 'extension');
const downloadsPath = join(runDir, 'downloads');
await mkdir(join(profile, 'Default'), { recursive: true });
await mkdir(join(profile, 'NativeMessagingHosts'), { recursive: true });
await mkdir(downloadsPath);
await cp(join(root, 'extension'), extensionPath, { recursive: true });
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const extensionId = [...createHash('sha256').update(der).digest('hex').slice(0, 32)].map((hex) => String.fromCharCode(97 + parseInt(hex, 16))).join('');
const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify({ ...manifest, key: der.toString('base64') }, null, 2));

let origin;
let otherOrigin;
function fixture(request, response) {
  const path = new URL(request.url, 'http://fixture.invalid').pathname;
  if (path === '/upload-fixture' && request.method === 'POST') {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => { size += chunk.length; if (size > 16384) request.destroy(); else chunks.push(chunk); });
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const valid = body.includes('filename="fictional-upload.txt"') && body.includes('Fictional upload content.\n');
      response.writeHead(valid ? 200 : 400, { 'Content-Type': 'text/plain' });
      response.end(valid ? 'Uploaded fictional-upload.txt' : 'Unexpected upload content');
    });
    return;
  }
  if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  if (path === '/redirect') { response.writeHead(302, { Location: `${otherOrigin}/form` }); response.end(); return; }
  if (path === '/download-fixture') {
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="stem-browser-probe.txt"' });
    response.end('Fictional Stem download.\n'); return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (path === '/existing') response.setHeader('Set-Cookie', 'stem_probe_session=fictional; SameSite=Strict; Path=/');
  const frame = path === '/same-frame' ? origin : path === '/cross-frame' ? otherOrigin : null;
  response.end(`<!doctype html><html><head><title>Stem fictional fixture</title></head><body>
    <h1>Fictional browser fixture</h1>
    <p>Existing session: ${request.headers.cookie?.includes('stem_probe_session=fictional') ? 'fictional' : 'none'}</p>
    ${path === '/child' ? '<p>FRAME_ONLY_SECRET</p>' : ''}
    <label>Name <input id="name" autocomplete="off"></label>
    <button id="greet" type="button" data-stem-fixture>Greet</button><p id="result"></p>
    <label>Upload <input id="upload" type="file" data-stem-fixture></label>
    <button id="upload-submit" type="button" data-stem-fixture>Upload fictional file</button><p id="upload-result"></p>
    ${frame ? `<iframe src="${frame}/child" title="Fixture child"></iframe>` : ''}
    <script>
      document.querySelector('#greet').onclick=()=>{document.querySelector('#result').textContent='Hello '+document.querySelector('#name').value;};
      document.querySelector('#upload-submit').onclick=async()=>{
        const form = new FormData(); form.append('file', document.querySelector('#upload').files[0]);
        const result = await fetch('/upload-fixture', {method:'POST',body:form});
        document.querySelector('#upload-result').textContent = await result.text();
      };
    </script>
    </body></html>`);
}
const servers = [createServer(fixture), createServer(fixture)];
for (const server of servers) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
[origin, otherOrigin] = servers.map((server) => `http://127.0.0.1:${server.address().port}`);
const config = {
  extensionId, origin, otherOrigin, downloadsPath,
  fixturePath: join(runDir, 'fictional-upload.txt'),
  resultPath: join(runDir, 'result.json'),
  screenshotPath: join(runDir, 'screenshot.png')
};
const configPath = join(runDir, 'config.json');
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
await writeFile(config.fixturePath, 'Fictional upload content.\n');
await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: downloadsPath, prompt_for_download: false },
  browser: { check_default_browser: false },
  extensions: { ui: { developer_mode: true } }
}));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const wrapper = join(runDir, 'native-host');
await writeFile(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve(root, 'native-host.mjs'))} ${quote(configPath)} "$@"\n`);
await chmod(wrapper, 0o700);
await writeFile(join(profile, 'NativeMessagingHosts', 'com.stem.browser_probe.json'), JSON.stringify({
  name: 'com.stem.browser_probe', description: 'Isolated Stem browser feasibility probe', path: wrapper,
  type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`]
}));
const args = [
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update',
  ...(kind === 'chromium' ? ['--headless=new', `--load-extension=${extensionPath}`] : []),
  ...(kind === 'arc' ? [`--load-extension=${extensionPath}`] : []),
  `${origin}/existing`,
  ...(kind === 'chrome' ? ['chrome://extensions/'] : [])
];
const launch = { kind, executable: binaries[kind], args, runDir, extensionPath, nativeHostManifest: join(profile, 'NativeMessagingHosts', 'com.stem.browser_probe.json') };
await writeFile(join(runDir, 'launch.json'), JSON.stringify(launch, null, 2));
console.log(JSON.stringify(launch, null, 2));
if (kind === 'chrome') console.log('Load the printed extension folder through Load unpacked in this isolated Chrome window.');
const child = spawn(binaries[kind], args, { stdio: ['ignore', 'ignore', 'pipe'] });
let logs = '';
child.stderr.on('data', (bytes) => { logs = (logs + bytes.toString()).slice(-30000); });
let spawnError;
let exited = false;
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
child.on('error', (error) => { spawnError = error; });
child.on('exit', () => { exited = true; });
try {
  const deadline = Date.now() + (kind === 'chromium' ? 90000 : 300000);
  let previous = '';
  while (Date.now() < deadline) {
    if (interrupted) throw new Error('Probe interrupted');
    if (spawnError) throw spawnError;
    try {
      const result = JSON.parse(await readFile(config.resultPath, 'utf8'));
      const state = `${result.status}:${result.checks.length}`;
      if (state !== previous) console.log(`${result.status}: ${result.checks.at(-1) ?? result.error ?? 'handshake'}`);
      previous = state;
      if (result.status !== 'running') {
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = result.status === 'passed' ? 0 : 1;
        break;
      }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (exited) throw new Error(`Browser exited (${child.exitCode ?? child.signalCode}) before probe completion`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (previous === '' || previous.startsWith('running:')) throw new Error('Timed out waiting for native-host completion');
} finally {
  child.kill('SIGTERM');
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  await writeFile(join(runDir, 'browser.log'), logs);
  for (let attempt = 0; attempt < 20 && !exited && !spawnError; attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!exited && !spawnError) child.kill('SIGKILL');
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  console.log(`Evidence: ${runDir}`);
}

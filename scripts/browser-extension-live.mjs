#!/usr/bin/env node
// Live check of the Stem browser extension (src/browser-extension) in Chrome
// for Testing, in a throwaway profile.
//
//   node scripts/browser-extension-live.mjs [--headed] [--record-fixture] [--keep]
//
// What runs where:
// - This script serves fixture pages on 127.0.0.1, writes a temporary profile
//   whose NativeMessagingHosts/com.stem.browser.json points back at THIS file
//   (`--native-host` mode), and spawns Chrome for Testing with
//   --load-extension. It never drives the browser itself: no Playwright
//   connection, no CDP port. Playwright is only asked where its browser lives.
// - Chrome then launches this file as the native host. In that mode it plays
//   the DESKTOP side of src/shared/browser-native.ts over native messaging
//   (the real desktop speaks the same frames through the native host and a
//   socket), runs the scenario, and writes the result file.
// - A tiny helper extension, generated into the temp dir, does the two things
//   the scenario can't do from the protocol: press the marker's Stop button
//   (a content script reaching the closed shadow root through
//   chrome.dom.openOrClosedShadowRoot — no CDP), log whether the marker is in
//   each page, and (with --record-fixture) capture a raw getFullAXTree of the
//   fixture form for tests/fixtures.
//
// Never point this at a real browser profile.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
// --extension <dir> loads another copy (an instrumented one while debugging).
const extArg = process.argv.indexOf('--extension');
const extensionDir = extArg > 0 ? resolve(process.argv[extArg + 1]) : join(repo, 'src/browser-extension');
const resultsFile = join(repo, 'experiments/browser-control/results/2026-10-05-extension.json');
const fixtureFile = join(repo, 'tests/fixtures/browser-extension-axtree.json');

function extensionIdFromKey(keyBase64) {
  const hex = createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('');
}


// ---------------------------------------------------------------------------
// Launcher
// ---------------------------------------------------------------------------

async function main() {
  const headed = process.argv.includes('--headed');
  const recordFixture = process.argv.includes('--record-fixture');
  const keep = process.argv.includes('--keep');
  const { chromium } = await import('playwright');
  const executable = chromium.executablePath();
  const manifest = JSON.parse(await readFile(join(extensionDir, 'manifest.json'), 'utf8'));
  const extensionId = extensionIdFromKey(manifest.key);

  const runDir = await mkdtemp(join(tmpdir(), 'stem-extension-live-'));
  const profile = join(runDir, 'profile');
  const downloads = join(runDir, 'downloads');
  const helperDir = join(runDir, 'helper-extension');
  await mkdir(join(profile, 'Default'), { recursive: true });
  await mkdir(join(profile, 'NativeMessagingHosts'), { recursive: true });
  await mkdir(downloads);
  await mkdir(helperDir);

  const uploadPath = join(runDir, 'upload-me.txt');
  const uploadContent = 'Stem upload fixture, 2026-10-05.\n';
  await writeFile(uploadPath, uploadContent);

  const state = { lastUpload: null, markerLog: [], capture: null, stopPresses: [], windowLog: [] };
  const server = createServer((req, res) => {
    try {
      const p = fixture(req, res, state);
      if (p && p.catch) p.catch((e) => res.writeHead(500).end(String(e)));
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  await new Promise((r, j) => {
    server.once('error', j);
    server.listen(0, '127.0.0.1', r);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  await writeHelperExtension(helperDir, origin, recordFixture);

  const config = {
    extensionId,
    expectedVersion: manifest.version,
    origin,
    uploadPath,
    uploadContent,
    downloads,
    headed,
    resultPath: join(runDir, 'result.json'),
    recordFixture
  };
  const configPath = join(runDir, 'config.json');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

  const quote = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;
  const wrapper = join(runDir, 'native-host.sh');
  await writeFile(wrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} --native-host ${quote(configPath)} "$@"\n`);
  await chmod(wrapper, 0o700);
  await writeFile(
    join(profile, 'NativeMessagingHosts', 'com.stem.browser.json'),
    JSON.stringify({
      name: 'com.stem.browser',
      description: 'Stem live test host (fake desktop)',
      path: wrapper,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`]
    })
  );
  await writeFile(
    join(profile, 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true },
      browser: { check_default_browser: false },
      extensions: { ui: { developer_mode: true } }
    })
  );

  const args = [
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--load-extension=${extensionDir},${helperDir}`,
    ...(headed ? ['--window-size=1100,850', '--window-position=40,40'] : ['--headless=new']),
    `${origin}/user`
  ];
  const launch = { executable, args, runDir, headed, extensionId };
  console.log(JSON.stringify(launch, null, 2));
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let logs = '';
  child.stderr.on('data', (b) => {
    logs = (logs + b.toString()).slice(-40_000);
  });
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  // Whatever happens to this script, the test browser goes with it.
  process.on('exit', () => {
    if (!exited) child.kill('SIGKILL');
  });

  let result = null;
  const deadline = Date.now() + 300_000;
  let lastShown = '';
  try {
    while (Date.now() < deadline) {
      try {
        result = JSON.parse(await readFile(config.resultPath, 'utf8'));
        const last = result.checks.at(-1);
        const line = `${result.status} ${result.checks.length} ${last ? `${last.ok ? 'ok  ' : 'FAIL'} ${last.name}` : ''}`;
        if (line !== lastShown) console.log(line);
        lastShown = line;
        if (result.status !== 'running') break;
      } catch (e) {
        if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
      }
      if (exited) throw new Error(`Chrome exited (${child.exitCode}) before the scenario finished`);
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    child.kill('SIGTERM');
    for (let i = 0; i < 30 && !exited; i++) await new Promise((r) => setTimeout(r, 100));
    if (!exited) child.kill('SIGKILL');
    server.closeAllConnections();
    server.close();
    await writeFile(join(runDir, 'browser.log'), logs);
  }

  if (!result || result.status === 'running') {
    console.error('Timed out. Browser log tail:\n', logs.slice(-4000));
    process.exitCode = 1;
    return;
  }
  if (recordFixture) {
    if (state.capture) {
      writeFileSync(fixtureFile, `${JSON.stringify(state.capture, null, 1)}\n`);
      console.log(`Wrote ${fixtureFile}`);
    } else console.error('No AX capture arrived from the helper extension.');
  }
  const record = {
    recordedOn: '2026-10-05',
    recordedAt: new Date().toISOString(),
    // Chrome draws nothing while the display sleeps or the session is locked;
    // a headed run's screenshot/wheel results mean nothing without this.
    display: displayState(),
    mode: headed ? 'headed' : 'headless=new',
    browser: result.hello && result.hello.userAgent,
    executable,
    extensionId,
    status: result.status,
    passed: result.checks.filter((c) => c.ok).length,
    failed: result.checks.filter((c) => !c.ok).length,
    checks: result.checks,
    markerLog: state.markerLog,
    error: result.error
  };
  // One file, keyed by mode and by whether the Mac was drawing at all, so a
  // headed run with the display awake sits beside one with it asleep (where
  // Chrome captures nothing, by design) instead of overwriting it.
  let all = {};
  try {
    all = JSON.parse(readFileSync(resultsFile, 'utf8'));
  } catch {
    all = {};
  }
  const dark = record.display && (record.display.asleep || record.display.locked);
  all[`${record.mode}${dark ? ', display asleep or locked' : ''}`] = record;
  writeFileSync(resultsFile, `${JSON.stringify(all, null, 2)}\n`);
  console.log(`\n${record.passed} passed, ${record.failed} failed (${record.mode}). Results: ${resultsFile}`);
  for (const c of result.checks) if (!c.ok) console.log(`FAIL ${c.name}: ${c.detail}`);
  if (!keep) await rm(runDir, { recursive: true, force: true }).catch(() => {});
  else console.log(`Kept ${runDir}`);
  process.exitCode = result.status === 'passed' ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Fixture pages
// ---------------------------------------------------------------------------

function fixture(req, res, state) {
  const url = new URL(req.url, 'http://fixture.invalid');
  const send = (status, type, body, headers = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
    res.end(body);
  };
  const html = (title, body) => send(200, 'text/html; charset=utf-8', `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`);
  const readBody = () =>
    new Promise((r) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => r(Buffer.concat(chunks)));
    });
  switch (url.pathname) {
    case '/favicon.ico':
      return send(204, 'text/plain', '');
    case '/user':
      return html('The user’s own page', '<h1>The user is reading this</h1><p>Stem must not switch away from it.</p>');
    case '/page2':
      return html('Page two', '<h1>Second page</h1><p>Nothing else here.</p>');
    case '/help':
      return html('Help', '<h1>Help</h1>');
    case '/frame':
      return html('Inner frame', '<p>Inside the frame</p><button type="button">Frame button</button>');
    case '/search':
      return html('Search results', `<h1>Results for ${escapeHtml(url.searchParams.get('q') || '')}</h1><a href="/form">Back to the form</a>`);
    case '/delayed':
      return html('Delayed', '<p id="t">Loading…</p><script>setTimeout(() => { document.querySelector("#t").textContent = "Ready now"; }, 1500)</script>');
    case '/api/data':
      return send(200, 'application/json', JSON.stringify({ greeting: `Hello ${url.searchParams.get('name') || ''}`, items: [1, 2, 3] }));
    case '/download':
      return send(200, 'text/plain', 'Quarterly report: all good.\n', { 'content-disposition': 'attachment; filename="report.txt"' });
    case '/upload':
      return readBody().then((body) => {
        const text = body.toString('latin1');
        const m = /filename="([^"]*)"\r\n[^\r]*\r\n\r\n([\s\S]*?)\r\n--/.exec(text);
        state.lastUpload = { bytes: body.length, filename: m ? m[1] : null, content: m ? m[2] : null };
        send(200, 'text/plain', m ? `Uploaded ${Buffer.byteLength(m[2], 'latin1')} bytes: ${m[1]}` : 'Upload not understood');
      });
    case '/__marker':
      state.markerLog.push({ at: Date.now(), href: url.searchParams.get('href'), present: url.searchParams.get('present') === '1', doc: url.searchParams.get('doc') });
      return send(204, 'text/plain', '');
    case '/__marker-log':
      return send(200, 'application/json', JSON.stringify(state.markerLog));
    case '/__stop-pressed':
      state.stopPresses.push({ at: Date.now(), found: url.searchParams.get('found') === '1' });
      return send(204, 'text/plain', '');
    case '/__stop-log':
      return send(200, 'application/json', JSON.stringify(state.stopPresses));
    case '/__window':
      state.windowLog.push({ at: Date.now(), state: url.searchParams.get('state'), error: url.searchParams.get('e') });
      return send(204, 'text/plain', '');
    case '/__window-log':
      return send(200, 'application/json', JSON.stringify(state.windowLog));
    case '/__last-upload':
      return send(200, 'application/json', JSON.stringify(state.lastUpload));
    case '/__capture':
      if (req.method === 'POST') {
        return readBody().then((body) => {
          state.capture = JSON.parse(body.toString('utf8'));
          send(204, 'text/plain', '');
        });
      }
      return send(200, 'application/json', JSON.stringify({ done: !!state.capture }));
    case '/form':
      return html('Fixture form', FORM_BODY);
    default:
      return send(404, 'text/plain', 'not found');
  }
}

function displayState() {
  if (process.platform !== 'darwin') return null;
  const out = { asleep: null, locked: null };
  try {
    out.locked = /"IOConsoleLocked" = Yes/.test(execFileSync('ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8' }));
  } catch {
    // ioreg missing: leave it unknown.
  }
  try {
    // CoreGraphics knows now; pmset's log lags by minutes.
    const py =
      'import ctypes, ctypes.util\n' +
      "cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))\n" +
      'cg.CGDisplayIsAsleep.restype = ctypes.c_bool\n' +
      'print(cg.CGDisplayIsAsleep(cg.CGMainDisplayID()))';
    out.asleep = execFileSync('python3', ['-c', py], { encoding: 'utf8' }).trim() === 'True';
  } catch {
    // No python3: unknown.
  }
  return out;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

const FORM_BODY = `
<header><nav aria-label="Main"><a href="/page2">Page two</a> <a href="/help" target="_blank">Open help</a> <a href="/download">Download report</a></nav></header>
<main>
  <h1>Order form</h1>
  <p>Fill in the <strong>form</strong> below and press <em>Greet</em>.</p>
  <label>Name <input id="name" value="Ada" autocomplete="off"></label>
  <label for="email">Email</label><input id="email" type="email" placeholder="you@example.com">
  <label>Password <input id="pw" type="password"></label>
  <label>Colour <select id="colour"><option>Red</option><option selected>Green</option><option value="b">Blue</option></select></label>
  <label><input type="checkbox" id="sub"> Subscribe</label>
  <fieldset><legend>Size</legend><label><input type="radio" name="size" value="s" checked> Small</label><label><input type="radio" name="size" value="l"> Large</label></fieldset>
  <textarea aria-label="Notes">hello</textarea>
  <button id="greet" type="button">Greet</button>
  <button id="alert" type="button" onclick="alert('Hi there')">Alert me</button>
  <button id="prompt" type="button" onclick="document.querySelector('#out').textContent = 'Prompted: ' + prompt('Your name?', 'Ada')">Ask my name</button>
  <p id="out"></p>
  <form action="/search" method="get" role="search"><input name="q" aria-label="Search"><button type="submit">Go</button></form>
  <ul><li>One</li><li>Two <a href="#t">anchor</a></li></ul>
  <table><tr><th>Item</th><th>Price</th></tr><tr><td>Tea</td><td>3</td></tr></table>
  <section aria-label="Files">
    <input type="file" id="file" hidden>
    <button id="choose" type="button" onclick="document.querySelector('#file').click()">Choose file</button>
    <button id="send" type="button">Send file</button>
    <p id="upload-out"></p>
  </section>
  <iframe src="/frame" title="Same-origin frame" style="height:80px"></iframe>
  <div style="height:2400px">Tall section</div>
  <p id="bottom">The end of the page.</p>
</main>
<script>
  console.log('form loaded', 42);
  document.querySelector('#greet').addEventListener('click', async () => {
    const name = document.querySelector('#name').value;
    document.querySelector('#out').textContent = 'Hello ' + name;
    console.error('greet clicked', name);
    const r = await fetch('/api/data?name=' + encodeURIComponent(name));
    document.querySelector('#out').dataset.api = (await r.json()).greeting;
  });
  document.querySelector('#send').addEventListener('click', async () => {
    const f = document.querySelector('#file').files[0];
    if (!f) { document.querySelector('#upload-out').textContent = 'No file chosen'; return; }
    const form = new FormData(); form.append('file', f);
    const r = await fetch('/upload', { method: 'POST', body: form });
    document.querySelector('#upload-out').textContent = await r.text();
  });
</script>`;

// ---------------------------------------------------------------------------
// Helper extension (test only)
// ---------------------------------------------------------------------------

async function writeHelperExtension(dir, origin, recordFixture) {
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        manifest_version: 3,
        name: 'Stem live-test helper',
        version: '1.0.0',
        permissions: ['debugger', 'tabs', 'downloads'],
        host_permissions: ['http://127.0.0.1/*'],
        background: { service_worker: 'sw.js' },
        content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['cs.js'], run_at: 'document_start' }]
      },
      null,
      2
    )
  );
  // Content script: logs marker presence per document; presses Stop on demand.
  await writeFile(
    join(dir, 'cs.js'),
    `(() => {
  const doc = Math.random().toString(36).slice(2);
  let last = null;
  const report = () => {
    const present = !!document.querySelector('stem-marker');
    if (present === last) return;
    last = present;
    fetch('/__marker?present=' + (present ? 1 : 0) + '&doc=' + doc + '&href=' + encodeURIComponent(location.href), { method: 'POST' }).catch(() => {});
  };
  const start = () => {
    new MutationObserver(report).observe(document.documentElement, { childList: true, subtree: false, attributes: false });
    report();
  };
  if (document.documentElement) start(); else document.addEventListener('readystatechange', start, { once: true });
  addEventListener('hashchange', () => {
    if (['#stem-test-minimize', '#stem-test-restore', '#stem-test-user-download'].includes(location.hash)) {
      chrome.runtime.sendMessage({ op: location.hash.slice(11) });
      return;
    }
    if (location.hash !== '#stem-test-press-stop') return;
    const host = document.querySelector('stem-marker');
    const root = host && chrome.dom.openOrClosedShadowRoot(host);
    const button = root && root.querySelector('button');
    if (button) button.click();
    fetch('/__stop-pressed?found=' + (button ? 1 : 0), { method: 'POST' }).catch(() => {});
  });
})();\n`
  );
  // Service worker: optionally captures a raw AX tree of the fixture form in a
  // tab of its own (never one the scenario uses) for tests/fixtures.
  await writeFile(
    join(dir, 'sw.js'),
    `const ORIGIN = ${JSON.stringify(origin)};
const RECORD = ${JSON.stringify(recordFixture)};
async function capture() {
  const tab = await chrome.tabs.create({ url: ORIGIN + '/form?capture=1', active: false });
  for (let i = 0; i < 100; i++) { const t = await chrome.tabs.get(tab.id); if (t.status === 'complete') break; await new Promise((r) => setTimeout(r, 100)); }
  await new Promise((r) => setTimeout(r, 300));
  const target = { tabId: tab.id };
  await chrome.debugger.attach(target, '1.3');
  const { nodes } = await chrome.debugger.sendCommand(target, 'Accessibility.getFullAXTree', {});
  const { frameTree } = await chrome.debugger.sendCommand(target, 'Page.getFrameTree', {});
  const frames = [];
  for (const child of frameTree.childFrames || []) {
    const [{ nodes: fnodes }, owner] = await Promise.all([
      chrome.debugger.sendCommand(target, 'Accessibility.getFullAXTree', { frameId: child.frame.id }),
      chrome.debugger.sendCommand(target, 'DOM.getFrameOwner', { frameId: child.frame.id })
    ]);
    frames.push({ ownerBackendNodeId: owner.backendNodeId, nodes: fnodes });
  }
  await chrome.debugger.detach(target);
  await chrome.tabs.remove(tab.id);
  const body = { capturedWith: navigator.userAgent, pageUrl: frameTree.frame.url, nodes, frames };
  await fetch(ORIGIN + '/__capture', { method: 'POST', body: JSON.stringify(body) });
}
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.op === 'user-download') {
    // The user saving something themselves, from no Stem tab.
    chrome.downloads.download({ url: ORIGIN + '/download?by=user', saveAs: false });
    return;
  }
  if (!sender.tab || (msg.op !== 'minimize' && msg.op !== 'restore')) return;
  chrome.windows
    .update(sender.tab.windowId, { state: msg.op === 'minimize' ? 'minimized' : 'normal' })
    .then((w) => fetch(ORIGIN + '/__window?state=' + w.state, { method: 'POST' }))
    .catch((e) => fetch(ORIGIN + '/__window?state=error&e=' + encodeURIComponent(String(e)), { method: 'POST' }));
});
if (RECORD) capture().catch((e) => fetch(ORIGIN + '/__capture', { method: 'POST', body: JSON.stringify({ error: String(e) }) }));
`
  );
}

// ---------------------------------------------------------------------------
// Fake desktop (runs as the native host)
// ---------------------------------------------------------------------------

async function nativeHost(configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const checks = [];
  const transcript = [];
  const out = { status: 'running', checks, transcript };
  const pending = new Map();
  const stopped = [];
  let helloResolve;
  const helloP = new Promise((r) => (helloResolve = r));
  let buf = Buffer.alloc(0);

  const save = () => writeFileSync(config.resultPath, JSON.stringify(out, null, 2));
  const sendFrame = (msg) => {
    const body = Buffer.from(JSON.stringify(msg));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    process.stdout.write(Buffer.concat([head, body]));
  };
  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
      buf = buf.subarray(4 + len);
      if (msg.type === 'hello') helloResolve(msg);
      else if (msg.type === 'stopped') stopped.push({ threadId: msg.threadId, at: Date.now() });
      else if (msg.type === 'result') {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p(msg.result);
        }
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));

  const brief = (r) => {
    const copy = { ...r };
    if (copy.screenshot) copy.screenshot = { width: copy.screenshot.width, height: copy.screenshot.height, bytes: copy.screenshot.jpegBase64.length };
    if (typeof copy.text === 'string' && copy.text.length > 1500) copy.text = `${copy.text.slice(0, 1500)}…`;
    return copy;
  };
  const req = (threadId, action, timeoutMs = 110_000) =>
    new Promise((resolveReq, reject) => {
      const id = randomUUID();
      const t0 = Date.now();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${action.kind} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, (result) => {
        clearTimeout(timer);
        transcript.push({ threadId, action, ms: Date.now() - t0, result: brief(result) });
        resolveReq(result);
      });
      sendFrame({ type: 'request', id, threadId, action });
    });
  const fetchJson = async (path) => (await fetch(config.origin + path)).json();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function check(name, fn) {
    const t0 = Date.now();
    try {
      const detail = await fn();
      checks.push({ name, ok: true, ms: Date.now() - t0, detail: detail === undefined ? '' : detail });
    } catch (e) {
      checks.push({ name, ok: false, ms: Date.now() - t0, detail: String((e && e.stack) || e).slice(0, 1500) });
    }
    save();
  }
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  const ok = (r, re, what) => {
    assert(r && r.ok, `${what || 'request'} failed: ${JSON.stringify(r)}`);
    if (re) assert(re.test(r.text || ''), `${what || 'request'} text ${JSON.stringify((r.text || '').slice(0, 600))} does not match ${re}`);
    return r;
  };
  const refOf = (text, role, name) => {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`- ${role} "${esc}"[^\\n]*?\\[ref=(e\\d+)\\]`).exec(text);
    assert(m, `no ref for ${role} "${name}" in snapshot`);
    return m[1];
  };
  const evalIn = async (thread, tab, script) => {
    const r = await req(thread, { kind: 'evaluate', tab, script });
    ok(r, null, `evaluate ${script}`);
    // The value follows the "Tab N · …" header (and any shared-tab note before it).
    const lines = r.text.split('\n');
    return JSON.parse(lines.slice(lines.findIndex((l) => l.startsWith('Tab ')) + 1).join('\n'));
  };

  save();
  const A = 'thread-a';
  const B = 'thread-b';
  const C = 'thread-c';
  let userTab;
  let formTab;
  let snap;
  let firstAttach;

  try {
    const hello = await Promise.race([helloP, sleep(20_000).then(() => null)]);
    out.hello = hello;
    await check('hello: protocol 1, the manifest-derived id, version', async () => {
      assert(hello, 'no hello within 20 s');
      assert(hello.protocol === 1, `protocol ${hello.protocol}`);
      assert(hello.extensionId === config.extensionId, `id ${hello.extensionId} != ${config.extensionId}`);
      assert(hello.extensionVersion === config.expectedVersion, `version ${hello.extensionVersion}`);
      assert(/Chrome\//.test(hello.userAgent), 'userAgent');
      return `${hello.extensionId} v${hello.extensionVersion}`;
    });
    sendFrame({ type: 'host', connected: true });

    if (config.recordFixture) {
      await check('helper captured a raw AX tree of the fixture form', async () => {
        for (let i = 0; i < 100; i++) {
          if ((await fetchJson('/__capture')).done) return 'captured';
          await sleep(200);
        }
        throw new Error('no capture');
      });
    }

    await check('tabs lists the user’s own tab as active', async () => {
      let r;
      for (let i = 0; i < 50; i++) {
        r = await req(A, { kind: 'tabs' });
        if (r.ok && /\/user \(active/.test(r.text)) break;
        await sleep(200);
      }
      ok(r, /- (\d+) · The user’s own page — http:\/\/127\.0\.0\.1:\d+\/user \(active\)/);
      userTab = Number(/- (\d+) · The user’s own page/.exec(r.text)[1]);
      return r.text;
    });

    await check('open: new background tab, the user’s tab stays active', async () => {
      const r = ok(await req(A, { kind: 'open', url: `${config.origin}/form?tab=F` }), /^Opened tab \d+ in the background: Fixture form — http:\/\/127\.0\.0\.1:\d+\/form\?tab=F$/);
      formTab = r.tab;
      assert(Number.isInteger(formTab) && formTab !== userTab, 'tab id');
      const t = ok(await req(A, { kind: 'tabs' }));
      assert(new RegExp(`- ${userTab} · [^\\n]*\\(active\\)`).test(t.text), 'user tab no longer active');
      assert(new RegExp(`- ${formTab} · Fixture form[^\\n]*\\(yours, your current tab\\)`).test(t.text), `form tab not marked yours: ${t.text}`);
      return `${r.text}\n${t.text}`;
    });

    await check('snapshot: outline with refs, same-origin iframe spliced in', async () => {
      const r = ok(await req(A, { kind: 'snapshot' }), /^Tab \d+ · Fixture form — /);
      snap = r.text;
      for (const want of ['textbox "Name"', 'button "Greet"', 'combobox "Colour"', 'checkbox "Subscribe"', 'iframe "Same-origin frame":', 'button "Frame button"', 'row: Tea | 3']) {
        assert(snap.includes(want), `missing ${want}`);
      }
      assert(r.tab === formTab, 'result tab');
      return snap;
    });

    await check('fill: text field, select by option text, checkbox', async () => {
      const name = refOf(snap, 'textbox', 'Name');
      const colour = refOf(snap, 'combobox', 'Colour');
      const sub = refOf(snap, 'checkbox', 'Subscribe');
      const r1 = ok(await req(A, { kind: 'fill', ref: name, value: 'Bob' }), /Set textbox "Name" \(e\d+\) to "Bob"/);
      const r2 = ok(await req(A, { kind: 'fill', ref: colour, value: 'blue' }), /Selected "Blue"/);
      const r3 = ok(await req(A, { kind: 'fill', ref: sub, value: 'true' }), /Checked checkbox "Subscribe"/);
      const r4 = ok(await req(A, { kind: 'fill', ref: sub, value: 'true' }), /already checked/);
      const v = await evalIn(A, undefined, '[document.querySelector("#name").value, document.querySelector("#colour").value, document.querySelector("#sub").checked]');
      assert(JSON.stringify(v) === JSON.stringify(['Bob', 'b', true]), `page state ${JSON.stringify(v)}`);
      return [r1.text, r2.text, r3.text, r4.text].join('\n');
    });

    await check('click by ref in a background tab', async () => {
      const r = ok(await req(A, { kind: 'click', ref: refOf(snap, 'button', 'Greet') }), /Clicked button "Greet"/);
      await sleep(300);
      const v = await evalIn(A, undefined, '[document.querySelector("#out").textContent, document.querySelector("#out").dataset.api]');
      assert(v[0] === 'Hello Bob' && v[1] === 'Hello Bob', `out ${JSON.stringify(v)}`);
      return r.text;
    });

    await check('console: load-time and click messages, errorsOnly', async () => {
      const all = ok(await req(A, { kind: 'console' }), /Stem attached at (\d\d:\d\d:\d\d)/);
      firstAttach = /Stem attached at (\d\d:\d\d:\d\d)/.exec(all.text)[1];
      assert(/form loaded 42/.test(all.text), 'load-time log missing');
      assert(/error\s+greet clicked Bob/.test(all.text), 'click error missing');
      const errs = ok(await req(A, { kind: 'console', errorsOnly: true }));
      assert(/greet clicked/.test(errs.text) && !/form loaded/.test(errs.text), 'errorsOnly filter');
      return all.text;
    });

    await check('network: list and one request with its body', async () => {
      const list = ok(await req(A, { kind: 'network', filter: '/api/data' }), /\/api\/data\?name=Bob/);
      const id = /\n(r\d+) GET 200 fetch/.exec(list.text);
      assert(id, `no request id in ${list.text}`);
      const detail = ok(await req(A, { kind: 'network', request: id[1] }), /"greeting":"Hello Bob"/);
      assert(/Response headers:/.test(detail.text), 'headers');
      return `${list.text}\n---\n${detail.text}`;
    });

    await check('type + submit navigates; wait for text', async () => {
      const search = refOf(snap, 'textbox', 'Search');
      const r = ok(await req(A, { kind: 'type', ref: search, text: 'stem rocks', submit: true }), /pressed Enter\. The tab went to http:\/\/127\.0\.0\.1:\d+\/search\?q=stem\+rocks/);
      const w = ok(await req(A, { kind: 'wait', text: 'Results for stem rocks' }), /appeared after/);
      return `${r.text}\n${w.text}`;
    });

    await check('navigate back, then wait for delayed text and a timeout', async () => {
      ok(await req(A, { kind: 'navigate', to: 'back' }), /Went back/);
      const t = ok(await req(A, { kind: 'tabs' }));
      assert(new RegExp(`- ${formTab} · Fixture form`).test(t.text), 'not back on the form');
      ok(await req(A, { kind: 'navigate', url: `${config.origin}/delayed` }), /Loaded the page/);
      const w1 = ok(await req(A, { kind: 'wait', text: 'ready NOW' }), /appeared after/);
      const w2 = ok(await req(A, { kind: 'wait', text: 'never there', ms: 1000 }), /did not appear within 1 s/);
      const w3 = ok(await req(A, { kind: 'wait', url: '/delayed', ms: 2000 }), /appeared after/);
      return [w1.text, w2.text, w3.text].join('\n');
    });

    await check('press: Meta+A then Backspace clears a field (Mac editing commands), Tab moves focus', async () => {
      ok(await req(A, { kind: 'navigate', url: `${config.origin}/form?tab=F` }), /Loaded the page/);
      snap = ok(await req(A, { kind: 'snapshot' })).text;
      ok(await req(A, { kind: 'type', ref: refOf(snap, 'textbox', 'Name'), text: 'xyz' }), /It now reads: "Adaxyz"\./);
      const p1 = ok(await req(A, { kind: 'press', key: 'Meta+A' }), /Pressed Meta\+A/);
      ok(await req(A, { kind: 'press', key: 'Backspace' }));
      const v = await evalIn(A, undefined, 'document.querySelector("#name").value');
      assert(v === '', `name is ${JSON.stringify(v)}`);
      ok(await req(A, { kind: 'press', key: 'Tab' }));
      const focused = await evalIn(A, undefined, 'document.activeElement.id');
      assert(focused === 'email', `focus on ${focused}`);
      return p1.text;
    });

    await check('scroll: wheel down in a background tab, then a ref into view', async () => {
      const r = ok(await req(A, { kind: 'scroll' }), /Scrolled the page down( \(by script[^)]*\))?: it is now at y=\d+/);
      const y = await evalIn(A, undefined, 'scrollY');
      assert(y > 100, `scrollY ${y}`);
      const r2 = ok(await req(A, { kind: 'scroll', ref: refOf(snap, 'button', 'Greet') }), /into view/);
      return `${r.text}\n${r2.text}`;
    });

    await check('evaluate: value, top-level await, a thrown error', async () => {
      const t = ok(await req(A, { kind: 'evaluate', script: 'document.title' }), /\n"Fixture form"$/);
      const a = ok(await req(A, { kind: 'evaluate', script: 'await new Promise((r) => setTimeout(() => r({ n: 42 }), 50))' }), /"n": 42/);
      const e = await req(A, { kind: 'evaluate', script: 'nope.nothing' });
      assert(!e.ok && /The script threw: ReferenceError: nope is not defined/.test(e.error), JSON.stringify(e));
      return [t.text, a.text, e.error].join('\n');
    });

    await check('dialog: an alert during a click does not hang; other actions refuse; prompt answered with text', async () => {
      snap = ok(await req(A, { kind: 'snapshot' })).text;
      const t0 = Date.now();
      const r = ok(await req(A, { kind: 'click', ref: refOf(snap, 'button', 'Alert me') }), /Clicked button "Alert me" \(e\d+\)\. The page opened a dialog: alert "Hi there"/);
      const took = Date.now() - t0;
      assert(took < 8000, `click took ${took} ms`);
      const blocked = await req(A, { kind: 'snapshot' });
      assert(!blocked.ok && /A dialog is open in tab \d+: alert "Hi there"/.test(blocked.error), JSON.stringify(blocked));
      ok(await req(A, { kind: 'dialog', accept: true }), /Accepted the alert "Hi there"/);
      ok(await req(A, { kind: 'click', ref: refOf(snap, 'button', 'Ask my name') }), /dialog: prompt "Your name\?"/);
      ok(await req(A, { kind: 'dialog', accept: true, text: 'Zed' }), /with "Zed"/);
      const out = await evalIn(A, undefined, 'document.querySelector("#out").textContent');
      assert(out === 'Prompted: Zed', out);
      const none = await req(A, { kind: 'dialog', accept: true });
      assert(!none.ok && /No dialog is open/.test(none.error), 'dialog with none open');
      return `${r.text} (${took} ms)`;
    });

    await check('screenshot of a background tab: CSS-pixel size, not blank, marker hidden', async () => {
      const t = ok(await req(A, { kind: 'tabs' }));
      assert(new RegExp(`- ${userTab} · [^\\n]*\\(active\\)`).test(t.text), 'user tab should still be the active one');
      assert(!new RegExp(`- ${formTab} · [^\\n]*active`).test(t.text), 'form tab must be in the background');
      await req(A, { kind: 'evaluate', script: 'scrollTo(0, 0), 0' });
      const [w, h] = await evalIn(A, undefined, '[innerWidth, innerHeight]');
      const r = ok(await req(A, { kind: 'screenshot' }), /coordinates are CSS pixels of this picture/);
      const shot = r.screenshot;
      assert(shot && shot.jpegBase64, 'no picture');
      const sharp = (await import('sharp')).default;
      const img = sharp(Buffer.from(shot.jpegBase64, 'base64'));
      const meta = await img.metadata();
      assert(meta.width === shot.width && meta.height === shot.height, 'reported size != jpeg size');
      assert(Math.abs(meta.width - w) <= 20 && Math.abs(meta.height - h) <= 2, `picture ${meta.width}x${meta.height} vs view ${w}x${h}`);
      const stats = await img.stats();
      const spread = stats.channels.reduce((acc, c) => acc + c.stdev, 0) / stats.channels.length;
      assert(spread > 5, `picture looks blank (stdev ${spread})`);
      const { data, info } = await sharp(Buffer.from(shot.jpegBase64, 'base64')).raw().toBuffer({ resolveWithObject: true });
      const px = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
      const corner = px(1, Math.floor(info.height / 2));
      assert(corner.every((c) => c > 235), `left edge pixel ${corner}: marker border visible in the picture?`);
      writeFileSync(join(dirname(config.resultPath), 'screenshot.jpg'), Buffer.from(shot.jpegBase64, 'base64'));
      const full = ok(await req(A, { kind: 'screenshot', fullPage: true }), /Full-page screenshot/);
      assert(full.screenshot.height > h, `full page ${full.screenshot.height} <= ${h}`);
      return `${r.text} | view ${w}x${h} | stdev ${spread.toFixed(1)} | edge ${corner} | ${full.text}`;
    });

    await check('upload through a hidden file input; the server receives the bytes', async () => {
      snap = ok(await req(A, { kind: 'snapshot' })).text;
      const u = ok(await req(A, { kind: 'upload', ref: refOf(snap, 'button', 'Choose file'), paths: [config.uploadPath] }), /Attached upload-me\.txt \(\d+ B\)/);
      ok(await req(A, { kind: 'click', ref: refOf(snap, 'button', 'Send file') }));
      ok(await req(A, { kind: 'wait', text: 'Uploaded 33 bytes: upload-me.txt' }), /appeared/);
      const last = await fetchJson('/__last-upload');
      assert(last && last.content === config.uploadContent, `server got ${JSON.stringify(last)}`);
      return u.text;
    });

    await check('a click on an upload button is answered by a file chooser, not a native dialog', async () => {
      const r = ok(await req(A, { kind: 'click', ref: refOf(snap, 'button', 'Choose file') }), /It opened a file chooser/);
      return r.text;
    });

    await check('download: reported on the next result exactly once, with its path', async () => {
      const click = ok(await req(A, { kind: 'click', ref: refOf(snap, 'link', 'Download report') }));
      let got = click.downloads || [];
      // If the click's own result already carried it, there is nothing left to wait for.
      const w = ok(await req(A, { kind: 'downloads', ...(got.length ? {} : { wait: true, ms: 15000 }) }), /report\.txt — done/);
      got = got.concat(w.downloads || []);
      if (!got.length) {
        const again = ok(await req(A, { kind: 'tabs' }));
        got = got.concat(again.downloads || []);
      }
      assert(got.length === 1, `downloads reported ${got.length} times: ${JSON.stringify(got)}`);
      const d = got[0];
      assert(d.name === 'report.txt' && d.path.startsWith(config.downloads), JSON.stringify(d));
      assert(readFileSync(d.path, 'utf8') === 'Quarterly report: all good.\n', 'content');
      const after = ok(await req(A, { kind: 'tabs' }));
      assert(!after.downloads, 'reported twice');
      return `${JSON.stringify(d)} | ${w.text}`;
    });

    await check('a download the user makes during a run is never the run’s', async () => {
      await req(A, { kind: 'evaluate', tab: formTab, script: 'location.hash = "stem-test-user-download", 1' });
      const { readdirSync } = await import('node:fs');
      let names = [];
      for (let i = 0; i < 100; i++) {
        names = readdirSync(config.downloads).filter((n) => !n.endsWith('.crdownload'));
        if (names.length >= 2) break;
        await sleep(100);
      }
      assert(names.length >= 2, `the user's download never landed: ${names}`);
      await sleep(500);
      const t = ok(await req(A, { kind: 'tabs' }));
      assert(!t.downloads, `user download reported to the run: ${JSON.stringify(t.downloads)}`);
      const d = ok(await req(A, { kind: 'downloads' }));
      assert(!/report \(1\)\.txt/.test(d.text) && (d.text.match(/report/g) || []).length === 1, d.text);
      return `${names.join(', ')} on disk; run lists: ${d.text.replace(/\n/g, ' | ')}`;
    });

    let helpTab;
    await check('a target=_blank click opens a background tab; the user’s view does not switch', async () => {
      const r = ok(await req(A, { kind: 'click', ref: refOf(snap, 'link', 'Open help') }), /It opened tab (\d+) in the background/);
      helpTab = Number(/It opened tab (\d+)/.exec(r.text)[1]);
      await sleep(500);
      const t = ok(await req(A, { kind: 'tabs' }));
      assert(new RegExp(`- ${userTab} · [^\\n]*\\(active\\)`).test(t.text), `user tab lost focus: ${t.text}`);
      assert(new RegExp(`- ${helpTab} · [^\\n]*yours`).test(t.text), 'help tab should be yours');
      return r.text;
    });

    await check('close: own tab closes, the user’s tab is refused', async () => {
      assert(Number.isInteger(helpTab), 'no help tab to close (the target=_blank check failed)');
      const c = ok(await req(A, { kind: 'close', tab: helpTab }), /Closed tab/);
      const refused = await req(A, { kind: 'close', tab: userTab });
      assert(!refused.ok && refused.error === 'You can only close tabs you opened.', JSON.stringify(refused));
      return `${c.text} | ${refused.error}`;
    });

    await check('refuses chrome:// and file: (open, and acting in a tab showing one)', async () => {
      const a = await req(A, { kind: 'open', url: 'chrome://settings' });
      assert(!a.ok && /browser page/.test(a.error), JSON.stringify(a));
      const b = await req(A, { kind: 'open', url: 'file:///etc/hosts' });
      assert(!b.ok && /a file on this Mac, which Stem never opens/.test(b.error), JSON.stringify(b));
      const c = await req(A, { kind: 'navigate', url: 'file:///etc/hosts' });
      assert(!c.ok && /a file on this Mac/.test(c.error), JSON.stringify(c));
      return [a.error, b.error, c.error].join('\n');
    });

    let pageTab;
    await check('two runs at once in different tabs; a shared tab gets a warning; actions serialize', async () => {
      const [ob, sa] = await Promise.all([req(B, { kind: 'open', url: `${config.origin}/page2` }), req(A, { kind: 'snapshot', tab: formTab })]);
      ok(ob, /^Opened tab \d+ in the background: Page two/);
      ok(sa, /Fixture form/);
      pageTab = ob.tab;
      assert(pageTab !== formTab, 'same tab');
      const bs = ok(await req(B, { kind: 'snapshot' }), /Second page/);
      assert(bs.tab === pageTab, 'B current tab');
      const shared = ok(await req(B, { kind: 'evaluate', tab: formTab, script: 'location.pathname' }), /^Note: another Stem run also worked in this tab in the last 2 minutes/);
      const par = await Promise.all([
        req(A, { kind: 'evaluate', tab: formTab, script: 'await new Promise((r) => setTimeout(r, 400)), performance.now()' }),
        req(B, { kind: 'evaluate', tab: formTab, script: 'performance.now()' })
      ]);
      par.forEach((r) => ok(r));
      const ta = ok(await req(B, { kind: 'tabs' }));
      assert(new RegExp(`- ${formTab} · [^\\n]*in use by another Stem run`).test(ta.text), 'tabs should flag the shared tab');
      return `${shared.text.split('\n')[0]} | A: ${par[0].text.split('\n')[1]} B: ${par[1].text.split('\n')[1]}`;
    });

    await check('minimized window: click and scroll still work in a background tab; screenshot works or says why', async () => {
      const windowState = async (want) => {
        await req(A, { kind: 'evaluate', tab: formTab, script: `location.hash = "stem-test-${want === 'minimized' ? 'minimize' : 'restore'}", 1` });
        for (let i = 0; i < 50; i++) {
          const log = await fetchJson('/__window-log');
          if (log.length && log.at(-1).state === want) return;
          await sleep(100);
        }
        throw new Error(`window never became ${want}: ${JSON.stringify(await fetchJson('/__window-log'))}`);
      };
      await windowState('minimized');
      await sleep(1500);
      const s1 = ok(await req(A, { kind: 'snapshot', tab: formTab })).text;
      const t0 = Date.now();
      ok(await req(A, { kind: 'click', ref: refOf(s1, 'button', 'Greet') }), /Clicked button "Greet"/);
      const clickMs = Date.now() - t0;
      assert(clickMs < 4000, `click took ${clickMs} ms`);
      const sc = ok(await req(A, { kind: 'scroll' }), /Scrolled the page down/);
      const t1 = Date.now();
      const shot = await req(A, { kind: 'screenshot' });
      const shotMs = Date.now() - t1;
      assert(shot.ok || /isn't drawing right now/.test(shot.error), JSON.stringify(shot).slice(0, 300));
      const vis = await evalIn(A, formTab, 'document.visibilityState');
      // Restoring is best effort: a locked Mac keeps the window minimized.
      await windowState('normal').catch(() => {});
      return `click ${clickMs} ms | ${sc.text.split('\n')[1]} | screenshot ${shot.ok ? `ok ${shot.screenshot.width}x${shot.screenshot.height}` : `refused: ${shot.error}`} (${shotMs} ms) | visibilityState ${vis}`;
    });

    await check('marker: present, invisible to page script (no binding, closed shadow root)', async () => {
      const v = await evalIn(A, formTab, '[typeof stemMarkerStop, !!document.querySelector("stem-marker"), document.querySelector("stem-marker") && document.querySelector("stem-marker").shadowRoot === null]');
      assert(JSON.stringify(v) === JSON.stringify(['undefined', true, true]), JSON.stringify(v));
      const log = await fetchJson('/__marker-log');
      assert(log.some((e) => /tab=F/.test(e.href) && e.present), 'helper never saw the marker in the form tab');
      return JSON.stringify(v);
    });

    await check('marker Stop button → `stopped` for every run using that tab; later requests refused', async () => {
      stopped.length = 0;
      await req(A, { kind: 'evaluate', tab: formTab, script: 'location.hash = "stem-test-press-stop", 1' });
      for (let i = 0; i < 50 && stopped.length < 2; i++) await sleep(100);
      const presses = await fetchJson('/__stop-log');
      assert(presses.length && presses.at(-1).found, `helper did not find the Stop button: ${JSON.stringify(presses)}`);
      const ids = stopped.map((s) => s.threadId).sort();
      assert(JSON.stringify(ids) === JSON.stringify([A, B]), `stopped ${JSON.stringify(ids)}`);
      const later = await req(A, { kind: 'snapshot' });
      assert(!later.ok && later.stopped === true && /pressed Stop/.test(later.error), JSON.stringify(later));
      await sleep(1500);
      const log = await fetchJson('/__marker-log');
      const formDocs = log.filter((e) => /tab=F/.test(e.href));
      assert(formDocs.length && formDocs.at(-1).present === false, `marker still up after Stop: ${JSON.stringify(formDocs.slice(-3))}`);
      return `stopped: ${ids.join(', ')}; marker removed`;
    });

    await check('end: runs forgotten; a new run re-attaches with fresh history', async () => {
      sendFrame({ type: 'end', threadId: A });
      sendFrame({ type: 'end', threadId: B });
      await sleep(500);
      const listing = ok(await req(A, { kind: 'tabs' }));
      assert(!/yours/.test(listing.text), 'ended run still owns tabs');
      const c = ok(await req(C, { kind: 'console', tab: formTab }));
      const again = /Stem attached at (\d\d:\d\d:\d\d)/.exec(c.text);
      assert(again && again[1] > firstAttach, `not a fresh attach: ${again && again[1]} vs ${firstAttach}`);
      const n = await evalIn(C, formTab, 'document.querySelectorAll("stem-marker").length');
      assert(n === 1, `markers: ${n}`);
      sendFrame({ type: 'end', threadId: C });
      sendFrame({ type: 'end', threadId: A });
      await sleep(1500);
      const log = await fetchJson('/__marker-log');
      const formDocs = log.filter((e) => /tab=F/.test(e.href));
      assert(formDocs.at(-1).present === false, 'marker left behind after end');
      return c.text;
    });

    await check('stale and unknown refs say so', async () => {
      const r = await req(C, { kind: 'click', tab: formTab, ref: 'e3' });
      assert(!r.ok && r.error === 'Ref e3 is stale: take a new snapshot.', JSON.stringify(r));
      sendFrame({ type: 'end', threadId: C });
      return r.error;
    });

    out.status = checks.every((c) => c.ok) ? 'passed' : 'failed';
  } catch (e) {
    out.status = 'failed';
    out.error = String((e && e.stack) || e);
  }
  out.stoppedMessages = stopped;
  save();
  await sleep(200);
  process.exit(0);
}

// Last, so every module-level constant above is initialised first.
if (process.argv[2] === '--native-host') {
  await nativeHost(process.argv[3]);
} else {
  await main();
}

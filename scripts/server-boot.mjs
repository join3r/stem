// The headless tripwire: boot `stem-server` under plain `node`, on a filesystem
// with no `electron` to resolve, and make it answer real calls over its real
// transport.
//
// WHY THIS EXISTS, and why the ESLint rule next to it is not enough.
//
// `src/server` must not depend on Electron — that is the whole property the
// Phase 1 split bought, and the thing that makes a VPS deployment a packaging
// question rather than a rewrite. A lint rule checks import specifiers, which
// means it sees `import { app } from 'electron'` and nothing else: an `electron`
// import reached through a barrel file, a re-export, or a dynamic
// `await import('electron')` satisfies every static rule anybody writes. It also
// only ever sees the files it was pointed at, so a dependency that grows an
// Electron import in a later npm install is invisible to it.
//
// A process is not fooled by any of that. This script copies the BUILT output
// into a throwaway directory with no node_modules anywhere above it — so
// `electron` genuinely cannot be resolved, exactly as on a server — starts
// dist/main/server.js there with plain `node`, and then talks to it. If anything
// under src/server has picked up Electron by any route, the boot dies here.
//
// The copy is the load-bearing part. Running dist/main/server.js from inside the
// repo would find node_modules/electron, whose plain-Node export is a harmless
// path string — so a stray import would resolve, hand back `undefined` for `app`,
// and fail much later somewhere unrelated. The tripwire has to be a machine that
// does not have Electron on it.
//
// Hermetic by construction: STEM_E2E puts the scripted FakeBackend behind the
// seam, so there is no pi spawn, no auth and no network. What is under test is
// the server's boot path and its transport, not the model.
//
// It then does the migration for real, because the migration is a thing that
// happens between PROCESSES and cannot be told apart from a working one inside a
// single test runner: export the running server's state to an archive, refuse to
// unpack it over itself, unpack it into a state root that has never been used,
// and serve THAT — pairing a fresh device with it and asking it for the folder
// the first server made.
//
// And then it does the whole thing again in the container it will actually run
// in — the image built from this repo's Dockerfile, behind the real Caddyfile,
// reached over the Unix socket the two share and nothing else. That half needs
// Docker; when there is none it says so loudly and skips, rather than failing a
// suite whose other 50 checks have nothing to do with containers.
//
//   npm run test:server          # locally, same thing CI runs
//   STEM_SKIP_DOCKER=1 npm run test:server   # the first half only
import { spawn } from 'node:child_process';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = join(root, 'dist', 'main', 'server.js');

/** Generous: a cold boot writes the workspace, the recall DB and the registry. */
const BOOT_TIMEOUT_MS = 60_000;
/** How long to wait for the turn started over /rpc to stream and settle. */
const TURN_TIMEOUT_MS = 30_000;

const checks = [];
let failed = 0;

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

function fatal(message) {
  console.error(`\n[server-boot] ${message}`);
  process.exit(1);
}

// -- the isolated machine -----------------------------------------------------

if (!existsSync(ENTRY)) {
  console.log('[server-boot] no dist/main/server.js — building first');
  const build = spawn('npx', ['electron-vite', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  const code = await new Promise((resolve) => build.on('exit', resolve));
  if (code !== 0) fatal('the build failed; nothing to boot');
}

const sandbox = mkdtempSync(join(tmpdir(), 'stem-server-boot-'));
const appDir = join(sandbox, 'app');
const stateDir = join(sandbox, 'state');
/** Where the exported Stem is unpacked — a state root that has never been used. */
const secondState = join(sandbox, 'moved');
const archive = join(sandbox, 'stem-export.tar');
/** The passphrase file, standing in for the Docker secret at /run/secrets/stem_key. */
const keyFile = join(sandbox, 'stem_key');
/** What is in it. Written with a trailing newline, the way `echo` would write it. */
const PASSPHRASE = 'a passphrase for the container';
// Written before anything boots, because the server reads it at first use: with
// a key file present the headless host wraps its data key under this passphrase
// instead of degrading to plaintext, which is the whole of what a container has
// instead of a keychain. Every process below therefore runs the way the deployed
// one does.
writeFileSync(keyFile, `${PASSPHRASE}\n`, { mode: 0o600 });

// dist + package.json and nothing else. package.json comes along for its `type:
// "module"` (without it Node reads the bundle as CommonJS) and its version.
cpSync(join(root, 'dist'), join(appDir, 'dist'), { recursive: true });
cpSync(join(root, 'package.json'), join(appDir, 'package.json'));

// A clean environment: the developer running this locally may well have STEM_*
// pointing at their real profile, and the server must not touch it. Written as a
// function of the state root because there are two of them now — the one this
// boots, and the one the export is unpacked into further down.
function envFor(dir) {
  return {
    PATH: process.env.PATH,
    HOME: sandbox,
    TMPDIR: process.env.TMPDIR,
    SystemRoot: process.env.SystemRoot,
    STEM_STATE_DIR: dir,
    STEM_RECALL_DB: join(dir, 'recall.sqlite'),
    STEM_FILES_DIR: join(dir, 'files'),
    STEM_TASKS_STORE: join(dir, 'tasks.json'),
    STEM_KEY_FILE: keyFile,
    STEM_E2E: '1'
  };
}

/**
 * Unwrap a `STEMKEY1` envelope — the format src/server/host/passphrase-key.ts
 * writes, reimplemented here in twelve lines on purpose.
 *
 * This script runs on a machine with no node_modules and cannot import the
 * module under test, which turns out to be the right shape for this particular
 * check: the envelope is a compatibility contract between an archive written on
 * a Mac today and a container that opens it later, and a contract verified by
 * calling the same function that wrote it verifies nothing. If a change to that
 * file ever breaks this, the archive it broke is somebody's only copy.
 */
function unwrapKeyFile(bytes, passphrase) {
  if (bytes.subarray(0, 8).toString('ascii') !== 'STEMKEY1') throw new Error('not a STEMKEY1 envelope');
  const salt = bytes.subarray(8, 24);
  const iv = bytes.subarray(24, 36);
  const tag = bytes.subarray(36, 52);
  const key = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(bytes.subarray(52)), decipher.final()]).toString('utf8');
}

/** Decrypt one `stemenc:1:` field value with the data key, the way the bridge does. */
function decryptSecretValue(keyHex, value) {
  const raw = Buffer.from(value.split(':').slice(2).join(':'), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
const env = envFor(stateDir);

/**
 * Run one of stem-server's subcommands to completion and hand back what it said.
 * They are the deployment's whole interface — a person on an ssh session types
 * these — so they are exercised as processes, with their exit codes, and not by
 * calling into the module they happen to live in.
 */
function runServerCommand(args, commandEnv) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, ['dist/main/server.js', ...args], {
      cwd: appDir,
      env: commandEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let text = '';
    for (const pipe of [proc.stdout, proc.stderr]) {
      pipe.setEncoding('utf8');
      pipe.on('data', (chunk) => {
        text += chunk;
      });
    }
    proc.on('exit', (code) => resolve({ code, output: text }));
  });
}

// Before booting anything: the built layout the main bundle's own sibling joins
// depend on. Several modules locate an artifact relative to `import.meta.url`
// (the embed/scan workers, recall-mcp-server, pi-node-shim, the bridge
// extension), which is only correct while every module of the main bundle sits
// directly in dist/main. Rollup emits shared chunks into a chunks/ subdirectory
// by default and hoists a module there the moment two entries share it — which
// is what the standalone server entry made possible. That failure surfaces at
// runtime as ERR_MODULE_NOT_FOUND for a file nobody wrote, on a path the e2e
// suite never walks, so it is asserted here where the build output is in hand.
const distMain = join(appDir, 'dist', 'main');
for (const rel of ['embed-worker.js', 'scan-worker.js', 'recall-mcp-server.js', 'pi/pi-node-shim.mjs', 'pi/stem-mcp-extension.mjs']) {
  check(`${rel} sits where its sibling join expects it`, existsSync(join(distMain, rel)));
}
check(
  'no chunks/ subdirectory — sibling joins would resolve one level too deep from inside one',
  !existsSync(join(distMain, 'chunks'))
);

console.log(`[server-boot] booting ${join(appDir, 'dist/main/server.js')}`);
console.log(`[server-boot] state ${stateDir}`);

const child = spawn(process.execPath, ['dist/main/server.js'], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });

let output = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  output += chunk;
  process.stdout.write(`  [server] ${chunk}`);
});
child.stderr.on('data', (chunk) => {
  output += chunk;
  process.stderr.write(`  [server] ${chunk}`);
});

let exited = null;
child.on('exit', (code, signal) => {
  exited = { code, signal };
});

// The finally block below stops the server on every path this script takes to its
// own end — but not on the paths taken FOR it. Ctrl-C, a killed CI step, or a
// closed terminal all end this process without unwinding, and the server, being a
// child rather than a process group, simply carries on: a stem-server left
// listening on a port with a pi backend under it, which is exactly what happened
// once and went unnoticed for half an hour. These handlers are the backstop.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!exited) child.kill('SIGKILL');
    process.exit(1);
  });
}
process.on('exit', () => {
  if (!exited) child.kill('SIGKILL');
});

/** The line stem-server prints once it is listening — its whole interface. */
function boundUrl() {
  return /\[stem-server\] listening on (\S+)/.exec(output)?.[1] ?? null;
}

async function waitForBoot() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = boundUrl();
    if (url) return url;
    if (exited) {
      // The interesting failure. An `electron` import that survived into
      // src/server lands here, as ERR_MODULE_NOT_FOUND, before anything listens.
      fatal(
        `stem-server exited before it listened (code ${exited.code}, signal ${exited.signal}).\n` +
          'If that is ERR_MODULE_NOT_FOUND for "electron", something under src/server now imports it — ' +
          'directly or through something it imports. Route the capability through src/server/host instead.'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  fatal(`stem-server never printed a listening address within ${BOOT_TIMEOUT_MS}ms`);
}

const url = await waitForBoot();

// -- talking to it ------------------------------------------------------------

/**
 * A credential, obtained the way a device with no access to this server's disk
 * has to: by spending the one-shot code the server printed when it found its
 * registry empty. That makes the whole pairing path — code minted at boot, POST
 * /pair, a device record written, a token that then works — part of the tripwire
 * rather than something only the desktop's own tests ever walk.
 *
 * The registry itself is checked afterwards, and what matters is what is NOT in
 * it: no token, anywhere, in any record.
 */
async function pair() {
  // The banner is printed just after the listening line waitForBoot() returned on.
  const deadline = Date.now() + 10_000;
  let code = null;
  while (!code && Date.now() < deadline) {
    code = /\[stem-server\] pairing code: (\S+)/.exec(output)?.[1] ?? null;
    if (!code) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!code) fatal('the server booted with an empty registry but printed no pairing code');
  const res = await fetch(`${url}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(30_000)
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok || !body.result?.token) {
    fatal(`POST /pair refused the code the server itself printed: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body.result;
}

const grant = await pair();
check('POST /pair mints a device for a valid code', typeof grant.token === 'string' && !!grant.deviceId);

// A code is spent when it is used. Replaying the same one must not produce a
// second device — that is the difference between a pairing code and a password.
const replay = await fetch(`${url}/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: /\[stem-server\] pairing code: (\S+)/.exec(output)[1] }),
  signal: AbortSignal.timeout(30_000)
});
check('a spent pairing code is refused the second time', replay.status === 401, `HTTP ${replay.status}`);

// The property the whole registry rewrite is for: what is on disk cannot be used
// to authenticate. If a token ever appears here again, this check is the alarm.
const registry = JSON.parse(readFileSync(join(stateDir, 'devices.json'), 'utf8'));
check('the registry holds a record for the paired device', registry.devices.length === 1, `${registry.devices.length} records`);
check(
  'no record contains a token — only its hash',
  registry.devices.every((d) => !d.token && /^[0-9a-f]{64}$/.test(d.tokenHash ?? '')),
  JSON.stringify(registry.devices[0] ?? {}).slice(0, 120)
);
check(
  'the token is not recoverable from the registry',
  !readFileSync(join(stateDir, 'devices.json'), 'utf8').includes(grant.token)
);

const auth = { authorization: `Bearer ${grant.token}` };

async function rpc(channel, args = [], { headers = auth } = {}) {
  const res = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ channel, args }),
    signal: AbortSignal.timeout(30_000)
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

let sse = null;
try {
  // The event stream, opened BEFORE the turn that has to arrive on it.
  const events = [];
  /** `event:`-named frames — what the stream says about itself, not about a turn. */
  const controls = [];
  const streamRes = await fetch(`${url}/events`, { headers: { ...auth, accept: 'text/event-stream' } });
  check('GET /events opens a stream', streamRes.status === 200, `HTTP ${streamRes.status}`);
  sse = streamRes.body.getReader();
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await sse.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf('\n\n');
        while (split !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          // `<epoch>.<seq>`: the sequence restarts at 1 on every boot, so the
          // frames of one run have to be distinguishable from another's.
          const id = /^id: \w+\.(\d+)$/m.exec(block)?.[1];
          // Control frames (`snapshot`, `resync`) are about the stream rather
          // than about anything that happened, and are collected separately —
          // they carry no {channel, payload} and no place in the sequence.
          const name = /^event: (\S+)$/m.exec(block)?.[1];
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice(6))
            .join('\n');
          if (data) {
            try {
              const parsed = JSON.parse(data);
              if (name) controls.push({ name, data: parsed });
              else events.push({ id: id ? Number(id) : null, ...parsed });
            } catch {
              // A partial frame is the reader's problem, not a failure.
            }
          }
          split = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // The stream is torn down at the end of the run; that is not an error.
    }
  })();

  // -- the registry is the surface --
  const channelsRes = await fetch(`${url}/channels`, { headers: auth });
  const channels = (await channelsRes.json()).result ?? [];
  check('GET /channels answers with the registry', Array.isArray(channels) && channels.length > 50, `${channels.length} channels`);
  for (const expected of ['settings:get', 'chats:list', 'backend:startTurn', 'memory:activeFacts', 'mail:work']) {
    check(`  registry exposes ${expected}`, channels.includes(expected));
  }
  check(
    'client-owned channels are absent from the registry',
    !channels.includes('dialog:openFiles') &&
      !channels.includes('quickchat:reveal') &&
      !channels.includes('releaseNotes:get'),
    'a server has no native picker, no overlay window and no build of its own to announce'
  );

  // -- a handful of RPCs, over the real transport --
  const settings = await rpc('settings:get');
  check('settings:get returns the settings document', settings.status === 200 && !!settings.body?.result?.defaults, JSON.stringify(settings.body?.error ?? '').slice(0, 120));

  const status = await rpc('runtime:status');
  check('runtime:status answers', status.status === 200 && status.body?.ok === true);

  const mailWork = await rpc('mail:work', ['unknown-mail']);
  check('mail:work reads history over the authenticated transport',
    mailWork.status === 200 && Array.isArray(mailWork.body?.result?.groups) && mailWork.body.result.groups.length === 0);
  const invalidWork = await rpc('mail:work', [42]);
  check('mail:work rejects an invalid conversation id', invalidWork.status === 400);

  const chats = await rpc('chats:list');
  check('chats:list answers with an empty workspace', status.status === 200 && Array.isArray(chats.body?.result?.chats), `${chats.body?.result?.chats?.length ?? '?'} chats`);

  // -- a real turn, end to end, with the reply arriving on the SSE stream --
  const thread = await rpc('backend:createThread');
  const threadId = thread.body?.result;
  check('backend:createThread mints a thread', typeof threadId === 'string' && !!threadId, String(threadId));

  const turn = await rpc('backend:startTurn', [{ threadId, input: 'headless hello', surface: 'main' }]);
  check('backend:startTurn accepts a turn', turn.status === 200 && turn.body?.ok === true, JSON.stringify(turn.body?.error ?? '').slice(0, 120));

  const turnDeadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < turnDeadline && !events.some((e) => e.payload?.method === 'turn/completed')) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const backendEvents = events.filter((e) => e.channel === 'backend:event');
  check('the turn streamed back over SSE', backendEvents.length > 0, `${backendEvents.length} backend:event frames`);
  check('the turn completed', backendEvents.some((e) => e.payload?.method === 'turn/completed'));
  const ids = events.map((e) => e.id);
  check(
    'every SSE frame carries a monotonic id',
    ids.length > 0 && ids.every((id, i) => Number.isInteger(id) && (i === 0 || id > ids[i - 1])),
    `ids ${ids[0]}..${ids[ids.length - 1]}`
  );
  // The stream announces what is already running before it sends anything that
  // happened — the whole reason a client can come back mid-turn and know it.
  const snapshot = controls[0];
  check(
    'the stream opens with a live-turn snapshot',
    snapshot?.name === 'snapshot' && Array.isArray(snapshot.data?.liveTurns),
    `${controls.length} control frame(s), first ${snapshot?.name ?? 'none'}`
  );

  const listed = await rpc('chats:list');
  check('the thread joined the chat list', (listed.body?.result?.chats ?? []).some((c) => c.threadId === threadId));

  // -- and the gates are on --
  const anonymous = await rpc('settings:get', [], { headers: {} });
  check('an unauthenticated call is refused', anonymous.status === 401, `HTTP ${anonymous.status}`);
  const unknown = await rpc('definitely:not:a:channel');
  check('an unregistered channel is refused', unknown.status >= 400 && unknown.body?.ok !== true, `HTTP ${unknown.status}`);

  // -- something worth carrying, made through the transport --
  const folder = await rpc('folders:create', ['Moved with me', null]);
  check(
    'folders:create makes a folder',
    folder.status === 200 && (folder.body?.result?.folders ?? []).some((f) => f.name === 'Moved with me'),
    JSON.stringify(folder.body?.error ?? folder.body?.result ?? '').slice(0, 120)
  );
  // And one file put where the user's Files live, because a folder is a row in a
  // JSON file and a file is bytes with a mode on them.
  mkdirSync(join(stateDir, 'workspace', 'files'), { recursive: true });
  writeFileSync(join(stateDir, 'workspace', 'files', 'carried.txt'), 'this should survive the move\n');
  // And a chat, written the way pi writes one: its first line records the folder
  // the session ran in. pi REFUSES to resume a session whose folder is gone, so
  // an import that carries this path through verbatim produces a Stem whose old
  // chats list perfectly and cannot be opened — which is exactly what happened,
  // and what killed every scheduled run on the server for days without a word in
  // any log. The check is on the other side of the move.
  mkdirSync(join(stateDir, 'pi-home', 'sessions'), { recursive: true });
  writeFileSync(
    join(stateDir, 'pi-home', 'sessions', 'moved.jsonl'),
    `${JSON.stringify({ type: 'session', version: 3, id: 'moved-chat', cwd: join(stateDir, 'workspace') })}\n` +
      `${JSON.stringify({ type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })}\n`
  );

  // -- and a signed-in tool, which is the thing that travels badly --
  //
  // Adding an MCP server with an Authorization header is what mints the data key
  // and writes the first ciphertext. Everything else in this script would look
  // identical whether the server encrypted its credentials or quietly fell back
  // to plaintext; this is the check that tells them apart, and it is the state
  // that the move either carries or silently destroys.
  const added = await rpc('mcp:add', [
    { name: 'fastmail', transport: 'http', url: 'https://api.fastmail.com/mcp', headers: { Authorization: 'Bearer real-token' } }
  ]);
  check('mcp:add registers a server with a credential', added.status === 200 && added.body?.ok === true, JSON.stringify(added.body?.error ?? '').slice(0, 160));

  const mcpConfig = JSON.parse(readFileSync(join(stateDir, 'pi-home', 'mcp.json'), 'utf8'));
  const storedHeader = mcpConfig.servers?.fastmail?.headers?.Authorization ?? '';
  check(
    'the credential went to disk encrypted, not in the clear',
    storedHeader.startsWith('stemenc:1:') && !storedHeader.includes('real-token'),
    storedHeader.slice(0, 40)
  );
  // The headless host had no keychain and one key file, which is exactly what a
  // container has. STEMKEY1 is the passphrase envelope; anything else here means
  // it took the plaintext fallback with a key file sitting right there.
  const wrappedKey = readFileSync(join(stateDir, 'pi-home', 'secret.key'));
  check(
    'the data key is wrapped under the passphrase in the key file',
    wrappedKey.subarray(0, 8).toString('ascii') === 'STEMKEY1',
    wrappedKey.subarray(0, 8).toString('ascii')
  );
  check(
    '  and the passphrase in that file opens it',
    /^[0-9a-f]{64}$/.test(unwrapKeyFile(wrappedKey, PASSPHRASE))
  );

  // -- the export, taken WHILE the server is running --
  //
  // Which is the normal case and the awkward one: recall.sqlite has an open
  // write-ahead log at this moment, so this is the check that the snapshot the
  // exporter takes is a database and not a torn copy of one. Running it as its
  // own process is the other half — `stem-server export` has to work on a machine
  // with no Electron, which is the machine it will actually be run on.
  writeFileSync(keyFile, 'a passphrase for the container\n', { mode: 0o600 });
  const exported = await runServerCommand(['export', archive, '--key-file', keyFile], envFor(stateDir));
  check('stem-server export writes an archive', exported.code === 0, exported.output.slice(-200));
  check('the archive exists', existsSync(archive), archive);
  check('the export says what it left behind', /left behind on purpose/.test(exported.output));
} finally {
  // -- and it stops when asked --
  await sse?.cancel().catch(() => {});
  const stopped = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const stoppedCleanly = await Promise.race([
    stopped.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 15_000))
  ]);
  if (!stoppedCleanly) child.kill('SIGKILL');
  check('SIGTERM shuts the server down', stoppedCleanly);
  check('shutdown was graceful', /\[stem-server\] SIGTERM — shutting down/.test(output));
}

// -- the move, in three more processes ----------------------------------------
//
// The archive written above, unpacked into a state root that has never been used,
// and then SERVED. Nothing in this section touches the first server: it is over,
// and what is left is a file. That is the whole claim the export makes — you can
// pick Stem up, put it somewhere else, and it is still your Stem — and the only
// way to check it is to finish the journey.

if (existsSync(archive)) {
  // Refusing first. Unpacking over a state root somebody has used would merge two
  // Stems file by file, so the refusal is not a nicety, and the message has to
  // name what it found or nobody can act on it.
  const onTop = await runServerCommand(['import', archive, '--key-file', keyFile], envFor(stateDir));
  check('import refuses a state root that has been used', onTop.code !== 0, `exit ${onTop.code}`);
  check('  and says what it found there', /it already has .+ in it/.test(onTop.output), onTop.output.slice(-200));

  const imported = await runServerCommand(['import', archive, '--key-file', keyFile], envFor(secondState));
  check('import unpacks into an empty state root', imported.code === 0, imported.output.slice(-300));
  check(
    '  and says pairing is the next thing to do',
    /stem-server pair/.test(imported.output),
    imported.output.slice(-200)
  );

  // What must NOT have travelled. The registry and this client's credential are
  // the two that would be actively wrong on another machine.
  for (const absent of ['devices.json', 'client.json', 'server.json', 'stem.log']) {
    check(`  ${absent} did not travel`, !existsSync(join(secondState, absent)));
  }
  check(
    '  the Files folder did',
    readFileSync(join(secondState, 'workspace', 'files', 'carried.txt'), 'utf8').trim() === 'this should survive the move'
  );
  // The chat came over pointing at THIS state root's workspace, not the one it
  // was written in. pi will not resume a session whose recorded folder is gone,
  // so a chat that keeps the old path is a chat nobody can open again.
  {
    const moved = readFileSync(join(secondState, 'pi-home', 'sessions', 'moved.jsonl'), 'utf8').split('\n');
    const header = JSON.parse(moved[0]);
    check(
      '  a chat from the old machine points at this workspace',
      header.cwd === join(secondState, 'workspace'),
      header.cwd
    );
    check('  and the conversation under it is untouched', JSON.parse(moved[1]).message.role === 'user');
  }

  // The database the first server was writing to while the snapshot was taken.
  // A torn copy opens and answers nothing; this asks it for the same number of
  // rows the original had.
  const rowsIn = (dir) => {
    const db = new DatabaseSync(join(dir, 'recall.sqlite'), { readOnly: true });
    try {
      return db.prepare('SELECT count(*) AS n FROM messages').get().n;
    } finally {
      db.close();
    }
  };
  const before = rowsIn(stateDir);
  check('the memory database survived being copied out from under a live server', rowsIn(secondState) === before, `${before} messages`);

  // The seam that fails silently. The data key arrives re-wrapped, and if the
  // passphrase that opens it here is not byte-for-byte the one the key file
  // holds, the next server to boot mints a fresh key over the top and every
  // signed-in tool in the archive becomes ciphertext nobody can read — with no
  // error, on a machine the user has just moved to.
  const movedKey = readFileSync(join(secondState, 'pi-home', 'secret.key'));
  const movedConfig = JSON.parse(readFileSync(join(secondState, 'pi-home', 'mcp.json'), 'utf8'));
  check(
    'the moved Stem still has the tool it was signed in to',
    !!movedConfig.servers?.fastmail,
    Object.keys(movedConfig.servers ?? {}).join(', ')
  );
  check(
    "and the passphrase from the key file opens that Stem's credentials on the other side",
    decryptSecretValue(unwrapKeyFile(movedKey, PASSPHRASE), movedConfig.servers.fastmail.headers.Authorization) ===
      'Bearer real-token'
  );

  // -- and now serve it --
  const second = spawn(process.execPath, ['dist/main/server.js'], {
    cwd: appDir,
    env: envFor(secondState),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let secondOutput = '';
  for (const pipe of [second.stdout, second.stderr]) {
    pipe.setEncoding('utf8');
    pipe.on('data', (chunk) => {
      secondOutput += chunk;
      process.stdout.write(`  [moved] ${chunk}`);
    });
  }
  let secondExited = null;
  second.on('exit', (code, signal) => {
    secondExited = { code, signal };
  });
  process.on('exit', () => {
    if (!secondExited) second.kill('SIGKILL');
  });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let secondUrl = null;
  while (!secondUrl && Date.now() < deadline && !secondExited) {
    secondUrl = /\[stem-server\] listening on (\S+)/.exec(secondOutput)?.[1] ?? null;
    if (!secondUrl) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  check('the imported Stem boots', !!secondUrl, secondUrl ? '' : `exited ${secondExited?.code ?? 'never listened'}`);

  if (secondUrl) {
    // An empty registry is what makes this print a code at all — which is the
    // strongest available evidence that no device came along with the archive.
    let movedCode = null;
    const codeDeadline = Date.now() + 10_000;
    while (!movedCode && Date.now() < codeDeadline) {
      movedCode = /\[stem-server\] pairing code: (\S+)/.exec(secondOutput)?.[1] ?? null;
      if (!movedCode) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check('the imported Stem has nothing paired with it yet', !!movedCode);

    if (movedCode) {
      const paired = await fetch(`${secondUrl}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: movedCode }),
        signal: AbortSignal.timeout(30_000)
      });
      const grantThere = (await paired.json().catch(() => null))?.result;
      check('a device can be paired with it', !!grantThere?.token);

      if (grantThere?.token) {
        const res = await fetch(`${secondUrl}/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${grantThere.token}` },
          body: JSON.stringify({ channel: 'chats:list', args: [] }),
          signal: AbortSignal.timeout(30_000)
        });
        const folders = (await res.json().catch(() => null))?.result?.folders ?? [];
        check(
          'the moved Stem serves the state that travelled with it',
          folders.some((f) => f.name === 'Moved with me'),
          JSON.stringify(folders).slice(0, 160)
        );
      }
    }
  }

  const secondStopped = new Promise((resolve) => second.once('exit', resolve));
  second.kill('SIGTERM');
  await Promise.race([secondStopped, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  if (!secondExited) second.kill('SIGKILL');
}

// -- and the same thing again, in the container it will actually run in --------
//
// Everything above proves the server has no Electron in it. This proves the
// image has no Electron in it EITHER, which is a different claim: the image
// installs its own node_modules on Linux (`--omit=dev`, so no electron package
// exists to import), builds its own bundle, binds a Unix socket instead of a
// port, and is reached only through Caddy in the next container. It is the
// deployment, end to end, on a machine that owns no domain.
//
// The three things a laptop cannot have are in deploy/docker-compose.test.yml —
// no certificate, no privileged ports, the fake backend — and nothing else about
// the compose files or the Caddyfile is changed, on purpose: a harness that
// assembles its own version of the deployment tests the harness.

/** The base image both stages of the Dockerfile start from. */
const BASE_IMAGE = 'node:24-bookworm-slim';

/**
 * Run a command with a deadline it cannot outlive, and hand back what it said.
 *
 * Detached, so the kill goes to the whole process GROUP. That is not belt and
 * braces: `docker` shells out to a credential helper, and on a machine where
 * that helper is waiting on a keychain nobody is there to unlock, killing docker
 * alone leaves the helper holding the pipes open and this function waiting on an
 * EOF that never comes. Every docker call below goes through here for that
 * reason — a tripwire that hangs is worse than one that says it did not run.
 */
function runBounded(command, args, { timeoutMs, env = process.env, cwd = root, onChunk } = {}) {
  return new Promise((resolveRun) => {
    const proc = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let timedOut = false;
    for (const pipe of [proc.stdout, proc.stderr]) {
      pipe.setEncoding('utf8');
      pipe.on('data', (chunk) => {
        text += chunk;
        onChunk?.(chunk);
      });
    }
    const cutoff = setTimeout(() => {
      timedOut = true;
      text += `\n[server-boot] gave up after ${Math.round(timeoutMs / 1000)}s\n`;
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // Already gone, or never started.
      }
    }, timeoutMs);
    cutoff.unref?.();
    const finish = (code) => {
      clearTimeout(cutoff);
      resolveRun({ code, output: text, timedOut });
    };
    proc.on('error', () => finish(null));
    // 'close' rather than 'exit': the pipes have to be drained before the output
    // is complete, and a killed group can deliver 'exit' first.
    proc.on('close', finish);
  });
}

/**
 * Whether this machine can actually build and run the deployment, and what to say
 * when it cannot.
 *
 * Three separate things have to be true, and they fail differently. A missing
 * daemon is somebody running the suite on a laptop; a missing compose plugin is a
 * half-installed Docker; a daemon that cannot reach a registry is a sandbox or an
 * offline machine — and that last one is the reason this probes rather than just
 * starting the build. `docker build` with no route to the registry does not fail,
 * it HANGS on "load metadata", and a tripwire that hangs for twenty minutes is
 * worse than one that says it is not running.
 */
async function dockerAvailability() {
  if (process.env.STEM_SKIP_DOCKER) return 'STEM_SKIP_DOCKER is set';
  const version = await runBounded('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 30_000 });
  if (version.code !== 0) return 'no Docker daemon is reachable from here';
  const compose = await runBounded('docker', ['compose', 'version'], { timeoutMs: 30_000 });
  if (compose.code !== 0) return 'Docker is here but `docker compose` is not';
  const registry = await runBounded('docker', ['manifest', 'inspect', BASE_IMAGE], { timeoutMs: 60_000 });
  if (registry.code !== 0) {
    return (
      `the Docker daemon could not resolve ${BASE_IMAGE}` +
      (registry.timedOut ? ' within 60s — no route to the registry, or a credential helper waiting on a locked keychain' : '')
    );
  }
  return null;
}

/**
 * A free TCP port on loopback, so two runs of this script cannot collide.
 * `listen` is asynchronous even for port 0 — `address()` is null until the
 * 'listening' event, so this has to wait for it rather than read straight back.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const dockerMissing = await dockerAvailability();

if (dockerMissing) {
  // Loud rather than silent. A containerized check that quietly stops running is
  // a deployment that quietly stops being tested, and the failure it would have
  // caught arrives on the day somebody is upgrading a live server.
  console.log('\n' + '='.repeat(78));
  console.log(`[server-boot] SKIPPING the containerized checks: ${dockerMissing}.`);
  console.log('[server-boot] The image, the Caddyfile, the Unix socket and the bind-mounted');
  console.log('[server-boot] state root are NOT covered by this run. Run it again on a machine');
  console.log('[server-boot] with Docker before deploying or upgrading a server.');
  console.log('='.repeat(78) + '\n');
} else {
  const port = await freePort();
  const containerState = join(sandbox, 'container-state');
  mkdirSync(containerState, { recursive: true });

  const composeFiles = ['-f', 'docker-compose.yml', '-f', 'deploy/docker-compose.test.yml'];
  const composeEnv = {
    ...process.env,
    // Its own project name, so this never collides with a Stem the developer is
    // actually running on this machine — and so `down -v` below takes only ours.
    COMPOSE_PROJECT_NAME: 'stem-boot-test',
    STEM_HOSTNAME: 'stem.localhost',
    // The host's own architecture. Production defaults to linux/amd64 (a VPS is
    // x86_64 unless it says otherwise); building for it from an Apple Silicon Mac
    // would go through QEMU and take an age, and what is under test is the
    // packaging rather than the instruction set.
    STEM_PLATFORM: process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64',
    STEM_STATE_ROOT: containerState,
    STEM_KEY_FILE: keyFile,
    STEM_TEST_PORT: String(port)
  };

  /**
   * One `docker compose` invocation. `timeoutMs` is a hard cap rather than a
   * courtesy: every step here can wait on something outside this machine, and a
   * hung step in CI is a job that gets cancelled twenty minutes later with no
   * output anybody can act on.
   */
  function compose(args, { quiet = false, timeoutMs = 120_000 } = {}) {
    return runBounded('docker', ['compose', ...composeFiles, ...args], {
      timeoutMs,
      env: composeEnv,
      onChunk: quiet ? undefined : (chunk) => process.stdout.write(`  [docker] ${chunk}`)
    });
  }

  /**
   * `/proc/net/tcp`'s `local_address` as something a person can read: the IP is
   * four little-endian hex bytes and the port is big-endian hex, so `0B00007F:0035`
   * is 127.0.0.11:53. A failure here names the listener it found, and a hex blob
   * would send whoever reads it back to the kernel docs to find out whose it is.
   */
  function decodeProcAddress(field) {
    const [ipHex, portHex] = String(field).split(':');
    const port = parseInt(portHex, 16);
    // v6 addresses are 32 hex digits; nothing here needs them spelled out in
    // full, only distinguished from the one v4 address we expect to see.
    if (ipHex?.length !== 8) return `${ipHex}:${port}`;
    const octets = [];
    for (let i = 6; i >= 0; i -= 2) octets.push(parseInt(ipHex.slice(i, i + 2), 16));
    return `${octets.join('.')}:${port}`;
  }

  /** One request through Caddy, with a Host header fetch() would not let us set. */
  function through(path, { method = 'GET', headers = {}, body, host = 'stem.localhost' } = {}) {
    return new Promise((resolveReq, rejectReq) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path, method, headers: { host, ...headers } },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => resolveReq({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
        }
      );
      req.setTimeout(30_000, () => req.destroy(new Error('timed out')));
      req.on('error', rejectReq);
      req.end(body);
    });
  }

  try {
    // The build is the slow part and the one that matters most: `npm ci` for the
    // production tree happens in here, on Linux, which is the only way
    // onnxruntime-node's compiled binary is ever the right one.
    console.log('\n[server-boot] building the image (first run downloads a Go toolchain for Caddy)');
    // Two npm installs and a Go build from cold. Fast on a warm cache, and the
    // cap is there for the case where something is wedged rather than slow.
    const built = await compose(['build'], { timeoutMs: 20 * 60_000 });
    check('the image builds', built.code === 0, built.output.slice(-400));

    if (built.code === 0) {
      // The move, into the container: the archive written further up, imported by
      // the same `stem-server import` an operator runs — with no --key-file,
      // because the Compose secret is already mounted where it looks by default.
      const importedThere = await compose(
        ['run', '--rm', '-v', `${sandbox}:/import:ro`, 'stem', 'node', 'dist/main/server.js', 'import', '/import/stem-export.tar'],
        { timeoutMs: 180_000 }
      );
      check('stem-server import runs in the container with no arguments but the archive', importedThere.code === 0, importedThere.output.slice(-400));
      check(
        '  and finds its passphrase in the Compose secret by itself',
        /\/run\/secrets\/stem_key/.test(importedThere.output),
        importedThere.output.slice(-200)
      );

      const up = await compose(['up', '-d']);
      check('the deployment comes up', up.code === 0, up.output.slice(-400));

      // Wait for the line the server prints when it is listening — which in here
      // names a socket, not a URL, because there is no port to name.
      let logs = '';
      const bootDeadline = Date.now() + 120_000;
      while (Date.now() < bootDeadline && !/listening on unix:/.test(logs)) {
        logs = (await compose(['logs', '--no-color', 'stem'], { quiet: true })).output;
        if (!/listening on unix:/.test(logs)) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      check('the server in the container listens on a Unix socket', /listening on unix:\/run\/stem\/stem\.sock/.test(logs), logs.slice(-300));

      // The claim the socket exists to make, checked at the kernel rather than
      // taken on trust: /proc/net/tcp lists every socket in this network
      // namespace, and state 0A is LISTEN. Nothing of Stem's may be among them.
      const listeners = await compose(['exec', '-T', 'stem', 'sh', '-c', 'cat /proc/net/tcp /proc/net/tcp6'], { quiet: true });
      const listening = listeners.output
        .split('\n')
        .filter((line) => / 0A /.test(line))
        .map((line) => decodeProcAddress(line.trim().split(/\s+/)[1]))
        // 127.0.0.11 is the daemon's own embedded DNS resolver, which Docker puts
        // in every container on a user-defined network before the image's own
        // process starts. It is not ours, we cannot switch it off, and it answers
        // only inside this namespace — so the claim being made is about Stem, not
        // about the namespace being empty.
        .filter((addr) => !addr.startsWith('127.0.0.11:'));
      check('the container has no TCP listener of its own — not even on loopback', listening.length === 0, listening.join(' '));

      // From here on everything goes through Caddy, over that socket. Stem
      // logging "listening" says nothing about the proxy in front of it: Caddy
      // starts in parallel, and a request sent the instant Stem is up arrives
      // before anything is accepting on the published port. So wait for the
      // refusals to stop, and let a proxy that never comes up fail as itself
      // rather than as whichever check happened to be first.
      let reachable = false;
      const proxyDeadline = Date.now() + 60_000;
      while (Date.now() < proxyDeadline && !reachable) {
        reachable = await through('/channels')
          .then(() => true)
          .catch(() => false);
        if (!reachable) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      check('Caddy accepts connections on the published port', reachable, (await compose(['logs', '--no-color', 'caddy'], { quiet: true })).output.slice(-400));

      const anonymous = await through('/channels');
      check('an unauthenticated call through Caddy is refused', anonymous.status === 401, `HTTP ${anonymous.status}`);

      // An imported state root has no devices, so the server prints a code.
      const codeThere = /\[stem-server\] pairing code: (\S+)/.exec(logs)?.[1] ?? null;
      check('the container prints a pairing code, so nothing came over paired', !!codeThere);

      let tokenThere = null;
      if (codeThere) {
        const paired = await through('/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: codeThere })
        });
        tokenThere = JSON.parse(paired.body || '{}')?.result?.token ?? null;
        check('a device pairs with it through Caddy', !!tokenThere, `HTTP ${paired.status} ${paired.body.slice(0, 160)}`);
      }

      if (tokenThere) {
        const auth = { authorization: `Bearer ${tokenThere}`, 'content-type': 'application/json' };

        // The DNS-rebinding check, from behind a proxy: Caddy passes the Host
        // header through untouched, and a name the deployment never declared in
        // STEM_TRUSTED_HOSTS is refused — by Stem, not by Caddy. It has to carry
        // a real token to prove that, because `gate()` in transport/server.ts
        // answers 401 before it ever looks at the Host, so an anonymous request
        // gets turned away for the wrong reason and proves nothing about origin.
        const wrongHost = await through('/channels', { host: 'stem.attacker.example', headers: auth });
        check(
          'a Host nobody declared is refused behind the proxy, token or no token',
          wrongHost.status === 403,
          `HTTP ${wrongHost.status} ${wrongHost.body.slice(0, 120)}`
        );

        const chats = await through('/rpc', {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ channel: 'chats:list', args: [] })
        });
        const folders = JSON.parse(chats.body || '{}')?.result?.folders ?? [];
        check(
          'the containerized Stem serves the state that was moved into it',
          folders.some((f) => f.name === 'Moved with me'),
          JSON.stringify(folders).slice(0, 160)
        );

        // The tool that travelled, still signed in — asked for through the same
        // wire a desktop would ask through.
        const servers = await through('/rpc', {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ channel: 'mcp:list', args: [] })
        });
        check(
          'and the tool it was signed in to came with it',
          /fastmail/.test(servers.body),
          servers.body.slice(0, 200)
        );

        // SSE through a reverse proxy is the thing that breaks quietly: a
        // buffering proxy holds every delta until the turn ends, which looks like
        // a slow model. The stream's first bytes are written at connect, so
        // getting them at all is the proof.
        const stream = await new Promise((resolveStream) => {
          const req = httpRequest(
            { host: '127.0.0.1', port, path: '/events', headers: { host: 'stem.localhost', ...auth, accept: 'text/event-stream' } },
            (res) => {
              res.setEncoding('utf8');
              res.once('data', (chunk) => {
                req.destroy();
                resolveStream({ status: res.statusCode, type: res.headers['content-type'] ?? '', first: chunk });
              });
            }
          );
          req.setTimeout(15_000, () => {
            req.destroy();
            resolveStream({ status: 0, type: '', first: '' });
          });
          req.on('error', () => resolveStream({ status: 0, type: '', first: '' }));
          req.end();
        });
        check(
          'the event stream flushes through Caddy rather than being buffered',
          stream.status === 200 && /text\/event-stream/.test(stream.type) && stream.first.length > 0,
          `HTTP ${stream.status} ${stream.type} ${JSON.stringify(stream.first.slice(0, 40))}`
        );

        // Encryption at rest, in the container, with the key file as its only
        // keyring — read out of the bind-mounted state root through the container
        // itself, because the files are 0600 and owned by root.
        const dump = (rel) =>
          compose(['exec', '-T', 'stem', 'sh', '-c', `base64 /var/lib/stem/state/${rel} | tr -d '\\n'`], { quiet: true }).then((r) =>
            Buffer.from(r.output.trim(), 'base64')
          );
        const keyThere = await dump('pi-home/secret.key');
        check(
          "the container's data key is wrapped under the Compose secret",
          keyThere.subarray(0, 8).toString('ascii') === 'STEMKEY1',
          keyThere.subarray(0, 8).toString('ascii')
        );
        const configThere = JSON.parse((await dump('pi-home/mcp.json')).toString('utf8'));
        check(
          '  and the credential that travelled opens with it, in the container',
          decryptSecretValue(unwrapKeyFile(keyThere, PASSPHRASE), configThere.servers.fastmail.headers.Authorization) ===
            'Bearer real-token'
        );
      }

      // Caddy's rate limit — which is the whole reason it is a custom build.
      const modules = await compose(['exec', '-T', 'caddy', 'caddy', 'list-modules'], { quiet: true });
      check('Caddy was built with the rate-limit module', /http\.handlers\.rate_limit/.test(modules.output));

      // …and it is actually applied to /pair. Left until last: it costs the
      // budget for a minute, and everything above needed that route working.
      const statuses = [];
      for (let i = 0; i < 12; i++) {
        const res = await through('/pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: 'WRONGCOD' })
        });
        statuses.push({ status: res.status, body: res.body });
      }
      // Caddy answers 429 with an empty body; Stem's own attempt lockout answers
      // 429 with JSON. Distinguishing them is what says WHICH one refused.
      check(
        'the proxy turns away a burst on /pair before Stem ever sees it',
        statuses.some((r) => r.status === 429 && !r.body.includes('"ok"')),
        statuses.map((r) => r.status).join(',')
      );
    }
  } finally {
    // -v: the socket volume, the model cache and Caddy's certificate store are
    // this test's, and a run that left them behind would hand the next one a
    // state it did not create.
    await compose(['down', '-v', '--remove-orphans'], { quiet: true });
  }
}

try {
  rmSync(sandbox, { recursive: true, force: true });
} catch (e) {
  // The container writes into the bind-mounted state root as root, so on Linux
  // this directory is not ours to remove. Worth saying, never worth failing over
  // — the checks have already run, and /tmp is /tmp.
  console.log(`[server-boot] left ${sandbox} behind (${String(e?.message ?? e)})`);
}

console.log(`\n[server-boot] ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);

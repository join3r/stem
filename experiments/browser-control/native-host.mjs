// Scripted native peer for a feasibility test, not Stem's production helper.
// Browser-created stdin/stdout are the ONLY control transport. No socket listener.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (process.argv[3] !== `chrome-extension://${config.extensionId}/`) process.exit(2);
let buffer = Buffer.alloc(0);
const pending = new Map();
let started = false;
const checks = [];
const evidence = { transport: 'browser-created native messaging pipes', checks };

function send(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > 1024 * 1024) throw new Error('Native message too large');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(bytes.length);
  process.stdout.write(Buffer.concat([prefix, bytes]));
}

function call(op, args = {}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${op} timed out`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    send({ id, op, ...args });
  });
}

async function check(name, fn) {
  await fn();
  checks.push(name);
  await writeFile(config.resultPath, JSON.stringify({ ...evidence, status: 'running' }, null, 2));
}

async function scenario(hello) {
  evidence.browser = hello.userAgent;
  evidence.extensionId = hello.extensionId;
  assert.equal(hello.extensionId, config.extensionId);
  let tabId;
  await check('Native Messaging handshake and tab enumeration', async () => {
    let fixture;
    // onInstalled can run before Chrome has navigated its launch tab.
    for (let attempt = 0; attempt < 100 && !fixture; attempt++) {
      const tabs = await call('list');
      fixture = tabs.find((tab) => tab.url === `${config.origin}/existing`);
      if (!fixture) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(fixture, 'The pre-existing fictional tab is listed');
    await assert.rejects(call('inspect', { tabId: fixture.id }), /need a browser grant/);
  });
  await check('Native peer cannot grant itself access', async () => {
    await assert.rejects(call('grant', { tabId: 1 }), /Unsupported operation/);
  });
  await check('Internal and script URLs are rejected', async () => {
    await assert.rejects(call('open', { url: 'chrome://settings' }), /ordinary web pages/);
    await assert.rejects(call('open', { url: 'javascript:alert(1)' }), /ordinary web pages/);
  });
  await check('Open a background tab and inspect its existing session', async () => {
    ({ tabId } = await call('open', { url: `${config.origin}/form` }));
    const page = await call('inspect', { tabId });
    assert.match(page.text, /Fictional browser fixture/);
    assert.match(page.text, /Existing session: fictional/);
  });
  await check('Fill a form and click a fixture control', async () => {
    await call('fill', { tabId, selector: '#name', value: 'Ada Example' });
    await call('clickFixture', { tabId, selector: '#greet' });
    assert.match((await call('inspect', { tabId })).text, /Hello Ada Example/);
  });
  await check('Capture a PNG through extension CDP', async () => {
    const { png } = await call('screenshot', { tabId });
    const bytes = Buffer.from(png, 'base64');
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await writeFile(config.screenshotPath, bytes);
    evidence.screenshotBytes = bytes.length;
  });
  await check('Select and submit a fictional file, verifying the server received its content', async () => {
    await call('uploadFixture', { tabId, fixturePath: config.fixturePath });
    const page = await call('inspect', { tabId });
    assert.deepEqual(page.fields.find((field) => field.id === 'upload').value, ['fictional-upload.txt']);
    await call('clickFixture', { tabId, selector: '#upload-submit' });
    let received = false;
    for (let attempt = 0; attempt < 50 && !received; attempt++) {
      received = (await call('inspect', { tabId })).text.includes('Uploaded fictional-upload.txt');
      if (!received) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(received, true, 'The local fixture server received the expected upload bytes');
  });
  await check('CDP text input produces trusted events, so isTrusted alone cannot identify human takeover', async () => {
    assert.deepEqual(await call('trustedInputFixture', { tabId }), [{ isTrusted: true }]);
  });
  await check('Download a fixture into the isolated download folder', async () => {
    const result = await call('downloadFixture', { tabId });
    assert.equal(result.filename, `${config.downloadsPath}/stem-browser-probe.txt`);
    assert.equal(await readFile(result.filename, 'utf8'), 'Fictional Stem download.\n');
  });
  await check('Reject a direct cross-origin navigation', async () => {
    await assert.rejects(call('navigate', { tabId, url: `${config.otherOrigin}/form` }), /Destination needs/);
  });
  await check('Same-origin child frames allow whole-tab screenshots', async () => {
    await call('navigate', { tabId, url: `${config.origin}/same-frame` });
    assert.ok((await call('screenshot', { tabId })).png.length > 0);
  });
  await check('Cross-origin child content is excluded from top-page text and screenshots', async () => {
    await call('navigate', { tabId, url: `${config.origin}/cross-frame` });
    const page = await call('inspect', { tabId });
    assert.doesNotMatch(page.text, /FRAME_ONLY_SECRET/);
    await assert.rejects(call('screenshot', { tabId }), /unapproved frame origin/);
  });
  await check('Cross-origin redirects revoke a tab grant', async () => {
    await call('navigate', { tabId, url: `${config.origin}/redirect` });
    await assert.rejects(call('inspect', { tabId }), /need a browser grant/);
  });
  await check('Stop revokes opened-tab access', async () => {
    ({ tabId } = await call('open', { url: `${config.origin}/form` }));
    await call('inspect', { tabId });
    await call('stop');
    await assert.rejects(call('inspect', { tabId }), /need a browser grant/);
  });
  await writeFile(config.resultPath, JSON.stringify({ ...evidence, status: 'passed' }, null, 2));
  process.exit(0);
}

function receive(message) {
  if (message.type === 'hello' && !started) {
    started = true;
    scenario(message).catch(async (error) => {
      await writeFile(config.resultPath, JSON.stringify({ ...evidence, status: 'failed', error: error.stack }, null, 2));
      process.exit(1);
    });
    return;
  }
  const request = pending.get(message.id);
  if (!request) return;
  clearTimeout(request.timer);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error));
  else request.resolve(message.result);
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (!length || length > 16 * 1024 * 1024) process.exit(3);
    if (buffer.length < 4 + length) return;
    const bytes = buffer.subarray(4, 4 + length);
    buffer = buffer.subarray(4 + length);
    try { receive(JSON.parse(bytes.toString('utf8'))); }
    catch { process.exit(3); }
  }
});
process.stdin.on('end', () => process.exit(0));

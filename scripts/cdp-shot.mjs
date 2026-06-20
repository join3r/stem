// Attach to the dev Electron renderer over CDP (port 9222) and save a PNG.
// Usage: node scripts/cdp-shot.mjs [outPath]
const out = process.argv[2] || '/tmp/stem-shot.png';
const port = 9223;

async function getPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return { ...page, webSocketDebuggerUrl: page.webSocketDebuggerUrl.replace('localhost', '127.0.0.1') };
    } catch {
      // dev server not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('No CDP page target after 60s');
}

const target = await getPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
});

await new Promise((resolve) => ws.addEventListener('open', resolve));
await send('Page.enable');
await send('Runtime.enable');
if (process.env.DARK) {
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
}
// Optionally run a JS expression (e.g. click a tab) before capturing.
if (process.argv[3]) {
  await send('Runtime.evaluate', { expression: process.argv[3] });
}
// give the renderer a moment to paint (override with WAIT=ms)
await new Promise((r) => setTimeout(r, Number(process.env.WAIT) || 1500));
const { data } = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync(out, Buffer.from(data, 'base64'));
console.log('saved', out);
ws.close();
process.exit(0);

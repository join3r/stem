import { TabGrants, requireSameOriginFrames, webOrigin } from './policy.mjs';

const grants = new TabGrants();
const attached = new Set();
const contexts = new Map();
let port;
let queue = Promise.resolve();
const command = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  if (method === 'Runtime.executionContextCreated') {
    const entries = contexts.get(tabId) ?? new Map();
    entries.set(params.context.id, params.context);
    contexts.set(tabId, entries);
  } else if (method === 'Runtime.executionContextDestroyed') {
    contexts.get(tabId)?.delete(params.executionContextId);
  } else if (method === 'Runtime.executionContextsCleared') contexts.delete(tabId);
});

function fixtureUrl(url) {
  webOrigin(url);
  if (new URL(url).hostname !== '127.0.0.1') throw new Error('This development probe only controls loopback fixtures');
}

async function detach(tabId) {
  if (!attached.delete(tabId)) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  if (frameId !== 0) return;
  grants.navigation(tabId, url);
  // Rechecking before each command is mandatory even if an event was missed.
});
chrome.tabs.onRemoved.addListener((tabId) => { grants.revoke(tabId); attached.delete(tabId); });
chrome.debugger.onDetach.addListener(({ tabId }) => {
  attached.delete(tabId);
  contexts.delete(tabId);
  grants.revoke(tabId); // A user stopping debugging must not be silently overridden.
});

async function ready(tabId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return tab;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Tab did not finish loading');
}

async function authorized(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const origin = grants.require(tab);
  fixtureUrl(tab.url);
  if (tab.status !== 'complete') throw new Error('Page is navigating; inspect again after it loads');
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached.add(tabId);
    await command(tabId, 'Page.enable');
    await command(tabId, 'Runtime.enable');
  }
  const { frameTree } = await command(tabId, 'Page.getFrameTree');
  if (frameTree.frame.securityOrigin !== origin) throw new Error('The document changed origin');
  return { origin, frameTree };
}

async function evaluate(tabId, expression) {
  const { origin, frameTree } = await authorized(tabId);
  const { executionContextId } = await command(tabId, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'Stem feasibility probe' });
  const context = contexts.get(tabId)?.get(executionContextId);
  if (!context?.uniqueId || context.auxData?.frameId !== frameTree.frame.id || context.origin !== origin) throw new Error('The inspected document context changed');
  // A globally unique context binds the evaluation to this document even if
  // navigation destroys/reuses a numeric executionContextId in another process.
  const answer = await command(tabId, 'Runtime.evaluate', { expression, uniqueContextId: context.uniqueId, returnByValue: true, awaitPromise: true });
  if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.text);
  return answer.result.value;
}

async function execute(request) {
  const { op, tabId } = request;
  if (op === 'list') return (await chrome.tabs.query({})).filter((tab) => !tab.incognito && tab.url?.startsWith('http://127.0.0.1:')).map(({ id, title, url }) => ({ id, title, url }));
  if (op === 'open') {
    fixtureUrl(request.url);
    const tab = await chrome.tabs.create({ url: request.url, active: false });
    grants.grantOpened(tab.id, request.url);
    await ready(tab.id);
    return { tabId: tab.id };
  }
  if (op === 'stop') {
    grants.clear();
    await Promise.all([...attached].map(detach));
    return { stopped: true };
  }
  if (op === 'inspect') return evaluate(tabId, `({title: document.title, text: document.body.innerText.slice(0, 8000), fields: [...document.querySelectorAll('input:not([type=password]),textarea')].map(e => ({id:e.id, value:e.type === 'file' ? [...e.files].map(f=>f.name) : e.value}))})`);
  if (op === 'fill') {
    return evaluate(tabId, `(() => {
      const e = document.querySelector(${JSON.stringify(request.selector)});
      if (!(e instanceof HTMLInputElement) && !(e instanceof HTMLTextAreaElement)) throw new Error('Expected a text field');
      if (e instanceof HTMLInputElement && !['text','email','search','url','tel'].includes(e.type)) throw new Error('This probe only fills ordinary text fields');
      const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(request.value)});
      e.dispatchEvent(new Event('input', {bubbles:true}));
      e.dispatchEvent(new Event('change', {bubbles:true}));
      return {filled:true};
    })()`);
  }
  // Fixture-only click. Production requires the agreed consequential-action
  // approval gate; this probe must never be registered as a trusted Stem tool.
  if (op === 'clickFixture') return evaluate(tabId, `(() => {
    const e = document.querySelector(${JSON.stringify(request.selector)});
    if (!e || !e.hasAttribute('data-stem-fixture')) throw new Error('Only fixture controls may be clicked by this probe');
    e.click(); return {clicked:true};
  })()`);
  if (op === 'screenshot') {
    const { origin, frameTree } = await authorized(tabId);
    requireSameOriginFrames(frameTree, origin);
    const shot = await command(tabId, 'Page.captureScreenshot', { format: 'png' });
    return { png: shot.data };
  }
  if (op === 'trustedInputFixture') {
    await evaluate(tabId, `(() => {
      const e = document.querySelector('#name');
      if (!e) throw new Error('Fixture field missing');
      globalThis.__stemProbeEvents = [];
      e.addEventListener('input', event => globalThis.__stemProbeEvents.push({isTrusted: event.isTrusted}), {once:true});
      e.focus();
    })()`);
    await authorized(tabId);
    await command(tabId, 'Input.insertText', { text: ' Native input' });
    return evaluate(tabId, 'globalThis.__stemProbeEvents');
  }
  if (op === 'uploadFixture') {
    await authorized(tabId);
    const { root } = await command(tabId, 'DOM.getDocument');
    const { nodeId } = await command(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][data-stem-fixture]' });
    if (!nodeId) throw new Error('Fixture upload field not found');
    await command(tabId, 'DOM.setFileInputFiles', { nodeId, files: [request.fixturePath] });
    return { selected: true };
  }
  if (op === 'downloadFixture') {
    const { origin } = await authorized(tabId);
    const url = new URL('/download-fixture', origin).href;
    const downloadId = await chrome.downloads.download({ url, filename: 'stem-browser-probe.txt', conflictAction: 'uniquify', saveAs: false });
    for (let attempt = 0; attempt < 100; attempt++) {
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (item?.state === 'complete') return { complete: true, filename: item.filename };
      if (item?.state === 'interrupted') throw new Error(item.error ?? 'Download interrupted');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Download timed out');
  }
  if (op === 'navigate') {
    const { origin } = await authorized(tabId);
    if (webOrigin(request.url) !== origin) throw new Error('Destination needs a browser grant');
    await chrome.tabs.update(tabId, { url: request.url });
    await ready(tabId);
    return { navigated: true };
  }
  throw new Error(`Unsupported operation: ${op}`);
}

function connect() {
  if (port) return;
  const connection = chrome.runtime.connectNative('com.stem.browser_probe');
  port = connection;
  connection.onMessage.addListener((message) => {
    queue = queue.then(async () => {
      if (port !== connection) return;
      try { connection.postMessage({ id: message.id, result: await execute(message) }); }
      catch (error) { connection.postMessage({ id: message.id, error: String(error.message ?? error) }); }
    }).catch(() => {});
  });
  connection.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message;
    if (error) console.warn(error);
    port = undefined;
    grants.clear();
    for (const tabId of attached) void detach(tabId);
  });
  connection.postMessage({ type: 'hello', userAgent: navigator.userAgent, extensionId: chrome.runtime.id });
}

chrome.action.onClicked.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);

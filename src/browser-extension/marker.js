/* global window, document, requestAnimationFrame, setInterval, clearInterval, setTimeout */

// The "Stem is working · Stop" marker drawn in a tab while a run acts in it.
//
// Three things about where it lives, each load-bearing:
//
// - It runs in a CDP isolated world (Page.addScriptToEvaluateOnNewDocument with
//   a worldName), not the page's own JavaScript world. The page shares the DOM
//   with it but none of its objects: it cannot call the marker's functions or
//   patch the prototypes the marker uses.
// - It draws inside a CLOSED shadow root, every style set inline with
//   !important, so the page's CSS can neither hide it nor restyle it, and page
//   script cannot reach the Stop button (host.shadowRoot is null from outside).
// - The Stop button calls a Runtime.addBinding function exposed ONLY in that
//   isolated world (executionContextName), which reaches the extension as
//   Runtime.bindingCalled. The page cannot call it, so it cannot fake a Stop,
//   and nothing new is exposed to it.
//
// The marker also takes itself down if the extension stops pinging it for
// EXPIRY_MS: a debugger detach the extension did not ask for (the user
// cancelling Chrome's debugging bar, the service worker dying) leaves no way to
// remove it explicitly, and a binding survives the detach, so silence is the
// only signal there is.

export const MARKER_WORLD = 'stem-marker';
export const MARKER_BINDING = 'stemMarkerStop';
/** The extension pings attached tabs this often… */
export const MARKER_PING_MS = 5_000;
/** …and the marker hides itself after this long without one. */
const EXPIRY_MS = 15_000;

/** Runs in the page's isolated world. Idempotent: a second call is a no-op. */
function installMarker(BINDING, EXPIRY) {
  if (window.top !== window) return;
  const g = globalThis;
  if (g.__stemMarker) return;
  const ACCENT = '#c79257';
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  const css = (el, props) => {
    for (const k of Object.keys(props)) el.style.setProperty(k, props[k], 'important');
  };
  let host = null;
  let pill = null;
  let label = null;
  let lastPing = Date.now();
  let capturing = false;
  let passthrough = false;
  let expired = false;
  let removed = false;
  let menuArmed = false;

  function build() {
    host = document.createElement('stem-marker');
    css(host, {
      all: 'initial',
      position: 'fixed',
      inset: '0',
      'z-index': '2147483647',
      'pointer-events': 'none',
      display: 'block',
      margin: '0',
      padding: '0',
      border: '0',
      background: 'transparent'
    });
    const root = host.attachShadow({ mode: 'closed' });
    const frame = document.createElement('div');
    css(frame, {
      position: 'fixed',
      inset: '0',
      border: `3px solid ${ACCENT}`,
      'box-shadow': 'inset 0 0 14px rgba(199, 146, 87, 0.45)',
      'box-sizing': 'border-box',
      'pointer-events': 'none'
    });
    pill = document.createElement('div');
    css(pill, {
      position: 'fixed',
      left: '50%',
      bottom: '14px',
      transform: 'translateX(-50%)',
      display: 'flex',
      'align-items': 'center',
      gap: '8px',
      padding: '5px 5px 5px 12px',
      'border-radius': '999px',
      background: 'rgba(30, 25, 21, 0.92)',
      color: '#fff',
      font: `500 12px/18px ${FONT}`,
      'letter-spacing': 'normal',
      'text-transform': 'none',
      'white-space': 'nowrap',
      'box-shadow': '0 4px 18px rgba(0, 0, 0, 0.28)',
      'pointer-events': 'auto',
      'user-select': 'none',
      cursor: 'default'
    });
    const dot = document.createElement('span');
    css(dot, { width: '8px', height: '8px', 'border-radius': '50%', background: ACCENT, display: 'inline-block' });
    label = document.createElement('span');
    label.textContent = 'Stem is working ·';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Stop';
    css(button, {
      all: 'unset',
      cursor: 'pointer',
      padding: '1px 11px',
      'border-radius': '999px',
      background: ACCENT,
      color: '#22150a',
      font: `600 12px/18px ${FONT}`
    });
    // Synthetic clicks are fine: the page's own script can't reach this button
    // (closed root, separate world), and a Stop is the safe direction anyway.
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      label.textContent = 'Stopping…';
      const fn = g[BINDING];
      if (typeof fn === 'function') fn('stop');
    });
    // Keep the page from seeing presses on the pill as outside clicks (closing
    // its menus) or starting drags.
    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
      pill.addEventListener(t, (e) => e.stopPropagation());
    }
    pill.append(dot, label, button);
    root.append(frame, pill);
  }

  function apply() {
    if (!host) return;
    css(host, { display: capturing || expired ? 'none' : 'block' });
    css(pill, { 'pointer-events': passthrough ? 'none' : 'auto' });
  }

  function mount() {
    if (removed) return;
    if (!host) build();
    const parent = document.documentElement;
    if (!parent) return;
    if (host.parentNode !== parent) parent.append(host);
    apply();
  }

  // A right-click Stem dispatches must not open the browser's own context
  // menu: on a Mac that is a native menu, visible over whatever the user is
  // doing. Armed only around Stem's clicks, after the page's own handlers ran.
  window.addEventListener('contextmenu', (e) => {
    if (menuArmed) e.preventDefault();
  });

  const timer = setInterval(() => {
    if (!expired && Date.now() - lastPing > EXPIRY) {
      expired = true;
      apply();
    }
    // The page replaced or emptied <html>'s children: put the marker back.
    if (!expired && host && host.parentNode !== document.documentElement) mount();
  }, 1000);

  const nextFrame = () =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve(true);
        }
      };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 120);
    });

  g.__stemMarker = {
    ping() {
      lastPing = Date.now();
      expired = false;
      mount();
      if (!pill || !host.isConnected) return null;
      const r = pill.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    },
    hide() {
      capturing = true;
      apply();
      return nextFrame();
    },
    show() {
      capturing = false;
      apply();
      return true;
    },
    passthrough(on) {
      passthrough = !!on;
      apply();
      return true;
    },
    armContextMenu(on) {
      menuArmed = !!on;
      return true;
    },
    remove() {
      removed = true;
      clearInterval(timer);
      if (host) host.remove();
      delete g.__stemMarker;
      return true;
    }
  };
  mount();
}

/** The marker's install script, as Page.addScriptToEvaluateOnNewDocument wants it. */
export const MARKER_SOURCE = `(${installMarker.toString()})(${JSON.stringify(MARKER_BINDING)}, ${EXPIRY_MS});`;

/**
 * Wire the marker into a freshly attached tab: the binding (scoped to the
 * marker's world), and the script for this document and every later one.
 */
export async function installMarkerHooks(send) {
  await send('Runtime.addBinding', { name: MARKER_BINDING, executionContextName: MARKER_WORLD });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: MARKER_SOURCE, worldName: MARKER_WORLD, runImmediately: true });
}

/**
 * Call the marker in the main frame's isolated world. `install` re-runs the
 * installer first (a ping after a navigation the script has not reached yet).
 * Page.createIsolatedWorld hands back the existing world for that name, so this
 * never stacks up worlds.
 */
export async function markerCall(send, frameId, call, { install = false } = {}) {
  const { executionContextId } = await send('Page.createIsolatedWorld', { frameId, worldName: MARKER_WORLD });
  const expression = `${install ? MARKER_SOURCE : ''}\n(globalThis.__stemMarker ? globalThis.__stemMarker.${call} : null)`;
  const r = await send('Runtime.evaluate', { expression, contextId: executionContextId, awaitPromise: true, returnByValue: true });
  return r && r.result ? r.result.value : null;
}

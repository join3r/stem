/* global chrome, document, setInterval */

// The toolbar popup: is Stem connected, what is it doing here, and Stop all.
// It holds no state of its own; it asks the service worker every second while
// open.

const $ = (id) => document.getElementById(id);

function render(state) {
  if (!state) return;
  $('version').textContent = `v${state.version}`;
  const status = $('status');
  const hint = $('hint');
  let text;
  let tone;
  hint.hidden = true;
  if (!state.port) {
    tone = 'off';
    text = 'Not connected to Stem';
    hint.hidden = false;
    hint.textContent = /not found|forbidden/i.test(state.lastError || '')
      ? 'Set up browser control in the Stem app (Settings → Features → Browser control) on this Mac.'
      : 'Is the Stem app installed on this Mac? This retries every 30 seconds.';
  } else if (state.host === false) {
    tone = 'warn';
    text = 'Stem app isn’t running';
  } else {
    tone = 'on';
    text = 'Connected to Stem';
  }
  status.dataset.tone = tone;
  $('status-text').textContent = text;

  const runs = state.runs || [];
  $('runs-section').hidden = runs.length === 0;
  $('idle').hidden = runs.length !== 0;
  $('runs-title').textContent = runs.length === 1 ? 'Working now' : `${runs.length} tasks working now`;
  const list = $('runs');
  list.replaceChildren(
    ...runs.map((run, i) => {
      const li = document.createElement('li');
      const titles = run.tabs.map((t) => t.title);
      li.textContent = titles.length ? titles.join(' · ') : runs.length > 1 ? `Task ${i + 1} (no tab yet)` : 'No tab yet';
      return li;
    })
  );
}

async function refresh() {
  try {
    render(await chrome.runtime.sendMessage({ type: 'stem:state' }));
  } catch {
    // The worker is starting up; the next tick gets it.
  }
}

$('stop-all').addEventListener('click', async () => {
  $('stop-all').disabled = true;
  try {
    render(await chrome.runtime.sendMessage({ type: 'stem:stop-all' }));
  } finally {
    $('stop-all').disabled = false;
  }
});

void refresh();
setInterval(refresh, 1000);

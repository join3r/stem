import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Plug,
  Globe,
  HardDrive,
  Plus,
  Minus,
  X,
  Check,
  Copy,
  KeyRound,
  RefreshCw,
  TriangleAlert
} from 'lucide-react';
import type {
  AuthProviderId,
  ApiKeyProviderId,
  CustomInstructionsSettings,
  EscapeAction,
  ExecSettings,
  MobilePairingInfo,
  MobileSettings,
  WebSearchSettings,
  QuickChatSettings,
  QuickChatShortcutStatus,
  LocalProviderId,
  LocalProvidersSettings,
  LocalProviderTestResult
} from '../../../shared/types';
import { API_KEY_PROVIDER_IDS, AUTH_PROVIDER_IDS, isLocalProviderId, providerName } from '../../../shared/providers';
import { formatAccelerator, IS_MAC, splitAccelerator } from '../../accel';
import { localProbeTarget, probeStillDescribes } from '../../localProbe';
import { RequestGate } from '../../requestGate';
import { InfoTip } from '../../ui/InfoTip';
import { ModelPicker } from '../../ui/ModelPicker';
import { QrImage } from '../../ui/QrImage';
import { EFFORT_LABELS } from '../../modelLabels';
import {
  backendSections,
  backendState,
  credentialLabel,
  credentialRequirement,
  SEARCH_BACKENDS,
  SEARCH_ENDPOINTS
} from '../searchBackends';
import type { ModelTabProps } from './shared';

// Inactivity presets for starting a fresh Quick Chat thread on re-summon.
// 0 = never (always continue the current session).
const NEW_THREAD_PRESETS: { label: string; ms: number }[] = [
  { label: 'Off', ms: 0 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 5 * 60_000 },
  { label: '15m', ms: 15 * 60_000 }
];

// ---- Settings tab: Quick Chat overlay configuration ----

/**
 * Map a physical `KeyboardEvent.code` to an Electron accelerator key token.
 * Using `code` (not `key`) is essential: with Option held, macOS composes
 * `key` into a non-ASCII glyph (Option+J → "∆"), which Electron's accelerator
 * parser rejects. `code` is layout- and modifier-independent. Returns null for
 * unsupported/pure-modifier keys.
 */
function codeToAccelerator(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3); // KeyJ -> J
  if (/^Digit[0-9]$/.test(code)) return code.slice(5); // Digit1 -> 1
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code; // F1..F24
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  const NUMPAD: Record<string, string> = {
    NumpadDecimal: 'numdec',
    NumpadAdd: 'numadd',
    NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv',
    NumpadEnter: 'Return'
  };
  if (code in NUMPAD) return NUMPAD[code];
  const MAP: Record<string, string> = {
    Space: 'Space',
    Enter: 'Return',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`'
  };
  return MAP[code] ?? null;
}

/** Render an Electron accelerator for display: mac glyphs (a four-modifier
 *  hyperkey collapses to the accented hyper icon), plus-joined text elsewhere. */
function renderAccelerator(accel: string): ReactNode {
  const { isHyper, keys } = splitAccelerator(accel);
  if (IS_MAC && isHyper) {
    return (
      <span className="accel">
        <span className="accel-hyper" aria-label="Hyper">✦</span>
        {keys.join('')}
      </span>
    );
  }
  return <span className="accel">{formatAccelerator(accel)}</span>;
}

function ShortcutRecorder({
  value,
  onChange
}: {
  value: string | null;
  onChange: (accel: string | null) => void;
}) {
  const [recording, setRecording] = useState(false);

  function onKeyDown(e: React.KeyboardEvent) {
    e.preventDefault();
    if (e.code === 'Escape') {
      setRecording(false);
      return;
    }
    const main = codeToAccelerator(e.code);
    if (!main) return; // waiting for a non-modifier / supported key
    const mods: string[] = [];
    // The meta key is ⌘ on mac and the Super/Windows key elsewhere — both are
    // valid Electron accelerator tokens, but only for their own platform.
    if (e.metaKey) mods.push(IS_MAC ? 'Command' : 'Super');
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (mods.length === 0) return; // a global shortcut needs a modifier
    onChange([...mods, main].join('+'));
    setRecording(false);
  }

  return (
    <button
      className={`recorder${recording ? ' recording' : ''}`}
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={recording ? onKeyDown : undefined}
    >
      <span>{recording ? 'Press keys…' : value ? renderAccelerator(value) : 'Click to record'}</span>
      {value && !recording && (
        <span
          className="recorder-clear"
          title="Clear shortcut"
          onClick={(e) => {
            e.stopPropagation();
            onChange(null);
          }}
        >
          <X size={12} />
        </span>
      )}
    </button>
  );
}

// ---- AI providers (Settings → top section) ----

const OAUTH_CHOICES: { id: AuthProviderId; hint: string }[] = [
  { id: 'openai-codex', hint: 'Sign in with a ChatGPT Plus or Pro subscription.' },
  { id: 'anthropic', hint: 'Sign in with a Claude Pro or Max subscription.' },
  { id: 'xai', hint: 'Sign in with a SuperGrok or X Premium+ subscription.' }
];

/** How a connected provider signed in — shown as the row's secondary line. */
function providerKind(id: string): string {
  if (id === 'openai-codex') return 'ChatGPT subscription';
  if (id === 'xai') return 'Grok subscription';
  if (isLocalProviderId(id)) return 'Server';
  return 'API key / subscription';
}

/**
 * Provider management, mirroring the MCP Servers tab: connected providers as a
 * grouped list with a +/− gutter; the + button opens an Add Provider form with
 * an account / API key / local-server segmented choice. Runs against the same
 * auth IPC as the onboarding wizard.
 */
function ProvidersSection({ deadProvider }: { deadProvider?: string | null }) {
  const [providers, setProviders] = useState<string[]>([]);
  const [local, setLocal] = useState<LocalProvidersSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The Add Provider form is collapsed behind the + button (like the MCP tab's
  // Add Server) so the steady state is a calm list of connected providers.
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<'account' | 'apikey' | 'local'>('account');
  // In-flight OAuth attempt (null = none). Mirrors the onboarding wizard's
  // oauthWait/manualInput steps in miniature; completion resolves the
  // providerLogin promise, so `done` events only clear transient state.
  const [oauth, setOauth] = useState<{
    provider: AuthProviderId;
    authUrl: string | null;
    progress: string | null;
    input: { requestId: string; message: string; placeholder?: string } | null;
  } | null>(null);

  const refresh = useCallback(async () => {
    const [status, settings] = await Promise.all([window.stem.runtimeStatus(), window.stem.getSettings()]);
    setProviders(status.providers ?? []);
    setLocal(settings.localProviders);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      window.stem.onAuthEvent((e) => {
        setOauth((cur) => {
          if (!cur) return cur;
          switch (e.kind) {
            case 'auth-url':
              return { ...cur, authUrl: e.url };
            case 'progress':
              return { ...cur, progress: e.message };
            case 'input-request':
              return { ...cur, input: { requestId: e.requestId, message: e.message, placeholder: e.placeholder } };
            default:
              return cur;
          }
        });
      }),
    []
  );

  /** Providers changed: refresh this section AND tell App to reload status+models. */
  const changed = useCallback(async () => {
    await refresh();
    window.dispatchEvent(new CustomEvent('stem:providers-changed'));
  }, [refresh]);

  function closeForm() {
    setAdding(false);
    setMode('account');
  }

  async function startOAuth(provider: AuthProviderId) {
    setError(null);
    setOauth({ provider, authUrl: null, progress: null, input: null });
    try {
      const res = await window.stem.providerLogin(provider);
      if (!res.ok) setError(res.error ?? 'Sign-in failed.');
      else {
        await changed();
        closeForm();
      }
    } finally {
      setOauth(null);
    }
  }

  function cancelOAuth() {
    void window.stem.providerLoginCancel();
    setOauth(null);
  }

  async function disconnect(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await window.stem.disconnectProvider(id);
      if (!res.ok) setError(res.error ?? 'Could not disconnect.');
      else {
        setSelected(null);
        await changed();
      }
    } finally {
      setBusy(false);
    }
  }

  // Cloud rows come from auth.json keys; local rows from enabled servers.
  const cloudProviders = providers.filter((p) => !isLocalProviderId(p));
  const enabledLocals = local ? (Object.keys(local) as LocalProviderId[]).filter((id) => local[id].enabled) : [];
  const rows = [
    ...cloudProviders.map((id) => ({ id, local: false, detail: providerKind(id) })),
    // A custom endpoint is registered the same way but needn't be on this box, so
    // it keeps the remote icon.
    ...enabledLocals.map((id) => ({ id, local: id !== 'custom', detail: local![id].baseUrl }))
  ];

  return (
    <>
      <div className="grp-head">AI Providers</div>
      {rows.length === 0 ? (
        <div className="group">
          <div className="group-row">
            <span className="row-main">
              <em>No providers yet. Add one with the + button.</em>
            </span>
          </div>
        </div>
      ) : (
        <div className="group">
          {rows.map((row) => (
            <div
              key={row.id}
              className={`group-row${selected === row.id ? ' selected' : ''}`}
              onClick={() => setSelected(row.id)}
            >
              <span className={`row-icon ${row.local ? 'local' : 'remote'}`}>
                {row.local ? <HardDrive size={14} /> : <Globe size={14} />}
              </span>
              <span className="row-main">
                <strong>{providerName(row.id)}</strong>
                <em>{row.detail}</em>
              </span>
              {row.id === deadProvider && (
                <button
                  className="pill danger row-reconnect"
                  title="Session expired — reconnect"
                  onClick={(e) => {
                    e.stopPropagation();
                    if ((AUTH_PROVIDER_IDS as string[]).includes(row.id)) void startOAuth(row.id as AuthProviderId);
                  }}
                >
                  Session expired · Reconnect
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="gutter">
        <button title="Add provider" onClick={() => setAdding(true)}>
          <Plus size={15} />
        </button>
        <button
          title="Reconnect selected"
          onClick={() => {
            if (selected && (AUTH_PROVIDER_IDS as string[]).includes(selected)) {
              void startOAuth(selected as AuthProviderId);
            }
          }}
          disabled={!selected || busy || !(AUTH_PROVIDER_IDS as string[]).includes(selected ?? '')}
        >
          <RefreshCw size={15} />
        </button>
        <button
          title="Disconnect selected"
          onClick={() => selected && void disconnect(selected)}
          disabled={!selected || busy}
        >
          <Minus size={15} />
        </button>
      </div>

      {adding && (
        <>
          <div className="grp-head">Add Provider</div>
          <div className="formgroup">
            {!oauth && (
              <>
                <div className="seg-ctl">
                  <button className={mode === 'account' ? 'active' : ''} onClick={() => setMode('account')}>
                    Account
                  </button>
                  <button className={mode === 'apikey' ? 'active' : ''} onClick={() => setMode('apikey')}>
                    API key
                  </button>
                  {/* "Server", not "Local server": the same form now also takes a
                      custom endpoint, which needn't be on this machine. */}
                  <button className={mode === 'local' ? 'active' : ''} onClick={() => setMode('local')}>
                    Server
                  </button>
                </div>
                {mode === 'account' && (
                  <ProviderAccountForm onConnect={(id) => void startOAuth(id)} onCancel={closeForm} />
                )}
                {mode === 'apikey' && (
                  <ProviderApiKeyForm
                    onSaved={async () => {
                      await changed();
                      closeForm();
                    }}
                    onError={setError}
                    onCancel={closeForm}
                  />
                )}
                {mode === 'local' && local && (
                  <LocalServerAddForm
                    settings={local}
                    onSaved={async () => {
                      await changed();
                      closeForm();
                    }}
                    onError={setError}
                    onCancel={closeForm}
                  />
                )}
              </>
            )}

            {oauth && !oauth.input && (
              <div className="set-block">
                <span className="set-sub">Waiting for your browser…</span>
                <p className="muted">
                  Finish signing in to {providerName(oauth.provider)} in your browser — Stem continues automatically.
                </p>
                {oauth.authUrl && (
                  <p className="muted">
                    Nothing happened? Open this link yourself: <code className="login-cmd">{oauth.authUrl}</code>
                  </p>
                )}
                {oauth.progress && <p className="muted">{oauth.progress}</p>}
                <div className="push-row">
                  <button className="push" onClick={cancelOAuth}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {oauth?.input && (
              <ProviderManualCode
                message={oauth.input.message}
                placeholder={oauth.input.placeholder}
                onSubmit={(value) => {
                  void window.stem.providerLoginRespond(oauth.input!.requestId, value);
                  setOauth({ ...oauth, input: null });
                }}
                onCancel={cancelOAuth}
              />
            )}
          </div>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </>
  );
}

/** Subscription sign-in (ChatGPT / Claude): pick the account, then Connect. */
function ProviderAccountForm({
  onConnect,
  onCancel
}: {
  onConnect: (id: AuthProviderId) => void;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState<AuthProviderId>('openai-codex');
  const choice = OAUTH_CHOICES.find((c) => c.id === provider)!;
  return (
    <div className="set-block">
      <select
        className="ifield"
        aria-label="Account provider"
        value={provider}
        onChange={(e) => setProvider(e.target.value as AuthProviderId)}
      >
        {OAUTH_CHOICES.map((c) => (
          <option key={c.id} value={c.id}>
            {providerName(c.id)}
          </option>
        ))}
      </select>
      <p className="muted">{choice.hint}</p>
      <div className="push-row">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="push default" onClick={() => onConnect(provider)}>
          Connect
        </button>
      </div>
    </div>
  );
}

function ProviderManualCode({
  message,
  placeholder,
  onSubmit,
  onCancel
}: {
  message: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <form
      className="set-block"
      onSubmit={(e) => {
        e.preventDefault();
        const value = inputRef.current?.value.trim();
        if (value) onSubmit(value);
      }}
    >
      <span className="set-sub">{message}</span>
      <input ref={inputRef} className="ifield" type="text" placeholder={placeholder ?? 'Paste the code here'} autoFocus />
      <div className="push-row">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="push default">
          Continue
        </button>
      </div>
    </form>
  );
}

function ProviderApiKeyForm({
  onSaved,
  onError,
  onCancel
}: {
  onSaved: () => Promise<void>;
  onError: (message: string | null) => void;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState<ApiKeyProviderId>('anthropic');
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="set-block"
      onSubmit={async (e) => {
        e.preventDefault();
        const trimmed = key.trim();
        if (!trimmed) return;
        setSaving(true);
        onError(null);
        try {
          const res = await window.stem.setApiKey(provider, trimmed);
          if (!res.ok) onError(res.error ?? 'The API key could not be saved.');
          else {
            setKey('');
            await onSaved();
          }
        } finally {
          setSaving(false);
        }
      }}
    >
      <select
        className="ifield"
        aria-label="API key provider"
        value={provider}
        onChange={(e) => setProvider(e.target.value as ApiKeyProviderId)}
      >
        {API_KEY_PROVIDER_IDS.map((id) => (
          <option key={id} value={id}>
            {providerName(id)}
          </option>
        ))}
      </select>
      <input
        className="ifield"
        type="password"
        placeholder="sk-…"
        aria-label="API key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        autoFocus
      />
      <div className="push-row">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="push default" disabled={saving || !key.trim()}>
          {saving ? 'Saving…' : 'Save key'}
        </button>
      </div>
    </form>
  );
}

/**
 * Add an OpenAI-compatible server (Ollama / LM Studio / a custom endpoint): pick
 * the server, adjust the URL if needed, optionally Test, then Enable. Editing
 * later = disconnect (−) and re-add, matching the MCP servers list.
 *
 * The custom endpoint adds a key field and swaps model discovery for a typed
 * list: an arbitrary endpoint may not serve GET /v1/models at all (or may serve
 * far more than the key can reach), so Test becomes a convenience that fills the
 * field in rather than the thing that decides the catalog.
 *
 * The how-it-works prose for all three lives in the header InfoTip, not inline —
 * the fields differ by selection and a paragraph per branch buries the form.
 */
function LocalServerAddForm({
  settings,
  onSaved,
  onError,
  onCancel
}: {
  settings: LocalProvidersSettings;
  onSaved: () => Promise<void>;
  onError: (message: string | null) => void;
  onCancel: () => void;
}) {
  const [server, setServer] = useState<LocalProviderId>('ollama');
  const [baseUrl, setBaseUrl] = useState(settings.ollama.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState('');
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<LocalProviderTestResult | null>(null);
  const [saving, setSaving] = useState(false);
  // The probe runs for seconds against a URL the user is still typing into, so a
  // late answer must prove it still belongs to this form before it may speak for
  // it: a crossed result restores a cleared badge and fills one endpoint's model
  // ids into another, which Enable then writes to models.json verbatim. The
  // gate covers switching servers or submitting; the value snapshot covers edits
  // to the URL or key, which leave the request itself outstanding. `formRef`
  // mirrors the live values because the post-await closure sees only the ones
  // captured when the test started.
  const testGateRef = useRef(new RequestGate());
  const formRef = useRef({ server, baseUrl, apiKey, models });
  formRef.current = { server, baseUrl, apiKey, models };
  const custom = server === 'custom';
  const modelList = models
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  function pick(id: LocalProviderId) {
    testGateRef.current.invalidate();
    setServer(id);
    setBaseUrl(settings[id].baseUrl);
    setApiKey('');
    setModels('');
    setTest(null);
    setTesting(false);
  }

  async function runTest() {
    const request = testGateRef.current.begin();
    const tested = localProbeTarget(server, baseUrl, apiKey);
    const speaksForTheForm = () => {
      const form = formRef.current;
      return (
        testGateRef.current.isCurrent(request) &&
        probeStillDescribes(tested, localProbeTarget(form.server, form.baseUrl, form.apiKey))
      );
    };
    setTesting(true);
    setTest(null);
    try {
      const result = await window.stem.testLocalProvider(
        tested.server,
        tested.baseUrl,
        custom ? tested.apiKey : undefined
      );
      if (speaksForTheForm()) {
        setTest(result);
        // A listing endpoint that does answer saves the typing — but never
        // overwrite ids the user already chose.
        if (custom && result.ok && result.models?.length && !formRef.current.models.trim())
          setModels(result.models.join(', '));
      }
    } catch {
      if (speaksForTheForm()) setTest({ ok: false, error: 'request failed' });
    } finally {
      // Not snapshot-guarded: an edit mid-probe must still release the button.
      if (testGateRef.current.isCurrent(request)) setTesting(false);
    }
  }

  async function enable() {
    // Nothing in flight may label the form once it has been submitted — and the
    // discarded probe no longer owns the button it left in its testing state.
    testGateRef.current.invalidate();
    setTesting(false);
    setSaving(true);
    onError(null);
    try {
      const res = await window.stem.updateLocalProvider(server, {
        enabled: true,
        baseUrl: baseUrl.trim(),
        // Sent even when empty so re-adding a previously keyed endpoint without
        // one clears the stored key instead of silently inheriting it.
        apiKey: custom ? apiKey.trim() : '',
        models: custom ? modelList : []
      });
      if (!res.ok) onError(res.error ?? 'Could not enable the server.');
      else await onSaved();
    } finally {
      setSaving(false);
    }
  }

  const testLabel = test
    ? test.ok
      ? `${test.models?.length ?? 0} model${(test.models?.length ?? 0) === 1 ? '' : 's'} found` +
        (test.skippedNoTools ? ` (${test.skippedNoTools} without tool support hidden)` : '')
      : test.error ?? 'failed'
    : null;

  return (
    <div className="set-block">
      <span className="set-sub">
        Server{' '}
        <InfoTip label="About servers">
          Any OpenAI-compatible server Stem can register itself, rather than one it already knows.{' '}
          <strong>Ollama</strong> and <strong>LM Studio</strong> run on this machine and report their own models — LM
          Studio loads one on first use, so its first reply can take a while. <strong>Custom endpoint</strong> is any
          other URL: a gateway, a proxy, a server elsewhere on your network. Stem appends <code>/v1</code> to the URL if
          it isn't there, and sends the key as a bearer token when you give one. Test connection fills the model IDs in
          when the endpoint lists them; endpoints that serve no listing just need the IDs typed in.
        </InfoTip>
      </span>
      <select
        className="ifield"
        aria-label="Server"
        value={server}
        onChange={(e) => pick(e.target.value as LocalProviderId)}
      >
        {(Object.keys(settings) as LocalProviderId[]).map((id) => (
          <option key={id} value={id}>
            {providerName(id)}
          </option>
        ))}
      </select>
      <input
        className="ifield"
        aria-label={`${providerName(server)} base URL`}
        placeholder={custom ? 'https://api.example.com/v1' : undefined}
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      {custom && (
        <>
          <input
            className="ifield"
            type="password"
            aria-label="API key"
            placeholder="API key (leave empty if the server needs none)"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <input
            className="ifield"
            aria-label="Model IDs"
            placeholder="Model IDs, comma-separated"
            value={models}
            onChange={(e) => setModels(e.target.value)}
          />
        </>
      )}
      <div className="retrieval-test">
        <button
          className="retrieval-test-btn"
          onClick={() => void runTest()}
          disabled={testing}
          title={testing ? 'Testing…' : 'Test connection'}
          aria-label={`Test ${providerName(server)} connection`}
        >
          <Plug size={14} />
          <span>{testing ? 'Testing…' : 'Test connection'}</span>
        </button>
        {!testing && testLabel && (
          <span className={`retrieval-test-status ${test!.ok ? 'ok' : 'err'}`} title={testLabel}>
            {test!.ok ? <Check size={12} /> : <X size={12} />}
            {testLabel}
          </span>
        )}
      </div>
      <div className="push-row">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="push default"
          disabled={saving || !baseUrl.trim() || (custom && modelList.length === 0)}
          onClick={() => void enable()}
        >
          {saving ? 'Enabling…' : 'Enable'}
        </button>
      </div>
    </div>
  );
}

// ---- Mobile (Settings → phone pairing) ----

/**
 * The phone bridge: an enable switch, the one-time `tailscale serve` step, and
 * the pairing link as both a QR and a copyable string.
 *
 * Two things shape this panel. First, the link IS the credential — the bearer
 * token rides its fragment — so it is only shown while the bridge is on, and the
 * warning about it is not optional. Second, nothing on this Mac can discover the
 * MagicDNS name `tailscale serve` publishes under, so the user has to tell Stem
 * what it is; until they do, the pairing link points at loopback and the panel
 * says so rather than offering a QR that resolves to the phone's own localhost.
 */
function MobileSection() {
  const [mobile, setMobile] = useState<MobileSettings | null>(null);
  const [pairing, setPairing] = useState<MobilePairingInfo | null>(null);
  // Drafts, so typing an address or a port doesn't write settings per keystroke.
  const [addressDraft, setAddressDraft] = useState('');
  const [portDraft, setPortDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmReroll, setConfirmReroll] = useState(false);

  /** Adopt saved settings + fresh pairing info, resetting the drafts to match. */
  const adopt = useCallback((next: MobileSettings, info: MobilePairingInfo) => {
    setMobile(next);
    setPairing(info);
    setAddressDraft(next.publicUrl);
    setPortDraft(String(next.port));
  }, []);

  useEffect(() => {
    void (async () => {
      const [settings, info] = await Promise.all([window.stem.getSettings(), window.stem.getMobilePairing()]);
      adopt(settings.mobile, info);
    })();
  }, [adopt]);

  async function update(patch: Partial<MobileSettings>) {
    setBusy(true);
    setConfirmReroll(false);
    try {
      // updateMobileSettings starts/stops/rebinds the server before it resolves,
      // so the pairing info read after it reflects the new state.
      const settings = await window.stem.updateMobileSettings(patch);
      adopt(settings.mobile, await window.stem.getMobilePairing());
    } finally {
      setBusy(false);
    }
  }

  async function reroll() {
    setBusy(true);
    setConfirmReroll(false);
    try {
      const info = await window.stem.rerollMobileToken();
      setPairing(info);
    } finally {
      setBusy(false);
    }
  }

  function commitPort() {
    const port = Number(portDraft);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setPortDraft(String(mobile?.port ?? ''));
      return;
    }
    if (port !== mobile?.port) void update({ port });
  }

  function copyLink() {
    if (!pairing) return;
    void navigator.clipboard.writeText(pairing.url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <>
      <div className="grp-head">Mobile</div>
      <div className="formgroup">
        <div className="set-row">
          <span className="set-label">
            <strong>Phone access</strong>
            <em>
              Open Stem on your phone, with the same memory{' '}
              <InfoTip label="How phone access works">
                Stem serves its own phone client from a server bound to this Mac's loopback address —
                nothing off the machine can reach it directly. <code>tailscale serve</code> fronts it
                with HTTPS on your tailnet, so only your own devices can connect, and each one pairs
                with a bearer token you can revoke here.
              </InfoTip>
            </em>
          </span>
          <button
            className={`switch${mobile?.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={mobile?.enabled ?? false}
            aria-label="Phone access"
            disabled={busy || !mobile}
            onClick={() => mobile && void update({ enabled: !mobile.enabled })}
          />
        </div>

        {mobile?.enabled && (
          <>
            <div className="set-block fg-divider">
              <span className="set-sub">Port</span>
              <div className="pair-actions">
                <input
                  className="ifield pair-port"
                  type="text"
                  inputMode="numeric"
                  aria-label="Phone bridge port"
                  value={portDraft}
                  disabled={busy}
                  onChange={(e) => setPortDraft(e.target.value)}
                  onBlur={commitPort}
                  // Enter commits through the same blur path, so there is one writer.
                  onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                />
                <span className={`retrieval-test-status ${pairing?.running ? 'ok' : 'err'}`}>
                  {pairing?.running ? <Check size={12} /> : <X size={12} />}
                  {pairing?.running ? 'Listening' : 'Not listening — the port may be in use'}
                </span>
              </div>
            </div>

            <div className="set-block fg-divider">
              <span className="set-sub">One-time setup</span>
              <p className="muted">Run this once in a terminal, then paste the address it prints:</p>
              <code className="pair-cmd">tailscale serve --bg {mobile.port}</code>
              <input
                className="ifield"
                type="text"
                placeholder="https://your-mac.your-tailnet.ts.net"
                aria-label="Tailnet address"
                value={addressDraft}
                disabled={busy}
                onChange={(e) => setAddressDraft(e.target.value)}
                onBlur={() => addressDraft.trim() !== mobile.publicUrl && void update({ publicUrl: addressDraft })}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
              <p className="muted">
                <code>tailscale serve status</code> shows the address again later.
              </p>
            </div>

            <div className="set-block fg-divider">
              <span className="set-sub">Pair a phone</span>
              {pairing && (
                <>
                  {pairing.reachable ? (
                    <p className="muted">
                      Scan this with your phone's camera, then use Share → Add to Home Screen to install it.
                    </p>
                  ) : (
                    <p className="muted">
                      No tailnet address yet, so this link only works in a browser on this Mac. Add the
                      address above to get one your phone can open.
                    </p>
                  )}
                  <div className="qr-card">
                    <QrImage text={pairing.url} label="Pairing code for this Stem" />
                  </div>
                  <code className="pair-url">{pairing.url}</code>
                  <div className="pair-actions">
                    <button className="retrieval-test-btn" onClick={copyLink} title="Copy the pairing link">
                      <Copy size={14} />
                      <span>Copy pairing link</span>
                    </button>
                    {copied && (
                      <span className="retrieval-test-status ok">
                        <Check size={12} />
                        Copied
                      </span>
                    )}
                  </div>
                  <p className="pair-warn">
                    <TriangleAlert size={13} />
                    <span>
                      This link is the key to Stem — anything holding it can read your chats and your
                      memory. Treat it like a password: send it to yourself, not to anyone else.
                    </span>
                  </p>
                </>
              )}
            </div>

            <div className="set-block fg-divider">
              <span className="set-sub">Paired phones</span>
              {confirmReroll ? (
                <>
                  <p className="muted">
                    Every phone paired with the current link stops working immediately and has to scan a
                    new one. Nothing else changes.
                  </p>
                  <div className="push-row">
                    <button type="button" className="push" onClick={() => setConfirmReroll(false)}>
                      Cancel
                    </button>
                    <button type="button" className="push default" disabled={busy} onClick={() => void reroll()}>
                      {busy ? 'Un-pairing…' : 'Un-pair everything'}
                    </button>
                  </div>
                </>
              ) : (
                <div className="pair-actions">
                  <button
                    className="retrieval-test-btn"
                    onClick={() => setConfirmReroll(true)}
                    disabled={busy}
                    title="Mint a new pairing link and revoke the old one"
                  >
                    <KeyRound size={14} />
                    <span>New pairing link</span>
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

export function SettingsTab({
  models,
  modelId,
  onSelectModel,
  deadProvider
}: ModelTabProps & { deadProvider?: string | null }) {
  const [qc, setQc] = useState<QuickChatSettings | null>(null);
  // The all-backends key list is collapsed by default: most people configure one
  // backend, and a wall of empty key fields would bury the picker.
  const [showSearchKeys, setShowSearchKeys] = useState(false);
  const [ws, setWs] = useState<WebSearchSettings>({
    main: true,
    quickChat: true,
    provider: 'auto',
    credentials: {}
  });
  // Connected AI providers, only so the search picker can tell you that the
  // ChatGPT backend already works on your sign-in. Kept in step with the
  // Providers section below, which broadcasts on every connect/disconnect.
  const [providers, setProviders] = useState<string[]>([]);
  const [escapeAction, setEscapeAction] = useState<EscapeAction>('off');
  const [ci, setCi] = useState<CustomInstructionsSettings>({ main: '', quickChat: '' });
  const [exec, setExec] = useState<ExecSettings | null>(null);
  const [allowInput, setAllowInput] = useState('');
  const [shortcutStatus, setShortcutStatus] = useState<QuickChatShortcutStatus | null>(null);
  const [copiedSummon, setCopiedSummon] = useState(false);
  // Per-field debounce so typing doesn't spam the atomic settings writer.
  const ciMainTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ciQuickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    window.stem.getSettings().then((s) => {
      setQc(s.quickChat);
      setWs(s.webSearch);
      setEscapeAction(s.escapeAction);
      setCi(s.customInstructions);
      setExec(s.exec);
    });
    window.stem.getQuickChatShortcutStatus().then(setShortcutStatus);
  }, []);

  useEffect(() => {
    const load = (): void => {
      void window.stem.runtimeStatus().then((s) => setProviders(s.providers ?? []));
    };
    load();
    window.addEventListener('stem:providers-changed', load);
    return () => window.removeEventListener('stem:providers-changed', load);
  }, []);

  function updateExec(patch: Partial<ExecSettings>) {
    setExec((cur) => (cur ? { ...cur, ...patch } : cur)); // optimistic; reconcile below
    window.stem.updateExecSettings(patch).then((s) => setExec(s.exec));
  }

  function saveCiMain(value: string) {
    setCi((c) => ({ ...c, main: value }));
    if (ciMainTimer.current) clearTimeout(ciMainTimer.current);
    ciMainTimer.current = setTimeout(() => void window.stem.updateCustomInstructions({ main: value }), 400);
  }

  function saveCiQuick(value: string) {
    setCi((c) => ({ ...c, quickChat: value }));
    if (ciQuickTimer.current) clearTimeout(ciQuickTimer.current);
    ciQuickTimer.current = setTimeout(() => void window.stem.updateCustomInstructions({ quickChat: value }), 400);
  }

  function selectEscapeAction(action: EscapeAction) {
    setEscapeAction(action); // optimistic; persist + reconcile from the saved settings
    // Notify the main window's composer (App) so the new mode applies immediately,
    // without waiting for a window focus cycle.
    window.dispatchEvent(new CustomEvent('stem:escape-action', { detail: action }));
    window.stem.updateEscapeAction(action).then((s) => setEscapeAction(s.escapeAction));
  }

  function update(patch: Partial<QuickChatSettings>) {
    window.stem.updateQuickChat(patch).then((s) => setQc(s.quickChat));
  }

  /** Re-bind, then re-read whether the OS actually granted the new accelerator. */
  function updateShortcut(accel: string | null) {
    window.stem.updateQuickChat({ shortcut: accel }).then(async (s) => {
      setQc(s.quickChat);
      setShortcutStatus(await window.stem.getQuickChatShortcutStatus());
    });
  }

  function copySummonCommand() {
    if (!shortcutStatus) return;
    void navigator.clipboard.writeText(shortcutStatus.summonCommand).then(() => {
      setCopiedSummon(true);
      setTimeout(() => setCopiedSummon(false), 1600);
    });
  }

  function updateWebSearch(patch: Partial<WebSearchSettings>) {
    setWs((cur) => ({ ...cur, ...patch })); // optimistic; reconcile below
    window.stem.updateWebSearch(patch).then((s) => setWs(s.webSearch));
  }

  const activeBackend = SEARCH_BACKENDS.find((b) => b.id === ws.provider) ?? null;
  const activeState = activeBackend ? backendState(activeBackend, ws.credentials, providers) : null;

  /**
   * Patch one credential. Sent as the whole map because the IPC merges settings
   * shallowly — a partial `credentials` would drop every other backend's key.
   */
  function setCredential(field: string, value: string) {
    updateWebSearch({ credentials: { ...ws.credentials, [field]: value } });
  }

  if (!qc) return <p className="muted">Loading…</p>;

  // The Quick Chat default-effort options follow the chosen default model's capabilities.
  // "Same as main" (empty) has no concrete model here, so offer all levels.
  const qcModel = qc.defaultModel ? models.find((m) => m.id === qc.defaultModel) : undefined;
  const qcEfforts = qcModel?.supportedEfforts.length ? qcModel.supportedEfforts : ['low', 'medium', 'high', 'xhigh'];
  // Only models with a priority (Fast) tier can default to Fast. With no concrete model
  // ("Same as main"), offer it — the runtime ignores Fast on models that don't support it.
  const qcHasFast = qcModel ? qcModel.serviceTiers.some((t) => t.id === 'priority') : true;

  // Switch the default model, clamping a now-unsupported saved effort/speed into range.
  function selectQcModel(id: string | null) {
    const m = id ? models.find((x) => x.id === id) : undefined;
    const efforts = m?.supportedEfforts.length ? m.supportedEfforts : ['low', 'medium', 'high', 'xhigh'];
    const patch: Partial<QuickChatSettings> = { defaultModel: id };
    if (qc && !efforts.includes(qc.defaultEffort)) patch.defaultEffort = m?.defaultEffort ?? efforts[0];
    // Drop a saved Fast default when the new model has no priority tier.
    if (qc?.defaultServiceTier === 'priority' && m && !m.serviceTiers.some((t) => t.id === 'priority')) {
      patch.defaultServiceTier = null;
    }
    update(patch);
  }

  return (
    <div>
      <div className="grp-head">Model</div>
      <div className="formgroup">
        {models.length === 0 ? (
          <p className="muted">Loading models…</p>
        ) : (
          <>
            <ModelPicker
              models={models}
              value={modelId}
              onChange={(id) => onSelectModel(id ?? '')}
              ariaLabel="Model"
            />
            <label className="set-check" title="Search the live web for current info, with citations">
              <input type="checkbox" checked={ws.main} onChange={(e) => updateWebSearch({ main: e.target.checked })} />
              Web search
            </label>
          </>
        )}
      </div>

      <ProvidersSection deadProvider={deadProvider} />

      <div className="grp-head">Web search</div>
      <div className="formgroup">
        <div className="set-block">
          <span className="set-sub">
            Search backend{' '}
            <InfoTip label="About search backends">
              This is independent of the model you chat with — a local Ollama chat can search
              through Exa, a ChatGPT chat through SearXNG. <strong>Automatic</strong> tries each
              backend you have configured and ends at one that needs no key, so search works with
              no setup at all. <strong>All at once</strong> queries every configured backend and
              combines the answers. Keys below are kept for every backend, so switching between
              them never means re-entering one.
              <br />
              The list is grouped by what each backend still wants from you.{' '}
              <strong>Works with no key</strong> holds the ones you can pick right now — Exa
              searches through its public endpoint, and ChatGPT rides the sign-in you already
              have under AI Providers, billing searches to that subscription.
            </InfoTip>
          </span>
          <select
            className="ifield"
            aria-label="Search backend"
            value={ws.provider}
            onChange={(e) => updateWebSearch({ provider: e.target.value })}
          >
            {/* Grouped by what each backend still wants from you, so the rows
                stay bare names and the heading carries the answer. */}
            {backendSections(ws.credentials, providers).map((section) => (
              <optgroup key={section.label} label={section.label}>
                {section.backends.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {/* The selected backend's own field, inline — the common case is
              "pick one, paste its key" without opening anything else. */}
          {activeBackend?.field && (
            <input
              className="ifield"
              type={activeBackend.field.endsWith('ApiKey') ? 'password' : 'url'}
              placeholder={
                activeBackend.placeholder
                  ? `${activeBackend.placeholder}${activeState?.ready ? ' (optional)' : ''}`
                  : activeState?.ready
                    ? 'Optional'
                    : undefined
              }
              aria-label={credentialLabel(activeBackend)}
              value={ws.credentials[activeBackend.field] ?? ''}
              onChange={(e) => setCredential(activeBackend.field as string, e.target.value)}
            />
          )}
          {activeBackend && activeState && (
            <em className={activeState.ready ? 'muted' : 'muted set-warn'}>
              {activeState.ready ? '✓' : '!'} {activeState.status}
              {activeBackend.note ? `. ${activeBackend.note}` : ''}
            </em>
          )}
        </div>

        <div className="set-block">
          <button className="push" onClick={() => setShowSearchKeys((v) => !v)} aria-expanded={showSearchKeys}>
            {showSearchKeys ? 'Hide' : 'Show'} all backend keys
          </button>
          {showSearchKeys && (
            <>
              {SEARCH_BACKENDS.filter((b) => b.field).map((b) => (
                <label className="set-block" key={b.field}>
                  <span className="set-sub">
                    {credentialLabel(b)}{' '}
                    {/* Which of these you can leave blank, without selecting each
                        backend in turn to read its status line. */}
                    <em className="set-opt">{credentialRequirement(b, ws.credentials, providers)}</em>
                  </span>
                  <input
                    className="ifield"
                    type={b.field?.endsWith('ApiKey') ? 'password' : 'url'}
                    placeholder={b.placeholder}
                    aria-label={credentialLabel(b)}
                    value={ws.credentials[b.field as string] ?? ''}
                    onChange={(e) => setCredential(b.field as string, e.target.value)}
                  />
                </label>
              ))}
              {SEARCH_ENDPOINTS.map((f) => (
                <label className="set-block" key={f.field}>
                  <span className="set-sub">{f.label}</span>
                  <input
                    className="ifield"
                    type={f.field.endsWith('ApiKey') ? 'password' : 'url'}
                    placeholder={f.placeholder}
                    aria-label={f.label}
                    value={ws.credentials[f.field] ?? ''}
                    onChange={(e) => setCredential(f.field, e.target.value)}
                  />
                  <em className="muted">{f.hint}</em>
                </label>
              ))}
            </>
          )}
        </div>
      </div>

      {/* The Files folder lives in the Sources tab (Files sub-tab) — it is a
          source the assistant reads from, not an app setting. */}

      <div className="grp-head">Input</div>
      <div className="formgroup">
        <div className="set-block">
          <span className="set-sub">
            Escape key{' '}
            <InfoTip label="What Escape does while streaming">
              While a reply is streaming, Escape can stop it and return your just-sent message to
              the composer to edit — as if you never sent it.
            </InfoTip>
          </span>
          <div className="seg-ctl">
            <button
              className={escapeAction === 'off' ? 'active' : ''}
              onClick={() => selectEscapeAction('off')}
              title="Escape does nothing in the composer"
            >
              Off
            </button>
            <button
              className={escapeAction === 'single' ? 'active' : ''}
              onClick={() => selectEscapeAction('single')}
              title="One Escape stops the turn and pulls your message back into the composer"
            >
              Single
            </button>
            <button
              className={escapeAction === 'twoStage' ? 'active' : ''}
              onClick={() => selectEscapeAction('twoStage')}
              title="First Escape stops the turn; a second Escape retracts your message"
            >
              Two-stage
            </button>
          </div>
        </div>
      </div>

      <div className="grp-head">Custom instructions</div>
      <div className="formgroup">
        <div className="set-block">
          <span className="set-sub">
            Standing instructions{' '}
            <InfoTip label="About standing instructions">
              High-priority directives Stem follows in every reply — in the main app and in Quick
              Chat. Stem can also update these itself when you ask it to.
            </InfoTip>
          </span>
          <textarea
            className="ci-textarea"
            value={ci.main}
            onChange={(e) => saveCiMain(e.target.value)}
            rows={5}
            placeholder="e.g. Reply briefly and to the point. Use plain Markdown unless I ask for components."
          />
        </div>
      </div>

      <div className="grp-head">Command execution</div>
      <div className="formgroup">
        <div className="set-row">
          <span className="set-label">
            <strong>Run commands</strong>
            <em>
              Let Stem run shell commands (CLIs, git, agent-browser){' '}
              <InfoTip label="How command approval works">
                What runs on its own is governed by the approval mode below — from manual (you
                approve everything unlisted) to yolo (everything runs). Folders you marked
                read-only are always protected.
              </InfoTip>
            </em>
          </span>
          <button
            className={`switch${exec?.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={exec?.enabled ?? false}
            aria-label="Run commands"
            onClick={() => exec && updateExec({ enabled: !exec.enabled })}
          />
        </div>

        {exec?.enabled && (
          <>
            <div className="set-block">
              <span className="set-sub">
                Approval mode{' '}
                <InfoTip label="About approval modes">
                  <strong>Manual</strong> — only allowlisted commands run on their own; everything
                  else pauses for your approval. <strong>Assisted</strong> — an AI safety check
                  clears commands that serve your request; only flagged ones pause.{' '}
                  <strong>Yolo</strong> — every command runs immediately, no questions asked (folders
                  you marked read-only stay protected). The safety check is a heuristic, not a
                  security boundary.
                </InfoTip>
              </span>
              <div className="seg-ctl">
                <button
                  className={exec.approvalMode === 'manual' ? 'active' : ''}
                  onClick={() => updateExec({ approvalMode: 'manual' })}
                >
                  Manual
                </button>
                <button
                  className={exec.approvalMode === 'assisted' ? 'active' : ''}
                  onClick={() => updateExec({ approvalMode: 'assisted' })}
                >
                  Assisted
                </button>
                <button
                  className={exec.approvalMode === 'yolo' ? 'active' : ''}
                  onClick={() => updateExec({ approvalMode: 'yolo' })}
                  title="Every command runs immediately — use with care"
                >
                  Yolo
                </button>
              </div>
            </div>

            {exec.approvalMode === 'assisted' && (
              <div className="set-block">
                <span className="set-sub">Safety-check model</span>
                <ModelPicker
                  models={models}
                  value={exec.judgeModel}
                  onChange={(id) => updateExec({ judgeModel: id })}
                  emptyLabel="Auto (cheapest)"
                  ariaLabel="Safety-check model"
                />
              </div>
            )}

            {exec.approvalMode !== 'yolo' && (
              <div className="set-block">
                <span className="set-sub">
                  Always-allowed commands{' '}
                  <InfoTip label="About the allowlist">
                    Command prefixes that run without the safety check — grown by the approval card's
                    "Always allow" button or added here (e.g. <code>git push</code> or <code>npm</code>).
                  </InfoTip>
                </span>
                {exec.allowlist.length > 0 && (
                  <div className="exec-allowlist">
                    {exec.allowlist.map((prefix) => (
                      <span key={prefix} className="pill">
                        {prefix}
                        <button
                          title={`Remove "${prefix}"`}
                          aria-label={`Remove "${prefix}" from the allowlist`}
                          onClick={() => updateExec({ allowlist: exec.allowlist.filter((p) => p !== prefix) })}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const prefix = allowInput.trim();
                    if (!prefix || exec.allowlist.includes(prefix)) return;
                    updateExec({ allowlist: [...exec.allowlist, prefix] });
                    setAllowInput('');
                  }}
                >
                  <input
                    className="ifield"
                    type="text"
                    placeholder="Add a prefix, e.g. git push"
                    aria-label="Add an allowlisted command prefix"
                    value={allowInput}
                    onChange={(e) => setAllowInput(e.target.value)}
                  />
                </form>
              </div>
            )}
          </>
        )}
      </div>

      <MobileSection />

      <div className="grp-head">Quick Chat</div>
      <div className="formgroup">
        <div className="set-row">
          <span className="set-label">
            <strong>Global shortcut</strong>
            <em>Summon the quick-chat overlay from anywhere</em>
          </span>
          <ShortcutRecorder value={qc.shortcut} onChange={updateShortcut} />
        </div>
        {/* The recorder can't tell whether the key is live: the grab happens in the OS.
            Main reports that back, so a shortcut that will never fire says so here
            instead of looking configured and doing nothing. */}
        {qc.shortcut && shortcutStatus && !shortcutStatus.registered && (
          <div className="set-block">
            <span className="retrieval-test-status err">
              <X size={12} />
              The system refused this combination — another app is probably holding it. Record a
              different one.
            </span>
          </div>
        )}
        {/* A granted grab is not the same as a delivered key: most Linux desktops keep
            Super for themselves and swallow it before Stem sees it. */}
        {window.stem.platform === 'linux' &&
          !shortcutStatus?.wayland &&
          qc.shortcut?.includes('Super') &&
          shortcutStatus?.registered && (
            <div className="set-block">
              <span className="set-sub">
                Most Linux desktops reserve the Super key for themselves. If nothing happens when
                you press this, record a combination with Ctrl or Alt instead.
              </span>
            </div>
          )}
        {shortcutStatus?.wayland && (
          <div className="set-block fg-divider">
            <p className="pair-warn">
              <TriangleAlert size={13} />
              <span>
                This is a Wayland session, where an app can't grab a key for itself — the
                shortcut above stays silent no matter what you record. Add a custom keyboard
                shortcut in your system settings that runs this command instead:
              </span>
            </p>
            <code className="pair-cmd">{shortcutStatus.summonCommand}</code>
            <div className="pair-actions">
              <button
                className="retrieval-test-btn"
                onClick={copySummonCommand}
                title="Copy the summon command"
              >
                <Copy size={14} />
                <span>Copy command</span>
              </button>
              {copiedSummon && (
                <span className="retrieval-test-status ok">
                  <Check size={12} />
                  Copied
                </span>
              )}
            </div>
          </div>
        )}

        <div className="set-block">
          <span className="set-sub">Default model</span>
          <ModelPicker
            models={models}
            value={qc.defaultModel}
            onChange={selectQcModel}
            emptyLabel="Same as main"
            ariaLabel="Quick Chat default model"
          />
          <label className="set-check" title="Search the live web for current info, with citations">
            <input
              type="checkbox"
              checked={ws.quickChat}
              onChange={(e) => updateWebSearch({ quickChat: e.target.checked })}
            />
            Web search
          </label>
        </div>

        <div className="set-block">
          <span className="set-sub">Default effort</span>
          <div className="seg-ctl">
            {qcEfforts.map((e) => (
              <button key={e} className={qc.defaultEffort === e ? 'active' : ''} onClick={() => update({ defaultEffort: e })}>
                {EFFORT_LABELS[e] ?? e}
              </button>
            ))}
          </div>
        </div>

        {qcHasFast && (
          <div className="set-block">
            <span className="set-sub">Default speed</span>
            <div className="seg-ctl">
              <button
                className={qc.defaultServiceTier === 'priority' ? '' : 'active'}
                onClick={() => update({ defaultServiceTier: null })}
              >
                Standard
              </button>
              <button
                className={qc.defaultServiceTier === 'priority' ? 'active' : ''}
                onClick={() => update({ defaultServiceTier: 'priority' })}
                title="1.5× speed, increased usage"
              >
                Fast
              </button>
            </div>
          </div>
        )}

        <div className="set-row">
          <span className="set-label">
            <strong>Show on all displays</strong>
            <em>Float above every Space &amp; the active display</em>
          </span>
          <button
            className={`switch${qc.showOnAllDisplays ? ' on' : ''}`}
            role="switch"
            aria-checked={qc.showOnAllDisplays}
            aria-label="Show on all displays"
            onClick={() => update({ showOnAllDisplays: !qc.showOnAllDisplays })}
          />
        </div>

        <div className="set-row">
          <span className="set-label">
            <strong>Show progress on other Spaces</strong>
            <em>Float the progress pill when the main window loses focus &amp; a thread is running</em>
          </span>
          <button
            className={`switch${qc.followAcrossSpaces ? ' on' : ''}`}
            role="switch"
            aria-checked={qc.followAcrossSpaces}
            aria-label="Show progress on other Spaces"
            onClick={() => update({ followAcrossSpaces: !qc.followAcrossSpaces })}
          />
        </div>

        <div className="set-row">
          <span className="set-label">
            <strong>Sound when finished</strong>
            <em>Play a chime when a turn finishes while the progress pill is visible</em>
          </span>
          <button
            className={`switch${qc.finishSound ? ' on' : ''}`}
            role="switch"
            aria-checked={qc.finishSound}
            aria-label="Sound when finished"
            onClick={() => update({ finishSound: !qc.finishSound })}
          />
        </div>

        <div className="set-block">
          <span className="set-sub">New thread after idle</span>
          <div className="seg-ctl">
            {NEW_THREAD_PRESETS.map((p) => (
              <button
                key={p.label}
                className={qc.newThreadTimeoutMs === p.ms ? 'active' : ''}
                onClick={() => update({ newThreadTimeoutMs: p.ms })}
                title="Re-summoning the overlay after this idle time starts a fresh thread"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="set-block">
          <span className="set-sub">Extra instructions</span>
          <textarea
            className="ci-textarea"
            value={ci.quickChat}
            onChange={(e) => saveCiQuick(e.target.value)}
            rows={4}
            placeholder="e.g. Be even more terse here — one or two sentences."
          />
          <p className="muted">Layered on top of your main custom instructions, only in the Quick Chat overlay.</p>
        </div>
      </div>
      <p className="muted" style={{ marginTop: 'var(--sp-5)' }}>
        Press the shortcut to open the overlay; Escape or the shortcut again hides it.
      </p>
    </div>
  );
}

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type {
  AuthProviderId,
  ApiKeyProviderId,
  AuthUiEvent,
  LocalProviderId,
  LocalProviderTestResult,
  QuickChatShortcutStatus,
  RuntimeStatus
} from '../../shared/types';
import { API_KEY_PROVIDER_IDS, providerName } from '../../shared/providers';
import { IS_MAC } from '../accel';
import { RequestGate } from '../requestGate';

// First-run / re-auth gate: the wizard shown instead of the app until Stem holds
// working provider credentials. Drives the main-process ProviderAuth over IPC:
// providerLogin() opens the system browser and resolves when auth.json is
// written; progress (auth URL, manual-code request, failure) arrives as
// auth:event pushes. 'firstRun' walks Welcome → sign-in; 'reauth' (credentials
// lost/expired later) skips the welcome and offers a way back to the chat.

const PROVIDER_LABELS: Record<AuthProviderId, string> = {
  anthropic: 'Claude',
  'openai-codex': 'ChatGPT',
  xai: 'Grok'
};

// The wizard's pitch is "your data stays on this machine", so it names the
// machine repeatedly. Calling a Linux box a Mac in the first sentence a new user
// reads undercuts exactly the claim the sentence is making.
const DEVICE = IS_MAC ? 'Mac' : 'computer';

type Step =
  | 'welcome'
  | 'chooseProvider'
  | 'oauthWait'
  | 'apiKey'
  | 'localServer'
  | 'manualInput'
  | 'finishing'
  | 'quickChatSetup'
  | 'error';

interface WizardState {
  step: Step;
  provider: AuthProviderId | null;
  authUrl: string | null;
  deviceCode: { userCode: string; verificationUri: string } | null;
  progress: string | null;
  inputRequest: { requestId: string; message: string; placeholder?: string } | null;
  error: string | null;
}

type WizardAction =
  | { type: 'continue' }
  | { type: 'pickProvider'; provider: AuthProviderId }
  | { type: 'pickApiKey' }
  | { type: 'pickLocal' }
  | { type: 'backToChoice' }
  | { type: 'finishing' }
  | { type: 'quickChatSetup' }
  | { type: 'authEvent'; event: AuthUiEvent }
  | { type: 'fail'; error: string };

function initialState(variant: 'firstRun' | 'reauth', initialProvider?: AuthProviderId): WizardState {
  return {
    step: variant === 'firstRun' ? 'welcome' : 'chooseProvider',
    // Seed the known-dead provider (reauth only) so chooseProvider can deep-link it.
    provider: variant === 'reauth' ? initialProvider ?? null : null,
    authUrl: null,
    deviceCode: null,
    progress: null,
    inputRequest: null,
    error: null
  };
}

function reduce(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'continue':
      return { ...state, step: 'chooseProvider' };
    case 'pickProvider':
      return {
        ...state,
        step: 'oauthWait',
        provider: action.provider,
        authUrl: null,
        deviceCode: null,
        progress: null,
        inputRequest: null,
        error: null
      };
    case 'pickApiKey':
      return { ...state, step: 'apiKey', provider: null, error: null };
    case 'pickLocal':
      return { ...state, step: 'localServer', provider: null, error: null };
    case 'backToChoice':
      return { ...initialState('reauth'), step: 'chooseProvider' };
    case 'finishing':
      return { ...state, step: 'finishing' };
    case 'quickChatSetup':
      return { ...state, step: 'quickChatSetup' };
    case 'fail':
      return { ...state, step: 'error', error: action.error };
    case 'authEvent': {
      const e = action.event;
      // Ignore stray pushes when no attempt is in flight (a superseded login).
      if (state.step !== 'oauthWait' && state.step !== 'manualInput' && state.step !== 'finishing') return state;
      switch (e.kind) {
        case 'auth-url':
          return { ...state, authUrl: e.url };
        case 'device-code':
          return { ...state, deviceCode: { userCode: e.userCode, verificationUri: e.verificationUri } };
        case 'progress':
          return { ...state, progress: e.message };
        case 'input-request':
          return {
            ...state,
            step: 'manualInput',
            inputRequest: { requestId: e.requestId, message: e.message, placeholder: e.placeholder }
          };
        case 'done':
          return e.ok ? { ...state, step: 'finishing' } : { ...state, step: 'error', error: e.error };
        default:
          return state;
      }
    }
  }
}

export interface OnboardingGateProps {
  variant: 'firstRun' | 'reauth';
  /** Why re-auth is needed (the failing turn's error); reauth variant only. */
  reauthMessage?: string | null;
  /** The known-dead provider (reauth only) — deep-links chooseProvider to a one-click reconnect. */
  initialProvider?: AuthProviderId;
  /** Sign-in finished — the parent swaps in the main app with this status. */
  onAuthenticated: (status: RuntimeStatus) => void;
  /** Reauth was a false alarm — go back to the chat. */
  onDismissReauth?: () => void;
}

export function OnboardingGate({
  variant,
  reauthMessage,
  initialProvider,
  onAuthenticated,
  onDismissReauth
}: OnboardingGateProps) {
  const [state, dispatch] = useReducer(reduce, undefined, () => initialState(variant, initialProvider));
  // Wayland only: the summon command to bind, plus the status to hand onAuthenticated
  // once the user dismisses that step (see finish).
  const [waylandShortcut, setWaylandShortcut] = useState<QuickChatShortcutStatus | null>(null);
  const [copiedSummon, setCopiedSummon] = useState(false);
  const pendingStatusRef = useRef<RuntimeStatus | null>(null);
  // The finish path runs in async handlers after awaits — guard against unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => window.stem.onAuthEvent((event) => dispatch({ type: 'authEvent', event })), []);

  const finish = useCallback(
    async (status: RuntimeStatus | undefined) => {
      dispatch({ type: 'finishing' });
      if (variant === 'firstRun') await window.stem.completeOnboarding().catch(() => undefined);
      const next = status ?? (await window.stem.runtimeStatus());
      if (!mountedRef.current) return;

      // In a Wayland session no app can grab a hotkey for itself, so Quick Chat —
      // the summon-from-anywhere overlay that is half the point of Stem — stays
      // silent until the user binds a DE shortcut to the summon command. Settings
      // explains this, but a first-run user has no reason to go looking: they press
      // the shortcut, nothing happens, and Stem looks broken. So say it here, once,
      // while they are already being set up.
      if (variant === 'firstRun') {
        const shortcut = await window.stem.getQuickChatShortcutStatus().catch(() => null);
        if (!mountedRef.current) return;
        if (shortcut?.wayland) {
          pendingStatusRef.current = next;
          setWaylandShortcut(shortcut);
          dispatch({ type: 'quickChatSetup' });
          return;
        }
      }
      onAuthenticated(next);
    },
    [variant, onAuthenticated]
  );

  const copySummonCommand = useCallback(() => {
    if (!waylandShortcut) return;
    void navigator.clipboard.writeText(waylandShortcut.summonCommand).then(() => {
      if (!mountedRef.current) return;
      setCopiedSummon(true);
      setTimeout(() => mountedRef.current && setCopiedSummon(false), 1600);
    });
  }, [waylandShortcut]);

  const leaveQuickChatSetup = useCallback(async () => {
    // finish() already ran completeOnboarding and resolved the status; this step is
    // purely informational, so entering the app must not depend on it succeeding.
    onAuthenticated(pendingStatusRef.current ?? (await window.stem.runtimeStatus()));
  }, [onAuthenticated]);

  const startOAuth = useCallback(
    async (provider: AuthProviderId) => {
      dispatch({ type: 'pickProvider', provider });
      const res = await window.stem.providerLogin(provider);
      if (!mountedRef.current) return;
      if (res.ok) await finish(res.status);
      else dispatch({ type: 'fail', error: res.error ?? 'Sign-in failed.' });
    },
    [finish]
  );

  const cancelOAuth = useCallback(() => {
    void window.stem.providerLoginCancel();
    dispatch({ type: 'backToChoice' });
  }, []);

  const saveApiKey = useCallback(
    async (provider: ApiKeyProviderId, key: string) => {
      const res = await window.stem.setApiKey(provider, key);
      if (!mountedRef.current) return;
      if (res.ok) await finish(res.status);
      else dispatch({ type: 'fail', error: res.error ?? 'The API key could not be saved.' });
    },
    [finish]
  );

  const submitManualCode = useCallback(
    (value: string) => {
      const req = state.inputRequest;
      if (!req) return;
      void window.stem.providerLoginRespond(req.requestId, value);
      // Return to the waiting view; the login promise resolves the flow.
      dispatch({ type: 'pickProvider', provider: state.provider ?? 'anthropic' });
    },
    [state.inputRequest, state.provider]
  );

  const providerLabel = state.provider ? PROVIDER_LABELS[state.provider] : 'the provider';
  // The deep-linked dead provider to emphasize on chooseProvider (reauth only).
  const deepLink = variant === 'reauth' ? initialProvider ?? null : null;

  return (
    <div className="app gate">
      <div className="gate-card onboarding">
        {state.step === 'welcome' && (
          <>
            <h1>Welcome to Stem</h1>
            <p>A private AI assistant that lives on your {DEVICE}.</p>
            <p className="gate-sub">
              Stem brings your own AI account: sign in with a ChatGPT, Claude, or Grok subscription, use an API
              key (Anthropic, OpenAI, OpenRouter), or run local models with Ollama or LM Studio. Your
              chats, files, and memory stay on this {DEVICE}.
            </p>
            <button className="primary" onClick={() => dispatch({ type: 'continue' })}>
              Get started
            </button>
          </>
        )}

        {state.step === 'chooseProvider' && (
          <>
            <h1>{variant === 'reauth' ? 'Sign in again' : 'Sign in'}</h1>
            {variant === 'reauth' && (
              <p className="gate-sub">
                {deepLink
                  ? `Your ${PROVIDER_LABELS[deepLink]} session expired. Reconnect to keep going.`
                  : reauthMessage
                    ? `Stem's connection to your AI account stopped working: ${reauthMessage}`
                    : 'Stem needs you to sign in to your AI account again.'}
              </p>
            )}
            <div className="gate-providers">
              <button
                className={deepLink ? (deepLink === 'openai-codex' ? 'primary' : 'push') : 'primary'}
                onClick={() => void startOAuth('openai-codex')}
              >
                {deepLink === 'openai-codex' ? 'Reconnect ChatGPT' : 'Continue with ChatGPT'}
              </button>
              <span className="gate-hint">
                ChatGPT Plus or Pro subscription <span className="gate-rec">Recommended</span>
              </span>
              <button
                className={deepLink === 'anthropic' ? 'primary' : 'push'}
                onClick={() => void startOAuth('anthropic')}
              >
                {deepLink === 'anthropic' ? 'Reconnect Claude' : 'Continue with Claude'}
              </button>
              <span className="gate-hint">
                Claude Pro or Max subscription. Heads up: using a Claude subscription in a
                third-party app like Stem can draw on extra usage on top of your plan.
              </span>
              <button
                className={deepLink === 'xai' ? 'primary' : 'push'}
                onClick={() => void startOAuth('xai')}
              >
                {deepLink === 'xai' ? 'Reconnect Grok' : 'Continue with Grok'}
              </button>
              <span className="gate-hint">SuperGrok or X Premium+ subscription</span>
            </div>
            <button className="gate-link" onClick={() => dispatch({ type: 'pickApiKey' })}>
              Use an API key instead
            </button>
            <button className="gate-link" onClick={() => dispatch({ type: 'pickLocal' })}>
              Use a local model or your own endpoint
            </button>
            {variant === 'reauth' && onDismissReauth && (
              <button className="gate-link" onClick={onDismissReauth}>
                Back to chat
              </button>
            )}
          </>
        )}

        {state.step === 'oauthWait' && (
          <>
            <h1>Waiting for your browser…</h1>
            <p className="gate-sub">
              We opened {providerLabel}'s sign-in page in your browser. Finish signing in there — Stem
              will continue automatically.
            </p>
            {state.deviceCode && (
              <p className="gate-sub">
                Enter code <code className="gate-code">{state.deviceCode.userCode}</code> at{' '}
                {state.deviceCode.verificationUri}
              </p>
            )}
            {state.authUrl && (
              <p className="gate-hint">
                Nothing happened? Open this link yourself:
                <br />
                <code className="login-cmd">{state.authUrl}</code>
              </p>
            )}
            {state.progress && <p className="gate-hint">{state.progress}</p>}
            <button className="push" onClick={cancelOAuth}>
              Cancel
            </button>
          </>
        )}

        {state.step === 'manualInput' && state.inputRequest && (
          <ManualCodeForm
            message={state.inputRequest.message}
            placeholder={state.inputRequest.placeholder}
            onSubmit={submitManualCode}
            onCancel={cancelOAuth}
          />
        )}

        {state.step === 'apiKey' && <ApiKeyForm onSave={saveApiKey} onBack={() => dispatch({ type: 'backToChoice' })} />}

        {state.step === 'localServer' && (
          <LocalServerForm
            onDone={(status) => void finish(status)}
            onFail={(error) => dispatch({ type: 'fail', error })}
            onBack={() => dispatch({ type: 'backToChoice' })}
          />
        )}

        {state.step === 'finishing' && (
          <>
            <h1>Setting things up…</h1>
            <p className="gate-sub">Signed in. Picking a default model and starting the assistant.</p>
          </>
        )}

        {state.step === 'quickChatSetup' && waylandShortcut && (
          <>
            <h1>One last step</h1>
            <p className="gate-sub">
              Quick Chat is Stem's overlay — summon it with a keyboard shortcut from inside any app.
              This is a Wayland session, where an app can't claim a shortcut for itself, so add one in
              your system's keyboard settings that runs this command:
            </p>
            <code className="pair-cmd gate-cmd">{waylandShortcut.summonCommand}</code>
            <div className="gate-form-actions">
              <button type="button" className="push" onClick={copySummonCommand}>
                {copiedSummon ? 'Copied' : 'Copy command'}
              </button>
              <button type="button" className="primary" onClick={() => void leaveQuickChatSetup()}>
                Start using Stem
              </button>
            </div>
            <p className="gate-hint">You can find this again under Settings → Quick Chat.</p>
          </>
        )}

        {state.step === 'error' && (
          <>
            <h1>Sign-in didn't finish</h1>
            <p className="error">{state.error}</p>
            <p className="gate-hint">
              If another sign-in was already running (here or in a terminal), close it and try again.
            </p>
            <button className="primary" onClick={() => dispatch({ type: 'backToChoice' })}>
              Try again
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ManualCodeForm({
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
    <>
      <h1>Almost there</h1>
      <p className="gate-sub">{message}</p>
      <form
        className="gate-form"
        onSubmit={(e) => {
          e.preventDefault();
          const value = inputRef.current?.value.trim();
          if (value) onSubmit(value);
        }}
      >
        <input ref={inputRef} type="text" placeholder={placeholder ?? 'Paste the code here'} autoFocus />
        <div className="gate-form-actions">
          <button type="button" className="push" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Continue
          </button>
        </div>
      </form>
    </>
  );
}

const LOCAL_SERVER_DEFAULTS: Record<LocalProviderId, string> = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
  custom: ''
};

const IS_DEFAULT_URL = (url: string): boolean =>
  Object.values(LOCAL_SERVER_DEFAULTS).some((d) => d !== '' && url === d);

/**
 * Local-only onboarding: point Stem at a running Ollama / LM Studio server, or at
 * an arbitrary OpenAI-compatible endpoint. The Test probe must find at least one
 * model before Continue unlocks, so the wizard can't finish into an empty
 * catalog — except for a custom endpoint, which may not serve a model listing at
 * all and so gates on the typed model IDs instead.
 */
function LocalServerForm({
  onDone,
  onFail,
  onBack
}: {
  onDone: (status?: RuntimeStatus) => void;
  onFail: (error: string) => void;
  onBack: () => void;
}) {
  const [server, setServer] = useState<LocalProviderId>('ollama');
  const [baseUrl, setBaseUrl] = useState(LOCAL_SERVER_DEFAULTS.ollama);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState('');
  const [test, setTest] = useState<LocalProviderTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const testGateRef = useRef(new RequestGate());
  const configRef = useRef({ server, baseUrl });
  configRef.current = { server, baseUrl };
  const custom = server === 'custom';
  const modelList = models
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  function invalidateTest() {
    testGateRef.current.invalidate();
    setTest(null);
    setTesting(false);
  }

  function pickServer(id: LocalProviderId) {
    invalidateTest();
    setServer(id);
    setApiKey('');
    setModels('');
    // Keep a hand-edited URL; replace one the user never touched.
    setBaseUrl((cur) => (IS_DEFAULT_URL(cur) || !cur ? LOCAL_SERVER_DEFAULTS[id] : cur));
  }

  async function runTest() {
    const request = testGateRef.current.begin();
    const tested = { server, baseUrl: baseUrl.trim() };
    setTesting(true);
    setTest(null);
    try {
      const result = await window.stem.testLocalProvider(
        tested.server,
        tested.baseUrl,
        custom ? apiKey.trim() : undefined
      );
      const current = configRef.current;
      if (
        testGateRef.current.isCurrent(request) &&
        current.server === tested.server &&
        current.baseUrl.trim() === tested.baseUrl
      ) {
        setTest(result);
        if (custom && result.ok && result.models?.length && !models.trim()) setModels(result.models.join(', '));
      }
    } catch {
      if (testGateRef.current.isCurrent(request)) {
        setTest({ ok: false, error: 'The server could not be reached.' });
      }
    } finally {
      if (testGateRef.current.isCurrent(request)) setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const res = await window.stem.updateLocalProvider(server, {
        enabled: true,
        baseUrl: baseUrl.trim(),
        apiKey: custom ? apiKey.trim() : '',
        models: custom ? modelList : []
      });
      if (res.ok) onDone(res.status);
      else onFail(res.error ?? 'The local server could not be set up.');
    } finally {
      setSaving(false);
    }
  }

  const modelCount = test?.ok ? test.models?.length ?? 0 : 0;
  const canContinue = custom
    ? !!baseUrl.trim() && modelList.length > 0 && !saving
    : !!test?.ok && modelCount > 0 && !saving;

  return (
    <>
      <h1>{custom ? 'Use your own endpoint' : 'Use a local model'}</h1>
      <p className="gate-sub">
        {custom ? (
          <>
            Point Stem at any OpenAI-compatible endpoint — a gateway, a proxy, a server on your network. Enter its URL,
            a key if it needs one, and the model IDs to offer.
          </>
        ) : (
          <>
            Chat with models running on this {DEVICE} — nothing leaves your machine. Start {providerName(server)}, then
            test the connection.
          </>
        )}
      </p>
      <form
        className="gate-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (canContinue) void save();
        }}
      >
        <select
          value={server}
          aria-label="Server"
          onChange={(e) => pickServer(e.target.value as LocalProviderId)}
        >
          <option value="ollama">Ollama</option>
          <option value="lmstudio">LM Studio</option>
          <option value="custom">Custom endpoint</option>
        </select>
        <input
          type="text"
          aria-label="Server URL"
          placeholder={custom ? 'https://api.example.com/v1' : undefined}
          value={baseUrl}
          onChange={(e) => {
            invalidateTest();
            setBaseUrl(e.target.value);
          }}
        />
        {custom && (
          <>
            <input
              type="password"
              aria-label="API key"
              placeholder="API key (leave empty if the server needs none)"
              value={apiKey}
              onChange={(e) => {
                invalidateTest();
                setApiKey(e.target.value);
              }}
            />
            <input
              type="text"
              aria-label="Model IDs"
              placeholder="Model IDs, comma-separated"
              value={models}
              onChange={(e) => setModels(e.target.value)}
            />
            <p className="gate-hint">
              Test connection fills these in when the endpoint lists its models; otherwise type them yourself.
            </p>
          </>
        )}
        {test && (
          // A failed probe is only an error when the probe is what unlocks
          // Continue; a custom endpoint that doesn't list models is expected, so
          // it reads as a hint next to the IDs the user typed.
          <p className={test.ok || custom ? 'gate-hint' : 'error'}>
            {test.ok
              ? modelCount > 0
                ? `Found ${modelCount} model${modelCount === 1 ? '' : 's'}.` +
                  (test.skippedNoTools ? ` ${test.skippedNoTools} hidden (no tool support).` : '')
                : test.skippedNoTools
                  ? `The server only has models without tool support — Stem needs a tool-capable model (e.g. llama3.1 or qwen2.5).`
                  : custom
                    ? `The endpoint answered but listed no models — enter the model IDs above.`
                    : `The server is running but has no models yet — pull/download one first.`
              : custom
                ? `Couldn't list models (${test.error}) — enter the model IDs above and continue.`
                : test.error}
          </p>
        )}
        <div className="gate-form-actions">
          <button type="button" className="push" onClick={onBack}>
            Back
          </button>
          <button type="button" className="push" onClick={() => void runTest()} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button type="submit" className="primary" disabled={!canContinue}>
            {saving ? 'Setting up…' : 'Continue'}
          </button>
        </div>
      </form>
    </>
  );
}

function ApiKeyForm({
  onSave,
  onBack
}: {
  onSave: (provider: ApiKeyProviderId, key: string) => void;
  onBack: () => void;
}) {
  const keyRef = useRef<HTMLInputElement>(null);
  const providerRef = useRef<HTMLSelectElement>(null);
  return (
    <>
      <h1>Use an API key</h1>
      <p className="gate-sub">
        Paste a key from your Anthropic, OpenAI, or OpenRouter account. It's stored only on this {DEVICE}.
      </p>
      <form
        className="gate-form"
        onSubmit={(e) => {
          e.preventDefault();
          const key = keyRef.current?.value.trim();
          const provider = (providerRef.current?.value as ApiKeyProviderId) ?? 'anthropic';
          if (key) onSave(provider, key);
        }}
      >
        <select ref={providerRef} defaultValue="anthropic" aria-label="API key provider">
          {API_KEY_PROVIDER_IDS.map((id) => (
            <option key={id} value={id}>
              {id === 'anthropic' ? 'Anthropic (Claude)' : providerName(id)}
            </option>
          ))}
        </select>
        <input ref={keyRef} type="password" placeholder="sk-…" autoFocus />
        <div className="gate-form-actions">
          <button type="button" className="push" onClick={onBack}>
            Back
          </button>
          <button type="submit" className="primary">
            Save key
          </button>
        </div>
      </form>
    </>
  );
}

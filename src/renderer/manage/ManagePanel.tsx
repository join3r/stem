import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Brain, Sparkles, Plug, Globe, HardDrive, Plus, Minus, ChevronRight, MessageSquare, Settings, X, FolderOpen } from 'lucide-react';
import type {
  CodexEventEnvelope,
  McpLoginUrlParams,
  McpServerSummary,
  McpTransport,
  MemoryContents,
  MemorySettings,
  ModelSummary,
  QuickChatSettings,
  SkillSummary
} from '../../shared/types';
import { MdxView } from '../chat/MdxView';
import { ChatList, type ChatListProps } from '../chats/ChatList';

type Tab = 'chats' | 'memory' | 'skills' | 'mcp' | 'settings';

const TABS: { id: Tab; label: string; icon: typeof Brain }[] = [
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'mcp', label: 'MCP', icon: Plug },
  { id: 'settings', label: 'Settings', icon: Settings }
];

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High'
};

// Inactivity presets for starting a fresh Quick Chat thread on re-summon.
// 0 = never (always continue the current session).
const NEW_THREAD_PRESETS: { label: string; ms: number }[] = [
  { label: 'Off', ms: 0 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 5 * 60_000 },
  { label: '15m', ms: 15 * 60_000 }
];

interface ModelTabProps {
  models: ModelSummary[];
  modelId: string | null;
  onSelectModel: (id: string) => void;
}

export type ManagePanelProps = ChatListProps & ModelTabProps;

export function ManagePanel({ models, modelId, onSelectModel, ...chatProps }: ManagePanelProps) {
  const [tab, setTab] = useState<Tab>('chats');
  return (
    <div className="manage">
      <div className="insp-tabs">
        <div className="insp-seg">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={tab === id ? 'active' : ''}
              title={label}
              aria-label={label}
              onClick={() => setTab(id)}
            >
              <Icon size={16} />
            </button>
          ))}
        </div>
      </div>
      <div className="manage-body">
        {tab === 'chats' && <ChatList {...chatProps} />}
        {tab === 'memory' && <MemoryTab />}
        {tab === 'skills' && <SkillsTab />}
        {tab === 'mcp' && <McpTab />}
        {tab === 'settings' && (
          <SettingsTab models={models} modelId={modelId} onSelectModel={onSelectModel} />
        )}
      </div>
    </div>
  );
}

function MemoryTab() {
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [contents, setContents] = useState<MemoryContents | null>(null);
  const [showTech, setShowTech] = useState(false);

  function loadContents() {
    window.stem.readMemory().then(setContents);
  }

  useEffect(() => {
    window.stem.getMemorySettings().then(setSettings);
    loadContents();
  }, []);

  async function toggle() {
    if (!settings) return;
    setSettings(await window.stem.setMemoryEnabled(!settings.enabled));
  }

  if (!settings) return <p className="muted">Loading…</p>;

  const notes = contents?.files.filter((f) => f.kind === 'note' && f.content.trim()) ?? [];
  const techFiles = contents?.files.filter((f) => f.kind === 'native' && f.exists && f.content.trim()) ?? [];

  return (
    <div>
      <div className="grp-head">Memory</div>
      <div className="group">
        <div className="group-row">
          <span className="row-main">
            <strong>Memory</strong>
            <em>Remember across conversations</em>
          </span>
          <button
            className={`switch${settings.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={settings.enabled}
            aria-label="Memory"
            onClick={toggle}
          />
        </div>
      </div>

      <div className="memory-view">
        <div className="memory-view-head">
          <strong>Stored memory</strong>
          <button className="link-btn" onClick={loadContents}>Refresh</button>
        </div>
        {!contents && <p className="muted">Loading…</p>}
        {contents && notes.length === 0 && (
          <p className="muted">No memories stored yet — Stem builds these as you chat.</p>
        )}
        {notes.map((f) => (
          <div key={f.name} className="memory-note">
            {f.statement ? <p className="statement">{f.statement}</p> : <MdxView text={f.content} />}
            {f.source && <span className="chip">{f.source}</span>}
          </div>
        ))}

        {techFiles.length > 0 && (
          <div className="memory-tech">
            <button
              className="memory-tech-head"
              aria-expanded={showTech}
              onClick={() => setShowTech((v) => !v)}
            >
              <ChevronRight size={14} className={showTech ? 'open' : ''} />
              <span>Technical details ({techFiles.length})</span>
            </button>
            {showTech &&
              techFiles.map((f) => (
                <div key={f.name} className="memory-doc">
                  <h4>{f.label}</h4>
                  <MdxView text={f.content} />
                </div>
              ))}
          </div>
        )}

        {contents && <p className="muted memory-path">{contents.dir}</p>}
      </div>
    </div>
  );
}

function SkillsTab() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  useEffect(() => {
    window.stem.listSkills().then(setSkills);
  }, []);

  async function toggle(slug: string, enabled: boolean) {
    setSkills(await window.stem.setSkillEnabled(slug, enabled));
  }

  if (skills.length === 0) {
    return <p className="muted">No skills yet. Drop a SKILL.md folder into the skills directory.</p>;
  }

  return (
    <div>
      <div className="grp-head">Skills</div>
      <div className="group">
        {skills.map((s) => (
          <div key={s.slug} className="group-row">
            <span className="row-main">
              <strong>{s.name}</strong>
              <em>{s.description}</em>
            </span>
            <button
              className={`switch${s.enabled ? ' on' : ''}`}
              role="switch"
              aria-checked={s.enabled}
              aria-label={s.name}
              onClick={() => toggle(s.slug, !s.enabled)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Settings tab: Quick Chat overlay configuration ----

// macOS canonical modifier order (⌃⌥⇧⌘) and their glyphs.
const MOD_ORDER = ['Control', 'Alt', 'Shift', 'Command'];
const MOD_GLYPH: Record<string, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' };
// The hyperkey fires all four modifiers at once; we collapse them to one icon.
const HYPER_MODS = ['Command', 'Control', 'Alt', 'Shift'];

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

/** Render an Electron accelerator ('Control+Alt+J') as mac glyphs, collapsing a
 *  full four-modifier hyperkey into a single hyper icon. */
function renderAccelerator(accel: string): ReactNode {
  const parts = accel.split('+');
  const mods = parts.filter((p) => HYPER_MODS.includes(p)).sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  const keys = parts.filter((p) => !HYPER_MODS.includes(p));
  const isHyper = HYPER_MODS.every((m) => mods.includes(m));
  return (
    <span className="accel">
      {isHyper ? (
        <span className="accel-hyper" aria-label="Hyper">✦</span>
      ) : (
        mods.map((m) => MOD_GLYPH[m] ?? m).join('')
      )}
      {keys.join('')}
    </span>
  );
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
    if (e.metaKey) mods.push('Command');
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

function SettingsTab({ models, modelId, onSelectModel }: ModelTabProps) {
  const [qc, setQc] = useState<QuickChatSettings | null>(null);
  const selectedModel = models.find((m) => m.id === modelId) ?? null;

  useEffect(() => {
    window.stem.getSettings().then((s) => setQc(s.quickChat));
  }, []);

  function update(patch: Partial<QuickChatSettings>) {
    window.stem.updateQuickChat(patch).then((s) => setQc(s.quickChat));
  }

  if (!qc) return <p className="muted">Loading…</p>;

  return (
    <div>
      <div className="grp-head">Model</div>
      <div className="formgroup">
        {models.length === 0 ? (
          <p className="muted">Loading models…</p>
        ) : (
          <>
            <select className="ifield" value={modelId ?? ''} onChange={(e) => onSelectModel(e.target.value)}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
            {selectedModel?.description && <p className="muted">{selectedModel.description}</p>}
          </>
        )}
      </div>

      <div className="grp-head">Files</div>
      <div className="formgroup">
        <div className="set-row">
          <span className="set-label">
            <strong>Files folder</strong>
            <em>Drop files here for Stem to read across chats</em>
          </span>
          <button
            className="icon-action"
            title="Open in Finder"
            aria-label="Open Files folder in Finder"
            onClick={() => window.stem.revealFiles()}
          >
            <FolderOpen size={16} />
          </button>
        </div>
      </div>

      <div className="grp-head">Quick Chat</div>
      <div className="formgroup">
        <div className="set-row">
          <span className="set-label">
            <strong>Global shortcut</strong>
            <em>Summon the quick-chat overlay from anywhere</em>
          </span>
          <ShortcutRecorder value={qc.shortcut} onChange={(accel) => update({ shortcut: accel })} />
        </div>

        <div className="set-block">
          <span className="set-sub">Default model</span>
          <select
            className="ifield"
            value={qc.defaultModel ?? ''}
            onChange={(e) => update({ defaultModel: e.target.value || null })}
          >
            <option value="">Same as main</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>

        <div className="set-block">
          <span className="set-sub">Default effort</span>
          <div className="seg-ctl">
            {(['low', 'medium', 'high', 'xhigh'] as const).map((e) => (
              <button key={e} className={qc.defaultEffort === e ? 'active' : ''} onClick={() => update({ defaultEffort: e })}>
                {EFFORT_LABELS[e]}
              </button>
            ))}
          </div>
        </div>

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
            >
              Fast
            </button>
          </div>
        </div>

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
      </div>
      <p className="muted" style={{ marginTop: 10 }}>
        Press the shortcut to open the overlay; Escape or the shortcut again hides it.
      </p>
    </div>
  );
}

function McpTab() {
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [transport, setTransport] = useState<McpTransport>('http');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loginName, setLoginName] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<McpLoginUrlParams | null>(null);
  const [signedIn, setSignedIn] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    setServers(await window.stem.listMcpServers());
  }

  useEffect(() => {
    refresh();
  }, []);

  // The OAuth authorize URL is streamed mid-login as a fallback link.
  useEffect(() => {
    return window.stem.onCodexEvent((event: CodexEventEnvelope) => {
      if (event.method === 'mcp/login/url') setLoginUrl(event.params as McpLoginUrlParams);
    });
  }, []);

  // Apply config/token changes to the live session without an app restart.
  async function reconnect() {
    setBusy('Reconnecting…');
    try {
      await window.stem.restartRuntime();
    } finally {
      setBusy(null);
    }
  }

  const canAdd =
    !!name.trim() && (transport === 'http' ? !!url.trim() : !!command.trim()) && !busy;

  async function add() {
    setError(null);
    try {
      const list = await window.stem.addMcpServer({
        name: name.trim(),
        transport,
        command: command.trim(),
        args: args.trim() ? args.trim().split(/\s+/) : [],
        url: url.trim()
      });
      setServers(list);
      setName('');
      setCommand('');
      setArgs('');
      setUrl('');
      await reconnect();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function remove(serverName: string) {
    setError(null);
    setServers(await window.stem.removeMcpServer(serverName));
    setSelected((cur) => (cur === serverName ? null : cur));
    setSignedIn((prev) => {
      const next = new Set(prev);
      next.delete(serverName);
      return next;
    });
    await reconnect();
  }

  async function signIn(serverName: string) {
    setError(null);
    setLoginName(serverName);
    setLoginUrl(null);
    try {
      const result = await window.stem.loginMcpServer(serverName);
      if (result.ok) {
        setSignedIn((prev) => new Set(prev).add(serverName));
        await reconnect();
        await refresh();
      } else {
        setError(result.error ?? 'Sign in failed.');
      }
    } finally {
      setLoginName(null);
      setLoginUrl(null);
    }
  }

  function signInLabel(serverName: string): string {
    if (loginName === serverName) return 'Waiting…';
    if (signedIn.has(serverName)) return 'Signed in';
    return 'Sign in';
  }

  return (
    <div>
      <div className="grp-head">MCP Servers</div>
      {servers.length === 0 ? (
        <div className="group">
          <div className="group-row">
            <span className="row-main">
              <em>No servers yet. Add one below.</em>
            </span>
          </div>
        </div>
      ) : (
        <div className="group">
          {servers.map((s) => {
            const remote = s.transport === 'http';
            const isSignedIn = signedIn.has(s.name);
            return (
              <div
                key={s.name}
                className={`group-row${selected === s.name ? ' selected' : ''}`}
                onClick={() => setSelected(s.name)}
              >
                <span className={`row-icon ${remote ? 'remote' : 'local'}`}>
                  {remote ? <Globe size={14} /> : <HardDrive size={14} />}
                </span>
                <span className="row-main">
                  <strong>{s.name}</strong>
                  <em>{remote ? s.url : `${s.command} ${s.args.join(' ')}`.trim()}</em>
                </span>
                {remote && !isSignedIn ? (
                  <button
                    className="push"
                    onClick={(e) => {
                      e.stopPropagation();
                      signIn(s.name);
                    }}
                    disabled={!!loginName || !!busy}
                  >
                    {signInLabel(s.name)}
                  </button>
                ) : (
                  <span className={`pill ${remote ? 'ok' : 'off'}`}>{remote ? 'Signed in' : 'Local'}</span>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="gutter">
        <button title="Add server" onClick={() => nameRef.current?.focus()}>
          <Plus size={15} />
        </button>
        <button
          title="Remove selected"
          onClick={() => selected && remove(selected)}
          disabled={!selected || !!busy || !!loginName}
        >
          <Minus size={15} />
        </button>
      </div>

      {loginName && loginUrl?.name === loginName && (
        <p className="muted">
          If the browser didn’t open, authorize here:{' '}
          <a href={loginUrl.url} target="_blank" rel="noreferrer">{loginUrl.url}</a>
        </p>
      )}
      {busy && <p className="muted">{busy}</p>}

      <div className="grp-head">Add Server</div>
      <div className="formgroup">
        <div className="seg-ctl">
          <button className={transport === 'http' ? 'active' : ''} onClick={() => setTransport('http')}>
            Remote
          </button>
          <button className={transport === 'stdio' ? 'active' : ''} onClick={() => setTransport('stdio')}>
            Local
          </button>
        </div>
        <input ref={nameRef} className="ifield" placeholder="Name (e.g. fastmail)" value={name} onChange={(e) => setName(e.target.value)} />
        {transport === 'http' ? (
          <input className="ifield" placeholder="https://api.fastmail.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
        ) : (
          <>
            <input className="ifield" placeholder="command (e.g. npx)" value={command} onChange={(e) => setCommand(e.target.value)} />
            <input className="ifield" placeholder="args (space-separated)" value={args} onChange={(e) => setArgs(e.target.value)} />
          </>
        )}
        <div className="push-row">
          <button className="push default" onClick={add} disabled={!canAdd}>Add Server</button>
        </div>
        {transport === 'http' && (
          <p className="muted">Remote servers are added unauthenticated — use “Sign in” to authorize via OAuth.</p>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Brain, Plug, Globe, HardDrive, Plus, Minus, ChevronRight, MessageSquare, Settings, X, FolderOpen, Trash2, Wand2 } from 'lucide-react';
import type {
  BackendEventEnvelope,
  McpLoginUrlParams,
  McpServerStatus,
  McpServerSummary,
  McpTransport,
  MemoryContents,
  MemorySettings,
  ModelSummary,
  NativeWebSearchSettings,
  QuickChatSettings,
  SkillSummary
} from '../../shared/types';
import { MdxView } from '../chat/MdxView';
import { ChatList, type ChatListProps } from '../chats/ChatList';
import { ModelPicker } from '../ui/ModelPicker';

type Tab = 'chats' | 'memory' | 'mcp' | 'settings';

const TABS: { id: Tab; label: string; icon: typeof Brain }[] = [
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'mcp', label: 'MCP & Skills', icon: Plug },
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
        {tab === 'memory' && <MemoryTab models={models} />}
        {tab === 'mcp' && <McpSkillsTab />}
        {tab === 'settings' && (
          <SettingsTab models={models} modelId={modelId} onSelectModel={onSelectModel} />
        )}
      </div>
    </div>
  );
}

function MemoryTab({ models }: { models: ModelSummary[] }) {
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [contents, setContents] = useState<MemoryContents | null>(null);
  const [showTech, setShowTech] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [consolidateMsg, setConsolidateMsg] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  // null => use the backend default model for distillation/tidy-up.
  const [memoryModel, setMemoryModel] = useState<string | null>(null);

  function loadContents() {
    window.stem.readMemory().then(setContents);
  }

  useEffect(() => {
    window.stem.getMemorySettings().then(setSettings);
    window.stem.getSettings().then((s) => setMemoryModel(s.memory.model));
    loadContents();
  }, []);

  function selectMemoryModel(id: string | null) {
    setMemoryModel(id);
    window.stem.updateMemorySettings({ model: id }).then((s) => setMemoryModel(s.memory.model));
  }

  async function toggle() {
    if (!settings) return;
    setSettings(await window.stem.setMemoryEnabled(!settings.enabled));
  }

  async function forget(id: number) {
    setContents(await window.stem.forgetMemory(id));
  }

  async function reset() {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setResetting(true);
    setConsolidateMsg(null);
    try {
      setContents(await window.stem.resetMemory());
      setConsolidateMsg('All memories cleared.');
    } catch {
      setConsolidateMsg('Reset failed — try again.');
    } finally {
      setResetting(false);
      setConfirmReset(false);
    }
  }

  async function consolidate() {
    setConsolidating(true);
    setConsolidateMsg(null);
    try {
      const r = await window.stem.consolidateMemory();
      setContents(r.contents);
      const changed = r.merged + r.corrected + r.dropped;
      setConsolidateMsg(
        changed === 0
          ? 'No duplicates or stale facts found.'
          : `Merged ${r.merged}, corrected ${r.corrected}, dropped ${r.dropped}.`
      );
    } catch {
      setConsolidateMsg('Consolidation failed — try again.');
    } finally {
      setConsolidating(false);
    }
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

      <div className="grp-head">Model</div>
      <div className="formgroup">
        <ModelPicker
          models={models}
          value={memoryModel}
          onChange={selectMemoryModel}
          emptyLabel="Default (recommended)"
          ariaLabel="Memory model"
        />
        <p className="muted">Used to distill and tidy up memories in the background.</p>
      </div>

      <div className="memory-view">
        <div className="memory-view-head">
          <strong>Stored memory</strong>
          <span className="memory-view-actions">
            <button
              className="link-btn"
              onClick={consolidate}
              disabled={consolidating || !settings.enabled || notes.length < 2}
              title="Merge duplicates and drop stale facts now"
            >
              <Wand2 size={13} /> {consolidating ? 'Tidying…' : 'Tidy up'}
            </button>
            <button className="link-btn" onClick={loadContents}>Refresh</button>
          </span>
        </div>
        {consolidateMsg && <p className="muted">{consolidateMsg}</p>}
        {!contents && <p className="muted">Loading…</p>}
        {contents && notes.length === 0 && (
          <p className="muted">No memories stored yet — Stem builds these as you chat.</p>
        )}
        {notes.map((f) => (
          <div key={f.name} className="memory-note">
            <div className="memory-note-body">
              {f.statement ? <p className="statement">{f.statement}</p> : <MdxView text={f.content} />}
              {f.source && <span className="chip">{f.source}</span>}
            </div>
            {f.id != null && (
              <button
                className="memory-note-forget"
                title="Forget this"
                aria-label="Forget this memory"
                onClick={() => forget(f.id!)}
              >
                <Trash2 size={14} />
              </button>
            )}
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

        {(notes.length > 0 || techFiles.length > 0) && (
          <div className="memory-reset">
            {confirmReset ? (
              <span className="memory-reset-confirm">
                <span className="muted">
                  Erase all {notes.length} {notes.length === 1 ? 'memory' : 'memories'}? This can’t be undone.
                </span>
                <button className="link-btn danger" onClick={reset} disabled={resetting}>
                  {resetting ? 'Resetting…' : 'Erase everything'}
                </button>
                <button className="link-btn" onClick={() => setConfirmReset(false)} disabled={resetting}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                className="link-btn danger memory-reset-trigger"
                onClick={reset}
                title="Permanently erase all memories (keeps your files)"
              >
                <Trash2 size={12} /> Reset all memory
              </button>
            )}
          </div>
        )}
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
  const [nws, setNws] = useState<NativeWebSearchSettings>({ main: true, quickChat: true });
  const selectedModel = models.find((m) => m.id === modelId) ?? null;

  useEffect(() => {
    window.stem.getSettings().then((s) => {
      setQc(s.quickChat);
      setNws(s.nativeWebSearch);
    });
  }, []);

  function update(patch: Partial<QuickChatSettings>) {
    window.stem.updateQuickChat(patch).then((s) => setQc(s.quickChat));
  }

  function toggleNativeSearch(key: keyof NativeWebSearchSettings, enabled: boolean) {
    window.stem.updateNativeWebSearch({ [key]: enabled }).then((s) => setNws(s.nativeWebSearch));
  }

  if (!qc) return <p className="muted">Loading…</p>;

  // The Quick Chat default-effort options follow the chosen default model's capabilities.
  // "Same as main" (empty) has no concrete model here, so offer all levels.
  const qcModel = qc.defaultModel ? models.find((m) => m.id === qc.defaultModel) : undefined;
  const qcEfforts = qcModel?.supportedEfforts.length ? qcModel.supportedEfforts : ['low', 'medium', 'high', 'xhigh'];

  // Switch the default model, clamping a now-unsupported saved effort into range.
  function selectQcModel(id: string | null) {
    const m = id ? models.find((x) => x.id === id) : undefined;
    const efforts = m?.supportedEfforts.length ? m.supportedEfforts : ['low', 'medium', 'high', 'xhigh'];
    const patch: Partial<QuickChatSettings> = { defaultModel: id };
    if (qc && !efforts.includes(qc.defaultEffort)) patch.defaultEffort = m?.defaultEffort ?? efforts[0];
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
            {selectedModel?.description && <p className="muted">{selectedModel.description}</p>}
            {selectedModel?.supportsNativeWebSearch && (
              <label className="set-check" title="Search the live web for current info, with citations">
                <input
                  type="checkbox"
                  checked={nws.main}
                  onChange={(e) => toggleNativeSearch('main', e.target.checked)}
                />
                Native web search
              </label>
            )}
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
          <ModelPicker
            models={models}
            value={qc.defaultModel}
            onChange={selectQcModel}
            emptyLabel="Same as main"
            ariaLabel="Quick Chat default model"
          />
          {qcModel?.supportsNativeWebSearch && (
            <label className="set-check" title="Search the live web for current info, with citations">
              <input
                type="checkbox"
                checked={nws.quickChat}
                onChange={(e) => toggleNativeSearch('quickChat', e.target.checked)}
              />
              Native web search
            </label>
          )}
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

// Combined panel: MCP servers and Skills live under the same icon as two sub-tabs.
function McpSkillsTab() {
  const [sub, setSub] = useState<'mcp' | 'skills'>('mcp');
  return (
    <div>
      <div className="seg-ctl">
        <button className={sub === 'mcp' ? 'active' : ''} onClick={() => setSub('mcp')}>
          MCP servers
        </button>
        <button className={sub === 'skills' ? 'active' : ''} onClick={() => setSub('skills')}>
          Skills
        </button>
      </div>
      {sub === 'mcp' ? <McpTab /> : <SkillsTab />}
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
  const [envText, setEnvText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loginName, setLoginName] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<McpLoginUrlParams | null>(null);
  // Live per-server connection status from the running app-server. This is the
  // source of truth for whether a remote server actually works — `authStatus`
  // only says whether OAuth creds exist on disk, which stays 'o_auth' even when
  // the token is rejected at connect time and the server exposes no tools.
  const [statuses, setStatuses] = useState<Record<string, McpServerStatus>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    const [list, status] = await Promise.all([
      window.stem.listMcpServers(),
      window.stem.getMcpStatus()
    ]);
    setServers(list);
    setStatuses(status);
  }

  useEffect(() => {
    refresh();
    // The assistant can add/remove servers itself; refresh the list when it does.
    const offChanged = window.stem.onMcpChanged(() => refresh());
    // Live connection-status updates (e.g. a server goes ready/failed).
    const offStatus = window.stem.onMcpStatus((s) => setStatuses(s));
    return () => {
      offChanged();
      offStatus();
    };
  }, []);

  // The OAuth authorize URL is streamed mid-login as a fallback link.
  useEffect(() => {
    return window.stem.onBackendEvent((event: BackendEventEnvelope) => {
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

  // Parse the env textarea ("KEY=value" per line) into a map; blank/`#` lines skipped.
  function parseEnv(text: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return env;
  }

  // Parse the headers textarea ("Key: value" or "Key=value" per line).
  function parseHeaders(text: string): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const i = trimmed.search(/[:=]/);
      if (i <= 0) continue;
      headers[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim();
    }
    return headers;
  }

  async function add() {
    setError(null);
    try {
      const headers = transport === 'http' ? parseHeaders(envText) : {};
      const env = transport === 'http' ? {} : parseEnv(envText);
      const list = await window.stem.addMcpServer({
        name: name.trim(),
        transport,
        command: command.trim(),
        args: args.trim() ? args.trim().split(/\s+/) : [],
        url: url.trim(),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {})
      });
      setServers(list);
      setName('');
      setCommand('');
      setArgs('');
      setUrl('');
      setEnvText('');
      await reconnect();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function remove(serverName: string) {
    setError(null);
    setServers(await window.stem.removeMcpServer(serverName));
    setSelected((cur) => (cur === serverName ? null : cur));
    setStatuses((prev) => {
      const next = { ...prev };
      delete next[serverName];
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
        // reconnect() respawns the app-server, which clears stale statuses and
        // re-emits fresh ones; refresh() then pulls the new snapshot.
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

  /**
   * Resolve how a remote (http) server should present. Live connection status
   * wins; we fall back to `authStatus` only when the app-server hasn't reported
   * yet (e.g. the panel opened before any thread started this session).
   *   connected — handshook, tools available
   *   failed    — dropped at connect time (OAuth token rejected → offer re-login)
   *   pending   — still starting
   *   needs-login — remote server with no usable credentials
   */
  function remoteState(s: McpServerSummary): 'connected' | 'failed' | 'pending' | 'needs-login' {
    const live = statuses[s.name]?.status;
    if (live === 'ready') return 'connected';
    if (live === 'failed') return 'failed';
    if (live === 'starting') return 'pending';
    const hasCreds = s.authStatus === 'o_auth' || s.authStatus === 'bearer_token';
    return hasCreds ? 'connected' : 'needs-login';
  }

  function signInLabel(serverName: string, state: 'failed' | 'needs-login'): string {
    if (loginName === serverName) return 'Waiting…';
    return state === 'failed' ? 'Reconnect' : 'Sign in';
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
            const state = remote ? remoteState(s) : null;
            const needsLogin = state === 'failed' || state === 'needs-login';
            const error = statuses[s.name]?.error ?? undefined;
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
                  <em title={state === 'failed' ? error : undefined} className={state === 'failed' ? 'mcp-failed' : undefined}>
                    {state === 'failed'
                      ? 'Connection failed — sign in again.'
                      : remote
                        ? s.url
                        : `${s.command} ${s.args.join(' ')}`.trim()}
                  </em>
                </span>
                {remote && needsLogin ? (
                  <button
                    className="push"
                    onClick={(e) => {
                      e.stopPropagation();
                      signIn(s.name);
                    }}
                    disabled={!!loginName || !!busy}
                  >
                    {signInLabel(s.name, state)}
                  </button>
                ) : remote ? (
                  <span className={`pill ${state === 'pending' ? 'off' : 'ok'}`}>
                    {state === 'pending' ? 'Connecting…' : 'Connected'}
                  </span>
                ) : (
                  <span className="pill off">Local</span>
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
          <>
            <input className="ifield" placeholder="https://api.fastmail.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
            <textarea
              className="ifield"
              placeholder="headers (optional), one per line — e.g. Authorization: Bearer …"
              rows={2}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
            />
          </>
        ) : (
          <>
            <input className="ifield" placeholder="command (e.g. npx)" value={command} onChange={(e) => setCommand(e.target.value)} />
            <input className="ifield" placeholder="args (space-separated)" value={args} onChange={(e) => setArgs(e.target.value)} />
            <textarea
              className="ifield"
              placeholder="env (optional), one KEY=value per line"
              rows={2}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
            />
          </>
        )}
        <div className="push-row">
          <button className="push default" onClick={add} disabled={!canAdd}>Add Server</button>
        </div>
        {transport === 'http' && (
          <p className="muted">
            Add an auth header (e.g. <code>Authorization: Bearer …</code>) above, or leave blank and use
            “Sign in” to authorize via OAuth where supported.
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

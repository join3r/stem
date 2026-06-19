import { useEffect, useRef, useState } from 'react';
import { Brain, Sparkles, Plug, Globe, HardDrive, Plus, Minus, ChevronRight } from 'lucide-react';
import type {
  CodexEventEnvelope,
  McpLoginUrlParams,
  McpServerSummary,
  McpTransport,
  MemoryContents,
  MemorySettings,
  SkillSummary
} from '../../shared/types';
import { MdxView } from '../chat/MdxView';

type Tab = 'memory' | 'skills' | 'mcp';

const TABS: { id: Tab; label: string; icon: typeof Brain }[] = [
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'skills', label: 'Skills', icon: Sparkles },
  { id: 'mcp', label: 'MCP', icon: Plug }
];

export function ManagePanel() {
  const [tab, setTab] = useState<Tab>('memory');
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
        {tab === 'memory' && <MemoryTab />}
        {tab === 'skills' && <SkillsTab />}
        {tab === 'mcp' && <McpTab />}
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
            <strong>Native memory</strong>
            <em>Remember across conversations</em>
          </span>
          <button
            className={`switch${settings.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={settings.enabled}
            aria-label="Native memory"
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

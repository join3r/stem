import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type {
  CodexEventEnvelope,
  McpLoginUrlParams,
  McpServerSummary,
  McpTransport,
  MemorySettings,
  SkillSummary
} from '../../shared/types';

type Tab = 'memory' | 'skills' | 'mcp';

export function ManagePanel() {
  const [tab, setTab] = useState<Tab>('memory');
  return (
    <div className="manage">
      <div className="manage-tabs">
        <button className={tab === 'memory' ? 'active' : ''} onClick={() => setTab('memory')}>Memory</button>
        <button className={tab === 'skills' ? 'active' : ''} onClick={() => setTab('skills')}>Skills</button>
        <button className={tab === 'mcp' ? 'active' : ''} onClick={() => setTab('mcp')}>MCP</button>
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
  useEffect(() => {
    window.stem.getMemorySettings().then(setSettings);
  }, []);

  async function toggle() {
    if (!settings) return;
    setSettings(await window.stem.setMemoryEnabled(!settings.enabled));
  }

  if (!settings) return <p className="muted">Loading…</p>;
  return (
    <div>
      <label className="switch-row">
        <input type="checkbox" checked={settings.enabled} onChange={toggle} />
        <span>Native memory {settings.enabled ? 'on' : 'off'}</span>
      </label>
      <p className="muted">When on, Stem remembers across conversations. Stored in its isolated home.</p>
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

  return (
    <div>
      {skills.length === 0 && <p className="muted">No skills yet. Drop a SKILL.md folder into the skills directory.</p>}
      {skills.map((s) => (
        <div key={s.slug} className="list-row">
          <label className="switch-row">
            <input type="checkbox" checked={s.enabled} onChange={() => toggle(s.slug, !s.enabled)} />
            <span>
              <strong>{s.name}</strong>
              <em className="muted">{s.description}</em>
            </span>
          </label>
        </div>
      ))}
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
    if (loginName === serverName) return 'Waiting for browser…';
    if (signedIn.has(serverName)) return 'Signed in ✓';
    return 'Sign in';
  }

  return (
    <div>
      {servers.map((s) => (
        <div key={s.name} className="list-row">
          <span>
            <strong>{s.name}</strong>
            <em className="muted">{s.transport === 'http' ? s.url : `${s.command} ${s.args.join(' ')}`.trim()}</em>
          </span>
          <span className="mcp-row-actions">
            {s.transport === 'http' && (
              <button
                className="mcp-signin"
                onClick={() => signIn(s.name)}
                disabled={!!loginName || !!busy || signedIn.has(s.name)}
              >
                {signInLabel(s.name)}
              </button>
            )}
            <button className="icon-btn" onClick={() => remove(s.name)} title="Remove" disabled={!!busy || !!loginName}>
              <Trash2 size={16} />
            </button>
          </span>
        </div>
      ))}

      {loginName && loginUrl?.name === loginName && (
        <p className="muted">
          If the browser didn’t open, authorize here:{' '}
          <a href={loginUrl.url} target="_blank" rel="noreferrer">{loginUrl.url}</a>
        </p>
      )}
      {busy && <p className="muted">{busy}</p>}

      <div className="mcp-form">
        <div className="mcp-transport">
          <button className={transport === 'http' ? 'active' : ''} onClick={() => setTransport('http')}>
            Remote (URL)
          </button>
          <button className={transport === 'stdio' ? 'active' : ''} onClick={() => setTransport('stdio')}>
            Local (command)
          </button>
        </div>
        <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        {transport === 'http' ? (
          <input placeholder="url (e.g. https://api.fastmail.com/mcp)" value={url} onChange={(e) => setUrl(e.target.value)} />
        ) : (
          <>
            <input placeholder="command (e.g. npx)" value={command} onChange={(e) => setCommand(e.target.value)} />
            <input placeholder="args (space-separated)" value={args} onChange={(e) => setArgs(e.target.value)} />
          </>
        )}
        <button onClick={add} disabled={!canAdd}>Add server</button>
        {transport === 'http' && (
          <p className="muted">Remote servers are added unauthenticated — use “Sign in” above to authorize via OAuth.</p>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

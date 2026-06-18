import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { McpServerSummary, MemorySettings, SkillSummary } from '../../shared/types';

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
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.stem.listMcpServers().then(setServers);
  }, []);

  async function add() {
    setError(null);
    try {
      const list = await window.stem.addMcpServer({
        name: name.trim(),
        command: command.trim(),
        args: args.trim() ? args.trim().split(/\s+/) : []
      });
      setServers(list);
      setName('');
      setCommand('');
      setArgs('');
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function remove(serverName: string) {
    setServers(await window.stem.removeMcpServer(serverName));
  }

  return (
    <div>
      {servers.map((s) => (
        <div key={s.name} className="list-row">
          <span>
            <strong>{s.name}</strong>
            <em className="muted">{s.command} {s.args.join(' ')}</em>
          </span>
          <button className="icon-btn" onClick={() => remove(s.name)} title="Remove">
            <Trash2 size={16} />
          </button>
        </div>
      ))}
      <div className="mcp-form">
        <input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="command (e.g. npx)" value={command} onChange={(e) => setCommand(e.target.value)} />
        <input placeholder="args (space-separated)" value={args} onChange={(e) => setArgs(e.target.value)} />
        <button onClick={add} disabled={!name.trim() || !command.trim()}>Add server</button>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

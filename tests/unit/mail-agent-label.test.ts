// Agents are addressed `<roleId>~<name>`; every client labels them from the
// persona list alone, and the router derives ids and names the same way.
import { describe, expect, it } from 'vitest';
import { personaName } from '../../src/renderer/mail/useMail';
import { agentId, agentName, agentPersona, agentSlug, isAgentId, narrowMcpServers, spawnableRoles } from '../../src/server/mail/agents';
import type { Persona } from '../../src/shared/types';

const personas: Persona[] = [{ id: 'critic', name: 'Critic', prompt: 'You are Critic.' }];

describe('agent addresses', () => {
  it('labels an agent by its name and role, and a persona by its name', () => {
    expect(personaName(personas, 'critic~reviewer-a')).toBe('reviewer-a (Critic)');
    expect(personaName(personas, 'gone~reviewer-a')).toBe('reviewer-a');
    expect(personaName(personas, 'critic')).toBe('Critic');
    expect(personaName(personas, 'task:1')).toBe('Scheduled task');
  });

  it('slugs model-picked names into safe ids', () => {
    expect(agentSlug('Reviewer A')).toBe('reviewer-a');
    expect(agentSlug('  <!-- x -->\n')).toBe('x');
    expect(agentSlug('!!!')).toBe('');
    expect(agentSlug('a'.repeat(40))).toHaveLength(32);
    const id = agentId('critic', 'reviewer-a');
    expect(isAgentId(id)).toBe(true);
    expect(isAgentId('critic')).toBe(false);
    expect(agentName(id)).toBe('reviewer-a');
  });

  it('runs an agent with its role but without memory, client access, or a second level of spawning', () => {
    const role: Persona = { ...personas[0], canSpawn: true, clients: true, builtin: true };
    const top = agentPersona(role, { id: 'critic~a', role: 'critic', name: 'a', spawnedBy: 'normal' }, {});
    expect(top).toMatchObject({ id: 'critic~a', name: 'a', prompt: 'You are Critic.', memory: false, canSpawn: true });
    expect(top.clients).toBeUndefined();
    expect(top.builtin).toBeUndefined();
    expect(top.recall).toBeUndefined();
    const nested = agentPersona(role, { id: 'critic~b', role: 'critic', name: 'b', spawnedBy: 'orchestrator~x', blind: true }, {});
    expect(nested.canSpawn).toBeUndefined();
    expect(nested.recall).toBe(false);
    const narrowed = agentPersona(
      { ...role, mcpServers: ['a', 'b'] },
      { id: 'critic~c', role: 'critic', name: 'c', spawnedBy: 'normal' },
      { mcpServers: ['a'], recall: false }
    );
    expect(narrowed.mcpServers).toEqual(['a']);
    expect(narrowed.recall).toBe(false);
  });

  it('never gives an agent wider integrations than its starter', () => {
    expect(narrowMcpServers(undefined, undefined)).toBeUndefined();
    expect(narrowMcpServers(['a'], undefined)).toEqual(['a']);
    expect(narrowMcpServers(undefined, ['b'])).toEqual(['b']);
    expect(narrowMcpServers(['a', 'b'], ['b', 'c'])).toEqual(['b']);
    expect(narrowMcpServers(['a'], [])).toEqual([]);
  });
});

describe('spawnable roles', () => {
  it('lists unpinned personas plus pinned ones in the conversation, marking coding roles', () => {
    const list: Persona[] = [
      { id: 'critic', name: 'Critic', prompt: '', recall: false, model: 'xai/grok-5' },
      { id: 'coder', name: 'Coder', prompt: '', harness: { agent: 'claude', cwd: '/r' } },
      { id: 'mac', name: 'Mac', prompt: '', computer: { device: 'm1' } }
    ];
    expect(spawnableRoles(list, ['coder'])).toEqual([
      { id: 'critic', name: 'Critic', model: 'xai/grok-5', blind: true },
      { id: 'coder', name: 'Coder', code: true }
    ]);
    expect(spawnableRoles(list, []).map((r) => r.id)).toEqual(['critic']);
  });
});

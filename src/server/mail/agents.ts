import type { MailAgent, Persona } from '../../shared/types';

// Agents: named, conversation-scoped instances of a persona (its role),
// started by spawn_agent to work one piece of a job. A persona is the reusable
// definition the user curates; an agent is what a job runs. The two used to be
// one thing — a second reviewer meant a second permanent persona, and the
// registry filled with helpers nobody cleaned up — which is the split the
// sub-agent designs elsewhere (Claude Code, Codex) also make.
//
// An agent lives on its conversation (MailConversation.agents), has its own
// hidden thread under its id in `sessions`, and runs with its role's prompt,
// model and capabilities — minus memory: it is one job's worker, not an expert
// that accumulates notes.

/** The most agents one conversation may start. Each is a full turn per mail, so this bounds the bill. */
export const MAX_AGENTS = 6;

const SEPARATOR = '~';

/** Whether an address names an agent rather than a persona. */
export function isAgentId(id: string): boolean {
  return id.includes(SEPARATOR);
}

/** `<roleId>~<name>`: unique per conversation, and labelable from the persona list alone. */
export function agentId(roleId: string, name: string): string {
  return `${roleId}${SEPARATOR}${name}`;
}

/** The name part of an agent id (the whole id when it is not one). */
export function agentName(id: string): string {
  const at = id.lastIndexOf(SEPARATOR);
  return at < 0 ? id : id.slice(at + 1);
}

/**
 * An agent name as a short slug: lowercase letters, digits and dashes, at most
 * 32 characters. Empty when nothing usable is left. The model picks the name,
 * so it never carries markup or line breaks into a preamble or an address.
 */
export function agentSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
}

/**
 * Whether a persona reaches one of the user's computers (a coding-agent,
 * computer or browser pin). Such a persona is started as an agent only where
 * the user put it in the conversation themselves (see bridgeSpawn): the pin
 * is the user's per-persona grant, and spawn_agent must not hand it to
 * whatever persona can start agents.
 */
export function isPinned(persona: Pick<Persona, 'harness' | 'computer' | 'browser'>): boolean {
  return !!(persona.harness || persona.computer || persona.browser);
}

/**
 * The allowlist an agent runs with: its role's, narrowed by its starter's.
 * Absent means "every server", so absent on one side is the other side.
 */
export function narrowMcpServers(role?: string[], starter?: string[]): string[] | undefined {
  if (!starter) return role ? [...role] : undefined;
  if (!role) return [...starter];
  return role.filter((name) => starter.includes(name));
}

/**
 * The persona row an agent's turns run with: its role's prompt, model, pins
 * and allowlist, under the agent's own id and name. Never keeps memory, never
 * opens to client chats, and starts agents of its own only one level down —
 * an agent started by an agent cannot (the depth limit every sub-agent system
 * has, for the same runaway reason). Blind agents run without recall (a
 * recall-off spawner only ever starts blind ones, see bridgeSpawn), and the
 * MCP allowlist is the one fixed at spawn.
 */
export function agentPersona(role: Persona, agent: MailAgent): Persona {
  const persona: Persona = { ...role, id: agent.id, name: agent.name, memory: false };
  delete persona.builtin;
  delete persona.clients;
  if (!role.canSpawn || isAgentId(agent.spawnedBy)) delete persona.canSpawn;
  if (agent.blind) persona.recall = false;
  if (agent.mcpServers) persona.mcpServers = [...agent.mcpServers];
  return persona;
}

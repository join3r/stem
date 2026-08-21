// Pure helpers for coding_agent turns: fold the acpx event stream into the
// little state the UI and the result text need, and render both. No I/O and no
// acpx import, so the same code serves the local host, the device host (whose
// events arrive over the wire), and unit tests.

/** The structural slice of acpx's AcpRuntimeEvent this module reads. */
export interface HarnessEvent {
  type: string;
  text?: string;
  stream?: string;
  tag?: string;
  toolCallId?: string;
  status?: string;
  title?: string;
  kind?: string;
  locations?: Array<{ path?: string }>;
  cost?: { amount?: number; currency?: string };
}

export interface HarnessTurnSummary {
  /** The agent's end-turn reply (output stream only, thoughts dropped). */
  text: string;
  toolCalls: number;
  /** Paths the agent's tool calls named, deduped in first-seen order. */
  files: string[];
  /** Cumulative session cost in USD, as of the latest usage update. */
  costUsd?: number;
  /** What the agent is doing right now, for the live row. */
  currentTool?: string;
}

/** Adapters send a generic placeholder title on late tool_call updates. */
const GENERIC_TITLES = new Set(['tool call', 'Terminal']);

export function newTurnSummary(): HarnessTurnSummary {
  return { text: '', toolCalls: 0, files: [] };
}

/** Fold one event into the summary (mutates and returns it). */
export function noteEvent(summary: HarnessTurnSummary, event: HarnessEvent): HarnessTurnSummary {
  if (event.type === 'text_delta') {
    if (event.stream !== 'thought' && typeof event.text === 'string') summary.text += event.text;
    return summary;
  }
  if (event.type === 'status') {
    if (event.tag === 'usage_update' && typeof event.cost?.amount === 'number') {
      summary.costUsd = event.cost.amount;
    }
    return summary;
  }
  if (event.type === 'tool_call') {
    if (event.tag === 'tool_call') summary.toolCalls += 1;
    for (const location of event.locations ?? []) {
      if (location?.path && !summary.files.includes(location.path)) summary.files.push(location.path);
    }
    const title = typeof event.title === 'string' ? event.title.trim() : '';
    if (title && !GENERIC_TITLES.has(title)) summary.currentTool = title;
    if (event.status === 'completed' || event.status === 'failed') summary.currentTool = undefined;
    return summary;
  }
  return summary;
}

/** "$0.42", with tenth-of-a-cent precision kept for sub-cent costs. */
export function formatCost(costUsd: number): string {
  return costUsd > 0 && costUsd < 0.01 ? `$${costUsd.toFixed(3)}` : `$${costUsd.toFixed(2)}`;
}

/**
 * The live activity row: "claude: editing src/foo.ts · 12 tool calls · $0.40".
 * Every part after the agent name is optional, so an early row degrades to
 * just "claude: working".
 */
export function activityDetail(agent: string, summary: HarnessTurnSummary): string {
  const parts: string[] = [];
  parts.push(summary.currentTool ? `${agent}: ${clipLine(summary.currentTool, 60)}` : `${agent}: working`);
  if (summary.toolCalls > 0) parts.push(`${summary.toolCalls} tool call${summary.toolCalls === 1 ? '' : 's'}`);
  if (typeof summary.costUsd === 'number') parts.push(formatCost(summary.costUsd));
  return parts.join(' · ');
}

function clipLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface HarnessResultInput {
  agent: string;
  summary: HarnessTurnSummary;
  status: 'ok' | 'failed' | 'cancelled';
  hostLabel: string;
  error?: string;
}

/**
 * The tool call's return text: the agent's reply first (it may be a question
 * the model must relay), then one bracketed bookkeeping line, then the
 * continuity note that tells the model how to keep the conversation going.
 */
export function formatRunResult(input: HarnessResultInput): string {
  const { agent, summary, status, hostLabel, error } = input;
  if (status === 'cancelled') {
    return `The ${agent} run was cancelled by the user. The session survives: calling coding_agent again with the same agent and cwd continues the same conversation.`;
  }
  if (status === 'failed') {
    return `The ${agent} run failed on ${hostLabel}: ${error || 'unknown error'}`;
  }
  const stats: string[] = [agent, `on ${hostLabel}`];
  if (summary.toolCalls > 0) stats.push(`${summary.toolCalls} tool call${summary.toolCalls === 1 ? '' : 's'}`);
  if (typeof summary.costUsd === 'number') stats.push(`session cost ${formatCost(summary.costUsd)}`);
  const files = summary.files.length ? `\nFiles touched: ${summary.files.join(', ')}` : '';
  const reply = summary.text.trim() || '(the agent ended its turn without a reply)';
  return (
    `${reply}\n\n[${stats.join(' · ')}]${files}\n` +
    'This session continues: call coding_agent again with the same agent and cwd to send a follow-up ' +
    '(answer its questions yourself when the conversation gives you the answer; otherwise relay them to the user).'
  );
}

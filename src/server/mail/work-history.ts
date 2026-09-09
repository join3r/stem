import type { MailWorkActivity, MailWorkRun } from '../../shared/types';
import { workDetail } from '../../shared/work-detail';

export interface HistoricalWorkRun extends MailWorkRun {
  request?: string;
  sourceRequest?: string;
  finalText?: string;
  notifications?: string[];
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : undefined;
const textContent = (content: unknown): string => typeof content === 'string' ? content :
  Array.isArray(content) ? content.map(record)
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block!.text as string).join('') : '';

function identity(content: unknown): string | undefined {
  const body = textContent(content)
    .replace(/^<!--stem:scheduled at="([^"]*)"-->[\s\S]*?<!--\/stem:scheduled-->\n+/, '')
    .replace(/^<!--stem:mail from=([^>]*)-->[\s\S]*?<!--\/stem:mail-->\n+/, '');
  return body.match(/^<!--stem:context-->\n<!--stem:turn id="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"-->/i)?.[1];
}

function sourceRequest(content: unknown): string | undefined {
  const preamble = textContent(content).match(/^<!--stem:mail from=[^>]*-->([\s\S]*?)<!--\/stem:mail-->/)?.[1];
  return preamble?.match(/For context, (?:the user mail|the request) this work answers — quoted automatically by Stem[^\n]*\n"""\n([\s\S]*?)\n"""\n(?:That mail also carried attachments|The mail body below is YOUR assignment)/)?.[1];
}

function timestamp(entry: RecordValue, message: RecordValue, fallback: number): number {
  for (const value of [entry.timestamp, message.timestamp]) {
    const at = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(at)) return at;
  }
  return fallback;
}

function calledTool(block: RecordValue): { name: string; args: unknown } {
  let name = typeof block.name === 'string' ? block.name : 'Tool';
  let args = block.arguments;
  for (let depth = 0; name === 'invoke_tool' && depth < 8; depth += 1) {
    const inner = record(args);
    if (!inner || typeof inner.tool !== 'string') break;
    name = inner.tool;
    args = inner.args;
  }
  return { name, args };
}

/** Recover only recorded, visible work from pi's append-only JSONL. There is no
 * reliable live status in a saved file: absent completion is an explicit gap,
 * never a fabricated success. The caller supplies persona ownership. */
export function parseWorkHistory(
  text: string,
  threadId: string,
  cleanUser: (content: unknown) => string = textContent
): HistoricalWorkRun[] {
  const runs: HistoricalWorkRun[] = [];
  let current: HistoricalWorkRun | undefined;
  let lastAt = 0;
  let lastAssistant: { text: string; progressId?: string; stop?: string; hasTools: boolean; at: number } | undefined;
  let corrupt = false;
  const finish = () => {
    if (!current) return;
    const unfinished = current.activities.filter((activity) => activity.kind === 'tool' && activity.status === 'running');
    if (current.status !== 'aborted' && !current.error) {
      if (lastAssistant?.stop === 'stop' && !lastAssistant.hasTools && !unfinished.length && !corrupt) {
        current.status = 'ok';
        current.endedAt = lastAssistant.at;
        if (lastAssistant.text.trim()) current.finalText = lastAssistant.text;
        const finalProgressId = lastAssistant.progressId;
        if (finalProgressId)
          current.activities = current.activities.filter((activity) => activity.id !== finalProgressId);
      } else {
        current.status = 'failed';
        current.error = corrupt
          ? 'Some saved records could not be read; this run’s complete history is unavailable.'
          : unfinished.length
            ? 'The saved history has no result for one or more tool calls; completion is unknown.'
            : 'The saved history has no confirmed completion for this run.';
      }
    }
    for (const activity of unfinished) {
      activity.status = 'error';
      activity.output = activity.output
        ? `${activity.output}\n[No completed tool result was recorded]`
        : '[No completed tool result was recorded]';
    }
    runs.push(current);
    current = undefined;
    lastAssistant = undefined;
    corrupt = false;
  };

  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let entry: RecordValue | undefined;
    try { entry = record(JSON.parse(line)); } catch { if (current) corrupt = true; continue; }
    if (entry?.type !== 'message') continue;
    const message = record(entry.message);
    if (!message) { if (current) corrupt = true; continue; }
    const at = timestamp(entry, message, lastAt);
    lastAt = at;
    if (message.role === 'user') {
      finish();
      const turnId = identity(message.content) ?? (typeof entry.id === 'string' ? entry.id : `${threadId}:line-${index}`);
      const source = sourceRequest(message.content);
      current = {
        id: turnId, turnId, threadId, personaId: '', startedAt: at,
        status: 'failed', activities: [], request: cleanUser(message.content),
        ...(source !== undefined ? { sourceRequest: source } : {})
      };
      continue;
    }
    if (!current) continue;
    if (message.role === 'toolResult') {
      const activity = current.activities.find((value) => value.kind === 'tool' && value.id === message.toolCallId);
      if (activity) {
        activity.endedAt = at;
        activity.status = message.isError === true ? 'error' : 'ok';
        activity.output = workDetail(textContent(message.content));
      } else {
        // Do not discard recoverable output merely because its call record was
        // lost. Its missing input is represented by an explicit placeholder.
        const id = typeof message.toolCallId === 'string' ? message.toolCallId : `result-${index}`;
        current.activities.push({
          id, kind: 'tool', label: typeof message.toolName === 'string' ? message.toolName : 'Tool result (call record unavailable)',
          at, endedAt: at, status: message.isError === true ? 'error' : 'ok',
          input: '[Tool call input was not recorded]', output: workDetail(textContent(message.content))
        });
      }
      continue;
    }
    if (message.role !== 'assistant') continue;
    // pi may retry a provider error within the same user turn. A subsequent
    // assistant record supersedes that terminal status, retaining its activity.
    delete current.error;
    delete current.endedAt;
    current.status = 'failed';
    const blocks = Array.isArray(message.content) ? message.content.map(record).filter((block): block is RecordValue => !!block) : [];
    const calls = blocks.filter((block) => block.type === 'toolCall');
    const body = textContent(message.content);
    const progressId = body.trim() ? `progress-${typeof entry.id === 'string' ? entry.id : index}` : undefined;
    if (progressId) current.activities.push({
      id: progressId, kind: 'progress', label: 'Progress update', at, endedAt: at,
      status: 'ok', output: workDetail(body)
    });
    for (const [callIndex, block] of calls.entries()) {
      const id = typeof block.id === 'string' ? block.id : `tool-${index}-${callIndex}`;
      if (current.activities.some((activity) => activity.kind === 'tool' && activity.id === id)) continue;
      const { name, args } = calledTool(block);
      const activity: MailWorkActivity = {
        id, kind: 'tool', label: name, at, status: 'running',
        ...(args !== undefined ? { input: workDetail(args) } : {})
      };
      current.activities.push(activity);
      const message = record(args)?.message;
      if (name === 'notify_user' && typeof message === 'string')
        current.notifications = [...(current.notifications ?? []), message];
    }
    const stop = typeof message.stopReason === 'string' ? message.stopReason : undefined;
    lastAssistant = { text: body, progressId, stop, hasTools: calls.length > 0, at };
    if (stop === 'error' || stop === 'aborted') {
      current.status = stop === 'aborted' ? 'aborted' : 'failed';
      current.endedAt = at;
      current.error = typeof message.errorMessage === 'string' && message.errorMessage.trim()
        ? workDetail(message.errorMessage) : stop === 'aborted' ? 'This run was stopped.' : 'This run failed.';
    }
  }
  finish();
  return runs;
}

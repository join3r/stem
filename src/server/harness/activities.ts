import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workDetail } from '../../shared/work-detail';
import { degrade } from '../degrade';
import { harnessRunsPath } from '../workspace/paths';
import type { HarnessEvent } from './format';
import { readHarnessRuns, type HarnessRunStatus } from './records';

export interface HarnessActivity {
  id: string;
  threadId: string;
  runId: string;
  agent: string;
  /** The outer coding_agent tool call; inner tools have their own stable id. */
  itemId?: string;
  kind: 'tool' | 'progress' | 'gap';
  title: string;
  startedAt: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  input?: string;
  output?: string;
  truncated?: boolean;
}

type Context = Pick<HarnessActivity, 'threadId' | 'runId' | 'agent' | 'itemId'>;
const MAX_DETAIL = 8_192;
const MAX_ROWS = 250;
const MAX_BYTES = 1_048_576;
const activitiesDir = (): string => `${harnessRunsPath()}.activities`;
const fileName = (runId: string): string => `${createHash('sha256').update(runId).digest('hex')}.json`;

/** Store displayable text only. Structured credentials and binary data never enter the log. */
function detail(value: unknown): { text: string; truncated: boolean } {
  const seen = new WeakSet<object>();
  const scrub = (v: unknown, depth: number): unknown => {
    if (depth > 8) return '[nested content omitted]';
    if (!v || typeof v !== 'object') return v;
    if (seen.has(v)) return '[circular content omitted]';
    seen.add(v);
    if (Array.isArray(v)) return [...v.slice(0, 100).map((child) => scrub(child, depth + 1)), ...(v.length > 100 ? ['[additional entries omitted]'] : [])];
    const entries = Object.entries(v);
    return Object.fromEntries([...entries.slice(0, 100).map(([key, child]) => [key,
      /^(data|blob)$/i.test(key) ? '[binary content omitted]' : scrub(child, depth + 1)
    ]), ...(entries.length > 100 ? [['omitted', '[additional fields omitted]']] : [])]);
  };
  const text = workDetail(scrub(value, 0), MAX_DETAIL);
  return { text, truncated: text.length > MAX_DETAIL || /\[.*(?:omitted|limit).*\]/.test(text) };
}

/** Exact run metadata is the authority for filtering; never infer linkage from timestamps. */
export async function readHarnessActivities(filter: { threadId?: string; runId?: string; itemId?: string } = {}): Promise<HarnessActivity[]> {
  const runs = (await readHarnessRuns()).filter((run) =>
    (!filter.threadId || run.threadId === filter.threadId) && (!filter.runId || run.runId === filter.runId) &&
    (!filter.itemId || run.itemId === filter.itemId));
  const groups = await Promise.all(runs.map(async (run): Promise<HarnessActivity[]> => {
    try {
      const parsed = JSON.parse(await readFile(join(activitiesDir(), fileName(run.runId)), 'utf8')) as { activities?: HarnessActivity[] };
      return Array.isArray(parsed.activities) ? parsed.activities.filter((row) => row.runId === run.runId && row.threadId === run.threadId) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') degrade('harness', 'could not read coding-agent activity', error);
      return [];
    }
  }));
  return groups.flat().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** Snapshot compaction coalesces streaming deltas. Each flush is atomic and precedes live delivery. */
export class HarnessActivityRecorder {
  private rows: HarnessActivity[] = [];
  private dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private chain = Promise.resolve();
  private progressId: string | undefined;
  private thoughtTools = new Set<string>();
  private dropped = false;

  constructor(private readonly context: Context, private readonly emit?: (row: HarnessActivity) => void) {}

  note(event: HarnessEvent): void {
    if (event.type === 'text_delta' && event.stream !== 'thought' && event.tag !== 'agent_thought_chunk' && event.text) {
      const id = event.messageId ? `${this.context.runId}:message:${event.messageId}` : (this.progressId ?? `${this.context.runId}:message:${randomUUID()}`);
      this.progressId = id;
      const row = this.get(id, 'progress', 'Progress');
      const content = detail((row.output ?? '') + event.text);
      row.output = content.text;
      row.truncated ||= content.truncated;
      this.changed(row);
    } else if (event.type === 'tool_call') {
      if (event.kind === 'think') {
        if (event.toolCallId) this.thoughtTools.add(event.toolCallId);
        return;
      }
      if (event.toolCallId && this.thoughtTools.has(event.toolCallId)) return;
      // A new tool separates adjacent assistant messages without inventing message boundaries.
      if (this.progressId) {
        const previous = this.rows.find((row) => row.id === this.progressId);
        if (previous) { previous.status = 'completed'; this.changed(previous); }
      }
      this.progressId = undefined;
      const id = `${this.context.runId}:tool:${event.toolCallId ?? randomUUID()}`;
      const row = this.get(id, 'tool', event.title || event.kind || 'Tool action');
      if (event.title && !['tool call', 'Terminal'].includes(event.title)) row.title = detail(event.title).text;
      if (event.rawInput !== undefined) {
        const input = detail(event.rawInput); row.input = input.text; row.truncated ||= input.truncated;
      }
      const output = event.rawOutput !== undefined && event.content !== undefined
        ? { result: event.rawOutput, content: event.content }
        : event.rawOutput ?? event.content;
      if (output !== undefined) {
        const formatted = detail(output); row.output = formatted.text; row.truncated ||= formatted.truncated;
      }
      if (event.status === 'completed' || event.status === 'failed') row.status = event.status;
      this.changed(row);
    }
  }

  private get(id: string, kind: HarnessActivity['kind'], title: string): HarnessActivity {
    const existing = this.rows.find((row) => row.id === id);
    if (existing) return existing;
    const at = new Date().toISOString();
    const row: HarnessActivity = { ...this.context, id, kind, title: detail(title).text, startedAt: at, updatedAt: at, status: 'running' };
    this.rows.push(row);
    return row;
  }

  private changed(row: HarnessActivity): void {
    row.updatedAt = new Date().toISOString();
    this.dirty.add(row.id);
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 250);
      this.timer.unref?.();
    }
  }

  async finish(status: HarnessRunStatus, error?: string): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const row of this.rows) if (row.status === 'running') {
      // An unfinished tool is not evidence of success just because the agent ended its turn.
      row.status = row.kind === 'tool' && status === 'ok' ? 'cancelled' : status === 'ok' ? 'completed' : status === 'running' ? 'failed' : status;
      if (row.kind === 'tool' && status === 'ok') row.output = detail(`${row.output ?? ''}\n[No terminal tool result was recorded before the agent ended its turn.]`).text;
      row.updatedAt = new Date().toISOString();
      this.dirty.add(row.id);
    }
    if (error) {
      const row = this.get(`${this.context.runId}:outcome`, 'progress', status === 'cancelled' ? 'Run stopped' : 'Run failed');
      row.status = status === 'cancelled' ? 'cancelled' : 'failed';
      const output = detail(error); row.output = output.text; row.truncated = output.truncated; this.dirty.add(row.id);
    }
    await this.flush();
  }

  flush(): Promise<void> {
    if (!this.dirty.size) return this.chain;
    while (this.rows.length > MAX_ROWS || Buffer.byteLength(JSON.stringify(this.rows)) > MAX_BYTES) {
      const removed = this.rows.shift();
      if (removed) this.dirty.delete(removed.id);
      this.dropped = true;
    }
    const rows = this.rows.map((row) => ({ ...row }));
    if (this.dropped) rows.unshift({ ...this.context, id: `${this.context.runId}:gap`, kind: 'gap', title: 'Earlier activity omitted because the retained history limit was reached',
      status: 'completed', startedAt: rows[0]?.startedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), truncated: true });
    const dirty = new Set(this.dirty);
    this.dirty.clear();
    this.chain = this.chain.then(async () => {
      const dir = activitiesDir();
      await mkdir(dir, { recursive: true });
      const path = join(dir, fileName(this.context.runId));
      const tmp = `${path}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, activities: rows }), 'utf8');
      await rename(tmp, path);
      for (const row of rows) if (dirty.has(row.id) || row.kind === 'gap') this.emit?.(row);
    }).catch((error: unknown) => { degrade('harness', 'could not persist coding-agent activity', error); });
    return this.chain;
  }
}

/** Share the 500-run log's retention bound; only our hashed snapshot files are removed. */
export async function pruneHarnessActivities(): Promise<void> {
  try {
    const retained = new Set((await readHarnessRuns()).map((run) => fileName(run.runId)));
    const dir = activitiesDir();
    for (const file of await readdir(dir)) {
      if (/^[a-f0-9]{64}\.json$/.test(file) && !retained.has(file)) await rm(join(dir, file), { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') degrade('harness', 'could not prune coding-agent activity', error);
  }
}

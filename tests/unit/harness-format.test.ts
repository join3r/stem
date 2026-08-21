// The pure formatting layer for coding_agent turns: folding acpx-shaped
// events into a turn summary, the live activity row, and the result text the
// model gets back. Event shapes mirror what the acpx spike captured from real
// claude-agent-acp turns (initial tool_call tagged `tool_call`, updates tagged
// `tool_call_update`, cumulative cost on `usage_update` status events).
import { describe, expect, it } from 'vitest';
import {
  activityDetail,
  formatCost,
  formatRunResult,
  newTurnSummary,
  noteEvent,
  type HarnessEvent
} from '../../src/server/harness/format';

function summarize(events: HarnessEvent[]) {
  const summary = newTurnSummary();
  for (const event of events) noteEvent(summary, event);
  return summary;
}

describe('turn summary', () => {
  it('collects reply text from the output stream and drops thoughts', () => {
    const summary = summarize([
      { type: 'text_delta', text: 'let me think', stream: 'thought' },
      { type: 'text_delta', text: 'Done. ' },
      { type: 'text_delta', text: 'The flag is added.', stream: 'output' }
    ]);
    expect(summary.text).toBe('Done. The flag is added.');
  });

  it('counts initial tool calls, not their updates', () => {
    const summary = summarize([
      { type: 'tool_call', tag: 'tool_call', toolCallId: 't1', status: 'pending', title: 'Terminal' },
      { type: 'tool_call', tag: 'tool_call_update', toolCallId: 't1', title: 'npm test' },
      { type: 'tool_call', tag: 'tool_call_update', toolCallId: 't1', status: 'completed', title: 'tool call' },
      { type: 'tool_call', tag: 'tool_call', toolCallId: 't2', status: 'pending', title: 'Edit file' }
    ]);
    expect(summary.toolCalls).toBe(2);
  });

  it('tracks touched files deduped, the latest cost, and the current tool', () => {
    const summary = summarize([
      { type: 'tool_call', tag: 'tool_call', toolCallId: 't1', locations: [{ path: 'src/foo.ts' }] },
      { type: 'tool_call', tag: 'tool_call_update', toolCallId: 't1', title: 'Editing src/foo.ts', locations: [{ path: 'src/foo.ts' }] },
      { type: 'status', tag: 'usage_update', text: 'usage', cost: { amount: 0.1, currency: 'USD' } },
      { type: 'tool_call', tag: 'tool_call', toolCallId: 't2', locations: [{ path: 'src/bar.ts' }] },
      { type: 'status', tag: 'usage_update', text: 'usage', cost: { amount: 0.4, currency: 'USD' } }
    ]);
    expect(summary.files).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(summary.costUsd).toBe(0.4);
    expect(summary.currentTool).toBe('Editing src/foo.ts');
  });

  it('clears the current tool once the call settles, so the row falls back to "working"', () => {
    const summary = summarize([
      { type: 'tool_call', tag: 'tool_call', toolCallId: 't1', title: 'npm test' },
      { type: 'tool_call', tag: 'tool_call_update', toolCallId: 't1', status: 'completed', title: 'tool call' }
    ]);
    expect(summary.currentTool).toBeUndefined();
    expect(activityDetail('claude', summary)).toBe('claude: working · 1 tool call');
  });
});

describe('activity row', () => {
  it('renders the full row with tool, count, and cost', () => {
    const summary = summarize([
      { type: 'tool_call', tag: 'tool_call', toolCallId: 't1', title: 'Editing src/foo.ts' },
      { type: 'status', tag: 'usage_update', text: 'usage', cost: { amount: 0.4 } }
    ]);
    expect(activityDetail('claude', summary)).toBe('claude: Editing src/foo.ts · 1 tool call · $0.40');
  });

  it('degrades to "working" before anything happened', () => {
    expect(activityDetail('opencode', newTurnSummary())).toBe('opencode: working');
  });
});

describe('cost formatting', () => {
  it('keeps sub-cent costs visible instead of rounding them to zero', () => {
    expect(formatCost(0.004)).toBe('$0.004');
    expect(formatCost(0.42)).toBe('$0.42');
    expect(formatCost(0)).toBe('$0.00');
  });
});

describe('result text', () => {
  it('leads with the reply, then bookkeeping, files, and the continuity note', () => {
    const summary = summarize([
      { type: 'text_delta', text: 'Added the --version flag. Should I also update the README?' },
      { type: 'tool_call', tag: 'tool_call', toolCallId: 't1', locations: [{ path: 'src/cli.ts' }] },
      { type: 'status', tag: 'usage_update', text: 'usage', cost: { amount: 0.25 } }
    ]);
    const text = formatRunResult({ agent: 'claude', summary, status: 'ok', hostLabel: 'this server' });
    expect(text.startsWith('Added the --version flag.')).toBe(true);
    expect(text).toContain('[claude · on this server · 1 tool call · session cost $0.25]');
    expect(text).toContain('Files touched: src/cli.ts');
    expect(text).toContain('call coding_agent again with the same agent and cwd');
  });

  it('says so when the agent ended its turn silently', () => {
    const text = formatRunResult({ agent: 'claude', summary: newTurnSummary(), status: 'ok', hostLabel: 'this server' });
    expect(text).toContain('(the agent ended its turn without a reply)');
  });

  it('a cancelled run names the user and keeps the continuity promise', () => {
    const text = formatRunResult({ agent: 'claude', summary: newTurnSummary(), status: 'cancelled', hostLabel: 'this server' });
    expect(text).toContain('cancelled by the user');
    expect(text).toContain('continues the same conversation');
  });

  it('a failed run names the host and the error', () => {
    const text = formatRunResult({
      agent: 'opencode',
      summary: newTurnSummary(),
      status: 'failed',
      hostLabel: "Vlado's MacBook",
      error: 'the client went silent'
    });
    expect(text).toBe("The opencode run failed on Vlado's MacBook: the client went silent");
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ExecApprovalRequest, HarnessApprovalRequest } from '../../src/shared/types';
import {
  ApprovalCard,
  ApprovalNotice,
  harnessAlwaysAllowScope,
  harnessOptionLabel,
  orderedHarnessOptions
} from '../../src/renderer/manage/ApprovalCard';
import { approvalsElsewhere, approvalsForThread, type PendingApproval } from '../../src/renderer/manage/approvalQueue';

const exec = (id: string, threadId: string): PendingApproval => ({
  kind: 'exec',
  request: {
    id,
    threadId,
    command: `echo ${id}`,
    cwd: '/work',
    prefixes: ['echo'],
    judgeVerdict: null
  } as ExecApprovalRequest
});

const harness = (id: string, threadId: string): PendingApproval => ({
  kind: 'harness',
  request: {
    id,
    threadId,
    agent: 'claude',
    hostLabel: 'join3r-macbook',
    title: 'Read /Users/me/proj/src/utils/media.py (4122 – 4144)',
    options: [
      { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
      { optionId: 'always', kind: 'allow_always', name: 'Always Allow Read(//Users/me/proj/src/utils/**)' },
      { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
    ]
  } as HarnessApprovalRequest
});

describe('the permission cards belong to the chat that asked', () => {
  const all = [exec('e1', 'A'), harness('h1', 'B'), exec('e2', 'A'), harness('h2', 'A')];

  it('a chat sees its own asks, oldest first, whichever service raised them', () => {
    expect(approvalsForThread(all, 'A').map((a) => a.request.id)).toEqual(['e1', 'e2', 'h2']);
    expect(approvalsForThread(all, 'B').map((a) => a.request.id)).toEqual(['h1']);
    // A fresh draft has no thread yet, so nothing can be its own.
    expect(approvalsForThread(all, null)).toEqual([]);
  });

  it('every other ask is "elsewhere" — including all of them from a draft', () => {
    expect(approvalsElsewhere(all, 'A').map((a) => a.request.id)).toEqual(['h1']);
    expect(approvalsElsewhere(all, null)).toHaveLength(4);
  });

  it('the inline card is a region above the composer, not a dialog', () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalCard, { approval: harness('h1', 'B'), variant: 'inline', queued: 2 })
    );
    expect(html).toContain('class="chat-approval"');
    expect(html).not.toContain('mcp-approval-backdrop');
    expect(html).toContain('The claude agent asks for permission');
    expect(html).toContain('2 more asks');
  });

  it('the modal variant keeps the dialog markup Quick Chat relies on', () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalCard, { approval: exec('e1', 'A'), variant: 'modal' })
    );
    expect(html).toContain('mcp-approval-backdrop');
    expect(html).toContain('Run this command?');
    expect(html).toContain('Allow once');
  });

  it('the notice names the chat and offers to open it, or a dialog when it cannot', () => {
    const named = renderToStaticMarkup(
      createElement(ApprovalNotice, {
        approvals: [harness('h1', 'B'), exec('e1', 'A')],
        titleFor: (id) => (id === 'B' ? 'DaVinci Resolve MCP' : null),
        onOpen: () => {}
      })
    );
    expect(named).toContain('The claude agent in “DaVinci Resolve MCP” asks for permission');
    expect(named).toContain('1 more ask waits');
    expect(named).toContain('Open chat');

    const unnamed = renderToStaticMarkup(
      createElement(ApprovalNotice, { approvals: [exec('e1', 'M')], titleFor: () => null, onOpen: () => {} })
    );
    expect(unnamed).toContain('in another conversation');
    expect(unnamed).toContain('Review');
    expect(unnamed).not.toContain('Open chat');
  });
});

describe('a coding agent’s option names', () => {
  const req = harness('h1', 'B').request as HarnessApprovalRequest;

  it('become short decisions on the buttons, reject first and allow last', () => {
    expect(orderedHarnessOptions(req).map(harnessOptionLabel)).toEqual(['Reject', 'Always allow', 'Allow']);
  });

  it('keep the rule "Always allow" would teach as a line beside the buttons', () => {
    const always = req.options.find((o) => o.kind === 'allow_always')!;
    expect(harnessAlwaysAllowScope(always)).toBe('Read(//Users/me/proj/src/utils/**)');
    expect(harnessAlwaysAllowScope({ optionId: 'x', kind: 'allow_always', name: 'Always allow' })).toBeNull();
    expect(harnessAlwaysAllowScope({ optionId: 'x', kind: 'allow_once', name: 'Allow Read(foo)' })).toBeNull();
    const html = renderToStaticMarkup(
      createElement(ApprovalCard, { approval: { kind: 'harness', request: req }, variant: 'inline' })
    );
    expect(html).toContain('Read(//Users/me/proj/src/utils/**)</code>');
    expect(html).not.toContain('>Always Allow Read(');
  });

  it('fall back to the harness’s own name for a kind we do not know', () => {
    expect(harnessOptionLabel({ optionId: 'o1', kind: 'ponder', name: 'Think about it' })).toBe('Think about it');
    expect(harnessOptionLabel({ optionId: 'o1' })).toBe('o1');
  });
});

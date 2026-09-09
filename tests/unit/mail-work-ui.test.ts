import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MailWork } from '../../src/renderer/mail/MailWork';
import type { MailWorkGroup } from '../../src/shared/types';

describe('Mail work evidence', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e99])('shows missing or invalid timestamp %s without an invented date or duration', (at) => {
    const group: MailWorkGroup = {
      id: 'old', conversationId: 'mail', historical: true,
      runs: [{ id: 'old-run', personaId: 'normal', startedAt: at, endedAt: 1_788_739_200_000, status: 'ok', activities: [
        { id: 'old-tool', kind: 'tool', label: 'Recovered tool', at, endedAt: 1_788_739_200_000, status: 'ok' }
      ] }]
    };
    const html = renderToStaticMarkup(createElement(MailWork, { group, personas: [] }));
    expect(html.match(/Time unavailable/g)).toHaveLength(2);
    expect(html.match(/Duration unavailable/g)).toHaveLength(2);
    expect(html).not.toContain('1970');
    expect(html).not.toContain('datetime=');
  });

  it('retains delegated partial work and its recorded details after a failure', () => {
    const group: MailWorkGroup = {
      id: 'work', conversationId: 'mail', sourceItemId: 'request', runs: [
        { id: 'lead', personaId: 'normal', startedAt: 1_000, endedAt: 3_000, status: 'ok', activities: [] },
        { id: 'delegate', personaId: 'coder', startedAt: 2_000, endedAt: 62_000, status: 'failed', error: 'Upload disconnected', activities: [
          { id: 'build', kind: 'tool', label: 'Build app', at: 2_000, endedAt: 42_000, status: 'ok', input: 'xcodebuild archive', output: 'Archive saved: /tmp/Stem.xcarchive' },
          { id: 'upload', kind: 'tool', label: 'Upload archive', at: 42_000, endedAt: 62_000, status: 'error', output: 'Connection closed' }
        ] }
      ]
    };
    const html = renderToStaticMarkup(createElement(MailWork, { group, personas: [] }));
    expect(html).toContain('normal');
    expect(html).toContain('coder');
    expect(html).toContain('Upload disconnected');
    expect(html).toContain('Archive saved: /tmp/Stem.xcarchive');
    expect(html).toContain('xcodebuild archive');
    expect(html).toContain('Connection closed');
    expect(html).toContain('1m 0s');
    expect(html).toContain('<details>');
  });

  it('marks incomplete recovered work and displays tool output as inert text', () => {
    const group: MailWorkGroup = {
      id: 'old', conversationId: 'mail', historical: true,
      gaps: ['Tool inputs were not saved.'],
      runs: [{ id: 'old-run', personaId: 'normal', startedAt: 1_000, endedAt: 2_000, status: 'aborted', activities: [
        { id: 'partial', kind: 'progress', label: 'Partial progress', at: 1_500, status: 'ok', output: '<script>steal()</script>' }
      ] }]
    };
    const html = renderToStaticMarkup(createElement(MailWork, { group, personas: [], unlinked: true }));
    expect(html).toContain('Recovered history');
    expect(html).toContain('Tool inputs were not saved.');
    expect(html).toContain('could not be linked reliably');
    expect(html).toContain('Stopped');
    expect(html).toContain('&lt;script&gt;steal()&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
});

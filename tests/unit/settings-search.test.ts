import { describe, expect, it } from 'vitest';
import { matchEntries, snippet, type SettingsEntry } from '../../src/renderer/manage/tabs/settings/searchIndex';

const entry = (over: Partial<SettingsEntry>): SettingsEntry => ({
  key: over.label ?? 'x',
  sub: 'app',
  group: '',
  chain: [],
  label: '',
  hint: '',
  info: '',
  parents: [],
  ...over
});

const subLabel = (s: SettingsEntry['sub']) => ({ app: 'App', features: 'Features', server: 'Server', models: 'Models' })[s];

describe('settings search match', () => {
  const entries = [
    entry({ label: 'Persona exchange limit', sub: 'features', group: 'Mail', info: 'Each mail you send resets this budget' }),
    entry({ label: 'Mail', sub: 'features' }),
    entry({ label: 'Light or dark', group: 'Appearance', hint: '' }),
    entry({ label: 'Theme', group: 'Appearance', hint: 'Colours and fonts' })
  ];

  it('puts label matches first, then place and hint, then the ⓘ text', () => {
    const hits = matchEntries(entries, 'mail', subLabel);
    expect(hits.map((h) => [h.entry.label, h.tier])).toEqual([
      ['Mail', 0],
      ['Persona exchange limit', 1]
    ]);
    expect(matchEntries(entries, 'budget', subLabel).map((h) => [h.entry.label, h.tier])).toEqual([
      ['Persona exchange limit', 2]
    ]);
  });

  it('needs every word, in any field and any order', () => {
    expect(matchEntries(entries, 'appearance dark', subLabel).map((h) => h.entry.label)).toEqual(['Light or dark']);
    expect(matchEntries(entries, 'FONTS', subLabel).map((h) => h.entry.label)).toEqual(['Theme']);
    expect(matchEntries(entries, 'dark fonts', subLabel)).toEqual([]);
    expect(matchEntries(entries, '   ', subLabel)).toEqual([]);
  });

  it('matches the sub-tab name', () => {
    expect(matchEntries(entries, 'features exchange', subLabel).map((h) => h.entry.label)).toEqual([
      'Persona exchange limit'
    ]);
  });
});

describe('settings search snippet', () => {
  it('keeps short text whole and cuts long text around the first term', () => {
    expect(snippet('short text', ['text'])).toBe('short text');
    const long = `${'a '.repeat(80)}needle ${'b '.repeat(80)}`.trim();
    const s = snippet(long, ['needle'], 40);
    expect(s).toContain('needle');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
  });
});

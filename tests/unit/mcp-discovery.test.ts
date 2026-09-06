import { describe, expect, it } from 'vitest';
import { compactCatalogText, searchMcpTools, summarizeToolCapabilities } from '../../src/server/pi/mcp-discovery.mjs';
import { renderDeviceCatalogBlock } from '../../src/server/mcp-device/catalog';

const definition = (name: string, description: string) => ({ name, description, inputSchema: { type: 'object', properties: {} } });
const clients = new Map([
  ['grafana', { tools: [definition('query_loki_logs', 'Query logs for errors'), definition('list_dashboards', 'List dashboards')] }],
  ['homeassistant', { tools: [definition('turn_off_light', 'Turn off a light'), definition('turn_on_light', 'Turn on a light')] }],
  ['fastmail', { tools: [definition('search_email', 'Search your mailbox'), definition('calendar_events', 'Read calendar events')] }]
]);

describe('local tool discovery', () => {
  it.each([
    ['query grafana error logs', 'grafana', 'query_loki_logs'],
    ['najdi chyby v logoch', 'grafana', 'query_loki_logs'],
    ['zhasni svetlo', 'homeassistant', 'turn_off_light'],
    ['zapni svetla', 'homeassistant', 'turn_on_light'],
    ['vyhladaj email', 'fastmail', 'search_email'],
    ['udalosti kalendar', 'fastmail', 'calendar_events']
  ])('finds %s without exposing other tools', (query, server, tool) => {
    const result = searchMcpTools(clients, { query, limit: 1 });
    expect(result.matches.map(m => [m.server, m.tool.name])).toEqual([[server, tool]]);
  });

  it('can browse beyond the search shortlist without losing any tool', () => {
    const first = searchMcpTools(clients, { server: 'homeassistant', limit: 1 });
    expect(first.total).toBe(2);
    expect(first.nextOffset).toBe(1);
    const second = searchMcpTools(clients, { server: 'homeassistant', limit: 1, offset: first.nextOffset! });
    expect(second.nextOffset).toBeNull();
    expect(first.matches[0].tool.name).not.toBe(second.matches[0].tool.name);
    expect(searchMcpTools(clients, { query: 'unrelatednonsense' }).matches).toEqual([]);
  });

  it('matches a distinctive schema field and prefers an exact tool name', () => {
    const tools = [definition('query', 'Search'), {
      name: 'lookup', description: 'Look up a record', inputSchema: { properties: { incidentReference: { type: 'string' } } }
    }];
    const index = new Map([['service', { tools }]]);
    expect(searchMcpTools(index, { query: 'incident reference' }).matches[0].tool.name).toBe('lookup');
    expect(searchMcpTools(index, { query: 'query' }).matches[0].tool.name).toBe('query');
  });

  it.each([50, 250, 1000])('keeps %i tools searchable while the initial integration summary stays bounded', count => {
    const tools = Array.from({ length: count }, (_, i) => definition(`query_metric_${i}`, `Query metric number ${i}. ${'Detail '.repeat(25)}`));
    const text = summarizeToolCapabilities(tools);
    expect(text.length).toBeLessThan(270);
    expect(text).not.toContain('Detail');
    expect(summarizeToolCapabilities([...tools].reverse())).toBe(text);
    const index = new Map([['monitor', { tools }]]);
    expect(searchMcpTools(index, { query: `query_metric_${count - 1}` }).matches[0].tool.name).toBe(`query_metric_${count - 1}`);
    expect(searchMcpTools(index, { server: 'monitor', limit: 10000 }).matches.length).toBe(5);
  });

  it('compacts legacy catalogue files and keeps new summaries stable', () => {
    const old = '### grafana (2 tools)\n  - query_logs: Very long details — (query, start?, end?)\n  - list_dashboards: List dashboards — ()';
    const next = compactCatalogText(old);
    expect(next).toContain('### grafana (2 tools)');
    expect(next).toContain('logs');
    expect(next).not.toContain('Very long details');
    expect(next).not.toContain('start?');
    expect(compactCatalogText(next)).toBe(next);
  });

  it('keeps offline capabilities discoverable without all their tool entries', () => {
    const tools = Array.from({ length: 200 }, (_, i) => ({ name: `query_dashboard_${i}`, description: 'x'.repeat(120), signature: '(a, b, c)' }));
    const block = renderDeviceCatalogBlock({ version: 1, devices: { mac: {
      deviceId: 'mac', announcedAt: '', servers: [{ name: 'monitor', status: 'ready', tools }]
    } } }, { label: () => 'Mac', include: () => true, isAvailable: () => false });
    expect(block.text).toContain('NOT connected');
    expect(block.text).toContain('dashboard');
    expect(block.text.length).toBeLessThan(400);
    expect(block.text).not.toContain('(a, b, c)');
  });
});

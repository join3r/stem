import { describe, expect, it } from 'vitest';
import { parseMcpPaste } from '../../src/renderer/manage/mcpPaste';

describe('parseMcpPaste', () => {
  it('reads a Claude Desktop mcpServers block with env', () => {
    const r = parseMcpPaste(`{
      "mcpServers": {
        "grafana": { "command": "npx", "args": ["-y", "@grafana/mcp-grafana"], "env": { "GRAFANA_URL": "http://g", "PORT": 3000 } }
      }
    }`);
    expect(r).toEqual({
      ok: true,
      servers: [
        {
          name: 'grafana',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@grafana/mcp-grafana'],
          url: '',
          env: { GRAFANA_URL: 'http://g', PORT: '3000' },
          headers: {}
        }
      ]
    });
  });

  it('reads VS Code servers with a URL and headers, and several entries', () => {
    const r = parseMcpPaste(`{ "servers": {
      "linear": { "type": "http", "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer x" } },
      "fs": { "command": "uvx", "args": ["mcp-fs"] },
      "notes": "not a server"
    } }`);
    expect(r.ok && r.servers.map((s) => [s.name, s.transport, s.url || s.command])).toEqual([
      ['linear', 'http', 'https://mcp.linear.app/mcp'],
      ['fs', 'stdio', 'uvx']
    ]);
    expect(r.ok && r.servers[0].headers).toEqual({ Authorization: 'Bearer x' });
  });

  it('accepts an entry without its outer braces, a trailing comma, and serverUrl', () => {
    const r = parseMcpPaste(`"fastmail": { "serverUrl": "https://api.fastmail.com/mcp", },`);
    expect(r.ok && r.servers[0]).toMatchObject({ name: 'fastmail', transport: 'http', url: 'https://api.fastmail.com/mcp' });
  });

  it('reads a lone unnamed entry', () => {
    const r = parseMcpPaste(`{ "command": "npx", "args": ["@playwright/mcp@latest"] }`);
    expect(r.ok && r.servers[0]).toMatchObject({ name: '', command: 'npx', args: ['@playwright/mcp@latest'] });
  });

  it('says what is wrong instead of guessing', () => {
    expect(parseMcpPaste('')).toMatchObject({ ok: false });
    expect(parseMcpPaste('npx -y something')).toMatchObject({ ok: false, error: expect.stringContaining('not JSON') });
    expect(parseMcpPaste('{ "mcpServers": { "x": { "type": "stdio" } } }')).toMatchObject({ ok: false, error: expect.stringContaining('No server entry') });
  });
});

// ---- Paste JSON: an MCP server entry from a README into the editor ----
//
// Nearly every MCP server's README ships the entry its users paste into Claude
// Desktop, Cursor or VS Code. Those differ only in the wrapper — `mcpServers`
// (Claude, Cursor), `servers` (VS Code), a bare `{ name: {...} }`, or a single
// unnamed entry — and in what the URL field is called. This reads all of them
// into the editor's shape; nothing is saved until the person presses Save.

export interface PastedServer {
  /** '' when the paste was a lone entry with no name around it. */
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  env: Record<string, string>;
  headers: Record<string, string>;
}

export type PasteResult = { ok: true; servers: PastedServer[] } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An entry looks like a server when it says how to reach one. */
function isEntry(v: unknown): v is Record<string, unknown> {
  return isObject(v) && (typeof v.command === 'string' || typeof v.url === 'string' || typeof v.serverUrl === 'string' || typeof v.httpUrl === 'string');
}

function stringMap(v: unknown): Record<string, string> {
  if (!isObject(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') out[k] = String(val);
  }
  return out;
}

function toServer(name: string, e: Record<string, unknown>): PastedServer {
  const url = [e.url, e.serverUrl, e.httpUrl].find((u): u is string => typeof u === 'string') ?? '';
  return {
    name,
    transport: url ? 'http' : 'stdio',
    command: typeof e.command === 'string' ? e.command : '',
    args: Array.isArray(e.args) ? e.args.filter((a) => typeof a === 'string' || typeof a === 'number').map(String) : [],
    url,
    env: stringMap(e.env),
    headers: stringMap(e.headers)
  };
}

/**
 * Parse a pasted snippet. READMEs often show the entry without its outer
 * braces (`"fastmail": { … }`), and JSON with a trailing comma, so both are
 * tried before giving up.
 */
export function parseMcpPaste(text: string): PasteResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'Paste a server entry first.' };
  const attempts = [trimmed, `{${trimmed}}`].map((t) => t.replace(/,\s*([}\]])/g, '$1').replace(/,\s*$/, ''));
  let data: unknown;
  for (const attempt of attempts) {
    try {
      data = JSON.parse(attempt);
      break;
    } catch {
      // try the next shape
    }
  }
  if (data === undefined) return { ok: false, error: 'That is not JSON Stem can read. Copy the whole block, braces included.' };
  if (isEntry(data)) return { ok: true, servers: [toServer('', data)] };
  if (!isObject(data)) return { ok: false, error: 'Expected an object with a server entry in it.' };
  const wrapper = isObject(data.mcpServers) ? data.mcpServers : isObject(data.servers) ? data.servers : data;
  const servers = Object.entries(wrapper)
    .filter(([, v]) => isEntry(v))
    .map(([name, v]) => toServer(name, v as Record<string, unknown>));
  if (servers.length === 0) return { ok: false, error: 'No server entry found: each needs a "command" or a "url".' };
  return { ok: true, servers };
}

// Shared by the bundled server and the standalone pi extension. No runtime or
// provider dependencies: discovery uses the catalogue already held by Stem.
const STOP = new Set('a an the to of for in on and or with from by as is are tool tools get set list create update delete remove add read write all id ids data'.split(' '));
const ALIASES = [
  ['email', 'mail', 'emails', 'posta', 'spravy'],
  ['light', 'lights', 'svetlo', 'svetla', 'osvetlenie'],
  ['off', 'zhasni', 'vypni', 'vypnut'], ['on', 'zapni', 'zapnut'],
  ['search', 'find', 'lookup', 'najdi', 'vyhladaj', 'hladat'],
  ['log', 'logs', 'logy', 'zaznamy'], ['error', 'errors', 'chyba', 'chyby'],
  ['alert', 'alerts', 'upozornenia'], ['dashboard', 'dashboards'],
  ['message', 'messages', 'sprava', 'spravy'], ['calendar', 'kalendar'],
  ['event', 'events', 'udalost', 'udalosti'], ['metric', 'metrics', 'metriky']
];

function words(value) {
  return String(value ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').normalize('NFD')
    .replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Bounded, deterministic capability hints, not one line per tool. */
export function summarizeToolCapabilities(tools) {
  const counts = new Map();
  for (const tool of tools) {
    for (const word of new Set(words(tool.name).filter(w => w.length > 2 && !STOP.has(w)))) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const hints = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12).map(([w]) => w).join(', ');
  return hints ? `Capabilities (hints): ${hints.slice(0, 180)}. Search to discover all tools.` : 'Search to discover available tools.';
}

/** Also compact an older bridge's file while its process is being replaced. */
export function compactCatalogText(text) {
  return String(text ?? '').split(/(?=^### )/m).filter(s => s.trim()).map(section => {
    const lines = section.trim().split('\n');
    const tools = lines.slice(1).filter(l => /^\s*- /.test(l))
      .map(l => ({ name: l.trim().slice(2).split(':')[0] }));
    return tools.length ? `${lines[0]}\n${summarizeToolCapabilities(tools)}` : section.trim();
  }).join('\n\n');
}

/** Rank without a model call. Empty query + server is paginated browsing. */
export function searchMcpTools(clients, { query = '', server, limit = 3, offset = 0 } = {}) {
  const requestedServer = typeof server === 'string' ? server.trim() : '';
  const q = String(query).trim().slice(0, 400);
  const terms = [...new Set(words(q).filter(w => w.length > 1 && !STOP.has(w)))];
  const groups = terms.map(t => new Set([t, ...(ALIASES.find(g => g.some(a => a === t || (a.length >= 3 && t.startsWith(a)))) ?? [])]));
  const ranked = [];
  for (const [name, entry] of clients) {
    if (requestedServer && name !== requestedServer) continue;
    for (const tool of entry.tools) {
      const nameWords = words(tool.name), serverWords = words(name);
      const detailWords = words(`${tool.description ?? ''} ${tool.signature ?? ''} ${JSON.stringify(tool.inputSchema ?? {})}`);
      const matches = (haystack, group) => haystack.some(w => [...group].some(t => w === t || (t.length >= 4 && w.startsWith(t))));
      let covered = 0, score = 0;
      for (const group of groups) {
        const n = matches(nameWords, group), d = matches(detailWords, group), s = matches(serverWords, group);
        if (n || d || s) covered++;
        score += n ? 8 : d ? 2 : s ? 1 : 0;
      }
      if (q && tool.name.toLowerCase() === q.toLowerCase()) score += 1000;
      if (q && !score) continue;
      ranked.push({ server: name, tool, entry, score: score + covered * covered * 3 });
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.server.localeCompare(b.server) || a.tool.name.localeCompare(b.tool.name));
  const take = Number.isFinite(limit) ? Math.max(1, Math.min(5, Math.floor(limit))) : 3;
  const skip = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  return { matches: ranked.slice(skip, skip + take), total: ranked.length, nextOffset: skip + take < ranked.length ? skip + take : null };
}

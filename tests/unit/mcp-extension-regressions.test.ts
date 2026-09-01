import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import stemMcpBridge, {
  bridgeOAuthTokenForServer,
  capToolContent,
  findProtectedPath,
  isInside,
  makeFsRootsGate,
  makeProtectedRootsGate,
  makeTurnContextGate,
  McpHttpClient,
  MCP_HTTP_REQUEST_TIMEOUT_MS,
  MCP_RESULT_BUDGET,
  mcpConnectionsSettledForTests,
  recallToolRefusal,
  resetMcpConnectionCacheForTests,
  withServiceTier
} from '../../src/server/pi/stem-mcp-extension.mjs';
import { mcpServerAuthIdentity, writeTurnContextGate } from '../../src/server/pi/mcp-config';

const cleanup: string[] = [];

afterEach(async () => {
  resetMcpConnectionCacheForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.STEM_MCP_CONFIG;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('MCP bridge filesystem policy', () => {
  it('treats symlink aliases and new descendants as inside a protected root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-mcp-policy-'));
    cleanup.push(root);
    const vault = join(root, 'vault');
    const workspace = join(root, 'workspace');
    await Promise.all([mkdir(vault), mkdir(workspace)]);
    await symlink(vault, join(workspace, 'alias'));
    await symlink(join(vault, 'created-through-link.md'), join(workspace, 'dangling-file'));

    expect(isInside(join(vault, 'direct.md'), vault)).toBe(true);
    expect(isInside(join(workspace, 'alias', 'existing-or-new.md'), vault)).toBe(true);
    expect(isInside(join(workspace, 'alias', 'new', 'nested.md'), vault)).toBe(true);
    expect(isInside(join(workspace, 'dangling-file'), vault)).toBe(true);
    expect(isInside(pathToFileURL(join(vault, 'from-file-url.md')).href, vault)).toBe(true);
    expect(isInside(`@${join(vault, 'from-at-prefix.md')}`, vault)).toBe(true);
    expect(isInside('~/.stem-policy-nonexistent-vault/new.md', join(homedir(), '.stem-policy-nonexistent-vault'))).toBe(true);
    expect(isInside(join(workspace, 'outside.md'), vault)).toBe(false);
  });

  it('keeps the last-known-good roots when the gate file goes missing or corrupt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-roots-gate-'));
    cleanup.push(root);
    const prPath = join(root, 'protected-roots.json');
    const gate = makeProtectedRootsGate(prPath);

    // Never-readable file: a fresh install genuinely has nothing protected.
    expect(gate()).toEqual([]);

    await writeFile(prPath, JSON.stringify({ roots: ['/vault'] }));
    expect(gate()).toEqual(['/vault']);

    // Corrupt rewrite (torn write, disk trouble) must NOT fail open.
    await writeFile(prPath, '{"roots": [tr');
    expect(gate()).toEqual(['/vault']);
    await rm(prPath);
    expect(gate()).toEqual(['/vault']);

    // Only a valid rewrite changes the set — including deliberately to empty.
    await writeFile(prPath, JSON.stringify({ roots: [] }));
    expect(gate()).toEqual([]);
  });

  it('finds path-shaped args inside protected roots, ignoring prose and outside paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-mcp-scan-'));
    cleanup.push(root);
    const vault = join(root, 'vault');
    await mkdir(vault);

    const roots = [vault];
    const target = join(vault, 'notes', 'secret.md');
    expect(findProtectedPath({ path: target }, roots)).toBe(target);
    expect(findProtectedPath({ nested: { files: [join(root, 'elsewhere.md'), target] } }, roots)).toBe(target);
    expect(findProtectedPath({ uri: pathToFileURL(target).href }, roots)).toBe(pathToFileURL(target).href);
    // Prose mentioning the folder name is not a path; outside paths pass.
    expect(findProtectedPath({ query: 'notes about the vault renovation' }, roots)).toBeNull();
    expect(findProtectedPath({ path: join(root, 'other', 'file.md') }, roots)).toBeNull();
    expect(findProtectedPath({ anything: 42, list: [true, null] }, roots)).toBeNull();
    expect(findProtectedPath({ path: target }, [])).toBeNull();
  });
});

describe('remote MCP request timeout', () => {
  it('never attaches a legacy name-only token without a matching identity stamp', () => {
    const server = { url: 'https://new.example/mcp', trusted: true };
    const legacy = { accessToken: 'old-secret' };
    expect(bridgeOAuthTokenForServer(server, legacy)).toBeNull();
    const stamped = { ...legacy, serverIdentity: mcpServerAuthIdentity(server)! };
    expect(bridgeOAuthTokenForServer(server, stamped)).toBe(stamped);
  });

  it('aborts a server that never returns response headers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })
      )
    );
    const client = new McpHttpClient('hanging', { url: 'https://mcp.test' }, null, () => {});
    client.start();
    const pending = client.handshake();
    const rejected = expect(pending).rejects.toThrow(`timed out after ${MCP_HTTP_REQUEST_TIMEOUT_MS}ms`);

    await vi.advanceTimersByTimeAsync(MCP_HTTP_REQUEST_TIMEOUT_MS + 1);
    await rejected;
  });
});

describe('built-in filesystem tool confinement (SEC-001)', () => {
  it('reads the three root lists, tolerating the old roots-only format', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-fs-roots-'));
    cleanup.push(root);
    const prPath = join(root, 'protected-roots.json');
    const gate = makeFsRootsGate(prPath);

    expect(gate()).toMatchObject({ roots: [], read: [], write: [] });

    await writeFile(prPath, JSON.stringify({ roots: ['/vault'], read: ['/scratch', '/vault'], write: ['/scratch'] }));
    expect(gate()).toMatchObject({ roots: ['/vault'], read: ['/scratch', '/vault'], write: ['/scratch'] });

    // Corrupt rewrite must NOT fail open — last-known-good stands.
    await writeFile(prPath, '{"roots": [tr');
    expect(gate()).toMatchObject({ roots: ['/vault'], read: ['/scratch', '/vault'], write: ['/scratch'] });

    // A file from an older main (roots only) reads as empty grants, not a crash.
    await writeFile(prPath, JSON.stringify({ roots: ['/vault'] }));
    expect(gate()).toMatchObject({ roots: ['/vault'], read: [], write: [] });
  });

  it('blocks every filesystem tool outside the granted roots, reads included', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-fs-confine-'));
    cleanup.push(root);
    const vaultRO = join(root, 'vault-ro');
    const vaultRW = join(root, 'vault-rw');
    const scratch = join(root, 'scratch');
    const outside = join(root, 'outside');
    await Promise.all([mkdir(vaultRO), mkdir(vaultRW), mkdir(scratch), mkdir(outside)]);
    const configPath = join(root, 'mcp.json');
    await writeFile(configPath, JSON.stringify({ servers: {} }));
    await writeFile(
      join(root, 'protected-roots.json'),
      JSON.stringify({ roots: [vaultRO], read: [scratch, vaultRO, vaultRW], write: [scratch, vaultRW] })
    );
    process.env.STEM_MCP_CONFIG = configPath;

    const toolCallHandlers: Array<(event: unknown) => { block?: boolean; reason?: string } | undefined> = [];
    const fakePi = {
      registerTool: (_tool: unknown) => {},
      on: (name: string, handler: (...args: unknown[]) => unknown) => {
        if (name === 'tool_call') toolCallHandlers.push(handler as (typeof toolCallHandlers)[number]);
      },
      getActiveTools: () => [] as string[],
      setActiveTools: (_tools: string[]) => {}
    };
    await stemMcpBridge(fakePi);
    await mcpConnectionsSettledForTests();
    expect(toolCallHandlers.length).toBeGreaterThan(0);

    const verdict = (toolName: string, path?: string) => {
      for (const handler of toolCallHandlers) {
        const res = handler({ toolName, input: path === undefined ? {} : { path } });
        if (res && res.block) return res;
      }
      return undefined;
    };

    // Reads outside every granted root are blocked — the SEC-001 exfiltration path.
    expect(verdict('read', join(outside, 'secrets.txt'))?.reason).toContain('outside the folders granted');
    expect(verdict('grep', join(outside, 'dir'))?.reason).toContain('outside the folders granted');
    expect(verdict('ls', outside)?.reason).toContain('outside the folders granted');
    expect(verdict('find', outside)?.reason).toContain('outside the folders granted');
    expect(verdict('read', '/etc/passwd')?.block).toBe(true);
    expect(verdict('read', '~/.ssh/id_rsa')?.block).toBe(true);

    // Writes outside every granted root are blocked, and read-only folders keep
    // their dedicated refusal.
    expect(verdict('write', join(outside, 'drop.txt'))?.reason).toContain('outside the folders granted');
    expect(verdict('edit', join(outside, 'drop.txt'))?.block).toBe(true);
    expect(verdict('write', join(vaultRO, 'note.md'))?.reason).toContain('read-only');

    // Granted roots, the workspace (pi's cwd), and default-path browsing all pass.
    expect(verdict('read', join(vaultRO, 'note.md'))).toBeUndefined();
    expect(verdict('read', join(vaultRW, 'note.md'))).toBeUndefined();
    expect(verdict('write', join(vaultRW, 'note.md'))).toBeUndefined();
    expect(verdict('write', join(scratch, 'script.sh'))).toBeUndefined();
    expect(verdict('read', join(process.cwd(), 'package.json'))).toBeUndefined();
    expect(verdict('write', 'relative/inside-workspace.md')).toBeUndefined();
    expect(verdict('ls')).toBeUndefined();

    // A relative path that traverses out of the workspace is still confined.
    const depth = process.cwd().split('/').filter(Boolean).length + 1;
    expect(verdict('read', `${'../'.repeat(depth)}etc/passwd`)?.block).toBe(true);

    // Non-filesystem tools pass through untouched.
    expect(verdict('run_command', join(outside, 'x'))).toBeUndefined();
  });
});

describe('failed MCP connection retry', () => {
  it('retries a configured server on the next session factory invocation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-mcp-retry-'));
    cleanup.push(root);
    const configPath = join(root, 'mcp.json');
    await writeFile(configPath, JSON.stringify({ servers: { retryme: { url: 'https://mcp.test', trusted: true } } }));
    process.env.STEM_MCP_CONFIG = configPath;

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('server is down'))
      .mockImplementation(async (_input, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
        const result = request.method === 'tools/list' ? { tools: [] } : {};
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      });
    vi.stubGlobal('fetch', fetchMock);

    const fakePi = {
      registerTool: (_tool: unknown) => {},
      on: (_name: string, _handler: (...args: unknown[]) => unknown) => {},
      getActiveTools: () => [] as string[],
      setActiveTools: (_tools: string[]) => {}
    };
    await stemMcpBridge(fakePi);
    await mcpConnectionsSettledForTests();
    expect(JSON.parse(await readFile(join(root, 'mcp-status.json'), 'utf8')).retryme.status).toBe('failed');

    await stemMcpBridge(fakePi);
    await mcpConnectionsSettledForTests();
    expect(fetchMock).toHaveBeenCalledTimes(4); // failed initialize, then initialize + notify + tools/list
    expect(JSON.parse(await readFile(join(root, 'mcp-status.json'), 'utf8')).retryme.status).toBe('ready');
  });
});

describe('MCP router protected-roots guard', () => {
  it('refuses invoke_tool calls whose args reach into a read-only folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-mcp-guard-'));
    cleanup.push(root);
    const vault = join(root, 'vault');
    await mkdir(vault);
    const configPath = join(root, 'mcp.json');
    await writeFile(configPath, JSON.stringify({ servers: { fs: { url: 'https://mcp.test', trusted: true } } }));
    await writeFile(join(root, 'protected-roots.json'), JSON.stringify({ roots: [vault] }));
    process.env.STEM_MCP_CONFIG = configPath;

    const methods: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
        methods.push(request.method ?? '');
        const result = request.method === 'tools/list'
          ? { tools: [{ name: 'write_file', description: 'writes a file' }] }
          : request.method === 'tools/call'
            ? { content: [{ type: 'text', text: 'wrote it' }] }
            : {};
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      })
    );

    type RegisteredTool = {
      name?: string;
      execute?: (...args: unknown[]) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;
    };
    const registered: RegisteredTool[] = [];
    const fakePi = {
      registerTool: (tool: RegisteredTool) => registered.push(tool),
      on: (_name: string, _handler: (...args: unknown[]) => unknown) => {},
      getActiveTools: () => [] as string[],
      setActiveTools: (_tools: string[]) => {}
    };
    await stemMcpBridge(fakePi);
    await mcpConnectionsSettledForTests();
    const invoke = registered.find((tool) => tool.name === 'invoke_tool');

    const blocked = await invoke!.execute!('call-1', {
      server: 'fs',
      tool: 'write_file',
      args: { path: join(vault, 'notes', 'x.md'), content: 'overwrite' }
    });
    expect(blocked.isError).toBe(true);
    expect(String(blocked.content[0]?.text)).toContain('read-only');
    expect(methods).not.toContain('tools/call');

    // The same tool is untouched for paths outside the protected roots.
    const allowed = await invoke!.execute!('call-2', {
      server: 'fs',
      tool: 'write_file',
      args: { path: join(root, 'open.md'), content: 'fine' }
    });
    expect(allowed.isError).not.toBe(true);
    expect(methods).toContain('tools/call');
  });
});

describe('MCP tool-result size cap', () => {
  it('passes small results through untouched, non-text blocks included', () => {
    const image = { type: 'image', data: 'x'.repeat(2 * MCP_RESULT_BUDGET), mimeType: 'image/png' };
    const content = [{ type: 'text', text: 'small' }, image];
    expect(capToolContent(content)).toEqual(content);
  });

  it('cuts an oversized text block at the budget and appends the how-to-narrow notice', () => {
    const capped = capToolContent([{ type: 'text', text: 'a'.repeat(MCP_RESULT_BUDGET + 500) }]);
    expect(capped).toHaveLength(2);
    expect((capped[0] as { text: string }).text).toHaveLength(MCP_RESULT_BUDGET);
    const notice = (capped[1] as { text: string }).text;
    expect(notice).toContain('truncated');
    expect(notice).toContain(String(MCP_RESULT_BUDGET + 500));
    expect(notice).toContain('narrower call');
  });

  it('text blocks share ONE budget; later blocks are dropped once it is spent', () => {
    const half = Math.ceil(MCP_RESULT_BUDGET / 2);
    const capped = capToolContent([
      { type: 'text', text: 'a'.repeat(half) },
      { type: 'image', data: 'img', mimeType: 'image/png' },
      { type: 'text', text: 'b'.repeat(half) },
      { type: 'text', text: 'c'.repeat(half) }
    ]);
    // First survives whole, image passes through, second is trimmed to the
    // remainder, third contributes nothing but its size to the notice.
    const texts = capped.filter((b) => (b as { type: string }).type === 'text') as { text: string }[];
    expect(capped.some((b) => (b as { type: string }).type === 'image')).toBe(true);
    const kept = texts.slice(0, -1).reduce((n, b) => n + b.text.length, 0);
    expect(kept).toBe(MCP_RESULT_BUDGET);
    expect(texts[texts.length - 1].text).toContain('truncated');
  });

  it('invoke_tool results are capped before they reach the model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-mcp-cap-'));
    cleanup.push(root);
    const configPath = join(root, 'mcp.json');
    await writeFile(configPath, JSON.stringify({ servers: { logs: { url: 'https://mcp.test', trusted: true } } }));
    process.env.STEM_MCP_CONFIG = configPath;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
        const result = request.method === 'tools/list'
          ? { tools: [{ name: 'query', description: 'queries logs' }] }
          : request.method === 'tools/call'
            ? { content: [{ type: 'text', text: 'x'.repeat(MCP_RESULT_BUDGET * 3) }] }
            : {};
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      })
    );

    type RegisteredTool = {
      name?: string;
      execute?: (...args: unknown[]) => Promise<{ content: Array<{ type?: string; text?: string }> }>;
    };
    const registered: RegisteredTool[] = [];
    const fakePi = {
      registerTool: (tool: RegisteredTool) => registered.push(tool),
      on: (_name: string, _handler: (...args: unknown[]) => unknown) => {},
      getActiveTools: () => [] as string[],
      setActiveTools: (_tools: string[]) => {}
    };
    await stemMcpBridge(fakePi);
    await mcpConnectionsSettledForTests();

    const invoke = registered.find((tool) => tool.name === 'invoke_tool');
    const result = await invoke!.execute!('call-1', { server: 'logs', tool: 'query', args: {} });
    const total = result.content.reduce((n, b) => n + (b.text?.length ?? 0), 0);
    expect(total).toBeLessThan(MCP_RESULT_BUDGET + 1000);
    expect(result.content[result.content.length - 1]?.text).toContain('truncated');
  });
});

describe('non-blocking MCP connect', () => {
  it('returns from the factory while routed servers are still handshaking', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-mcp-nonblock-'));
    cleanup.push(root);
    const configPath = join(root, 'mcp.json');
    await writeFile(configPath, JSON.stringify({ servers: { slowpoke: { url: 'https://mcp.test', trusted: true } } }));
    process.env.STEM_MCP_CONFIG = configPath;

    // Every request stalls until the test releases it — a hung remote server.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        await gate;
        const request = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
        const result = request.method === 'tools/list' ? { tools: [{ name: 'slow_tool', description: 'x' }] } : {};
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      })
    );

    const fakePi = {
      registerTool: (_tool: unknown) => {},
      on: (_name: string, _handler: (...args: unknown[]) => unknown) => {},
      getActiveTools: () => [] as string[],
      setActiveTools: (_tools: string[]) => {}
    };
    // The factory must resolve immediately (pi readiness gates on it) even though
    // the routed server has not answered its handshake yet.
    await stemMcpBridge(fakePi);
    expect(JSON.parse(await readFile(join(root, 'mcp-status.json'), 'utf8')).slowpoke.status).toBe('starting');
    expect(JSON.parse(await readFile(join(root, 'mcp-catalog.json'), 'utf8')).text).toBe('');

    release();
    await mcpConnectionsSettledForTests();
    expect(JSON.parse(await readFile(join(root, 'mcp-status.json'), 'utf8')).slowpoke.status).toBe('ready');
    expect(JSON.parse(await readFile(join(root, 'mcp-catalog.json'), 'utf8')).text).toContain('slow_tool');
  });
});

describe('McpHttpClient auth healing', () => {
  it('retries a 401 with whatever token the refresh callback hands back', async () => {
    // No refreshToken on the client's own grant: the old guard skipped the
    // retry entirely, so a worker that outlived a re-login kept failing until
    // it was respawned. The coordinator can hand back the login's token.
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        sent.push(init.headers.Authorization);
        if (sent.length === 1) {
          return { ok: false, status: 401, headers: new Headers(), text: async (): Promise<string> => 'expired' };
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ jsonrpc: '2.0', id: 1, result: { healed: true } }),
          text: async (): Promise<string> => ''
        };
      })
    );
    const client = new McpHttpClient(
      'remote',
      { url: 'https://mcp.test' },
      { accessToken: 'stale-access' },
      async () => ({ accessToken: 'relogin-access' })
    );
    const result = (await client.rpc('tools/list', {})) as { healed?: boolean };
    expect(sent).toEqual(['Bearer stale-access', 'Bearer relogin-access']);
    expect(result.healed).toBe(true);
  });
});

describe('recall search tools in a recall-off turn', () => {
  // The persona `recall` flag withholds the injected recall block, but the
  // stem-recall server's search tools were still registered for every turn: a
  // persona denied the block could call search_facts and get the same material
  // back. The turn-context gate now carries `recall`, and the bridge refuses
  // those tools when it is false.
  const cleanup: string[] = [];
  afterEach(async () => {
    for (const p of cleanup.splice(0)) await rm(p, { recursive: true, force: true });
  });

  it('refuses the memory searches, not the guide, and only for the recall server', () => {
    const off = { mail: true, scheduled: false, coding: false, recall: false };
    const on = { ...off, recall: true };
    for (const tool of ['search_facts', 'search_past_chats', 'search_chat_summaries', 'search_folder_docs']) {
      expect(recallToolRefusal('stem-recall', tool, off)).toMatch(/without access to the user's memory/);
      expect(recallToolRefusal('stem-recall', tool, on)).toBeNull();
    }
    expect(recallToolRefusal('stem-recall', 'read_stem_guide', off)).toBeNull();
    // Another server's tool that happens to share a name is the user's own integration.
    expect(recallToolRefusal('notion', 'search_facts', off)).toBeNull();
    // No gate reading at all (older main) → allowed, the pre-gate behaviour.
    expect(recallToolRefusal('stem-recall', 'search_facts', null)).toBeNull();
  });

  it('reads recall from the gate main writes, and defaults to allowed when the field is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-recall-gate-'));
    cleanup.push(root);
    const gate = makeTurnContextGate(join(root, 'turn-context.json'));
    // No file yet: a live chat with recall.
    expect(gate()).toEqual({ mail: false, scheduled: false, coding: true, recall: true });
    // What main writes for a Critic delivery.
    await writeTurnContextGate({ mail: true, scheduled: false, coding: false, recall: false }, root);
    expect(gate().recall).toBe(false);
    expect(recallToolRefusal('stem-recall', 'search_facts', gate())).not.toBeNull();
    // An older main's file, written before the field existed.
    await writeFile(join(root, 'turn-context.json'), JSON.stringify({ mail: false, scheduled: false, coding: true }));
    expect(gate().recall).toBe(true);
  });
});

describe('set_custom_instructions in unattended turns', () => {
  async function instructionsTool(root: string) {
    const configPath = join(root, 'mcp.json');
    await writeFile(configPath, JSON.stringify({ servers: {} }));
    process.env.STEM_MCP_CONFIG = configPath;
    type RegisteredTool = {
      name?: string;
      execute?: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
    };
    const registered: RegisteredTool[] = [];
    await stemMcpBridge({
      registerTool: (tool: RegisteredTool) => registered.push(tool),
      on: () => {},
      getActiveTools: () => [] as string[],
      setActiveTools: () => {}
    });
    return registered.find((tool) => tool.name === 'set_custom_instructions')!;
  }

  it('proposes by reply in a mail turn instead of raising a card that expires', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-instr-mail-'));
    cleanup.push(root);
    const tool = await instructionsTool(root);
    await writeFile(join(root, 'turn-context.json'), JSON.stringify({ mail: true, scheduled: true }));
    const confirm = vi.fn(async () => true);
    const res = await tool.execute!(
      'i-1',
      { action: 'append', text: 'Always check #war-room.' },
      undefined,
      undefined,
      { ui: { confirm } }
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(String(res.content[0]?.text)).toContain('reply mail');
  });

  it('still raises the card in a live chat (missing or live-chat gate)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-instr-live-'));
    cleanup.push(root);
    const tool = await instructionsTool(root);
    const confirm = vi.fn(async () => false);
    // No turn-context.json at all — the reading must default to a live chat.
    const res = await tool.execute!(
      'i-2',
      { action: 'append', text: 'Always check #war-room.' },
      undefined,
      undefined,
      { ui: { confirm } }
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String(res.content[0]?.text)).toContain('declined');
  });
});

describe('assistant MCP administration', () => {
  it('says which machine each server runs on, so a failure is diagnosed on the right one', async () => {
    // The listing used to give the command and nothing else, and an assistant
    // reading it had no way to know that a `spawn uvx ENOENT` was the SERVER
    // missing uvx rather than the laptop in front of the user.
    const root = await mkdtemp(join(tmpdir(), 'stem-mcp-list-'));
    cleanup.push(root);
    const configPath = join(root, 'mcp.json');
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          grafana: { command: 'uvx', args: ['mcp-grafana'], trusted: true, disabled: true },
          notes: {
            command: 'npx',
            args: ['-y', 'notes-mcp'],
            trusted: true,
            disabled: true,
            location: { deviceId: 'dev-1', label: "Vlado's MacBook" }
          },
          fastmail: { url: 'https://api.fastmail.com/mcp', trusted: true, disabled: true }
        }
      })
    );
    process.env.STEM_MCP_CONFIG = configPath;

    type RegisteredTool = {
      name?: string;
      execute?: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }>;
    };
    const registered: RegisteredTool[] = [];
    await stemMcpBridge({
      registerTool: (tool: RegisteredTool) => registered.push(tool),
      on: () => {},
      getActiveTools: () => [] as string[],
      setActiveTools: () => {}
    });
    const list = registered.find((tool) => tool.name === 'list_mcp_servers');
    // The live connection outcome rides along: a server whose OAuth token
    // expired used to list as merely "configured", and the assistant could only
    // report "no email tools" instead of "your sign-in expired". Written after
    // the bridge is up because startup publishes (and would overwrite) a status
    // snapshot of its own.
    await mcpConnectionsSettledForTests();
    await writeFile(
      join(root, 'mcp-status.json'),
      JSON.stringify({
        fastmail: { status: 'failed', error: 'HTTP 401 Invalid Authorization bearer token, token has expired' },
        grafana: { status: 'ready' }
      })
    );
    const text = String((await list!.execute!('list-1', {})).content[0]?.text);

    expect(text).toContain('- grafana (stdio): uvx mcp-grafana — runs where Stem itself runs');
    expect(text).toContain("- notes (stdio): npx -y notes-mcp — runs on the user's computer “Vlado's MacBook”");
    // Switched off is the other reason a server "does not work" with no error.
    expect(text).toContain('switched off in Settings');
    // A failed connect names its error so the assistant can tell the user WHY
    // (an expired login, not a missing server) — and a healthy one stays quiet.
    expect(text).toContain('currently FAILING: HTTP 401 Invalid Authorization bearer token, token has expired');
    expect(text).toContain('reconnect it themselves in Settings');
    expect(text).not.toContain('grafana (stdio): uvx mcp-grafana — runs where Stem itself runs, switched off in Settings —');
    // And the rule that makes the placement actionable travels with the list.
    expect(text).toContain('must exist there');
  });

  it('leaves config mutation to the main process after approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-mcp-admin-'));
    cleanup.push(root);
    const configPath = join(root, 'mcp.json');
    const initial = JSON.stringify({
      servers: { existing: { command: '/bin/echo', args: [], trusted: true, disabled: true } }
    }, null, 2);
    await writeFile(configPath, initial);
    process.env.STEM_MCP_CONFIG = configPath;

    type RegisteredTool = {
      name?: string;
      execute?: (...args: unknown[]) => Promise<unknown>;
    };
    const registered: RegisteredTool[] = [];
    const fakePi = {
      registerTool: (tool: RegisteredTool) => registered.push(tool),
      on: (_name: string, _handler: (...args: unknown[]) => unknown) => {},
      getActiveTools: () => [] as string[],
      setActiveTools: (_tools: string[]) => {}
    };
    await stemMcpBridge(fakePi);
    // Declared as variadic because the assertions below read the arguments the
    // bridge passed; a zero-arg mock types every recorded call as an empty tuple.
    const confirm = vi.fn(async (..._args: unknown[]) => true);
    const ctx = { ui: { confirm } };
    const add = registered.find((tool) => tool.name === 'add_mcp_server');
    const remove = registered.find((tool) => tool.name === 'remove_mcp_server');

    await add?.execute?.(
      'add-id',
      {
        name: 'new-server',
        transport: 'http',
        url: 'https://mcp.example',
        oauthClientId: 'client-id',
        oauthClientSecret: 'real-client-secret'
      },
      undefined,
      undefined,
      ctx
    );
    await remove?.execute?.('remove-id', { name: 'existing' }, undefined, undefined, ctx);

    expect(confirm).toHaveBeenCalledTimes(2);
    const proposal = JSON.parse(String(confirm.mock.calls[0]?.[1])) as {
      input?: { oauthClientSecret?: string };
    };
    expect(proposal.input?.oauthClientSecret).toBe('real-client-secret');
    expect(await readFile(configPath, 'utf8')).toBe(initial);
  });
});

describe('service tier ("Fast") payload injection', () => {
  const codexBody = { input: [{ role: 'user' }], instructions: 'You are…', model: 'gpt-5.2-codex' };
  const grokResponsesBody = { input: [{ role: 'user' }], model: 'grok-4.5' };
  const grokCompletionsBody = { messages: [{ role: 'user' }], model: 'grok-4.3' };

  it('injects priority into codex and Grok bodies, over both API shapes', () => {
    for (const body of [codexBody, grokResponsesBody, grokCompletionsBody]) {
      expect(withServiceTier(body, 'priority')).toEqual({ ...body, service_tier: 'priority' });
    }
  });

  it('leaves unrecognized providers alone, including OpenRouter-hosted Grok', () => {
    expect(withServiceTier({ messages: [], model: 'llama3:8b' }, 'priority')).toBeUndefined();
    expect(withServiceTier({ messages: [], model: 'x-ai/grok-4.3' }, 'priority')).toBeUndefined();
    // Anthropic-shaped body whose model name could one day collide.
    expect(withServiceTier({ model: 'grok-4.3', max_tokens: 10 }, 'priority')).toBeUndefined();
  });

  it('never overwrites an explicit tier and does nothing on Standard', () => {
    expect(withServiceTier({ ...codexBody, service_tier: 'flex' }, 'priority')).toBeUndefined();
    expect(withServiceTier(codexBody, null)).toBeUndefined();
    expect(withServiceTier(undefined, 'priority')).toBeUndefined();
  });
});

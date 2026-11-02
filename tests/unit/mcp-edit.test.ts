// Editing an MCP server in place (the panel's Edit…).
//
// Before this, "edit" meant re-adding under the same name, which replaced the
// whole entry: the form could not show a stored token back, so changing the
// URL beside one meant retyping it, and the form's "Runs on" defaulted to the
// server, so an edit of a server pinned to your Mac quietly moved it away.
// What is checked here is exactly those two things — what the form is shown,
// and what survives a save — plus the credential rule an add already has.

import { beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import {
  addMcpServer,
  editMcpServer,
  getMcpServer,
  mcpServersForAppName,
  setMcpServerApps,
  setMcpServerEnabled,
  updateMcpServer
} from '../../src/server/pi/mcp';
import {
  mcpServerAuthIdentity,
  piMcpOAuthPath,
  readMcpConfig,
  readOAuthTokens,
  saveOAuthToken,
  writeMcpConfig
} from '../../src/server/pi/mcp-config';
import { secretKeyHex } from '../../src/server/pi/secrets';
import { forgetCachedDevices, mintDevice, readDevices } from '../../src/server/transport/auth';
import { devicesStorePath, piMcpConfigPath } from '../../src/server/workspace/paths';
import { MCP_SECRET_MASK } from '../../src/shared/types';

beforeEach(async () => {
  process.env.STEM_SECRET_KEY = secretKeyHex()!;
  rmSync(piMcpConfigPath(), { force: true });
  rmSync(piMcpOAuthPath(), { force: true });
  rmSync(`${piMcpConfigPath()}.state.lock`, { force: true });
  rmSync(`${piMcpConfigPath()}.state.lock.reaper`, { force: true });
  await readDevices().catch(() => undefined);
  rmSync(devicesStorePath(), { force: true });
  forgetCachedDevices();
});

describe('what the Edit form is shown', () => {
  it('masks values whose name says credential and shows the rest', async () => {
    await addMcpServer({
      name: 'ha',
      transport: 'stdio',
      command: 'uvx',
      args: ['ha-mcp@latest'],
      env: { HOMEASSISTANT_URL: 'http://homeassistant.local:8123/', HOMEASSISTANT_TOKEN: 'eyJ.secret' }
    });
    expect(await getMcpServer('ha')).toEqual({
      name: 'ha',
      transport: 'stdio',
      command: 'uvx',
      args: ['ha-mcp@latest'],
      url: '',
      env: { HOMEASSISTANT_URL: 'http://homeassistant.local:8123/', HOMEASSISTANT_TOKEN: MCP_SECRET_MASK },
      headers: {},
      oauthClientId: '',
      oauthClientSecret: '',
      oauthScope: ''
    });
  });

  it('masks bearer headers and the OAuth client secret of a URL server', async () => {
    await addMcpServer({
      name: 'slack',
      transport: 'http',
      url: 'https://mcp.slack.test/mcp',
      headers: { Authorization: 'Bearer x', 'X-Team': 'eng' },
      oauthClientId: 'client-1',
      oauthClientSecret: 'shh',
      oauthScope: 'chat:write'
    });
    expect(await getMcpServer('slack')).toMatchObject({
      transport: 'http',
      url: 'https://mcp.slack.test/mcp',
      headers: { Authorization: MCP_SECRET_MASK, 'X-Team': 'eng' },
      oauthClientId: 'client-1',
      oauthClientSecret: MCP_SECRET_MASK,
      oauthScope: 'chat:write'
    });
  });

  it('refuses a name that is not there', async () => {
    await expect(getMcpServer('nope')).rejects.toThrow('No MCP server named "nope"');
  });
});

describe('saving an edit', () => {
  it('changes one env var, keeps the masked token, and keeps where it runs and whether it is on', async () => {
    const { device } = await mintDevice('Ada’s MacBook');
    await addMcpServer({
      name: 'ha',
      transport: 'stdio',
      command: 'uvx',
      args: ['ha-mcp@latest'],
      env: { HOMEASSISTANT_URL: 'http://homeassistant.local:8123/', HOMEASSISTANT_TOKEN: 'eyJ.secret' },
      location: { deviceId: device.id }
    });
    await writeMcpConfig({
      servers: { ...(await readMcpConfig()).servers, ha: { ...(await readMcpConfig()).servers.ha, disabled: true } }
    });

    // What the form sends back: the URL retyped, the token as it was shown.
    const list = await updateMcpServer({
      name: 'ha',
      transport: 'stdio',
      command: 'uvx',
      args: ['ha-mcp==8.4.3'],
      env: { HOMEASSISTANT_URL: 'http://192.168.1.25:8123', HOMEASSISTANT_TOKEN: MCP_SECRET_MASK }
    });

    const stored = (await readMcpConfig()).servers.ha;
    expect(stored).toEqual({
      command: 'uvx',
      args: ['ha-mcp==8.4.3'],
      env: { HOMEASSISTANT_URL: 'http://192.168.1.25:8123', HOMEASSISTANT_TOKEN: 'eyJ.secret' },
      trusted: true,
      location: { deviceId: device.id, label: 'Ada’s MacBook' },
      disabled: true
    });
    expect(list.find((s) => s.name === 'ha')).toMatchObject({
      enabled: false,
      location: { deviceId: device.id, label: 'Ada’s MacBook' }
    });
  });

  it('takes a retyped secret and drops a masked key that has nothing stored under it', async () => {
    await addMcpServer({ name: 'ha', transport: 'stdio', command: 'uvx', env: { HOMEASSISTANT_TOKEN: 'old' } });
    await updateMcpServer({
      name: 'ha',
      transport: 'stdio',
      command: 'uvx',
      env: { HOMEASSISTANT_TOKEN: 'new', OTHER_TOKEN: MCP_SECRET_MASK }
    });
    expect((await readMcpConfig()).servers.ha.env).toEqual({ HOMEASSISTANT_TOKEN: 'new' });
  });

  it('keeps the OAuth token when the URL and credentials did not change, and revokes it when they did', async () => {
    await addMcpServer({
      name: 'slack',
      transport: 'http',
      url: 'https://mcp.slack.test/mcp',
      headers: { Authorization: 'Bearer x' },
      oauthClientId: 'client-1',
      oauthClientSecret: 'shh'
    });
    const identity = mcpServerAuthIdentity((await readMcpConfig()).servers.slack)!;
    await saveOAuthToken('slack', {
      serverIdentity: identity,
      resource: 'https://mcp.slack.test/mcp',
      tokenEndpoint: 'https://mcp.slack.test/token',
      clientId: 'client-1',
      scope: 'chat:write',
      accessToken: 'at',
      expiresAt: Date.now() + 60_000
    });

    // Same identity, sent back through the mask: the token is still that server's.
    await updateMcpServer({
      name: 'slack',
      transport: 'http',
      url: 'https://mcp.slack.test/mcp',
      headers: { Authorization: MCP_SECRET_MASK },
      oauthClientId: 'client-1',
      oauthClientSecret: MCP_SECRET_MASK
    });
    expect((await readMcpConfig()).servers.slack.oauthClientSecret).toBe('shh');
    expect((await readOAuthTokens()).slack?.accessToken).toBe('at');

    // A new URL is a new server as far as a credential is concerned.
    await updateMcpServer({
      name: 'slack',
      transport: 'http',
      url: 'https://mcp.slack.test/v2/mcp',
      headers: { Authorization: MCP_SECRET_MASK },
      oauthClientId: 'client-1',
      oauthClientSecret: MCP_SECRET_MASK
    });
    expect((await readOAuthTokens()).slack).toBeUndefined();
  });

  it('refuses to change the transport or to edit a server that is not there', async () => {
    await addMcpServer({ name: 'ha', transport: 'stdio', command: 'uvx' });
    await expect(
      updateMcpServer({ name: 'ha', transport: 'http', url: 'https://x.test/mcp' })
    ).rejects.toThrow('keeps its transport');
    await expect(updateMcpServer({ name: 'nope', transport: 'stdio', command: 'x' })).rejects.toThrow(
      'No MCP server named "nope"'
    );
  });
});

describe('Works with apps ("Ask about this window")', () => {
  it('is set on its own write, survives an edit, and goes back to name matching when cleared', async () => {
    await addMcpServer({ name: 'chat', transport: 'http', url: 'https://mcp.slack.test/mcp' });
    expect(await mcpServersForAppName('Slack', 'com.tinyspeck.slackmacgap')).toEqual([]);

    const list = await setMcpServerApps('chat', [' Slack ', 'slack', '']);
    expect(list.find((s) => s.name === 'chat')?.apps).toEqual(['Slack']);
    expect(await mcpServersForAppName('Slack', 'com.tinyspeck.slackmacgap')).toEqual(['chat']);

    await updateMcpServer({ name: 'chat', transport: 'http', url: 'https://mcp.slack.test/v2' });
    expect((await readMcpConfig()).servers.chat.apps).toEqual(['Slack']);

    await setMcpServerApps('chat', null);
    expect((await readMcpConfig()).servers.chat).not.toHaveProperty('apps');
  });

  it('honours a persona allowlist', async () => {
    await addMcpServer({ name: 'slack', transport: 'http', url: 'https://mcp.slack.test/mcp' });
    expect(await mcpServersForAppName('Slack', null, ['slack'])).toEqual(['slack']);
    expect(await mcpServersForAppName('Slack', null, [])).toEqual([]);
  });
});

// The assistant's edit_mcp_server. The case that needed it: a pinned Node binary
// moved, the fix was a new command, and the only assistant tool was an add that
// would have dropped the bank token stored beside it.
describe("the assistant's edit (edit_mcp_server)", () => {
  it('changes the command and keeps every stored env value it was not given', async () => {
    await addMcpServer({
      name: 'fio',
      transport: 'stdio',
      command: '/usr/local/bin/node',
      args: ['launch.mjs', 'abc'],
      env: { FIO_API_TOKEN: 'bank-secret', NODE_OPTIONS: '' }
    });
    await setMcpServerEnabled('fio', false);

    await editMcpServer('fio', { command: '/var/lib/stem/state/tools/fio/fio-node' });

    const stored = (await readMcpConfig()).servers.fio;
    expect(stored.command).toBe('/var/lib/stem/state/tools/fio/fio-node');
    expect(stored.args).toEqual(['launch.mjs', 'abc']);
    expect(stored.env).toEqual({ FIO_API_TOKEN: 'bank-secret', NODE_OPTIONS: '' });
    expect(stored.disabled).toBe(true);
    expect(stored.trusted).toBe(true);
  });

  it('sets and removes single env keys', async () => {
    await addMcpServer({ name: 'ha', transport: 'stdio', command: 'uvx', env: { A: '1', TOKEN: 's', B: '2' } });
    await editMcpServer('ha', { env: { A: 'one', C: '3' }, removeEnv: ['B'] });
    expect((await readMcpConfig()).servers.ha.env).toEqual({ A: 'one', TOKEN: 's', C: '3' });
  });

  it('keeps headers, the OAuth client and the signed-in token when only an unrelated field changes', async () => {
    await addMcpServer({
      name: 'slack',
      transport: 'http',
      url: 'https://mcp.slack.test/mcp',
      headers: { Authorization: 'Bearer h' },
      oauthClientId: 'client-1',
      oauthClientSecret: 'client-secret'
    });
    await saveOAuthToken('slack', { access_token: 'live', token_type: 'Bearer' } as never);
    await editMcpServer('slack', { headers: { 'X-Extra': 'v' } });
    const stored = (await readMcpConfig()).servers.slack;
    expect(stored.headers).toEqual({ Authorization: 'Bearer h', 'X-Extra': 'v' });
    expect(stored.oauthClientSecret).toBe('client-secret');
    // Headers are part of the auth identity, so a header change signs out — the
    // same rule the panel's Edit applies.
    expect((await readOAuthTokens()).slack).toBeUndefined();

    await saveOAuthToken('slack', { access_token: 'live2', token_type: 'Bearer' } as never);
    await editMcpServer('slack', { url: 'https://mcp.slack.test/mcp' });
    expect((await readOAuthTokens()).slack).toBeDefined();
  });

  it('refuses a server that is not there', async () => {
    await expect(editMcpServer('nope', { command: 'x' })).rejects.toThrow('No MCP server named "nope"');
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADMIN_APPROVAL_TITLE,
  DEVICE_MCP_BRIDGE_TITLE,
  ENV_SECRET_KEY,
  EXEC_BRIDGE_TITLE,
  HARNESS_BRIDGE_TITLE,
  INSTRUCTIONS_APPROVAL_TITLE,
  MCP_DEVICE_CATALOG_FILE,
  MCP_OAUTH_FILE,
  NATIVE_SEARCH_GATE_FILE,
  PROTECTED_ROOTS_FILE,
  SECRET_ENVELOPE_KEY,
  SECRET_VALUE_PREFIX,
  SERVICE_TIER_GATE_FILE,
  SKILL_BRIDGE_TITLE,
  SKILLS_REV_FILE,
  TASK_BRIDGE_TITLE,
  TESTED_PI_VERSION,
  toolArgsOf
} from '../../src/server/pi/protocol';

// Drift guards for the Stem ⇄ pi side-protocol. The bridge extension
// (stem-mcp-extension.mjs) runs inside the pi process and cannot import
// src/server/pi/protocol.ts, so its sentinel titles, tool names, and gate-file names
// are hand-written twins of the TS constants. These tests parse the extension
// source and fail when either side changes alone.

const ROOT = join(__dirname, '../..');
const extensionSource = readFileSync(join(ROOT, 'src/server/pi/stem-mcp-extension.mjs'), 'utf8');

/** Extract `const NAME = '<value>'` from the extension source. */
function extensionConst(name: string): string | undefined {
  return extensionSource.match(new RegExp(`const ${name} = '([^']+)'`))?.[1];
}

describe('sentinel titles match the bridge extension', () => {
  it('admin approval', () => {
    expect(extensionConst('ADMIN_APPROVAL_TITLE')).toBe(ADMIN_APPROVAL_TITLE);
  });
  it('instructions approval', () => {
    expect(extensionConst('INSTRUCTIONS_APPROVAL_TITLE')).toBe(INSTRUCTIONS_APPROVAL_TITLE);
  });
  it('task bridge', () => {
    expect(extensionConst('TASK_BRIDGE_TITLE')).toBe(TASK_BRIDGE_TITLE);
  });
  it('exec bridge', () => {
    expect(extensionConst('EXEC_BRIDGE_TITLE')).toBe(EXEC_BRIDGE_TITLE);
  });
  it('harness bridge', () => {
    expect(extensionConst('HARNESS_BRIDGE_TITLE')).toBe(HARNESS_BRIDGE_TITLE);
  });
  it('skill bridge', () => {
    expect(extensionConst('SKILL_BRIDGE_TITLE')).toBe(SKILL_BRIDGE_TITLE);
  });
  it('device MCP bridge', () => {
    expect(extensionConst('DEVICE_MCP_BRIDGE_TITLE')).toBe(DEVICE_MCP_BRIDGE_TITLE);
  });
});

describe('web-search tools match the bridge extension', () => {
  // The gate file flips these tools on/off per turn; the names are hand-written
  // twins of the tools the vendored pi-web-access package registers, so a package
  // that renames one must not silently turn the toggle into a no-op.
  it('the extension gates exactly the pi-web-access tool names', () => {
    const listed = extensionSource.match(/const WEB_ACCESS_TOOLS = \[([^\]]+)\]/)?.[1] ?? '';
    const names = [...listed.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(names).toEqual(['web_search', 'source_check', 'fetch_content', 'get_search_content']);
  });
});

describe('gate files referenced by the bridge extension', () => {
  it.each([
    NATIVE_SEARCH_GATE_FILE,
    SERVICE_TIER_GATE_FILE,
    PROTECTED_ROOTS_FILE
  ])('%s', (file) => {
    expect(extensionSource).toContain(`'${file}'`);
  });

  // SKILLS_REV_FILE deliberately has no twin any more. The extension used to write
  // SKILL.md itself and touch the rev file to announce it; skill writes now
  // round-trip to main (SKILL_BRIDGE_TITLE), which owns both the write and the
  // rev bump — so a reference here would mean the old path had come back.
  it('no longer writes skills itself', () => {
    expect(extensionSource).not.toContain(`'${SKILLS_REV_FILE}'`);
  });

  it(`falls back to ${MCP_OAUTH_FILE} next to the config`, () => {
    expect(extensionSource).toContain(`'${MCP_OAUTH_FILE}'`);
  });

  // Read, not written: main rewrites the device catalog on every announcement and
  // the bridge reads a pinned server's remembered tools out of it. A rename on
  // one side alone would leave a device-located server silently tool-less, which
  // looks exactly like a device that has never connected.
  it(`reads ${MCP_DEVICE_CATALOG_FILE} next to the config`, () => {
    expect(extensionConst('MCP_DEVICE_CATALOG_FILE')).toBe(MCP_DEVICE_CATALOG_FILE);
  });
});

describe('secrets-at-rest constants match the bridge extension', () => {
  it('env var carrying the key', () => {
    expect(extensionConst('ENV_SECRET_KEY')).toBe(ENV_SECRET_KEY);
  });
  it('encrypted-value prefix', () => {
    expect(extensionConst('SECRET_VALUE_PREFIX')).toBe(SECRET_VALUE_PREFIX);
  });
  it('envelope key', () => {
    expect(extensionConst('SECRET_ENVELOPE_KEY')).toBe(SECRET_ENVELOPE_KEY);
  });
});

describe('pi version pin', () => {
  it('package.json pins the exact tested version (no caret/tilde)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    // A range would let a fresh npm install silently swap in an untested pi;
    // PI_SKIP_VERSION_CHECK=1 means nothing else would notice. Bumping pi is
    // fine — retest the side-protocol and update TESTED_PI_VERSION with it.
    expect(pkg.dependencies['@earendil-works/pi-coding-agent']).toBe(TESTED_PI_VERSION);
  });

  it('the installed package is the tested version', () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8')
    ) as { version: string };
    expect(pkg.version).toBe(TESTED_PI_VERSION);
  });
});

describe('toolArgsOf', () => {
  it('probes the known arg-key aliases in order', () => {
    expect(toolArgsOf({ type: 't', toolInput: { a: 1 } })).toEqual({ a: 1 });
    expect(toolArgsOf({ type: 't', args: { b: 2 } })).toEqual({ b: 2 });
    expect(toolArgsOf({ type: 't', input: { c: 3 } })).toEqual({ c: 3 });
    expect(toolArgsOf({ type: 't', arguments: { d: 4 } })).toEqual({ d: 4 });
    expect(toolArgsOf({ type: 't', params: { e: 5 } })).toEqual({ e: 5 });
    expect(toolArgsOf({ type: 't', toolInput: { a: 1 }, args: { b: 2 } })).toEqual({ a: 1 });
    expect(toolArgsOf({ type: 't' })).toBeUndefined();
  });
});

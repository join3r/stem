import test from 'node:test';
import assert from 'node:assert/strict';
import { TabGrants, requireSameOriginFrames, webOrigin } from './extension/policy.mjs';

const tab = { id: 42, url: 'https://example.test/form', incognito: false };
test('grants are origin-bound, expire on leaving, and do not revive on return', () => {
  const grants = new TabGrants();
  assert.throws(() => grants.require(tab), /need a browser grant/);
  grants.grantOpened(tab.id, tab.url);
  assert.equal(grants.require(tab), 'https://example.test');
  grants.navigation(tab.id, 'https://example.test/next');
  assert.equal(grants.require(tab), 'https://example.test');
  grants.navigation(tab.id, 'https://other.test/');
  grants.navigation(tab.id, tab.url);
  assert.throws(() => grants.require(tab), /need a browser grant/);
});
test('pending navigation, private browsing, close and new sessions fail closed', () => {
  const grants = new TabGrants();
  grants.grantOpened(tab.id, tab.url);
  assert.throws(() => grants.require({ ...tab, pendingUrl: 'http://example.test/' }), /pending/);
  assert.throws(() => grants.require({ ...tab, incognito: true }), /Private/);
  assert.throws(() => new TabGrants().require(tab), /need a browser grant/);
  grants.revoke(tab.id);
  assert.throws(() => grants.require(tab), /need a browser grant/);
});
test('script, internal, file and credential-bearing URLs are excluded', () => {
  for (const url of ['javascript:alert(1)', 'chrome://settings', 'file:///tmp/a', 'https://user:pass@example.test/']) assert.throws(() => webOrigin(url));
});
test('whole-tab screenshots refuse nested foreign or opaque frames', () => {
  const origin = 'https://example.test';
  const frame = (securityOrigin, childFrames = []) => ({ frame: { securityOrigin }, childFrames });
  requireSameOriginFrames(frame(origin, [frame(origin)]), origin);
  assert.throws(() => requireSameOriginFrames(frame(origin, [frame(origin, [frame('https://other.test')])]), origin), /unapproved/);
  assert.throws(() => requireSameOriginFrames(frame(origin, [frame('://')]), origin), /unapproved/);
});

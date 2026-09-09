// Kept deliberately small: this probe implements ephemeral, origin-bound grants
// for tabs it opens. Persistent site/all-tab modes belong to the integration.
export function webOrigin(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only ordinary web pages are supported');
  if (parsed.username || parsed.password) throw new Error('Credentials in URLs are not supported');
  return parsed.origin;
}

export class TabGrants {
  #grants = new Map();
  grantOpened(tabId, url) { this.#grants.set(tabId, webOrigin(url)); }
  revoke(tabId) { this.#grants.delete(tabId); }
  clear() { this.#grants.clear(); }
  navigation(tabId, url) {
    try {
      if (this.#grants.get(tabId) !== webOrigin(url)) this.revoke(tabId);
    } catch { this.revoke(tabId); }
  }
  require(tab) {
    if (tab.incognito) throw new Error('Private browsing is excluded');
    const origin = webOrigin(tab.url);
    if (this.#grants.get(tab.id) !== origin) throw new Error('This tab and origin need a browser grant');
    if (tab.pendingUrl && webOrigin(tab.pendingUrl) !== origin) throw new Error('Cross-origin navigation is pending');
    return origin;
  }
}

// A whole-tab screenshot includes child frames. Deny it rather than accidentally
// disclose an embedded origin which has not been granted. This is conservative:
// production may offer explicit additional frame-origin grants.
export function requireSameOriginFrames(tree, origin) {
  if (tree.frame.securityOrigin !== origin) throw new Error('Screenshot includes an unapproved frame origin');
  for (const child of tree.childFrames ?? []) requireSameOriginFrames(child, origin);
}

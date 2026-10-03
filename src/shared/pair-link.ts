// The `stem://pair?…` link a phone scans, and the one question that decides
// whether there is a link to show at all: can the phone reach this server?
//
// A payload rather than JSON because a phone that has no Stem on it yet still
// does something sensible with the scan — iOS offers to open `stem://`, which
// the App Store handles — and because the same string can be copied into a
// message. ios/Stem/Transport/StemClient.swift (PairLink) reads it back; the parameter name
// `url` is the contract between the two.
//
// WHY REACHABILITY IS A QUESTION AT ALL. Stem's default install runs its own
// server bound to loopback (src/server/transport/server.ts), and a code minted
// there is perfectly valid — it just cannot be spent, because `http://127.0.0.1`
// on a phone means the phone. Encoding that address into a QR would produce a
// code that scans, looks right, and fails with a connection error a minute later
// on the other device. So the address is classified here, and Settings shows the
// code with an explanation instead of a QR that leads nowhere. A LAN address is
// deliberately NOT excluded: a phone on the same Wi-Fi reaches 192.168.x.x, and
// that is a real way people run this.

/** What Settings needs to render the pairing dialog, once a code has been minted. */
export interface PairingLink {
  /** The address the phone will dial, normalized; null when none here is any use to it. */
  serverUrl: string | null;
  /** The QR payload, or null when there is no address to put in it. */
  link: string | null;
}

/** Trailing slashes off — src/desktop/client-store.ts's rule, so both sides agree. */
function normalize(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * The host part of an address, lowercased, without credentials or port. IPv6
 * keeps its brackets, which is what makes `[::1]` comparable to a literal.
 */
function hostOf(url: string): string {
  const authority = /^https?:\/\/([^/?#]+)/i.exec(url)?.[1];
  if (!authority) return '';
  const afterUser = authority.slice(authority.lastIndexOf('@') + 1).toLowerCase();
  if (afterUser.startsWith('[')) return afterUser.slice(0, afterUser.indexOf(']') + 1);
  const colon = afterUser.indexOf(':');
  return colon === -1 ? afterUser : afterUser.slice(0, colon);
}

/**
 * Whether an address means "somewhere else" to a device that is not this one.
 * Everything loopback or unspecified means "here", and "here" is the phone.
 */
export function reachableFromAnotherDevice(url: string): boolean {
  const host = hostOf(normalize(url));
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === '[::1]' || host === '[::]') return false;
  if (host === '0.0.0.0') return false;
  return !/^127\./.test(host);
}

/**
 * The link for `code` against `serverUrl`, or a null link when the phone could
 * not use it. The code goes in as it is displayed — `ABCD-EFGH` — because the
 * dashes survive URL encoding untouched and the server normalizes them away
 * anyway (normalizeCode in src/server/transport/pairing.ts), so the string in the
 * QR and the string on the screen are the same string.
 */
export function pairingLink(serverUrl: string | null, code: string): PairingLink {
  const url = normalize(serverUrl ?? '');
  if (!url || !reachableFromAnotherDevice(url)) return { serverUrl: null, link: null };
  return {
    serverUrl: url,
    link: `stem://pair?url=${encodeURIComponent(url)}&code=${encodeURIComponent(code)}`
  };
}

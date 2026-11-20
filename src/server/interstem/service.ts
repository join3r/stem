// Inter-Stem mail (docs/inter-stem-mail-design.md): this Stem's addresses,
// the relay connections that bring mail in, and the queue that sends it out.
//
// Inbound mail lands in the Inbox HELD: no agent, recall, capture or model
// sees it until the user releases it (mail store releaseExternalItems).
// Outbound mail is only ever the user's: their own replies, or a persona's
// draft they approved (router resolveSendDraft).
import { degrade } from '../degrade';
import { log } from '../log';
import type { InterStemReach, InterStemStatus, MailConversation, MailExternal, MailItem, MailListResult, MessageAttachment } from '../../shared/types';
import { MAIL_FILES_MAX_COUNT, putMailFile, readMailFile } from './mail-files';
import {
  appendMailItem,
  createConversation,
  findExternalConversation,
  hasExternalEnvelope,
  readMail,
  setExternalStatus
} from '../workspace/mail';
import {
  b64,
  checkKeyBlob,
  domainOf,
  edPrivate,
  fingerprint,
  makeKeyBlob,
  newId,
  normalizeAddress,
  open,
  rawPublic,
  seal,
  signEnvelope,
  solvePowAsync,
  unb64,
  validAddress,
  verifyEnvelope,
  type Cert,
  type Envelope
} from './proto';
import {
  AuthorityResolver,
  RelayError,
  ack,
  fetchCert,
  globalRelay,
  globalTofuAllowed,
  invite,
  keyStatus,
  LEGACY_GLOBAL_RELAY_URLS,
  listOp,
  lookupKey,
  mailStatus,
  postMail,
  register,
  relayInfo,
  setUnlisted,
  streamMail,
  verifyCode,
  wellKnown,
  type Authority,
  type Identity,
  type TxtLookup
} from './relay-client';
import { addressUsable, assertAddressAllowed, interStemPolicy, PolicyError, type InterStemPolicy } from './policy';
import { interStemStore, type InterStemState, type InterStemStore, type StoredContact } from './store';

/** What the service needs from the mail store — swappable so tests can run two Stems in one process. */
export interface InterStemMailPort {
  createConversation: typeof createConversation;
  appendMailItem: typeof appendMailItem;
  findExternalConversation: typeof findExternalConversation;
  hasExternalEnvelope: typeof hasExternalEnvelope;
  setExternalStatus: typeof setExternalStatus;
  readMail: typeof readMail;
}

const defaultMail: InterStemMailPort = {
  createConversation,
  appendMailItem,
  findExternalConversation,
  hasExternalEnvelope,
  setExternalStatus,
  readMail
};

/** The sealed inner mail, version 1. Stems agree on this; relays never see it. */
interface InnerV1 {
  v: 1;
  kind: 'mail';
  thread: string;
  subject?: string;
  body: string;
  sentAt: number;
  /** Files, sealed with the mail (older Stems ignore the field and show the text). */
  attachments?: { name: string; mime: string; data: string }[];
}

/** An outbox entry's files, by mail-file id: read and sealed in only when it goes out. */
interface OutboxFiles {
  files?: { fileId: string; name: string; mime: string }[];
}

const INNER_MAX_BODY = 1_000_000;
/** Inbound files: a little over what we send (MAIL_FILES_MAX_BYTES), and never more than the relay carries. */
const INNER_MAX_FILE_BYTES = 20 * 1024 * 1024;
const OUTBOX_RETRY_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];
const OUTBOX_GIVE_UP_MS = 7 * 86_400_000;
const CERT_REFRESH_BEFORE_MS = 2 * 3_600_000;
const STATUS_WINDOW_MS = 8 * 86_400_000;
/** How long a mail to someone not on Stem waits for them to join, and how often we look. */
const WAIT_FOR_JOIN_MS = 30 * 86_400_000;
const WAIT_CHECK_MS = 6 * 3_600_000;
/** A compose-time reachability answer is reused this long (lookups are rate-limited). */
const LOOKUP_CACHE_MS = 10 * 60_000;
const CONTACT_NAME_MAX = 80;

export interface InterStemOptions {
  store?: InterStemStore;
  mail?: InterStemMailPort;
  /** DNS TXT lookup (tests inject one). */
  txt?: TxtLookup;
  /** Called after anything the UI shows changed (status, contacts). */
  onChange?: () => void;
  now?: () => number;
  /** The organization's policy (policy.ts); tests inject one. */
  policy?: () => InterStemPolicy;
  /** A mail from another person was filed (desktop notification, phone push). */
  onMail?: (mail: { conversationId: string; itemId: string; from: string; name?: string; subject?: string }) => void;
  /**
   * A contact the user verified and set to auto-draft wrote: release their mail
   * and have this persona draft a reply. Sending still waits for the user.
   */
  onAutoDraft?: (conversationId: string, itemId: string, personaId: string | undefined) => void;
  /** Someone the user wrote to before they were on Stem is reachable now. */
  onJoined?: (mail: { conversationId: string; itemId: string; address: string }) => void;
}

export class InterStemService {
  private store: InterStemStore;
  private mail: InterStemMailPort;
  private resolver: AuthorityResolver;
  private onChange: () => void;
  private now: () => number;
  private policy: () => InterStemPolicy;
  private streams = new Map<string, AbortController>();
  private connected = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private outboxRunning = false;
  private waitingRunning = false;
  private stopped = false;
  private lookups = new Map<string, { at: number; reach: InterStemReach }>();
  private onMail: NonNullable<InterStemOptions['onMail']>;
  private onAutoDraft: NonNullable<InterStemOptions['onAutoDraft']>;
  private onJoined: NonNullable<InterStemOptions['onJoined']>;

  constructor(opts: InterStemOptions = {}) {
    this.store = opts.store ?? interStemStore();
    this.mail = opts.mail ?? defaultMail;
    this.onChange = opts.onChange ?? (() => undefined);
    this.now = opts.now ?? Date.now;
    this.policy = opts.policy ?? interStemPolicy;
    this.onMail = opts.onMail ?? (() => undefined);
    this.onAutoDraft = opts.onAutoDraft ?? (() => undefined);
    this.onJoined = opts.onJoined ?? (() => undefined);
    this.resolver = new AuthorityResolver(() => this.globalAuthority(), opts.txt, undefined, this.policy);
  }

  /**
   * Verified addresses the policy still allows. One verified before a lockdown
   * (on the global relay, or outside the allowed domains) stays in the store
   * but is never connected, refreshed or sent from.
   */
  private live(state: InterStemState): InterStemState['addresses'] {
    const policy = this.policy();
    return state.addresses.filter((a) => a.state === 'verified' && addressUsable(policy, a.address, a.relay, globalRelay().url));
  }

  // ---- lifecycle ----

  /** Connect to every verified address's relay and start the timers. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.moveOffLegacyGlobalRelay();
    await this.connectAll();
    this.timers.push(
      setInterval(() => void this.processOutbox(), 30_000),
      setInterval(() => void this.refreshCerts(), 30 * 60_000),
      setInterval(() => void this.pollStatuses(), 5 * 60_000),
      setInterval(() => void this.checkWaiting(), 30 * 60_000)
    );
    for (const t of this.timers) t.unref?.();
    void this.processOutbox();
    void this.checkWaiting();
  }

  /**
   * The global relay was renamed. Addresses verified under an old name move to
   * the current one and drop their certificate: its issuer names the old URL,
   * which peers no longer accept as the authority. The relay is the same, so
   * the binding holds and refreshCerts fetches a new certificate.
   */
  private async moveOffLegacyGlobalRelay(): Promise<void> {
    if (process.env.STEM_GLOBAL_RELAY_URL) return;
    const url = globalRelay().url;
    const stale = (relay: string) => relay !== url && LEGACY_GLOBAL_RELAY_URLS.includes(relay);
    if (!(await this.store.read()).addresses.some((a) => stale(a.relay))) return;
    await this.store.update((s) => {
      for (const a of s.addresses) {
        if (!stale(a.relay)) continue;
        a.relay = url;
        delete a.cert;
      }
    });
    await this.refreshCerts();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const c of this.streams.values()) c.abort();
    this.streams.clear();
    this.connected.clear();
  }

  // ---- authority ----

  private async globalAuthority(): Promise<Authority> {
    const g = globalRelay();
    if (Object.keys(g.keys).length) {
      return { relay: g.url, keys: Object.fromEntries(Object.entries(g.keys).map(([k, v]) => [k, unb64(v)])) };
    }
    // No keys shipped (development, or before the global relay is deployed):
    // trust the relay's /.well-known once and pin what it said — but only when
    // the operator pointed this Stem at a relay explicitly. A build that only
    // knows the default URL must ship its keys: a first fetch an attacker
    // could answer would let them certify every address on the global relay.
    if (!globalTofuAllowed()) throw new Error('The global relay is not available in this build yet.');
    const state = await this.store.read();
    let pinned = state.relayKeys[g.url];
    if (!pinned || !Object.keys(pinned).length) {
      const wk = await wellKnown(g.url);
      pinned = Object.fromEntries(wk.keys.map((k) => [k.kid, k.pub]));
      await this.store.update((s) => {
        s.relayKeys[g.url] = pinned!;
      });
    }
    return { relay: g.url, keys: Object.fromEntries(Object.entries(pinned).map(([k, v]) => [k, unb64(v)])) };
  }

  // ---- identity and addresses ----

  private identity(state: InterStemState, address?: string): Identity {
    const cert = address ? state.addresses.find((a) => a.address === address)?.cert : undefined;
    return { seed: state.identitySeed, ...(cert ? { cert } : {}) };
  }

  async status(): Promise<InterStemStatus> {
    const s = await this.store.read();
    const policy = this.policy();
    const live = this.live(s);
    return {
      addresses: s.addresses
        .filter((a) => addressUsable(policy, a.address, a.relay, globalRelay().url))
        .map(({ address, state, relay }) => ({ address, state, relay })),
      unlisted: s.unlisted,
      fingerprint: fingerprint(rawPublic(edPrivate(s.identitySeed))),
      connected: live.length > 0 && [...new Set(live.map((a) => a.relay))].every((r) => this.connected.has(r)),
      ...(policy.mode === 'open'
        ? {}
        : { policy: policy.mode === 'off' ? { mode: 'off' } : { mode: 'restricted', domains: policy.domains } }),
      contacts: Object.values(s.contacts).map(
        ({ address, state, keyFp, verifiedByUser, keyChanged, firstSeen, name, autoDraft, draftPersona }) => ({
          address,
          state,
          keyFp,
          firstSeen,
          ...(verifiedByUser ? { verifiedByUser } : {}),
          ...(keyChanged ? { keyChanged } : {}),
          ...(name ? { name } : {}),
          ...(autoDraft && verifiedByUser ? { autoDraft } : {}),
          ...(draftPersona ? { draftPersona } : {})
        })
      )
    };
  }

  /** Ask the address's relay to email a code. */
  async addAddress(raw: string): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    if (!validAddress(address)) throw new Error('That is not an email address.');
    const { relay } = await this.resolver.authority(address);
    const state = await this.store.read();
    const info = await relayInfo(relay);
    const keyB64 = b64(rawPublic(edPrivate(state.identitySeed)));
    const nonce = await solvePowAsync(address, keyB64, info.limits.powBits ?? 0);
    const blob = JSON.stringify(makeKeyBlob(state.identitySeed, state.encPriv));
    await register(relay, this.identity(state), address, blob, nonce);
    await this.store.update((s) => {
      const existing = s.addresses.find((a) => a.address === address);
      if (existing) {
        // A new relay (an organization policy moved it) means a fresh verification there.
        if (existing.state !== 'verified' || existing.relay !== relay) {
          existing.state = 'pending';
          delete existing.cert;
        }
        existing.relay = relay;
      } else {
        s.addresses.push({ address, state: 'pending', relay, addedAt: this.now() });
      }
    });
    this.onChange();
    return this.status();
  }

  async verifyAddress(raw: string, code: string): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    const state = await this.store.read();
    const entry = state.addresses.find((a) => a.address === address);
    if (!entry) throw new Error('Add the address first.');
    this.assertUsable(entry);
    let cert: Cert;
    try {
      cert = await verifyCode(entry.relay, this.identity(state), address, code.trim());
    } catch (err) {
      if (err instanceof RelayError && err.code === 'invalid_code')
        throw new Error('That code is not right, or it expired.', { cause: err });
      throw err;
    }
    await this.store.update((s) => {
      const e = s.addresses.find((a) => a.address === address);
      if (e) Object.assign(e, { state: 'verified', cert });
    });
    if (state.unlisted)
      await setUnlisted(entry.relay, this.identity(state), true).catch((e) =>
        degrade('interstem', 'could not set unlisted on a new relay', e)
      );
    await this.connectAll();
    this.onChange();
    return this.status();
  }

  /**
   * The user confirmed through the email link instead of typing the code:
   * the relay already bound the address, so fetching a certificate succeeds.
   */
  async checkLinkVerified(raw: string): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    const state = await this.store.read();
    const entry = state.addresses.find((a) => a.address === address);
    if (!entry) throw new Error('Add the address first.');
    this.assertUsable(entry);
    const cert = await fetchCert(entry.relay, this.identity(state), address);
    await this.store.update((s) => {
      const e = s.addresses.find((a) => a.address === address);
      if (e) Object.assign(e, { state: 'verified', cert });
    });
    await this.connectAll();
    this.onChange();
    return this.status();
  }

  async removeAddress(raw: string): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    await this.store.update((s) => {
      s.addresses = s.addresses.filter((a) => a.address !== address);
    });
    await this.connectAll();
    this.onChange();
    return this.status();
  }

  async setUnlisted(unlisted: boolean): Promise<InterStemStatus> {
    const state = await this.store.read();
    for (const relay of new Set(this.live(state).map((a) => a.relay))) {
      await setUnlisted(relay, this.identity(state), unlisted);
    }
    await this.store.update((s) => {
      s.unlisted = unlisted;
    });
    this.onChange();
    return this.status();
  }

  /** Our verified address to send from when the user has several: the first. */
  async defaultSelf(): Promise<string | null> {
    const s = await this.store.read();
    return this.live(s)[0]?.address ?? null;
  }

  /**
   * Who signs a public share upload: the default verified address with a
   * fresh certificate. Shares live on the global relay, so any policy other
   * than "open" (which promises the global relay is never contacted) turns
   * sharing off.
   */
  async shareIdentity(): Promise<{ relay: string; address: string; identity: Identity }> {
    if (this.policy().mode !== 'open') {
      throw new ShareUnavailableError('policy', 'Your organization has turned off sharing outside the company.');
    }
    const address = await this.defaultSelf();
    if (!address) {
      throw new ShareUnavailableError(
        'no_address',
        'Sharing needs a verified address. Add one in Settings → Features → Your email address.'
      );
    }
    if (await this.closedDomain(address)) throw new ShareUnavailableError('policy', CLOSED_DOMAIN_SHARE);
    return { relay: globalRelay().url, address, identity: await this.freshCert(address) };
  }

  /**
   * Whether the address's domain publishes `access=closed` in its `_stem`
   * record: its people talk only on the company relay, so the global relay
   * refuses their share uploads (closed_relay) and we don't offer sharing.
   */
  async closedDomain(address: string): Promise<boolean> {
    const rec = await this.resolver.domainRecord(domainOf(address));
    return rec?.closed === true;
  }

  private async refreshCerts(force = false): Promise<void> {
    const state = await this.store.read();
    for (const a of this.live(state)) {
      if (!force && a.cert && a.cert.exp - this.now() > CERT_REFRESH_BEFORE_MS) continue;
      try {
        const cert = await fetchCert(a.relay, this.identity(state), a.address);
        await this.store.update((s) => {
          const e = s.addresses.find((x) => x.address === a.address);
          if (e) e.cert = cert;
        });
      } catch (err) {
        if (err instanceof RelayError && (err.code === 'not_your_address' || err.code === 'not_registered')) {
          // Another device verified this address since: this key no longer holds it.
          await this.store.update((s) => {
            const e = s.addresses.find((x) => x.address === a.address);
            if (e) e.state = 'pending';
            delete e?.cert;
          });
          degrade('interstem', `lost ${a.address}: another device holds it now`, err);
          this.onChange();
        } else {
          degrade('interstem', 'could not refresh a sender certificate', err);
        }
      }
    }
  }

  private async freshCert(address: string): Promise<Identity> {
    let state = await this.store.read();
    const entry = state.addresses.find((a) => a.address === address && a.state === 'verified');
    if (!entry) throw new Error(`${address} is not verified on this Stem.`);
    this.assertUsable(entry);
    if (!entry.cert || entry.cert.exp - this.now() < CERT_REFRESH_BEFORE_MS) {
      await this.refreshCerts(true);
      state = await this.store.read();
    }
    const id = this.identity(state, address);
    if (!id.cert) throw new Error(`No certificate for ${address}.`);
    return id;
  }

  private assertUsable(entry: { address: string; relay: string }): void {
    const policy = this.policy();
    if (addressUsable(policy, entry.address, entry.relay, globalRelay().url)) return;
    assertAddressAllowed(policy, entry.address);
    throw new PolicyError(`Your organization only allows ${entry.address} on its own relay. Add it again to move it there.`);
  }

  // ---- inbound ----

  private async connectAll(): Promise<void> {
    if (this.stopped) return;
    const state = await this.store.read();
    const relays = new Set(this.live(state).map((a) => a.relay));
    for (const [relay, ctl] of this.streams) {
      if (!relays.has(relay)) {
        ctl.abort();
        this.streams.delete(relay);
        this.connected.delete(relay);
      }
    }
    for (const relay of relays) if (!this.streams.has(relay)) this.connect(relay);
  }

  private connect(relay: string): void {
    const ctl = new AbortController();
    this.streams.set(relay, ctl);
    void (async () => {
      let backoff = 1_000;
      while (!ctl.signal.aborted && !this.stopped) {
        try {
          const state = await this.store.read();
          // Connected (and the backoff forgiven) only once the relay accepted the
          // stream: resetting before the attempt kept a down relay on a 1 s retry.
          await streamMail(relay, this.identity(state), (env) => this.receive(relay, env), ctl.signal, () => {
            this.connected.add(relay);
            this.onChange();
            backoff = 1_000;
          });
        } catch (err) {
          if (ctl.signal.aborted) break;
          degrade('interstem', `relay stream to ${relay} dropped`, err);
        }
        if (this.connected.delete(relay)) this.onChange();
        if (ctl.signal.aborted || this.stopped) break;
        await new Promise((r) => setTimeout(r, backoff).unref?.());
        backoff = Math.min(backoff * 2, 60_000);
      }
    })();
  }

  /** One envelope from the relay: verify it ourselves, file it held, ack it. */
  async receive(relay: string, env: Envelope): Promise<void> {
    const state = await this.store.read();
    const id = this.identity(state);
    const ours = this.live(state).find((a) => a.address === env.to);
    const done = () => ack(relay, id, [env.id]);
    if (!ours) {
      // Mail for an address this key no longer holds: not ours to read.
      log('interstem', 'acked mail for an address this Stem does not hold', { to: env.to });
      return done();
    }
    if (await this.mail.hasExternalEnvelope(env.id)) return done();
    const checked = await verifyEnvelope(env, this.now(), this.resolver.issuerKeys());
    if ('error' in checked) {
      degrade('interstem', `dropped mail from ${env.from}: ${checked.error}`, new Error(checked.error));
      return done();
    }
    // The certificate was checked as of the envelope's own timestamp (held
    // mail arrives late). Once it has expired that timestamp is only the
    // sender's word, so ask their home relay whether the key is still theirs:
    // a stolen, replaced key can't backdate mail past its replacement.
    if (this.now() >= env.cert.exp) {
      const stillTheirs = await keyStatus(env.cert.issuer, env.from, env.cert.keyFp).catch((e) => {
        degrade('interstem', 'could not check a late envelope’s key with its home relay', e);
        return null;
      });
      if (stillTheirs === false) {
        degrade('interstem', `dropped late mail from ${env.from}: that key is no longer theirs`, new Error('stale key'));
        return done();
      }
      // Can't confirm it: fail closed. Not acked, so the relay keeps it and
      // offers it again on the next connection (for as long as it holds mail).
      if (stillTheirs === null) return;
    }
    const contact = state.contacts[env.from];
    if (contact?.state === 'blocked') return done();

    let inner: InnerV1 | null = null;
    let unsupported = false;
    try {
      const plain = open(state.encPriv, checked.sealed, env.id, env.from, env.to);
      const parsed = JSON.parse(plain.toString('utf8')) as Partial<InnerV1> & { v?: number };
      if (
        parsed.v === 1 &&
        parsed.kind === 'mail' &&
        typeof parsed.body === 'string' &&
        /^[0-9a-f]{32}$/.test(parsed.thread ?? '')
      ) {
        const files = Array.isArray(parsed.attachments)
          ? parsed.attachments
              .filter((a) => a && typeof a.name === 'string' && typeof a.data === 'string')
              .slice(0, MAIL_FILES_MAX_COUNT)
              .map((a) => ({ name: a.name, mime: typeof a.mime === 'string' ? a.mime : 'application/octet-stream', data: a.data }))
          : [];
        inner = {
          v: 1,
          kind: 'mail',
          thread: parsed.thread!,
          body: parsed.body.slice(0, INNER_MAX_BODY),
          sentAt: typeof parsed.sentAt === 'number' ? parsed.sentAt : env.ts,
          ...(typeof parsed.subject === 'string' ? { subject: parsed.subject.slice(0, 300) } : {}),
          ...(files.length ? { attachments: files } : {})
        };
      } else {
        unsupported = true;
      }
    } catch (err) {
      degrade('interstem', `could not open mail from ${env.from}`, err);
      return done();
    }

    const signer = b64(checked.signer);
    const keyFp = fingerprint(checked.signer);
    let keyChanged = false;
    await this.store.update((s) => {
      const c = s.contacts[env.from];
      if (!c) {
        s.contacts[env.from] = { address: env.from, state: 'request', authKey: signer, keyFp, firstSeen: this.now() };
      } else if (!c.authKey) {
        // A contact made before we ever saw their key (blocked or accepted by
        // address): this is their first key, not a changed one. Nobody has
        // checked it in person.
        c.authKey = signer;
        c.keyFp = keyFp;
        delete c.verifiedByUser;
        delete c.autoDraft;
      } else if (c.authKey !== signer) {
        keyChanged = true;
        c.keyChanged = true;
        c.pendingAuthKey = signer;
        delete c.pendingEncKey;
        delete c.autoDraft; // back on only after the user checks the new key
      }
    });

    const thread = inner?.thread ?? newId();
    let conversation: MailConversation | null = await this.mail.findExternalConversation(thread, env.from, env.to);
    const body = inner?.body ?? 'This mail was sent by a newer version of Stem. Update Stem to read it.';
    if (!conversation) {
      conversation = await this.mail.createConversation(inner?.subject ?? '', [], body, {
        external: { address: env.from, thread, self: env.to }
      });
    }
    const external: MailExternal = {
      envelopeId: env.id,
      held: true,
      ...(keyChanged ? { keyChanged: true } : {}),
      ...(unsupported ? { unsupported: true } : {})
    };
    const attachments = inner?.attachments?.length ? await this.fileAttachments(inner.attachments) : [];
    const filed = await this.mail.appendMailItem({
      conversationId: conversation.id,
      from: env.from,
      to: ['user'],
      body,
      ...(inner?.subject ? { subject: inner.subject } : {}),
      ...(attachments.length ? { attachments } : {}),
      external
    });
    await done();
    this.onChange();
    const itemId = filed.items.find((i) => i.external?.envelopeId === env.id)?.id;
    if (!itemId) return;
    const after = (await this.store.read()).contacts[env.from];
    this.onMail({
      conversationId: conversation.id,
      itemId,
      from: env.from,
      ...(after?.name ? { name: after.name } : {}),
      ...(conversation.subject || inner?.subject ? { subject: inner?.subject || conversation.subject } : {})
    });
    // Auto-draft only for someone the user checked in person, whose key is the
    // one they checked, in a format we understand.
    if (
      after?.state === 'accepted' &&
      after.verifiedByUser &&
      after.autoDraft &&
      !after.keyChanged &&
      !keyChanged &&
      !unsupported
    ) {
      this.onAutoDraft(conversation.id, itemId, after.draftPersona);
    }
  }

  /**
   * Keep a received mail's files in the mail-file store; past the cap the rest
   * are named, not kept. The bytes are someone else's and arrive before the
   * user has looked: sizes are checked before decoding, and nothing is run
   * through an image converter — a picture gets a thumbnail only when it is a
   * format the viewer shows as it is (inboundPreview).
   */
  private async fileAttachments(files: NonNullable<InnerV1['attachments']>): Promise<MessageAttachment[]> {
    const out: MessageAttachment[] = [];
    let total = 0;
    for (const f of files) {
      total += Math.floor((f.data.length * 3) / 4);
      if (total > INNER_MAX_FILE_BYTES) {
        out.push({ kind: 'file', name: `${f.name} (too large, not kept)` });
        continue;
      }
      try {
        const bytes = Buffer.from(f.data, 'base64');
        const stored = await putMailFile(bytes, f.name, f.mime);
        out.push(inboundPreview(stored, bytes));
      } catch (err) {
        degrade('interstem', 'could not keep a received file', err);
        out.push({ kind: 'file', name: `${f.name} (could not be kept)` });
      }
    }
    return out;
  }

  // ---- contacts ----

  private async ownRelays(): Promise<{ relay: string; id: Identity }[]> {
    const state = await this.store.read();
    return [...new Set(this.live(state).map((a) => a.relay))].map((relay) => ({
      relay,
      id: this.identity(state)
    }));
  }

  /** Accept a Request (or anyone we mailed): they may reach us and see delivery. */
  async acceptContact(raw: string): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    for (const { relay, id } of await this.ownRelays()) await listOp(relay, id, 'allow', address);
    await this.store.update((s) => {
      const c = s.contacts[address];
      if (c) c.state = 'accepted';
    });
    this.onChange();
    return this.status();
  }

  async blockContact(raw: string): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    for (const { relay, id } of await this.ownRelays()) {
      await listOp(relay, id, 'unallow', address).catch((e) =>
        degrade('interstem', 'could not unallow a blocked contact', e)
      );
      await listOp(relay, id, 'block', address);
    }
    await this.store.update((s) => {
      const c = s.contacts[address];
      if (c) c.state = 'blocked';
      else s.contacts[address] = { address, state: 'blocked', authKey: '', keyFp: '', firstSeen: this.now() };
    });
    this.onChange();
    return this.status();
  }

  async unblockContact(raw: string): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    for (const { relay, id } of await this.ownRelays()) await listOp(relay, id, 'unblock', address);
    await this.store.update((s) => {
      const c = s.contacts[address];
      if (c) c.state = 'request';
    });
    this.onChange();
    return this.status();
  }

  /** The user compared fingerprints in person. */
  async markVerified(raw: string, verified: boolean): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    const out = await this.store.update((s) => {
      const c = s.contacts[address];
      if (!c) return false;
      // There is nothing to have compared before a key is pinned: a later first
      // key would inherit the check (and with it auto-draft) unseen.
      if (verified && !c.authKey) return 'nokey' as const;
      c.verifiedByUser = verified || undefined;
      if (!verified) {
        delete c.verifiedByUser;
        delete c.autoDraft; // auto-draft rests on the in-person check
      }
    });
    if (out === 'nokey') throw new Error('There is no key to check yet: they haven’t written, and you haven’t written to them.');
    this.onChange();
    return this.status();
  }

  /** Adopt a contact's new key after the user saw the change notice. */
  async acknowledgeKeyChange(raw: string): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    await this.store.update((s) => {
      const c = s.contacts[address];
      if (!c?.keyChanged) return false;
      if (c.pendingAuthKey) {
        c.authKey = c.pendingAuthKey;
        c.keyFp = fingerprint(unb64(c.pendingAuthKey));
      }
      c.encKey = c.pendingEncKey;
      if (!c.encKey) delete c.encKey;
      delete c.pendingAuthKey;
      delete c.pendingEncKey;
      delete c.keyChanged;
      delete c.verifiedByUser; // a new key is a new person until checked again
      delete c.autoDraft;
    });
    // Sends that stopped on the change go out now, to the adopted key.
    const { items } = await this.mail.readMail();
    for (const item of items) {
      if (item.external?.status === 'key-changed' && item.to.includes(address))
        await this.send(item.conversationId, item.id);
    }
    this.onChange();
    return this.status();
  }

  /**
   * The user's own settings for a contact: a name, and auto-draft (only for a
   * contact they verified in person).
   */
  async setContact(raw: string, patch: { name?: string | null; autoDraft?: boolean }): Promise<InterStemStatus> {
    const address = normalizeAddress(raw);
    if (!validAddress(address)) throw new Error('That is not an email address.');
    const out = await this.store.update((s) => {
      const c = s.contacts[address];
      if (!c) return 'unknown' as const;
      if (patch.name !== undefined) {
        const name = (patch.name ?? '').replace(/\s+/g, ' ').trim().slice(0, CONTACT_NAME_MAX);
        if (name) c.name = name;
        else delete c.name;
      }
      if (patch.autoDraft !== undefined) {
        if (patch.autoDraft && !c.verifiedByUser) return 'unverified' as const;
        if (patch.autoDraft) c.autoDraft = true;
        else delete c.autoDraft;
      }
      return 'ok' as const;
    });
    if (out === 'unknown') throw new Error('Write to them first: they become a contact once you have.');
    if (out === 'unverified') throw new Error('Check their key with them first (Verify), then turn on automatic drafts.');
    this.onChange();
    return this.status();
  }

  /** Remember which persona drafted for a contact: the default next time. */
  async recordDraftPersona(raw: string, personaId: string): Promise<void> {
    const address = normalizeAddress(raw);
    await this.store.update((s) => {
      const c = s.contacts[address];
      if (!c || c.draftPersona === personaId) return false;
      c.draftPersona = personaId;
    });
    this.onChange();
  }

  /**
   * Can this address be mailed? Asked while the user writes, so the answer is
   * cached for a while: lookups are rate-limited on the relay.
   */
  async lookup(raw: string): Promise<InterStemReach> {
    const address = normalizeAddress(raw);
    if (!validAddress(address)) return { state: 'unreachable' };
    const state = await this.store.read();
    if (state.addresses.some((a) => a.address === address)) return { state: 'self' };
    const contact = state.contacts[address];
    if (contact?.state === 'blocked') return { state: 'blocked' };
    try {
      assertAddressAllowed(this.policy(), address);
    } catch (err) {
      if (err instanceof PolicyError) return { state: 'refused', reason: err.message };
      throw err;
    }
    // Someone we have a key for is reachable without asking the relay.
    if (contact?.encKey && !contact.keyChanged) return { state: 'reachable' };
    const cached = this.lookups.get(address);
    if (cached && this.now() - cached.at < LOOKUP_CACHE_MS) return cached.reach;
    const self = await this.defaultSelf();
    if (!self) throw new Error('Verify one of your addresses first.');
    const id = await this.freshCert(self);
    const { relay } = await this.resolver.authority(address);
    const found = await lookupKey(relay, id, address);
    const reach: InterStemReach = { state: found ? 'reachable' : 'unreachable' };
    this.lookups.set(address, { at: this.now(), reach });
    return reach;
  }

  /** Ask their relay to invite an address that isn't reachable. Always "ok". */
  async invite(raw: string, from?: string): Promise<void> {
    const address = normalizeAddress(raw);
    const self = from ?? (await this.defaultSelf());
    if (!self) throw new Error('Verify one of your addresses first.');
    const { relay } = await this.resolver.authority(address);
    await invite(relay, await this.freshCert(self), address);
  }

  // ---- outbound ----

  /** Queue the user's item for sending; progress lands on the item. */
  async send(conversationId: string, itemId: string): Promise<void> {
    const { conversations, items } = await this.mail.readMail();
    const conversation = conversations.find((c) => c.id === conversationId);
    const item = items.find((i) => i.id === itemId);
    if (!conversation?.external || !item) return;
    const { address, thread, self } = conversation.external;
    try {
      assertAddressAllowed(this.policy(), address);
    } catch (err) {
      if (!(err instanceof PolicyError)) throw err;
      await this.mail.setExternalStatus(itemId, { status: 'failed', error: err.message });
      this.onChange();
      return;
    }
    const files = (item.attachments ?? []).flatMap((a) =>
      a.fileId ? [{ fileId: a.fileId, name: a.name ?? 'file', mime: a.mime ?? 'application/octet-stream' }] : []
    );
    const inner: InnerV1 & OutboxFiles = {
      v: 1,
      kind: 'mail',
      thread,
      body: item.body,
      sentAt: item.at,
      ...(conversation.subject ? { subject: conversation.subject } : {}),
      ...(files.length ? { files } : {})
    };
    await this.store.update((s) => {
      s.outbox = s.outbox.filter((o) => o.mailItemId !== itemId);
      s.waiting = s.waiting.filter((w) => w.mailItemId !== itemId);
      s.outbox.push({
        id: newId(),
        mailItemId: itemId,
        conversationId,
        from: self,
        to: address,
        inner: JSON.stringify(inner),
        tries: 0,
        nextAt: 0,
        createdAt: this.now()
      });
    });
    await this.mail.setExternalStatus(itemId, { status: 'queued', error: undefined });
    await this.processOutbox();
  }

  /**
   * The user sends one of their mails again: one that waited for its
   * recipient to join Stem, or one that failed. A mail that went out is not
   * resent (it would arrive twice).
   */
  async resend(conversationId: string, itemId: string): Promise<void> {
    const { items } = await this.mail.readMail();
    const item = items.find((i) => i.id === itemId && i.conversationId === conversationId);
    if (!item || item.from !== 'user' || !item.external) throw new Error('That mail is not yours to send.');
    const status = item.external.status;
    if (status === 'queued' || status === 'sent' || status === 'delivered') throw new Error('That mail is already on its way.');
    this.lookups.clear();
    await this.send(conversationId, itemId);
  }

  /**
   * Mail waiting for someone to join Stem: look them up now and then. Once
   * they are reachable the item says so and the user sends it (the design's
   * "offered for sending"): weeks may have passed, so it is never sent blind.
   */
  async checkWaiting(): Promise<void> {
    if (this.waitingRunning) return;
    this.waitingRunning = true;
    try {
      const state = await this.store.read();
      const now = this.now();
      const expired = state.waiting.filter((w) => now - w.since > WAIT_FOR_JOIN_MS);
      for (const w of expired) {
        await this.mail.setExternalStatus(w.mailItemId, {
          status: 'unreachable',
          error: `${w.to} didn't join Stem within 30 days. Send it again if you still want to.`
        });
      }
      const due = state.waiting.filter((w) => now - w.since <= WAIT_FOR_JOIN_MS && now - w.checkedAt >= WAIT_CHECK_MS);
      const joined = new Set<string>();
      const checked = new Set<string>();
      for (const to of new Set(due.map((w) => w.to))) {
        const w = due.find((x) => x.to === to)!;
        try {
          const id = await this.freshCert(w.from);
          const { relay } = await this.resolver.authority(to);
          if (await lookupKey(relay, id, to)) joined.add(to);
          checked.add(to);
        } catch (err) {
          degrade('interstem', `could not look ${to} up again`, err);
        }
      }
      for (const w of due.filter((x) => joined.has(x.to))) {
        await this.mail.setExternalStatus(w.mailItemId, { status: 'joined', error: undefined });
        this.onJoined({ conversationId: w.conversationId, itemId: w.mailItemId, address: w.to });
      }
      if (!expired.length && !checked.size) return;
      await this.store.update((s) => {
        s.waiting = s.waiting
          .filter((w) => now - w.since <= WAIT_FOR_JOIN_MS && !joined.has(w.to))
          .map((w) => (checked.has(w.to) ? { ...w, checkedAt: now } : w));
      });
      this.onChange();
    } finally {
      this.waitingRunning = false;
    }
  }

  /** Send everything due. One pass at a time. */
  async processOutbox(): Promise<void> {
    if (this.outboxRunning) return;
    this.outboxRunning = true;
    try {
      const state = await this.store.read();
      for (const entry of state.outbox.filter((o) => o.nextAt <= this.now())) {
        // quiet: a thrown send is retried below, and the retry path degrades with the error.
        const outcome = await this.sendOne(entry).catch(async (err: unknown) => {
          // A policy refusal won't change by retrying: fail the item now.
          if (!(err instanceof PolicyError)) return { retry: true as const, error: err };
          await this.mail.setExternalStatus(entry.mailItemId, { status: 'failed', error: err.message });
          return { done: true as const };
        });
        if ('done' in outcome) {
          await this.store.update((s) => {
            s.outbox = s.outbox.filter((o) => o.id !== entry.id);
          });
          continue;
        }
        const giveUp = this.now() - (entry.createdAt ?? this.now()) > OUTBOX_GIVE_UP_MS;
        if (giveUp) {
          await this.mail.setExternalStatus(entry.mailItemId, {
            status: 'failed',
            error: 'Could not reach their relay for a week.'
          });
          await this.store.update((s) => {
            s.outbox = s.outbox.filter((o) => o.id !== entry.id);
          });
          continue;
        }
        degrade('interstem', `send to ${entry.to} will be retried`, outcome.error);
        await this.store.update((s) => {
          const o = s.outbox.find((x) => x.id === entry.id);
          if (o) {
            o.tries += 1;
            o.nextAt = this.now() + OUTBOX_RETRY_MS[Math.min(o.tries - 1, OUTBOX_RETRY_MS.length - 1)];
          }
        });
      }
    } finally {
      this.outboxRunning = false;
    }
  }

  private async recipientKey(
    to: string,
    id: Identity,
    relay: string
  ): Promise<{ enc: Buffer } | { status: 'unreachable' | 'key-changed' }> {
    const state = await this.store.read();
    const contact: StoredContact | undefined = state.contacts[to];
    if (contact?.keyChanged) return { status: 'key-changed' };
    const found = await lookupKey(relay, id, to);
    if (!found) return { status: 'unreachable' };
    const keys = checkKeyBlob(found.authKey, found.keyBlob);
    if (!keys) throw new Error(`${to}'s relay returned a key that does not check out.`);
    if (contact && contact.authKey && contact.authKey !== found.authKey) {
      await this.store.update((s) => {
        const c = s.contacts[to];
        if (!c) return;
        c.keyChanged = true;
        c.pendingAuthKey = found.authKey;
        c.pendingEncKey = b64(keys.encPub);
        delete c.autoDraft;
      });
      this.onChange();
      return { status: 'key-changed' };
    }
    await this.store.update((s) => {
      const c = s.contacts[to];
      if (c) {
        c.encKey = b64(keys.encPub);
        if (!c.authKey) {
          c.authKey = found.authKey;
          c.keyFp = fingerprint(keys.sigPub);
          delete c.verifiedByUser;
          delete c.autoDraft;
        }
      } else
        s.contacts[to] = {
          address: to,
          // We wrote to them first: a contact by our own choice.
          state: 'accepted',
          authKey: found.authKey,
          encKey: b64(keys.encPub),
          keyFp: fingerprint(keys.sigPub),
          firstSeen: this.now()
        };
    });
    return { enc: keys.encPub };
  }

  private async sendOne(
    entry: InterStemState['outbox'][number]
  ): Promise<{ done: true } | { retry: true; error: unknown }> {
    const id = await this.freshCert(entry.from);
    const { relay } = await this.resolver.authority(entry.to);
    const key = await this.recipientKey(entry.to, id, relay);
    if ('status' in key) {
      if (key.status === 'unreachable') {
        // Kept here, and looked for now and then (checkWaiting).
        await this.mail.setExternalStatus(entry.mailItemId, {
          status: 'waiting',
          error: `${entry.to} isn't on Stem yet (or only takes mail from people they've written to). Your mail stays here, and Stem tells you when they can be reached.`
        });
        await this.store.update((s) => {
          s.waiting = s.waiting.filter((w) => w.mailItemId !== entry.mailItemId);
          s.waiting.push({
            mailItemId: entry.mailItemId,
            conversationId: entry.conversationId,
            from: entry.from,
            to: entry.to,
            since: this.now(),
            checkedAt: this.now()
          });
        });
      } else {
        await this.mail.setExternalStatus(entry.mailItemId, {
          status: key.status,
          error: `${entry.to}'s key changed. Check it, then send again.`
        });
      }
      this.onChange();
      return { done: true };
    }
    const envelopeId = newId();
    const plain = await this.withFiles(entry.inner);
    const sealed = seal(key.enc, Buffer.from(plain), envelopeId, entry.from, entry.to);
    const env = signEnvelope(
      { v: 1, id: envelopeId, ts: this.now(), from: entry.from, to: entry.to, cert: id.cert!, sealed: b64(sealed) },
      id.seed
    );
    try {
      await postMail(relay, env);
    } catch (err) {
      // quiet: every branch reports — a refusal on the item, a network error through the retry's degrade.
      if (err instanceof RelayError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        const why =
          err.code === 'queue_full'
            ? `${entry.to}'s mailbox on their relay is full.`
            : err.code === 'too_large'
              ? 'The mail is too large for their relay.'
              : err.code === 'closed_relay'
                ? `${entry.to}'s organization doesn't take Stem mail from outside it, or yours doesn't let mail out.`
                : `Their relay refused the mail (${err.code}).`;
        await this.mail.setExternalStatus(entry.mailItemId, { status: 'failed', error: why });
        return { done: true };
      }
      return { retry: true, error: err };
    }
    await this.mail.setExternalStatus(entry.mailItemId, { status: 'sent', envelopeId });
    // We wrote to them: they may reach us, and see what happened to their mail.
    for (const own of await this.ownRelays()) {
      await listOp(own.relay, own.id, 'allow', entry.to).catch((e) =>
        degrade('interstem', 'could not allow a recipient', e)
      );
    }
    await this.store.update((s) => {
      s.sent.push({ envelopeId, mailItemId: entry.mailItemId, from: entry.from, to: entry.to, at: this.now() });
      // Answering a Request accepts it: their next mail lands in the Inbox.
      const c = s.contacts[entry.to];
      if (c?.state === 'request') c.state = 'accepted';
    });
    this.onChange();
    return { done: true };
  }

  /** The sealed payload: the outbox's file references replaced by the files themselves. */
  private async withFiles(innerJson: string): Promise<string> {
    const inner = JSON.parse(innerJson) as InnerV1 & OutboxFiles;
    if (!inner.files?.length) return innerJson;
    const attachments: NonNullable<InnerV1['attachments']> = [];
    for (const f of inner.files) {
      const file = await readMailFile(f.fileId);
      // A file gone from the store can't be sent; the mail says what is missing.
      if (!file) throw new PolicyError(`The file ${f.name} is no longer here, so the mail can't be sent.`);
      attachments.push({ name: file.name, mime: file.mime, data: file.bytes.toString('base64') });
    }
    const rest: InnerV1 & OutboxFiles = { ...inner };
    delete rest.files;
    return JSON.stringify({ ...rest, attachments });
  }

  /** Learn delivery for recent sends (the relay only tells contacts who allowed us). */
  async pollStatuses(): Promise<void> {
    const state = await this.store.read();
    const live = state.sent.filter((e) => this.now() - e.at < STATUS_WINDOW_MS);
    const finished = new Set<string>();
    for (const e of live) {
      try {
        const id = await this.freshCert(e.from);
        const { relay } = await this.resolver.authority(e.to);
        const status = await mailStatus(relay, id, e.envelopeId);
        if (status === 'delivered' || status === 'expired') {
          await this.mail.setExternalStatus(e.mailItemId, { status });
          finished.add(e.envelopeId);
        }
      } catch (err) {
        // Outside the policy now: nothing will ever answer, stop asking.
        if (err instanceof PolicyError) finished.add(e.envelopeId);
        else degrade('interstem', 'could not check a delivery status', err);
      }
    }
    await this.store.update((s) => {
      s.sent = s.sent.filter((e) => !finished.has(e.envelopeId) && this.now() - e.at < STATUS_WINDOW_MS);
    });
  }
}

/** True when a held item must not reach any agent or model. */
export const CLOSED_DOMAIN_SHARE = 'Your organization keeps your address on its own relay, so it can’t publish public links.';

/** Why this Stem can't publish a share link; `code` is for the UI. */
export class ShareUnavailableError extends Error {
  constructor(
    readonly code: 'policy' | 'no_address',
    message: string
  ) {
    super(message);
  }
}

/** Pictures a mail viewer shows straight from their bytes, by their magic numbers. */
const SAFE_IMAGES: Array<{ mime: string; magic: (b: Buffer) => boolean }> = [
  { mime: 'image/png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', magic: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  { mime: 'image/webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' }
];
const INBOUND_PREVIEW_MAX = 2 * 1024 * 1024;

/** A received file as it shows on its mail: a picture of a safe format inline, anything else a named chip. */
function inboundPreview(file: { id: string; name: string; mime: string; size: number }, bytes: Buffer): MessageAttachment {
  const safe = SAFE_IMAGES.find((s) => s.magic(bytes));
  const base: MessageAttachment = { kind: safe ? 'image' : 'file', name: file.name, mime: safe?.mime ?? file.mime, fileId: file.id, size: file.size };
  return safe && bytes.length <= INBOUND_PREVIEW_MAX ? { ...base, dataUrl: `data:${safe.mime};base64,${bytes.toString('base64')}` } : base;
}

export function isHeld(item: Pick<MailItem, 'external'>): boolean {
  return item.external?.held === true;
}

export type { MailListResult };

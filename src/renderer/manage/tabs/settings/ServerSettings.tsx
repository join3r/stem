import { useEffect, useState } from 'react';
import type {
  ClientInfo,
  DevicesSnapshot,
  PairingCodeInfo,
  StateExportReport
} from '../../../../shared/types';
import { InfoTip } from '../../../ui/InfoTip';
import { PairPhoneDialog } from '../../PairPhoneDialog';

/**
 * Settings → Server: where this Stem actually runs, and everything that follows
 * from the answer — what can reach it, and how to pick it up and move it.
 */
export function ServerSettings() {
  return (
    <div>
      <ServerSection />
      <DevicesSection />
    </div>
  );
}

/**
 * Settings → Server: which Stem this app is a window onto.
 *
 * Moving is a restart, and the pane says so instead of pretending. Everything
 * the app has open — the event stream, the list of calls it is allowed to make,
 * every panel already filled in — was built against the connection made at
 * startup, so re-pointing a running app would leave half of it talking to a
 * server that is no longer there.
 *
 * Pairing is the whole act of moving: the address and the credential are stored
 * together, because a key means nothing to a server that never issued it.
 *
 * The how-it-works prose lives in the ⓘ beside each label. What stays inline is
 * what changes: where this app is pointed now, that the address is pinned by the
 * environment, that a restart is owed.
 */
function ServerSection() {
  const [me, setMe] = useState<ClientInfo | null>(null);
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justPaired, setJustPaired] = useState(false);

  useEffect(() => {
    void window.stem
      .clientInfo()
      .then((info) => {
        setMe(info);
        setUrl(info.configuredUrl ?? '');
      })
      .catch(() => undefined);
  }, []);

  async function run(act: () => Promise<ClientInfo>, paired = false) {
    setBusy(true);
    setError(null);
    setJustPaired(false);
    try {
      const info = await act();
      setMe(info);
      setUrl(info.configuredUrl ?? '');
      setCode('');
      setJustPaired(paired);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (!me) return null;
  // Something is waiting for a restart when the address just changed under a
  // running app — either because the pairing happened a moment ago, or because
  // it happened earlier and Settings has been reopened since.
  const moved = !!me.configuredUrl && (justPaired || me.configuredUrl !== me.serverUrl);

  return (
    <>
      <div className="grp-head grp-head-row">
        Server
        <InfoTip label="About the Stem server">
          Your chats, memory and skills live on a server. By default it is this computer — Stem
          starts one for itself and nothing leaves the machine. Point it at a server running
          somewhere else and this app becomes a window onto that one instead.
        </InfoTip>
      </div>
      <div className="formgroup">
        <div className="set-row">
          <span className="set-label">
            <strong>{me.remote ? me.serverUrl : 'This computer'}</strong>
            <em>
              {me.remote ? 'connected to a server elsewhere' : "Stem's own server, started with the app"}
            </em>
          </span>
        </div>

        {me.pinnedByEnv ? (
          <p className="muted">
            The address is fixed for this launch by <code>STEM_SERVER_URL</code>, so it can't be
            changed here.
          </p>
        ) : (
          <>
            {moved && (
              <p className="muted">
                Set to <strong>{me.configuredUrl}</strong>. Restart Stem to connect to it.
              </p>
            )}
            <form
              className="set-block"
              onSubmit={(e) => {
                e.preventDefault();
                void run(() => window.stem.pairWithServer(url.trim(), code.trim()), true);
              }}
            >
              <span className="set-sub">
                Connect to another server{' '}
                <InfoTip label="About connecting to another server">
                  Get the code on the other server — Settings → Server → Devices there, or{' '}
                  <code>stem-server pair</code>. It works once. Stem connects at startup, so the
                  move takes effect when you restart it.
                </InfoTip>
              </span>
              <input
                className="ifield"
                type="text"
                aria-label="Server address"
                value={url}
                placeholder="https://stem.example.com"
                onChange={(e) => setUrl(e.target.value)}
              />
              <input
                className="ifield"
                type="text"
                aria-label="Pairing code"
                value={code}
                placeholder="Code from that server's Settings → Server → Devices"
                onChange={(e) => setCode(e.target.value)}
              />
              <div className="push-row">
                <button type="submit" className="push default" disabled={busy || !url.trim() || !code.trim()}>
                  Connect
                </button>
              </div>
            </form>

            {me.configuredUrl && (
              <div className="set-row">
                <span className="set-label">
                  <strong>Go back to this computer</strong>
                  <em>Forget that server and its key, and run Stem's own again</em>
                </span>
                <button
                  className="link-btn"
                  disabled={busy}
                  onClick={() => void run(() => window.stem.useBuiltInServer())}
                >
                  Use this computer
                </button>
              </div>
            )}
          </>
        )}
        {error && <p className="muted">{error}</p>}

        <ExportBlock remote={me.remote} />
      </div>
    </>
  );
}

/** Bytes as a person reads them. Whole numbers below a gigabyte; nothing smaller than a KB. */
function sizeLabel(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Settings → Server → "Move or back up this Stem": everything Stem knows, in one
 * file you can carry to another machine or keep as a backup. The same file does
 * both, which is why the wording never picks one.
 *
 * The passphrase is asked for here rather than at the other end because that is
 * where the credentials are: the archive's tool credentials are re-wrapped under
 * it on the way out, and the server that receives it is handed the same
 * passphrase as its key file. It never leaves this machine except as the thing it
 * wraps.
 *
 * Everything that did NOT travel is listed afterwards, with a reason. Somebody
 * moving house wants to know what was left behind before they arrive, not when
 * they go looking for it.
 */
function ExportBlock({ remote }: { remote: boolean }) {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<StateExportReport | null>(null);

  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const ready = passphrase.length >= 12 && confirm === passphrase;

  async function run() {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const result = await window.stem.exportState(passphrase);
      if (result) {
        setReport(result);
        setPassphrase('');
        setConfirm('');
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (remote) {
    return (
      <div className="set-block">
        <span className="set-sub">Move or back up this Stem</span>
        <p className="muted">
          Your chats and memory are on the server you're connected to, not on this computer, so
          there is nothing here to write out. Back it up where it runs — <code>stem-server</code>{' '}
          keeps everything in one folder.
        </p>
      </div>
    );
  }

  return (
    <div className="set-block">
      <span className="set-sub">
        Move or back up this Stem{' '}
        <InfoTip label="About moving or backing up this Stem">
          Writes everything Stem knows — chats, memory, skills, your Files, settings and connected
          tools — into a single file. Take it to another computer or a server and import it there,
          or keep it as a backup. Your paired devices and this computer's own settings stay here.
          The passphrase is what unlocks the saved tool credentials wherever the copy ends up, so
          keep it with the copy — without it, every connected tool has to be signed in again. The
          file itself is not encrypted, so treat it the way you'd treat a password manager's export.
        </InfoTip>
      </span>
      <input
        className="ifield"
        type="password"
        aria-label="Passphrase"
        autoComplete="new-password"
        value={passphrase}
        placeholder="Passphrase (at least 12 characters)"
        onChange={(e) => setPassphrase(e.target.value)}
      />
      <input
        className="ifield"
        type="password"
        aria-label="Passphrase again"
        autoComplete="new-password"
        value={confirm}
        placeholder="The same passphrase again"
        onChange={(e) => setConfirm(e.target.value)}
      />
      {mismatch && <p className="muted">The two don't match.</p>}
      <div className="push-row">
        <button type="button" className="push" disabled={busy || !ready} onClick={() => void run()}>
          {busy ? 'Writing…' : 'Export…'}
        </button>
      </div>
      {error && <p className="muted">{error}</p>}
      {report && (
        <>
          <p className="muted">
            Wrote <strong>{sizeLabel(report.bytes)}</strong> to <code>{report.path}</code> —{' '}
            {report.included.map((g) => `${g.name} (${sizeLabel(g.bytes)})`).join(', ')}.
            {report.secrets === 'rewrapped' &&
              ' Your connected tools stay signed in on the other side.'}
            {report.secrets === 'none' &&
              " This computer has no keychain, so tool credentials were already unencrypted and travel as they are."}
            {report.secrets === 'unreadable' &&
              ' This computer can no longer open its own credential key, so connected tools will ask to be signed in again.'}
          </p>
          <p className="muted">Left behind on purpose:</p>
          <ul className="muted" style={{ marginTop: 0 }}>
            {report.omitted.map((o) => (
              <li key={o.name}>
                <strong>{o.name}.</strong> {o.reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** "3 Aug", "never" — a last-seen stamp, short enough to sit on one row. */
function seenLabel(iso: string | null): string {
  if (!iso) return 'never connected';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'never connected';
  const age = Date.now() - ms;
  if (age < 5 * 60_000) return 'connected just now';
  if (age < 24 * 3_600_000) return `last seen ${new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  return `last seen ${new Date(ms).toLocaleDateString()}`;
}

/**
 * Settings → Server → Devices: everything that can reach Stem's server, and the only way
 * to admit something new.
 *
 * A device is admitted by a code that is said once and spent once — never by
 * copying a token around — so nothing here can show you an existing device's
 * credential. The server does not have one to show: it keeps hashes. That much
 * is background, so it sits in the header ⓘ; the list itself is the page.
 *
 * A phone is admitted by the same code, and differs only in how it is carried:
 * nobody types eight characters into a phone if a camera is right there. So the
 * second button mints exactly what the first one does and shows it as a QR
 * (PairPhoneDialog) — one pairing mechanism, two ways of reading it out.
 */
function DevicesSection() {
  const [snapshot, setSnapshot] = useState<DevicesSnapshot | null>(null);
  const [me, setMe] = useState<ClientInfo | null>(null);
  const [label, setLabel] = useState('');
  const [minted, setMinted] = useState<PairingCodeInfo | null>(null);
  const [phone, setPhone] = useState<PairingCodeInfo | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What is pinned to each device (docs/mcp-device-pinning.md). Read once, for
  // one sentence: withdrawing a device is where its MCP servers become orphans,
  // and finding that out in another tab afterwards is finding out too late.
  const [pinned, setPinned] = useState<Record<string, string[]>>({});

  useEffect(() => {
    void window.stem.listDevices().then(setSnapshot).catch(() => undefined);
    void window.stem.clientInfo().then(setMe).catch(() => undefined);
    void window.stem
      .listMcpServers()
      .then((servers) => {
        const byDevice: Record<string, string[]> = {};
        for (const s of servers) {
          if (!s.location || s.location.orphaned) continue;
          (byDevice[s.location.deviceId] ??= []).push(s.name);
        }
        setPinned(byDevice);
      })
      .catch(() => undefined);
  }, []);

  /**
   * Mint a code, named by the field if it was filled in. Both buttons land here:
   * the pending list has to be re-read either way, because a code that has not
   * been spent yet is a row in it.
   */
  async function mint(fallbackLabel: string): Promise<PairingCodeInfo | null> {
    setBusy(true);
    setError(null);
    try {
      const code = await window.stem.createPairingCode(label.trim() || fallbackLabel);
      setLabel('');
      setSnapshot(await window.stem.listDevices());
      return code;
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createCode() {
    const code = await mint('Paired device');
    if (code) setMinted(code);
  }

  async function pairPhone() {
    const code = await mint('Phone');
    if (code) setPhone(code);
  }

  async function revoke(id: string) {
    setConfirming(null);
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await window.stem.revokeDevice(id));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const devices = snapshot?.devices ?? [];

  return (
    <>
      <div className="grp-head grp-head-row">
        Devices
        <InfoTip label="About devices">
          Everything signed in to this Stem. Each device holds its own key — Stem keeps only a
          fingerprint of it, so a key can be withdrawn but never read back out.
        </InfoTip>
      </div>
      <div className="formgroup">
        {devices.map((d) => {
          const self = !!me?.deviceId && d.id === me.deviceId;
          return (
            <div className="set-row" key={d.id}>
              <span className="set-label">
                <strong>
                  {d.label}
                  {self && <span className="muted"> · this device</span>}
                  {/* It said yes to run_command's `device` target — the switch
                      itself lives on that machine, this is just the fact. */}
                  {d.runsCommands && <span className="muted"> · runs commands</span>}
                  {d.runsComputer && <span className="muted"> · controls screen</span>}
                  {d.runsBrowser && <span className="muted"> · drives browser</span>}
                </strong>
                <em>{seenLabel(d.lastSeenAt)}</em>
              </span>
              {confirming === d.id ? (
                <span>
                  {/* Said before the click, not after: the servers are kept and
                      marked rather than deleted, but they stop working until
                      somebody moves them, and that is a fact about this click. */}
                  {pinned[d.id]?.length ? (
                    <em className="muted">
                      {pinned[d.id].join(', ')} {pinned[d.id].length === 1 ? 'runs' : 'run'} here and will stop —
                      Tools → MCP servers is where you move {pinned[d.id].length === 1 ? 'it' : 'them'}.{' '}
                    </em>
                  ) : null}
                  <button className="link-btn" onClick={() => void revoke(d.id)} disabled={busy}>
                    Confirm
                  </button>
                  <button className="link-btn" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  className="link-btn"
                  onClick={() => setConfirming(d.id)}
                  disabled={busy || self}
                  title={self ? 'This is the device you are using — withdrawing it would sign you out here' : undefined}
                >
                  Withdraw
                </button>
              )}
            </div>
          );
        })}
        {snapshot && devices.length === 0 && <p className="muted">Nothing is signed in yet.</p>}

        {snapshot?.pending.map((p) => (
          <div className="set-row" key={`${p.label}-${p.expiresAt}`}>
            <span className="set-label">
              <strong className="muted">{p.label}</strong>
              <em>waiting for a code to be entered · expires {new Date(p.expiresAt).toLocaleTimeString()}</em>
            </span>
          </div>
        ))}

        <form
          className="set-block"
          onSubmit={(e) => {
            e.preventDefault();
            void createCode();
          }}
        >
          <span className="set-sub">Add a device</span>
          <input
            className="ifield"
            type="text"
            aria-label="What to call the new device"
            value={label}
            placeholder="What to call it, e.g. Work laptop"
            onChange={(e) => setLabel(e.target.value)}
          />
          <div className="push-row">
            <button type="button" className="push" disabled={busy} onClick={() => void pairPhone()}>
              Pair a phone
            </button>
            <button type="submit" className="push default" disabled={busy}>
              Get a code
            </button>
          </div>
          {minted && (
            <p className="muted">
              Enter <strong style={{ letterSpacing: '0.08em' }}>{minted.code}</strong> on the new
              device. It works once, and only until {new Date(minted.expiresAt).toLocaleTimeString()}.
            </p>
          )}
          {error && !phone && <p className="muted">{error}</p>}
        </form>
      </div>

      {phone && (
        <PairPhoneDialog
          minted={phone}
          // The server this app is TALKING to, not the one it is configured for:
          // a code lives on the server that minted it, and after a move that is
          // still the old one until Stem restarts.
          serverUrl={me?.serverUrl ?? null}
          busy={busy}
          error={error}
          onAnotherCode={() => void pairPhone()}
          onClose={() => setPhone(null)}
        />
      )}
    </>
  );
}

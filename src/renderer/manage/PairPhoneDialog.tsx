import { useEffect, useMemo, useRef, useState } from 'react';
import { Smartphone, Check, Copy } from 'lucide-react';
import type { PairingCodeInfo } from '../../shared/types';
import { pairingLink } from '../../shared/pair-link';
import { tryQrPath } from '../../shared/qr';

// Settings → Server → Devices → "Pair a phone": one code, shown three ways.
//
// The phone app scans the QR; somebody without a working camera types the code
// and the address; somebody sending the pairing to themselves copies the link.
// All three carry the same code, and the code is spent by whichever arrives
// first — there is nothing to keep in sync because there is only one secret.
//
// WHY THE CODE IS ON SCREEN EVEN WITH NO QR. Stem's default install runs its own
// server on loopback, which a phone cannot reach (see src/shared/pair-link.ts).
// The temptation is to hide the button there, and it is wrong twice over: the
// address may be reachable in ways this process cannot see — a tunnel, a
// forwarded port, a hostname that resolves only on the LAN — and a user who
// knows their own address should not have a feature withheld on our guess. So
// the code is minted and shown regardless, with a sentence saying what the phone
// still needs.
//
// The countdown is a real clock, not a poll: the code expires ten minutes after
// it was minted whether or not anything is watching, and somebody who walks to
// another room and back deserves to be told the code in front of them is dead
// rather than to find out by typing it.

/** `9:42`, or `0:00` once it has run out. */
function remainingLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function PairPhoneDialog({
  minted,
  serverUrl,
  busy,
  error,
  onAnotherCode,
  onClose
}: {
  minted: PairingCodeInfo;
  /** Where this client reaches the server — the address the phone would dial. */
  serverUrl: string | null;
  busy: boolean;
  /** A failed re-mint. It belongs here rather than in the pane behind the backdrop. */
  error: string | null;
  onAnotherCode: () => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const { serverUrl: dialUrl, link } = useMemo(
    () => pairingLink(serverUrl, minted.code),
    [serverUrl, minted.code]
  );

  // Level M: a symbol on a screen is scanned at arm's length in room light, so
  // the fifteen percent it tolerates is the right trade against a denser grid
  // that a phone camera has to be held closer to resolve.
  //
  // Null two ways, and the dialog says which: no link at all (loopback — this
  // Stem has no address a phone could dial), or a link too long to fit a symbol
  // this encoder draws. Both leave the code and the address on screen, which is
  // the whole of what the phone needs; see tryQrPath for why the second one must
  // not be allowed to throw here.
  const qr = useMemo(() => (link ? tryQrPath(link, { ecLevel: 'M' }) : null), [link]);

  const remaining = Date.parse(minted.expiresAt) - now;
  const expired = remaining <= 0;

  function copyLink() {
    if (!link) return;
    void navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  return (
    <div
      className="mcp-approval-backdrop"
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mcp-approval-card pair-phone-card">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <Smartphone size={15} />
          </span>
          <strong>Pair a phone</strong>
        </div>

        {expired ? (
          <p className="muted">
            This code has expired. Codes last ten minutes, so nothing that has been sitting on a
            screen for longer can still be spent — take a fresh one.
          </p>
        ) : (
          <>
            {qr ? (
              <>
                <p className="muted">Open Stem on your phone and scan this.</p>
                <div className="pair-qr-plate">
                  <svg
                    className="pair-qr"
                    viewBox={`0 0 ${qr.extent} ${qr.extent}`}
                    role="img"
                    aria-label={`Pairing code ${minted.code} for ${dialUrl}`}
                  >
                    <path d={qr.d} />
                  </svg>
                </div>
              </>
            ) : link ? (
              <p className="muted">
                This server’s address is too long to fit in a scannable code. Type the code and the
                address into Stem on your phone instead — they pair exactly the same way.
              </p>
            ) : (
              <p className="muted">
                This Stem runs on this computer, at an address only this computer can reach, so
                there is no code to scan. Your phone needs an address it can get to — Stem running
                on a server, or this machine reachable over your network — and then the code below.
              </p>
            )}

            <dl className="mcp-approval-detail pair-detail">
              <dt>Code</dt>
              <dd>
                <strong className="pair-code">{minted.code}</strong>
              </dd>
              <dt>Address</dt>
              <dd>
                {dialUrl ? (
                  <code>{dialUrl}</code>
                ) : (
                  // Shown even though it is useless to the phone: somebody with a
                  // tunnel or a forwarded port knows what to substitute, and a
                  // blank here would read as "Stem doesn't know where it is".
                  <span className="muted">
                    <code>{serverUrl || 'unknown'}</code> — this computer only
                  </span>
                )}
              </dd>
              <dt>Expires in</dt>
              <dd>{remainingLabel(remaining)} · works once</dd>
            </dl>
            <p className="muted">
              It will show up as “{minted.label}” under Devices, and can be withdrawn there at any
              time.
            </p>
          </>
        )}

        {error && <p className="muted">{error}</p>}

        <div className="mcp-approval-actions">
          {/* Only once the code is dead: a working one on screen is not improved
              by a button that throws it away. */}
          {expired ? (
            <button type="button" className="push" disabled={busy} onClick={onAnotherCode}>
              Get another code
            </button>
          ) : (
            link && (
              <button
                type="button"
                className="icon-action"
                onClick={copyLink}
                title={copied ? 'Copied' : 'Copy link'}
                aria-label={copied ? 'Copied' : 'Copy link'}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            )
          )}
          <button ref={closeRef} type="button" className="push default" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { ChevronRight, UserRound } from 'lucide-react';
import type { UserProfile } from '../../../shared/types';
import { createJobStore, holdFullSpin, useJob } from './shared';
import { plainParagraphs } from '../../../shared/plain-text';

// The user summary (server: recall/profile.ts): a few paragraphs on who the
// user is and how they write, from the facts and their own messages, sent with every chat that may see
// memory. It rewrites itself as Stem learns, so the card is mostly for
// reading it, correcting it by hand, or switching it off.

// Module-level so a rewrite still spins after a tab switch and back.
const rewriteJob = createJobStore();
// Folded by default: the text runs to a screenful and would push the facts
// list out of sight. Module-level so the choice survives a tab switch.
let shownOnce = false;

const HEADINGS = new Set(['Current situation', 'Work context', 'Personal context', 'How they communicate', 'Top of mind', 'Brief history']);

function SummaryText({ text }: { text: string }) {
  return (
    <div className="user-summary-text">
      {plainParagraphs(text).split(/\n{2,}/).map((block, i) => {
        const [first, ...rest] = block.split('\n');
        return HEADINGS.has(first.trim()) && rest.length ? (
          <section key={i}>
            <h4>{first.trim()}</h4>
            <p>{rest.join('\n')}</p>
          </section>
        ) : (
          <p key={i}>{block}</p>
        );
      })}
    </div>
  );
}

export function UserSummaryCard({ disabled }: { disabled: boolean }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmRewrite, setConfirmRewrite] = useState(false);
  const { running, msg } = useJob(rewriteJob);
  const [shown, setShown] = useState(shownOnce);
  const toggleShown = () => {
    shownOnce = !shown;
    setShown(shownOnce);
  };

  useEffect(() => {
    let live = true;
    const load = () =>
      window.stem
        .getUserProfile()
        .then((p) => live && setProfile(p))
        // quiet: the card stays as it was; the next visit or change event asks again.
        .catch(() => undefined);
    void load();
    const off = window.stem.onUserProfileChanged(() => void load());
    return () => {
      live = false;
      off();
    };
  }, [running]);

  if (!profile) return null;

  const toggle = async () => setProfile(await window.stem.setUserProfileEnabled(!profile.enabled));

  const save = async () => {
    if (draft === null) return;
    setProfile(await window.stem.saveUserProfile(draft));
    setDraft(null);
  };

  const rewrite = () => {
    if (profile.editedAt && !confirmRewrite) {
      setConfirmRewrite(true);
      return;
    }
    setConfirmRewrite(false);
    rewriteJob.start(async () => {
      try {
        const r = await holdFullSpin(window.stem.rewriteUserProfile());
        setProfile(r.profile);
        if (r.updated) return null;
        return r.reason === 'not-enough'
          ? 'Stem needs to know you a little better first — a few more chats.'
          : 'The memory model gave no usable summary — try again.';
      } catch {
        return 'Rewrite failed — try again.';
      }
    });
  };

  const off = disabled || !profile.enabled;
  const status = !profile.enabled
    ? 'Off — chats get only the facts that match each message.'
    : profile.text
      ? 'From your facts and how you write. Sent with every chat that can see your memory; rewritten as Stem learns more about you. "Current situation" may name a hospital stay or a trip, and is left out of mail with other people.'
      : 'Not written yet — Stem writes it once it has learned a little about you from your chats.';

  return (
    <div className="group deep-check-card user-summary-card">
      <div className="deep-check-head">
        <span className="deep-check-icon" aria-hidden="true">
          <UserRound size={16} className={running ? 'spin' : undefined} />
        </span>
        <span className="row-main">
          <strong>{running ? 'Writing your summary…' : 'Summary of you'}</strong>
          <em>{status}</em>
        </span>
        <button
          className={`switch${profile.enabled ? ' on' : ''}`}
          role="switch"
          aria-checked={profile.enabled}
          aria-label="Summary of you"
          disabled={disabled}
          onClick={() => void toggle()}
        />
      </div>
      {draft !== null ? (
        <textarea
          className="ci-textarea user-summary-edit"
          aria-label="Summary of you"
          rows={12}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : (
        profile.enabled &&
        profile.text && (
          <>
            <button type="button" className="memory-tech-head" aria-expanded={shown} onClick={toggleShown}>
              <ChevronRight size={14} className={shown ? 'open' : ''} />
              <span>{shown ? 'Hide summary' : 'Show summary'}</span>
            </button>
            {shown && <SummaryText text={profile.text} />}
          </>
        )
      )}
      {msg && <p className="muted">{msg}</p>}
      {profile.enabled && (
        <div className="deep-check-foot">
          <span className="muted">
            {profile.generatedAt
              ? `Updated ${new Date(Math.max(profile.generatedAt, profile.editedAt ?? 0)).toLocaleDateString()}${profile.editedAt ? ' · edited by you' : ''}`
              : ''}
          </span>
          <span className="deep-check-actions">
            {draft !== null ? (
              <>
                <button type="button" className="push" onClick={() => setDraft(null)}>
                  Cancel
                </button>
                <button type="button" className="push default" onClick={() => void save()}>
                  Save
                </button>
              </>
            ) : (
              <>
                <button type="button" className="push" disabled={off || running} onClick={() => setDraft(profile.text)}>
                  {profile.text ? 'Edit' : 'Write it yourself'}
                </button>
                <button
                  type="button"
                  className={`push${confirmRewrite ? ' default' : ''}`}
                  disabled={off || running}
                  onClick={rewrite}
                  onBlur={() => setConfirmRewrite(false)}
                >
                  {running ? 'Writing…' : confirmRewrite ? 'Discard your edits?' : profile.text ? 'Rewrite' : 'Write now'}
                </button>
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

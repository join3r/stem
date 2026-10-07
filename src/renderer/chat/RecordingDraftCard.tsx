import { useEffect, useState } from 'react';
import { Check, Circle, FlaskConical, Loader2, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import type { RecordingDraft } from '../../shared/types';
import { noteDraft, prefillComposer, requestSheet, startPractice } from './recorder-store';
import { practiceMessage } from '../../shared/practice-message';

// The card a recording becomes in its chat: the skill Stem wrote from it, what
// it worked out changes each run ("Delivery date ← the date in the supplier's
// email"), any question it could not settle, and Save / Edit / Record another
// example / Discard. Once saved, Try it puts "Use <skill> on: " in the composer.

function stripInvoke(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export function RecordingDraftCard({
  draft
}: {
  draft: RecordingDraft;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(draft.skill?.name ?? '');
  const [description, setDescription] = useState(draft.skill?.description ?? '');
  const [body, setBody] = useState(draft.skill?.body ?? '');
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Try it needs the browser or this Mac; say so when chats have neither.
  // (A persona chat may still have them through its own pins.)
  const [canRun, setCanRun] = useState(true);
  useEffect(() => {
    if (draft.status !== 'saved') return;
    let alive = true;
    void window.stem
      .getSettings()
      .then((s) => alive && setCanRun(!!s.chatFeatures?.browser?.allow || !!s.chatFeatures?.computer?.allow))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [draft.status]);

  // A rewrite (another example, answers) replaces the text being shown.
  useEffect(() => {
    if (editing) return;
    setName(draft.skill?.name ?? '');
    setDescription(draft.skill?.description ?? '');
    setBody(draft.skill?.body ?? '');
  }, [draft.skill, editing]);

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await work();
    } catch (e) {
      setNotice(stripInvoke(e));
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    act(async () => {
      const edited = editing ? { name: name.trim(), description: description.trim(), body } : null;
      const res = await window.stem.saveRecordingDraft(draft.id, edited);
      noteDraft(res.draft);
      if (res.ok) setEditing(false);
      setNotice(res.ok ? null : res.message);
    });
  const discard = () => act(async () => noteDraft(await window.stem.discardRecordingDraft(draft.id)));
  const answer = () =>
    act(async () => {
      const given = draft.questions.map((question, i) => ({ question, answer: (answers[i] ?? '').trim() })).filter((a) => a.answer);
      if (given.length === 0) return;
      noteDraft(await window.stem.answerRecordingDraft(draft.id, given));
      setAnswers({});
    });

  const examples = draft.examples.length;
  const stepCount = draft.examples.reduce((n, ex) => n + ex.steps.length, 0);
  const open = draft.status === 'ready' || draft.status === 'failed';

  if (draft.status === 'discarded') {
    return (
      <div className="record-card closed">
        <Trash2 size={13} /> <span className="muted">Discarded a recorded skill draft{draft.skill ? ` (${draft.skill.name})` : ''}.</span>
      </div>
    );
  }

  return (
    <div className={`record-card status-${draft.status}`}>
      <div className="record-card-head">
        <span className="record-dot" aria-hidden="true" />
        <strong>Recorded skill</strong>
        <span className="muted">
          {examples} recording{examples === 1 ? '' : 's'} · {stepCount} steps
        </span>
        {draft.status === 'saved' && (
          <span className="record-badge ok">
            <Check size={12} /> Saved
          </span>
        )}
      </div>

      {draft.status === 'drafting' && (
        <p className="record-working">
          <Loader2 size={13} className="spin" /> Writing the skill from your recording{examples === 1 ? '' : 's'}…
        </p>
      )}

      {draft.skill && draft.status !== 'drafting' && (
        <>
          {editing ? (
            <div className="record-edit">
              <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Skill name" spellCheck={false} />
              <input value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Description" />
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14} aria-label="Skill body" spellCheck={false} />
            </div>
          ) : (
            <>
              <div className="record-title">
                <code>{draft.skill.name}</code>
                <span>{draft.skill.description}</span>
              </div>
              {draft.variables.length > 0 && (
                <div className="record-vars">
                  <div className="record-label">What changes each time</div>
                  {draft.variables.map((v, i) => (
                    <div className="record-var" key={i}>
                      <span className="record-var-name">{v.name}</span>
                      <span className="record-var-from">← {v.from}</span>
                    </div>
                  ))}
                </div>
              )}
              <details className="record-body">
                <summary>Steps</summary>
                <pre>{draft.skill.body}</pre>
              </details>
            </>
          )}
        </>
      )}

      {open && draft.questions.length > 0 && !editing && (
        <div className="record-questions">
          <div className="record-label">Stem couldn’t tell</div>
          {draft.questions.map((q, i) => (
            <label key={i} className="record-question">
              <span>{q}</span>
              <input
                value={answers[i] ?? ''}
                onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void answer();
                }}
                placeholder="Your answer"
              />
            </label>
          ))}
          <button className="push" disabled={busy || !Object.values(answers).some((a) => a.trim())} onClick={() => void answer()}>
            Answer and rewrite
          </button>
        </div>
      )}

      {draft.message && <p className="record-message">{draft.message}</p>}
      {notice && notice !== draft.message && <p className="record-message">{notice}</p>}

      {open && (
        <div className="record-actions">
          {draft.skill && (
            <button className="push default" disabled={busy} onClick={() => void save()}>
              {draft.duplicateOf ? `Update “${draft.duplicateOf}”` : 'Save skill'}
            </button>
          )}
          {draft.skill && (
            <button className="push" disabled={busy} onClick={() => setEditing(!editing)}>
              <Pencil size={13} /> {editing ? 'Done editing' : 'Edit'}
            </button>
          )}
          {draft.status === 'ready' && draft.skill && !editing && (
            <button
              className="push"
              disabled={busy}
              title="Let Stem try the task — the message names the steps it stops before; edit it first"
              onClick={() => {
                const { text, caret } = practiceMessage(draft.skill!.name, draft.finalSteps);
                startPractice(draft.threadId, draft.id, draft.skill!.name, text, caret);
              }}
            >
              <FlaskConical size={13} /> Practice run
            </button>
          )}
          <button className="push" disabled={busy} onClick={() => requestSheet(draft.threadId, draft.id)}>
            <Plus size={13} /> Record another example
          </button>
          <button className="push" disabled={busy} onClick={() => void discard()}>
            Discard
          </button>
        </div>
      )}

      {draft.status === 'saved' && draft.savedSlug && (
        <div className="record-actions">
          <button className="push" onClick={() => prefillComposer(draft.threadId, `Use the ${draft.savedSlug} skill on: `)}>
            <Play size={13} /> Try it
          </button>
          {!canRun && (
            <span className="muted record-hint">
              <Circle size={10} /> This chat can’t use the browser or this Mac yet — allow them in Settings → Features.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

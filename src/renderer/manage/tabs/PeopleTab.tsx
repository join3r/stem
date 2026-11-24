import { useCallback, useEffect, useState } from 'react';
import { Check, Sparkles, Trash2, User, UserPlus } from 'lucide-react';
import type { Person, PersonFact } from '../../../shared/types';
import { InfoTip } from '../../ui/InfoTip';
import {
  ConfirmDelete,
  DetailFooter,
  DetailHeader,
  DetailIdent,
  DetailTabs,
  Field,
  Glyph,
  ListGroup,
  ListHeader,
  ListRow,
  ListSearch
} from '../ListDetail';

// Manage → People: the people in the user's life Stem should know about. A
// person is a name (plus aliases), who they are to the user, where to reach
// them and the user's notes; the Facts tab lists what memory says about them —
// every fact that names them (server/recall/people-match.ts). Suggestions come
// from memory and stay inert until accepted. Explicit Save, like Personas: a
// draft overlay keeps unsaved edits until Save or Cancel.

const NEW_ID = '__new__';

function blank(): Person {
  return {
    id: NEW_ID,
    name: '',
    aliases: [],
    relation: '',
    stemAddress: '',
    emails: [],
    handles: [],
    notes: '',
    status: 'active',
    createdAt: 0,
    updatedAt: 0
  };
}

const EDITABLE = ['name', 'aliases', 'relation', 'stemAddress', 'emails', 'handles', 'notes', 'status'] as const;

function sameEdit(a: Person, b: Person): boolean {
  return EDITABLE.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/** "a, b , c" → ["a","b","c"]. */
const splitList = (text: string, sep: RegExp): string[] => text.split(sep).map((s) => s.trim()).filter(Boolean);

function rowLine(p: Person): string {
  if (p.status === 'suggested') return p.reason || p.relation || 'Suggested from memory';
  return [p.relation, p.stemAddress || p.emails[0] || p.handles[0]].filter(Boolean).join(' · ') || 'No details yet';
}

/** A list field edited as text: the raw text is kept while typing, the list on blur. */
function ListInput({
  id,
  value,
  onChange,
  placeholder,
  multiline
}: {
  id: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  multiline?: boolean;
}) {
  const joined = value.join(multiline ? '\n' : ', ');
  const [text, setText] = useState(joined);
  useEffect(() => setText(joined), [joined]);
  const commit = (t: string) => onChange(splitList(t, multiline ? /\n/ : /[,;\n]/));
  return multiline ? (
    <textarea
      id={id}
      className="ci-textarea"
      rows={3}
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        commit(e.target.value);
      }}
    />
  ) : (
    <input
      id={id}
      className="vfield"
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        commit(e.target.value);
      }}
      onBlur={() => setText(joined)}
    />
  );
}

export function PeopleTab() {
  const [people, setPeople] = useState<Person[]>([]);
  const [drafts, setDrafts] = useState<Map<string, Person>>(new Map());
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<'details' | 'facts'>('details');
  const [facts, setFacts] = useState<PersonFact[] | null>(null);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    window.stem.listPeople().then(setPeople, (e: unknown) => setError(String((e as Error)?.message ?? e)));
  }, []);
  useEffect(() => {
    reload();
    return window.stem.onPeopleChanged(reload);
  }, [reload]);

  const opened = openId ? (drafts.get(openId) ?? people.find((p) => p.id === openId) ?? null) : null;

  useEffect(() => {
    setFacts(null);
    if (!openId || openId === NEW_ID) return;
    let live = true;
    window.stem.personFacts(openId).then((f) => live && setFacts(f), () => live && setFacts([]));
    return () => {
      live = false;
    };
    // Re-read after a save: a new alias can claim more facts.
  }, [openId, people]);

  const setDraft = (p: Person) => setDrafts((m) => new Map(m).set(p.id, p));
  const dropDraft = (id: string) =>
    setDrafts((m) => {
      const next = new Map(m);
      next.delete(id);
      return next;
    });

  const open = (p: Person) => {
    setError(null);
    setNotice(null);
    setTab('details');
    setOpenId(p.id);
  };

  const back = () => {
    if (opened) {
      const saved = people.find((p) => p.id === opened.id);
      if (!saved || sameEdit(opened, saved)) dropDraft(opened.id);
    }
    setError(null);
    setOpenId(null);
  };

  const save = async (p: Person, status = p.status) => {
    setSaving(true);
    setError(null);
    try {
      const fresh = await window.stem.savePerson({ ...p, id: p.id === NEW_ID ? '' : p.id, status });
      setPeople(fresh);
      dropDraft(p.id);
      if (p.id === NEW_ID) {
        const created = fresh.find((q) => q.name.trim().toLowerCase() === p.name.trim().toLowerCase());
        setOpenId(created?.id ?? null);
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (p: Person) => {
    dropDraft(p.id);
    setOpenId(null);
    if (p.id === NEW_ID) return;
    try {
      setPeople(await window.stem.deletePerson(p.id));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };

  const suggest = async () => {
    setSuggesting(true);
    setError(null);
    setNotice(null);
    try {
      const r = await window.stem.suggestPeople();
      setPeople(r.people);
      setNotice(r.added ? `Suggested ${r.added} ${r.added === 1 ? 'person' : 'people'} from memory.` : 'No one new in memory.');
    } catch (e) {
      setError(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setSuggesting(false);
    }
  };

  if (opened) {
    const p = opened;
    const saved = people.find((x) => x.id === p.id);
    const dirty = !saved || !sameEdit(p, saved);
    const suggested = p.status === 'suggested';
    return (
      <div className="ld-detail">
        <DetailHeader backLabel="People" onBack={back}>
          {suggested && saved && (
            <button
              type="button"
              className="icon-action sm"
              onClick={() => void save(p, 'active')}
              title="Add to People"
              aria-label="Accept suggestion"
            >
              <Check size={14} />
            </button>
          )}
          <ConfirmDelete
            label={suggested ? 'Dismiss suggestion' : saved ? 'Delete person' : 'Discard this draft'}
            icon={<Trash2 size={14} />}
            onConfirm={() => void remove(p)}
          />
        </DetailHeader>
        <DetailIdent
          glyph={<Glyph icon={<User size={17} />} tone={suggested ? 'plain' : 'accent'} size="lg" />}
          name={
            <input
              className="ld-name-input"
              aria-label="Name"
              placeholder="Name"
              value={p.name}
              onChange={(e) => setDraft({ ...p, name: e.target.value })}
            />
          }
          caption={suggested ? 'Suggested from memory · not used until you accept it' : saved ? p.relation || 'Person' : 'Not saved yet'}
        />
        {error && <p className="task-failed">{error}</p>}
        {suggested && p.reason && (
          <p className="ld-advice" role="status">
            <Sparkles size={13} />
            <span>{p.reason} Check the name, then accept.</span>
          </p>
        )}
        <DetailTabs
          tabs={[
            { key: 'details', label: 'Details' },
            { key: 'facts', label: facts ? `Facts (${facts.length})` : 'Facts' }
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="ld-body">
          {tab === 'details' && (
            <>
              <Field label="Who they are to you" htmlFor="person-relation">
                <input
                  id="person-relation"
                  className="vfield"
                  value={p.relation}
                  placeholder="Colleague at Awantech, sister, client…"
                  onChange={(e) => setDraft({ ...p, relation: e.target.value })}
                />
              </Field>
              <Field label="Also called" htmlFor="person-aliases">
                <ListInput
                  id="person-aliases"
                  value={p.aliases}
                  placeholder="Peťo, Novák — separated by commas"
                  onChange={(aliases) => setDraft({ ...p, aliases })}
                />
              </Field>
              <Field label="Stem address" htmlFor="person-stem">
                <input
                  id="person-stem"
                  className="vfield"
                  value={p.stemAddress}
                  placeholder="Optional — their address if they use Stem"
                  onChange={(e) => setDraft({ ...p, stemAddress: e.target.value })}
                />
              </Field>
              <Field label="Email" htmlFor="person-emails">
                <ListInput
                  id="person-emails"
                  value={p.emails}
                  placeholder="peter@example.com — separated by commas"
                  onChange={(emails) => setDraft({ ...p, emails })}
                />
              </Field>
              <Field label="Other ways to reach them" htmlFor="person-handles">
                <ListInput
                  id="person-handles"
                  multiline
                  value={p.handles}
                  placeholder={'One per line, e.g.\nSlack: @peter\nPhone: +421 900 000 000'}
                  onChange={(handles) => setDraft({ ...p, handles })}
                />
              </Field>
              <Field label="Notes" htmlFor="person-notes">
                <textarea
                  id="person-notes"
                  className="ci-textarea"
                  rows={4}
                  value={p.notes}
                  placeholder="Anything Stem should keep in mind when this person comes up."
                  onChange={(e) => setDraft({ ...p, notes: e.target.value })}
                />
              </Field>
            </>
          )}
          {tab === 'facts' && (
            <div className="people-facts">
              {!saved ? (
                <p className="muted">Save first; then every fact that names them shows here.</p>
              ) : facts === null ? (
                <p className="muted">Loading…</p>
              ) : facts.length === 0 ? (
                <p className="muted">No facts name them yet. Stem learns them from your chats, or add an alias the facts use.</p>
              ) : (
                <ul>
                  {facts.map((f) => (
                    <li key={f.id} title={f.source.startsWith('contact:') ? 'Learned from mail with them' : undefined}>
                      {f.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        {suggested && saved ? (
          <DetailFooter
            dirty
            saving={saving}
            canSave={!!p.name.trim()}
            saveLabel="Accept"
            onCancel={back}
            onSave={() => void save(p, 'active')}
          />
        ) : (
          <DetailFooter
            dirty={dirty}
            saving={saving}
            canSave={!!p.name.trim()}
            onCancel={() => {
              dropDraft(p.id);
              if (!saved) setOpenId(null);
            }}
            onSave={() => void save(p)}
          />
        )}
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const matches = (p: Person) =>
    !q || [p.name, ...p.aliases, p.relation, p.stemAddress, ...p.emails].some((s) => s.toLowerCase().includes(q));
  const active = people.filter((p) => p.status === 'active' && matches(p)).sort((a, b) => a.name.localeCompare(b.name));
  const suggestions = people.filter((p) => p.status === 'suggested' && matches(p));

  return (
    <div className="ld-list">
      <ListHeader
        title="People"
        extra={
          <>
            {' '}
            <InfoTip label="About people">
              The people in your life Stem should know about. When a chat or mail names one of them, Stem gets their
              details, your notes and everything memory says about them. Facts belong to a person when they name them,
              so add the nicknames you use as aliases.
            </InfoTip>{' '}
            <button
              type="button"
              className="icon-action sm"
              onClick={() => void suggest()}
              disabled={suggesting}
              title="Suggest people from memory"
              aria-label="Suggest people from memory"
            >
              <Sparkles size={14} className={suggesting ? 'suggesting' : undefined} />
            </button>
          </>
        }
        newAriaLabel="New person"
        onNew={() => {
          setDraft(blank());
          open(blank());
        }}
      />
      <ListSearch value={query} onChange={setQuery} placeholder="Find a person" />
      {error && <p className="task-failed">{error}</p>}
      {notice && <p className="muted ld-empty" role="status">{notice}</p>}
      {suggestions.length > 0 && (
        <ListGroup label="Suggested" count={suggestions.length}>
          {suggestions.map((p) => (
            <ListRow
              key={p.id}
              glyph={<Glyph icon={<UserPlus size={14} />} />}
              name={p.name}
              sub={rowLine(p)}
              dim
              onOpen={() => open(p)}
            />
          ))}
        </ListGroup>
      )}
      {active.length > 0 && (
        <ListGroup label="People" count={active.length}>
          {active.map((p) => {
            const draft = drafts.get(p.id);
            return (
              <ListRow
                key={p.id}
                glyph={<Glyph icon={<User size={14} />} tone="accent" />}
                name={p.name}
                sub={`${rowLine(p)}${draft && !sameEdit(draft, p) ? ' · unsaved' : ''}`}
                onOpen={() => open(p)}
              />
            );
          })}
        </ListGroup>
      )}
      {active.length === 0 && suggestions.length === 0 && (
        <p className="muted ld-empty">
          {q ? 'No one matches.' : 'No people yet. Add someone, or let Stem suggest the people your memory already names.'}
        </p>
      )}
    </div>
  );
}
